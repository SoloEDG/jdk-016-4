import type { Document } from "../../../shared/types";
import { guideAngle, clearBlocking } from "../../fold/lib/guide";

export function selectCrease(doc: Document, id: string) {
  if (doc.paper.creases.some((c) => c.id === id)) {
    doc.selected = id;
    doc.playing = false;
    clearBlocking(doc);
  }
}
export function toggleDirection(doc: Document) {
  doc.directions[doc.selected] = (doc.directions[doc.selected] ?? 1) * -1;
  doc.playing = false;
  // 先回到零位再按新方向重新引导，避免旧阻挡状态残留。
  const target = -(doc.angles[doc.selected] ?? 0);
  doc.angles[doc.selected] = 0;
  guideAngle(doc, doc.selected, target, null);
}
