import type { Document } from "../../../shared/types";
import { clamp } from "../../../shared/document";
import { clearBlocking } from "../../fold/lib/guide";

export function seek(doc: Document, index: number) {
  doc.playing = false;
  doc.step = clamp(index, 0, doc.steps.length - 1);
  doc.angles = { ...doc.steps[doc.step]!.angles };
  const c = doc.paper.creases[doc.step - 1];
  if (c) doc.selected = c.id;
  // 跳转（含手动退回）后清掉上一次的阻挡标注，用户可重新播放继续。
  clearBlocking(doc);
}
export function captureStep(doc: Document) {
  const step = doc.steps[doc.step];
  if (step) {
    step.angles = { ...doc.angles };
    step.note = "已保存当前折叠形态，可随时还原。";
  }
}
