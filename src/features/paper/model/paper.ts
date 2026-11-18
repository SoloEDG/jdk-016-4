import type { Document, Paper } from "../../../shared/types";
import { clearBlocking } from "../../fold/lib/guide";
export function replacePaper(doc: Document, paper: Paper) {
  doc.paper = paper;
  doc.angles = {};
  doc.selected = paper.creases[0]?.id ?? "";
  doc.directions = Object.fromEntries(paper.creases.map((c) => [c.id, 1]));
  doc.playing = false;
  doc.step = 0;
  clearBlocking(doc);
}
export function setMaterial(doc: Document, front: string, back: string) {
  doc.front = front;
  doc.back = back;
}
