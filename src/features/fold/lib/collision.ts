import type {
  Face,
  Paper,
  PoseFace,
  Vec3,
} from "../../../shared/types";
import { add, dot, scale, sub } from "../../../shared/vector";
import { solvePose } from "./kinematics";

/**
 * 折叠碰撞引导
 * -------------
 * 所有判断都在纸张的物理坐标系中进行：接触容差取模型包围盒的固定比例，
 * 与观察缩放、界面像素完全无关；几何随纸张大小同比缩放时容差同比缩放，
 * 允许通过 / 发生阻挡的角度保持一致。
 */

/** 纸面之间允许的最小间隙（毫米，按 paper.size=200mm 标定）。 */
export const CONTACT_TOLERANCE_MM = 0.5;
/** 保守推进的最大迭代次数、最小角步长（度）与末端二分精度。 */
const CA_MAX_ITER = 4096;
const CA_MIN_STEP_DEG = 1e-4;
const CA_BISECTION_STEPS = 40;
/** 共面 / 重心坐标判定的数值底线。 */
const PLANE_EPS = 1e-9;
const BARY_EPS = 1e-7;

export interface Contact {
  point: Vec3;
  depth: number;
}
export interface PairContact extends Contact {
  faceA: string;
  faceB: string;
}
export interface CollisionReport {
  contacts: PairContact[];
  faces: string[];
  pairs: [string, string][];
}
export interface ContactStop {
  angle: number;
  report: CollisionReport;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * 接触容差（模型单位）= 纸张基准包围盒跨度的固定比例。
 *
 * 这样设计同时满足两条物理一致性要求：
 * - 几何坐标同比缩放（换纸张大小）时，容差同比缩放，首次接触的
 *   判定角度完全不变 —— 允许通过 / 发生阻挡的结果与纸张尺寸无关；
 * - 换算回毫米后，容差随纸张物理尺寸同比变化（200mm 纸约 0.5mm），
 *   且只依赖模型自身尺寸，与观察缩放、界面像素完全无关。
 */
export function contactTolerance(paper: Paper): number {
  let min: Vec3 = [Infinity, Infinity, Infinity];
  let max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const f of paper.faces) {
    for (const p of f.points) {
      min = [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])];
      max = [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])];
    }
  }
  const modelSpan = Math.max(
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  );
  return modelSpan * (CONTACT_TOLERANCE_MM / 200);
}

interface Topology {
  parent: Map<string, string | undefined>;
  children: Map<string, string[]>;
  /** pairKey -> 两个纸面共享的基准顶点（基准坐标）。 */
  sharedVertices: Map<string, Vec3[]>;
  /** 共享整条边 / 父子折痕连接的纸面对，允许正常贴合。 */
  exempt: Set<string>;
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const samePoint = (a: Vec3, b: Vec3) => dist(a, b) <= 1e-9;

export function buildTopology(paper: Paper): Topology {
  const parent = new Map<string, string | undefined>();
  const children = new Map<string, string[]>();
  const sharedVertices = new Map<string, Vec3[]>();
  const exempt = new Set<string>();

  for (const f of paper.faces) {
    parent.set(f.id, f.parent);
    if (f.parent) {
      const list = children.get(f.parent) ?? [];
      list.push(f.id);
      children.set(f.parent, list);
    }
  }

  for (let i = 0; i < paper.faces.length; i++) {
    for (let j = i + 1; j < paper.faces.length; j++) {
      const a = paper.faces[i]!;
      const b = paper.faces[j]!;
      const shared: Vec3[] = [];
      for (const pa of a.points) {
        if (b.points.some((pb) => samePoint(pa, pb)) && !shared.some((s) => samePoint(s, pa))) {
          shared.push(pa);
        }
      }
      const key = pairKey(a.id, b.id);
      if (shared.length) sharedVertices.set(key, shared);
      // 共享整条边（三角形有两个公共顶点）或父子折痕关系都属于正常贴合。
      if (shared.length >= 2 || parent.get(a.id) === b.id || parent.get(b.id) === a.id) {
        exempt.add(key);
      }
    }
  }
  return { parent, children, sharedVertices, exempt };
}

/** 某条折痕带动的全部纸面（直接子纸面 + 全部后代纸面）。 */
export function creaseSubtree(paper: Paper, creaseId: string): Set<string> {
  const crease = paper.creases.find((c) => c.id === creaseId);
  const topo = buildTopology(paper);
  const result = new Set<string>();
  if (!crease) return result;
  const queue = [crease.face];
  while (queue.length) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    for (const child of topo.children.get(id) ?? []) queue.push(child);
  }
  return result;
}

/** 纸面在 UI 中的可读名称：优先使用它自身折痕的名称，根纸面称为基底纸面。 */
export function faceLabel(paper: Paper, faceId: string): string {
  const face = paper.faces.find((f) => f.id === faceId);
  if (face?.crease) {
    return paper.creases.find((c) => c.id === face.crease)?.name ?? faceId;
  }
  return "基底纸面";
}

/* ------------------------------------------------------------------ */
/* 几何原语                                                            */
/* ------------------------------------------------------------------ */

function segSegClosest(
  p1: Vec3,
  q1: Vec3,
  p2: Vec3,
  q2: Vec3,
): { distance: number; cp1: Vec3; cp2: Vec3 } {
  const u = sub(q1, p1);
  const v = sub(q2, p2);
  const w0 = sub(p1, p2);
  const a = dot(u, u);
  const b = dot(u, v);
  const c = dot(v, v);
  const d = dot(u, w0);
  const e = dot(v, w0);
  const denom = a * c - b * b;
  let s = 0;
  if (denom > PLANE_EPS) s = clamp01((b * e - c * d) / denom);
  const t = clamp01((b * s + e) / (c || PLANE_EPS));
  if (denom > PLANE_EPS) s = clamp01((b * t - d) / (a || PLANE_EPS));
  const cp1 = add(p1, scale(u, s));
  const cp2 = add(p2, scale(v, t));
  return { distance: dist(cp1, cp2), cp1, cp2 };
}

function barycentric(
  p: Vec3,
  a: Vec3,
  b: Vec3,
  c: Vec3,
): [number, number, number] | null {
  const v0 = sub(b, a);
  const v1 = sub(c, a);
  const v2 = sub(p, a);
  const d00 = dot(v0, v0);
  const d01 = dot(v0, v1);
  const d11 = dot(v1, v1);
  const d20 = dot(v2, v0);
  const d21 = dot(v2, v1);
  const denom = d00 * d11 - d01 * d01;
  if (denom <= PLANE_EPS) return null;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  return [1 - v - w, v, w];
}

const insideTriangle = (bary: number[]) => bary.every((n) => n >= -BARY_EPS);

/** 点到线段的最短距离及最近点。 */
function pointSegmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 <= PLANE_EPS) return dist(p, a);
  const t = clamp01(dot(sub(p, a), ab) / len2);
  const closest = add(a, scale(ab, t));
  return dist(p, closest);
}

/** 点到三角形的精确最短距离（投影在内部取高，否则取到三条边的距离）。 */
function pointTriangleDistance(p: Vec3, tri: PoseFace): number {
  const [a, b, c] = tri.points;
  const bary = barycentric(p, a!, b!, c!);
  if (bary && insideTriangle(bary)) {
    return Math.abs(dot(tri.normal, sub(p, a!)));
  }
  return Math.min(
    pointSegmentDistance(p, a!, b!),
    pointSegmentDistance(p, b!, c!),
    pointSegmentDistance(p, c!, a!),
  );
}

function triangleEdges(f: PoseFace): [Vec3, Vec3][] {
  const p = f.points;
  return [
    [p[0]!, p[1]!],
    [p[1]!, p[2]!],
    [p[2]!, p[0]!],
  ];
}

/**
 * 线段 vs 三角形：
 * 1. 端点进入容差层且投影落在三角形内（刺穿 / 压入）；
 * 2. 两端点分居三角形平面两侧，且交点在三角形内部
 *    —— 即使两个端点最终都无碰撞，中途穿越也会被拦住。
 * 共面贴合不在此处理（交由边-边距离，并由拓扑豁免共享边）。
 */
function segTriangle(
  p0: Vec3,
  p1: Vec3,
  tri: PoseFace,
  tol: number,
): Contact | null {
  const [a, b, c] = tri.points;
  const n = tri.normal;
  const height = (p: Vec3) => dot(n, sub(p, a!));
  const h0 = height(p0);
  const h1 = height(p1);

  // 带容差的平面侧别：+1 正面、-1 反面、0 容差层内。
  const side = (h: number) =>
    h > tol ? 1 : h < -tol ? -1 : 0;
  const s0 = side(h0);
  const s1 = side(h1);

  for (const [p, h] of [
    [p0, h0],
    [p1, h1],
  ] as const) {
    if (Math.abs(h) <= tol) {
      const bary = barycentric(p, a!, b!, c!);
      if (bary && insideTriangle(bary)) {
        return { point: p, depth: tol * 2 - Math.abs(h) };
      }
    }
  }
  // 真正的刺穿只发生在两端严格分居平面两侧时。端点贴平面的情形
  // （折轴上的共享顶点高度恒为 0）已由上面的端点容差分支处理，
  // 这里不能用 h0/(h0-h1)：h0=0 会把交点错误算成该顶点本身。
  if (s0 * s1 < 0) {
    const denom = h0 - h1;
    if (Math.abs(denom) > PLANE_EPS) {
      const s = h0 / denom;
      const hitPoint = add(p0, scale(sub(p1, p0), s));
      const bary = barycentric(hitPoint, a!, b!, c!);
      if (bary && insideTriangle(bary)) {
        return { point: hitPoint, depth: tol };
      }
    }
  }
  return null;
}

function facePairContact(
  m: PoseFace,
  s: PoseFace,
  tol: number,
  ignoreWorld: Vec3[],
): Contact | null {
  let best: Contact | null = null;
  const consider = (c: Contact | null) => {
    if (!c) return;
    if (ignoreWorld.some((v) => dist(v, c.point) <= tol * 2)) return;
    if (!best || c.depth > best.depth) best = c;
  };

  const em = triangleEdges(m);
  const es = triangleEdges(s);
  for (const [a1, b1] of em) {
    for (const [a2, b2] of es) {
      const r = segSegClosest(a1, b1, a2, b2);
      if (r.distance <= tol) {
        consider({
          point: scale(add(r.cp1, r.cp2), 0.5),
          depth: tol - r.distance,
        });
      }
    }
  }
  for (const [p0, p1] of em) consider(segTriangle(p0, p1, s, tol));
  for (const [p0, p1] of es) consider(segTriangle(p0, p1, m, tol));
  return best;
}

/**
 * 两个三角形（视为实体面）的最短距离：各顶点到对面三角形的距离与
 * 边-边最近距离的最小值。已穿透的面返回 0。用于保守推进的间隙评估。
 */
function facePairDistance(m: PoseFace, s: PoseFace): number {
  let d = Infinity;
  for (const v of m.points) d = Math.min(d, pointTriangleDistance(v, s));
  for (const v of s.points) d = Math.min(d, pointTriangleDistance(v, m));
  for (const [a1, b1] of triangleEdges(m)) {
    for (const [a2, b2] of triangleEdges(s)) {
      d = Math.min(d, segSegClosest(a1, b1, a2, b2).distance);
    }
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* 报告与首次接触搜索                                                   */
/* ------------------------------------------------------------------ */

function poseMap(pose: PoseFace[]): Map<string, PoseFace> {
  return new Map(pose.map((f) => [f.id, f]));
}

function scanPairs(
  paper: Paper,
  pose: PoseFace[],
  pairs: [string, string][],
  topo: Topology,
  tol: number,
): CollisionReport {
  const byId = poseMap(pose);
  const contacts: PairContact[] = [];
  const faces = new Set<string>();
  for (const [idA, idB] of pairs) {
    const fa = byId.get(idA)!;
    const fb = byId.get(idB)!;
    const shared = topo.sharedVertices.get(pairKey(idA, idB)) ?? [];
    // 仅共享顶点的纸面：忽略公共顶点处的接触，但保留其它位置的穿越检查。
    const ignoreWorld = shared.map((v) => {
      const owner = byId.get(idA)!;
      const base = paper.faces.find((f) => f.id === idA)!;
      const idx = base.points.findIndex((p) => samePoint(p, v));
      return owner.points[idx]!;
    });
    const hit = facePairContact(fa, fb, tol, ignoreWorld);
    if (hit) {
      contacts.push({ faceA: idA, faceB: idB, ...hit });
      faces.add(idA);
      faces.add(idB);
    }
  }
  return {
    contacts,
    faces: [...faces],
    pairs: contacts.map((c) => [c.faceA, c.faceB] as [string, string]),
  };
}

function allCheckablePairs(paper: Paper, topo: Topology): [string, string][] {
  const result: [string, string][] = [];
  for (let i = 0; i < paper.faces.length; i++) {
    for (let j = i + 1; j < paper.faces.length; j++) {
      const a = paper.faces[i]!;
      const b = paper.faces[j]!;
      if (!topo.exempt.has(pairKey(a.id, b.id))) {
        result.push([a.id, b.id]);
      }
    }
  }
  return result;
}

/** 对当前姿态做完整体检（也能发现静止纸面之间的穿透）。 */
export function collisionReport(
  paper: Paper,
  pose: PoseFace[],
  tol: number = contactTolerance(paper),
): CollisionReport {
  const topo = buildTopology(paper);
  return scanPairs(paper, pose, allCheckablePairs(paper, topo), topo, tol);
}

function movingPairs(
  paper: Paper,
  topo: Topology,
  subtree: Set<string>,
): [string, string][] {
  const result: [string, string][] = [];
  for (const pair of allCheckablePairs(paper, topo)) {
    const inA = subtree.has(pair[0]);
    const inB = subtree.has(pair[1]);
    // 子树内部刚性同动、子树外部静止，都只需检查“动 vs 静”。
    if (inA !== inB) result.push(inA ? pair : [pair[1], pair[0]]);
  }
  return result;
}

/**
 * 沿 creaseId 从当前角度转向 target 时，首次发生接触的角度。
 * 可全程通过返回 null；否则返回可复现的停止角度与接触报告。
 *
 * 采用保守推进（Conservative Advancement）连续碰撞检测，保证不漏掉
 * 任何狭窄穿越：每个角步长都由“当前精确间隙 ÷ 动面整体最大旋转半径”
 * 数学推导而来，可证明该步长内动面没有任何点能进入容差层，因此不
 * 依赖采样密度，再窄的穿越也不会被跳过；计算量与行程长度近似线性，
 * 大幅拖动依然保持响应。结果只依赖几何与容差，与帧率、拖动速度无关。
 */
export function contactAt(
  paper: Paper,
  angles: Record<string, number>,
  creaseId: string,
  target: number,
  tol: number = contactTolerance(paper),
): ContactStop | null {
  if (!paper.creases.some((c) => c.id === creaseId)) return null;
  const cur = angles[creaseId] ?? 0;
  if (Math.abs(target - cur) <= 1e-9) return null;

  const topo = buildTopology(paper);
  const subtree = creaseSubtree(paper, creaseId);
  const pairs = movingPairs(paper, topo, subtree);
  if (!pairs.length) return null;

  const poseAt = (theta: number) =>
    solvePose(paper, { ...angles, [creaseId]: theta });
  const hit = (pose: PoseFace[]) => scanPairs(paper, pose, pairs, topo, tol);

  const startReport = hit(poseAt(cur));
  const direction = Math.sign(target - cur);
  let theta = cur;
  if (startReport.contacts.length) {
    // 起始已在容差层内：探测运动方向上的一个小步。
    const probe = cur + direction * 0.5;
    if (hit(poseAt(probe)).contacts.length) {
      // 继续深入接触 → 停在当前角度。
      return { angle: cur, report: startReport };
    }
    // 向安全侧退回：先小步离开容差层，再进入常规推进。
    // 退回不产生停止角，路径不影响最终结果，故这里的小步无需精确。
    let guard = 0;
    while (hit(poseAt(theta)).contacts.length && guard++ < CA_MAX_ITER) {
      theta += direction * 0.25;
      if (direction > 0 ? theta >= target : theta <= target) {
        const atTarget = hit(poseAt(target));
        return atTarget.contacts.length
          ? { angle: cur, report: atTarget }
          : null;
      }
    }
  }

  // 每个子树顶点相对当前姿态折轴的旋转半径（轴上顶点半径为 0）。
  const crease = paper.creases.find((c) => c.id === creaseId)!;
  const base = paper.faces.find((f) => f.id === crease.face)!;
  const startPose = poseAt(cur);
  const startById = poseMap(startPose);
  const [axisA, axisB] = base.hinge!.map((h) => {
    const idx = base.points.findIndex((p) => samePoint(p, h));
    return startById.get(crease.face)!.points[idx]!;
  });
  const axis = sub(axisB!, axisA!);
  const axisLen2 = dot(axis, axis) || PLANE_EPS;
  const vertexRadius = (p: Vec3) => {
    const w = sub(p, axisA!);
    const proj = scale(axis, dot(w, axis) / axisLen2);
    return dist(w, proj);
  };
  // 每个子树纸面各顶点的旋转半径，按“纸面 id + 顶点序号”索引，
  // 不能用坐标字符串做键：转动会引入浮点漂移导致查找失败。
  const radiusByFace = new Map<string, number[]>();
  for (const faceId of subtree) {
    const f = startById.get(faceId)!;
    radiusByFace.set(faceId, f.points.map(vertexRadius));
  }

  // 每个动面的全局最大旋转半径：保守推进必须用整体最大速度上界，
  // 不能用当前最近点的速度——最近特征会沿边滑动，其半径可能趋近 0
  // （折轴顶点），用它会算出过大的安全步长而跳过真正的穿越。
  const maxRadiusByFace = new Map<string, number>();
  for (const [faceId, radii] of radiusByFace) {
    maxRadiusByFace.set(faceId, Math.max(...radii));
  }

  /*
   * 保守推进（Conservative Advancement）连续碰撞检测：
   * 每一步计算当前姿态下动/静纸面的精确最短间隙 d，以及该动面任意
   * 点的旋转速度上界 v（取该面最大旋转半径，每弧度位移 ≤ v）。
   * 安全角步长取 (d − tol) / v：可证明该步长内动面没有任何点能进入
   * 容差层，因此再窄、再短暂的穿越都不会被跳过。逐段推进直到接触
   * 或越过目标，计算量与行程长度近似线性，大幅拖动依然保持响应。
   */
  let lastSafe = theta;
  for (let iter = 0; iter < CA_MAX_ITER; iter++) {
    const pose = poseAt(theta);
    const report = hit(pose);
    if (report.contacts.length) {
      // 在 [lastSafe, theta] 内二分夹逼，得到与推进路径无关的精确接触角。
      let lo = lastSafe;
      let hi = theta;
      for (let k = 0; k < CA_BISECTION_STEPS; k++) {
        const mid = (lo + hi) / 2;
        if (hit(poseAt(mid)).contacts.length) hi = mid;
        else lo = mid;
      }
      const contactReport = hit(poseAt(hi));
      return { angle: Math.round(hi * 100) / 100, report: contactReport };
    }
    lastSafe = theta;
    const byId = poseMap(pose);
    // 所有受检纸面对中最保守的安全步长（取最小值）。
    let safeStepRad = Infinity;
    for (const [movingId, staticId] of pairs) {
      const distance = facePairDistance(
        byId.get(movingId)!,
        byId.get(staticId)!,
      );
      const vMax = maxRadiusByFace.get(movingId) ?? 0;
      const clearance = distance - tol;
      if (vMax <= PLANE_EPS) continue; // 该面不随折痕运动。
      if (clearance <= 0) continue;
      safeStepRad = Math.min(safeStepRad, clearance / vMax);
    }
    const remaining = Math.abs(target - theta);
    if (!Number.isFinite(safeStepRad)) {
      // 所有相关纸面都不随该折痕运动（速度上界为 0），不可能新接触。
      return null;
    }
    let stepDeg = (safeStepRad * 180) / Math.PI;
    // 留 10% 余量并设最小步长，避免贴靠时的 Zeno 收敛。
    stepDeg = Math.max(stepDeg * 0.9, CA_MIN_STEP_DEG);
    if (stepDeg >= remaining) {
      // 剩余行程被证明全程安全：检查目标姿态后放行。
      const finalReport = hit(poseAt(target));
      if (finalReport.contacts.length) {
        return { angle: Math.round(target * 100) / 100, report: finalReport };
      }
      return null;
    }
    theta += direction * stepDeg;
  }
  // 达到迭代上限仍未判定：在当前角度做一次精确检测兜底。
  const fallback = hit(poseAt(theta));
  return fallback.contacts.length
    ? { angle: Math.round(theta * 100) / 100, report: fallback }
    : null;
}

/** 取一次接触中真正挡住运动子树的静止纸面。 */
export function blockerFaces(
  paper: Paper,
  report: CollisionReport,
  subtree: Set<string>,
): Face[] {
  const ids = new Set<string>();
  for (const [a, b] of report.pairs) {
    if (subtree.has(a) && !subtree.has(b)) ids.add(b);
    if (subtree.has(b) && !subtree.has(a)) ids.add(a);
  }
  return [...ids].map((id) => paper.faces.find((f) => f.id === id)!).filter(Boolean);
}
