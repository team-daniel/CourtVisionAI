import { CLASS_NAMES, overlap, type ClassId, type Detection } from "../core/detections";
export interface Letterbox { width: number; height: number; scale: number; left: number; top: number }
export function decodeYolo(data: Float32Array, dims: number[], transform: Letterbox, classes: ClassId[], confidence: number): Detection[] {
  const shape = dims.length === 3 && dims[0] === 1 ? dims.slice(1) : dims;
  if (shape.length !== 2) throw new Error(`Unsupported YOLO output [${dims}]. Expected [1,N,6] or [1,7,N].`);
  const endToEnd = shape[1] === 6 || shape[0] === 6;
  const channelsFirst = endToEnd ? shape[1] !== 6 : shape[0] === 7;
  if (!endToEnd && shape[0] !== 7 && shape[1] !== 7) throw new Error(`YOLO output [${dims}] does not match three classes: Ball, Player, Basket.`);
  const rows = channelsFirst ? shape[1] : shape[0], columns = channelsFirst ? shape[0] : shape[1];
  if (data.length !== rows * columns) throw new Error("Invalid YOLO output length");
  const at = (row: number, column: number) => data[channelsFirst ? column * rows + row : row * columns + column];
  const detections: Detection[] = [];
  for (let i = 0; i < rows; i++) {
    let cls: number, score: number, x1: number, y1: number, x2: number, y2: number;
    if (endToEnd) { cls = at(i, 5); score = at(i, 4); x1 = at(i, 0); y1 = at(i, 1); x2 = at(i, 2); y2 = at(i, 3); }
    else {
      const scores = [at(i, 4), at(i, 5), at(i, 6)]; score = Math.max(...scores); cls = scores.indexOf(score);
      x1 = at(i, 0) - at(i, 2) / 2; y1 = at(i, 1) - at(i, 3) / 2; x2 = at(i, 0) + at(i, 2) / 2; y2 = at(i, 1) + at(i, 3) / 2;
    }
    if (!Number.isFinite(score) || score < confidence) continue;
    if (!Number.isInteger(cls) || cls < 0 || cls > 2) throw new Error("The detector uses an incompatible class map. Expected 0=Ball, 1=Player, 2=Basket.");
    if (!classes.includes(cls as ClassId) || ![x1, y1, x2, y2].every(Number.isFinite)) continue;
    const { scale, left, top, width, height } = transform;
    const box: Detection["box"] = [Math.max(0, Math.min(width, (x1 - left) / scale)), Math.max(0, Math.min(height, (y1 - top) / scale)), Math.max(0, Math.min(width, (x2 - left) / scale)), Math.max(0, Math.min(height, (y2 - top) / scale))];
    if (box[2] <= box[0] || box[3] <= box[1]) continue;
    detections.push({ classId: cls as ClassId, className: CLASS_NAMES[cls as ClassId], confidence: score, box, trackId: null, state: "observed", source: "detector" });
  }
  const kept: Detection[] = [];
  for (const d of detections.sort((a, b) => b.confidence - a.confidence)) {
    if (!endToEnd && kept.some(k => k.classId === d.classId && overlap(k.box, d.box) > .45)) continue;
    kept.push(d); if (kept.length >= 80) break;
  }
  return kept;
}
