import { onUnmounted } from "vue";
import type { Document } from "../../../shared/types";
import { interpolate } from "../lib/steps";
import {
  blockerFaces,
  contactAt,
  creaseSubtree,
  faceLabel,
  type CollisionReport,
} from "../../fold/lib/collision";

/**
 * 自动播放：每个动画帧都先做碰撞预检，遇到首次接触就停在
 * 可复现的接触角（由几何二分确定，与帧率/速度无关），并记录
 * 受阻步骤。用户手动退回后可再次播放继续。
 */
export function usePlayer(doc: Document) {
  let frame = 0,
    last = 0,
    elapsed = 0,
    start: Record<string, number> = {},
    target = 0;

  function blockAt(
    stepIndex: number,
    creaseId: string,
    angle: number,
    report: CollisionReport,
  ) {
    const subtree = creaseSubtree(doc.paper, creaseId);
    const faces = blockerFaces(doc.paper, report, subtree).map((f) => f.id);
    const crease = doc.paper.creases.find((c) => c.id === creaseId);
    const blockers = faces.map((id) => faceLabel(doc.paper, id)).join("、");
    doc.playing = false;
    last = 0;
    doc.angles[creaseId] = angle;
    doc.blocking = {
      creaseId,
      angle,
      faces,
      pairs: report.pairs,
      points: report.contacts.map((c) => c.point),
      message: `第 ${stepIndex + 1} 步「${doc.steps[stepIndex]?.title ?? crease?.name ?? ""}」在 ${angle.toFixed(0)}° 处被纸面「${blockers}」挡住，已暂停。退回后可继续播放。`,
      stepIndex,
    };
  }

  function tick(now: number) {
    if (!doc.playing) {
      last = 0;
      return;
    }
    if (!last) {
      last = now;
      start = { ...doc.angles };
      target = (doc.step + 1) % doc.steps.length;
      elapsed = 0;
    }
    elapsed += (now - last) * doc.speed;
    last = now;
    const step = doc.steps[target]!;
    const t = Math.min(1, elapsed / step.duration);
    const candidate = interpolate(start, step.angles, t);

    // 逐折痕预检：只检查本步实际发生变化的折痕，任一受阻即停下。
    for (const crease of doc.paper.creases) {
      const wanted = candidate[crease.id] ?? 0;
      const current = doc.angles[crease.id] ?? 0;
      if (Math.abs(wanted - current) <= 1e-9) continue;
      const stop = contactAt(doc.paper, doc.angles, crease.id, wanted);
      if (stop) {
        blockAt(target, crease.id, stop.angle, stop.report);
        return;
      }
    }
    doc.angles = candidate;
    doc.blocking = null;

    if (elapsed >= step.duration) {
      doc.step = target;
      const c = doc.paper.creases[target - 1];
      if (c) doc.selected = c.id;
      if (target === doc.steps.length - 1) {
        doc.playing = false;
        last = 0;
        return;
      }
      start = { ...doc.angles };
      target++;
      elapsed = 0;
    }
    frame = requestAnimationFrame(tick);
  }
  function toggle() {
    doc.playing = !doc.playing;
    cancelAnimationFrame(frame);
    last = 0;
    if (doc.playing) frame = requestAnimationFrame(tick);
  }
  onUnmounted(() => cancelAnimationFrame(frame));
  return { toggle };
}
