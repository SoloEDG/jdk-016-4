import type { Document } from "../../../shared/types";
import { normalizeAngle } from "../lib/angle";
import { guideAngle, clearBlocking } from "../lib/guide";

/** 手动调整折痕角度：经碰撞引导后停在首次接触位置。 */
export function changeAngle(doc: Document, value: number) {
  doc.playing = false;
  const target = normalizeAngle(value);
  guideAngle(doc, doc.selected, target, null);
}
export function flatten(doc: Document) {
  doc.playing = false;
  doc.angles = {};
  doc.step = 0;
  clearBlocking(doc);
}
export function applyTarget(doc: Document) {
  const c = doc.paper.creases.find((c) => c.id === doc.selected);
  if (c) {
    doc.playing = false;
    guideAngle(doc, c.id, c.target * (doc.directions[c.id] ?? 1), null);
  }
}
