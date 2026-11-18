import type { BlockingState, Document } from "../../../shared/types";
import {
  blockerFaces,
  contactAt,
  creaseSubtree,
  faceLabel,
} from "./collision";

/**
 * 折叠碰撞引导：把几何引擎的接触结果转成文档状态与用户提示。
 * 所有角度判定都在物理坐标系中完成，与画面缩放无关。
 */

function buildMessage(
  doc: Document,
  creaseId: string,
  angle: number,
  blockerIds: string[],
  stepIndex: number | null,
): string {
  const crease = doc.paper.creases.find((c) => c.id === creaseId);
  const blockers = blockerIds.map((id) => faceLabel(doc.paper, id)).join("、");
  const where = stepIndex === null ? "" : `（第 ${stepIndex + 1} 步「${doc.steps[stepIndex]?.title ?? ""}」）`;
  return `${crease?.name ?? "该折痕"}在 ${angle.toFixed(0)}° 处被纸面「${blockers}」挡住，已停在首次接触位置${where}。`;
}

/**
 * 尝试把 creaseId 转到 target。
 * - 全程无接触：写入目标角度并清空阻挡状态；
 * - 发生接触：停在可复现的首次接触角，记录阻挡纸面与说明。
 * 返回是否被阻挡。
 */
export function guideAngle(
  doc: Document,
  creaseId: string,
  target: number,
  stepIndex: number | null = null,
): boolean {
  const stop = contactAt(doc.paper, doc.angles, creaseId, target);
  if (!stop) {
    doc.angles[creaseId] = target;
    doc.blocking = null;
    return false;
  }
  doc.angles[creaseId] = stop.angle;
  const subtree = creaseSubtree(doc.paper, creaseId);
  const blockers = blockerFaces(doc.paper, stop.report, subtree).map((f) => f.id);
  const state: BlockingState = {
    creaseId,
    angle: stop.angle,
    faces: blockers,
    pairs: stop.report.pairs,
    points: stop.report.contacts.map((c) => c.point),
    message: buildMessage(doc, creaseId, stop.angle, blockers, stepIndex),
    stepIndex,
  };
  doc.blocking = state;
  return true;
}

/** 切换折痕、换纸或重置时清空阻挡标注。 */
export function clearBlocking(doc: Document) {
  doc.blocking = null;
}
