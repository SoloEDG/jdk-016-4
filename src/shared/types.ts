export type Vec3 = [number, number, number];
export interface Face {
  id: string;
  points: Vec3[];
  parent?: string;
  hinge?: [Vec3, Vec3];
  crease?: string;
}
export interface Crease {
  id: string;
  name: string;
  description: string;
  face: string;
  target: number;
}
export interface Paper {
  id: string;
  name: string;
  subtitle: string;
  size: number;
  faces: Face[];
  creases: Crease[];
}
export interface Step {
  id: string;
  title: string;
  note: string;
  angles: Record<string, number>;
  duration: number;
}
export interface View {
  yaw: number;
  pitch: number;
  zoom: number;
  grid: boolean;
  wire: boolean;
}
export interface BlockingState {
  /** 当前阻挡所针对的折痕。 */
  creaseId: string;
  /** 首次接触处的可复现角度。 */
  angle: number;
  /** 造成阻挡的静止纸面 id（用于画面与折痕列表高亮）。 */
  faces: string[];
  /** 接触纸面对（与 faces 同源，便于列表与提示复用）。 */
  pairs: [string, string][];
  /** 接触点的世界坐标（用于画面精确标记）。 */
  points: Vec3[];
  /** 面向用户的阻挡说明。 */
  message: string;
  /** 自动播放受阻时，对应的是第几步（手动拖动时为 null）。 */
  stepIndex: number | null;
}
export interface Document {
  paper: Paper;
  front: string;
  back: string;
  texture: string;
  selected: string;
  angles: Record<string, number>;
  directions: Record<string, number>;
  steps: Step[];
  step: number;
  playing: boolean;
  speed: number;
  view: View;
  /** 最近一次碰撞引导状态；无阻挡时为 null。 */
  blocking: BlockingState | null;
}
export interface PoseFace {
  id: string;
  points: Vec3[];
  normal: Vec3;
}
