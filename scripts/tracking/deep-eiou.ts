import { overlap, type BoundingBox, type Detection } from "../core/detections";
import { linearAssignment } from "./linear-assignment";

export function normalise(feature: ArrayLike<number> | null | undefined): number[] | null {
  if (!feature) return null;
  const values = Array.from(feature), norm = Math.hypot(...values);
  return values.every(Number.isFinite) && norm > 1e-8 ? values.map(v => v / norm) : null;
}
export function cosine(a: readonly number[], b: readonly number[]): number { return Math.max(0, Math.min(2, 1 - a.reduce((sum, x, i) => sum + x * b[i], 0))); }
export interface RawPlayer { detection: Detection; rawTrackId: number; feature: number[] }
interface Track { id: number; box: BoundingBox; feature: number[]; frame: number; start: number; active: boolean; state: "tracked" | "lost" | "removed"; index: number }
function expanded(box: BoundingBox, amount: number): BoundingBox {
  const dx = Math.floor((2 * amount + 1) * (box[2] - box[0]) / 2), dy = Math.floor((2 * amount + 1) * (box[3] - box[1]) / 2);
  return [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy];
}
export class DeepEIoU {
  private tracked: Track[] = [];
  private lost: Track[] = [];
  private frame = 0;
  private nextId = 1;
  reset(): void { this.tracked = []; this.lost = []; this.frame = 0; this.nextId = 1; }
  update(detections: Detection[], features: number[][], dtFrames = 1): RawPlayer[] {
    if (!Number.isFinite(dtFrames) || dtFrames <= 0 || features.length !== detections.length) throw new Error("Invalid tracker input");
    this.frame += dtFrames;
    this.tracked = this.tracked.filter(t => this.frame - t.frame <= 60);
    this.lost = this.lost.filter(t => this.frame - t.frame <= 60);
    const make = (d: Detection, i: number): Track => ({ id: 0, box: [...d.box], feature: normalise(features[i]) ?? features[i].map(() => 0), frame: this.frame, start: this.frame, active: this.frame === 1, state: "tracked", index: i });
    let high = detections.map(make).filter(t => detections[t.index].confidence >= .30);
    const low = detections.map(make).filter(t => detections[t.index].confidence >= .15 && detections[t.index].confidence < .30);
    const unconfirmed = this.tracked.filter(t => !t.active);
    let pool = [...this.tracked.filter(t => t.active), ...this.lost];
    const activated: Track[] = [];
    const associate = (tracks: Track[], candidates: Track[], expansion: number, threshold: number, appearance: boolean) => {
      const costs = tracks.map(t => candidates.map(d => {
        const geometry = 1 - overlap(expanded(t.box, expansion), expanded(d.box, expansion), 1);
        let embedding = cosine(t.feature, d.feature) / 2;
        if (embedding > .25 || geometry > .5) embedding = 1;
        return appearance ? Math.min(geometry, embedding) : geometry;
      }));
      const result = linearAssignment(costs, threshold, candidates.length);
      for (const [i, j] of result.matches) {
        const track = tracks[i], detection = candidates[j];
        track.feature = normalise(track.feature.map((x, k) => .9 * x + .1 * detection.feature[k])) ?? detection.feature;
        track.box = [...detection.box]; track.index = detection.index; track.frame = this.frame; track.active = true; track.state = "tracked";
        activated.push(track);
      }
      return { tracks: result.unmatchedRows.map(i => tracks[i]), detections: result.unmatchedColumns.map(j => candidates[j]) };
    };
    for (const expansion of [.7, .8]) {
      const rest = associate(pool, high, expansion, .8, true);
      pool = rest.tracks.filter(t => t.state === "tracked"); high = rest.detections;
    }
    const remaining = associate(pool, low, .5, .5, false);
    for (const t of remaining.tracks) t.state = "lost";
    const pending = associate(unconfirmed, high, .5, .7, true);
    for (const t of pending.tracks) t.state = "removed";
    for (const d of pending.detections) { d.id = this.nextId++; activated.push(d); }
    const unique = (items: Track[]) => [...new Map(items.map(t => [t.id, t])).values()];
    this.tracked = unique([...this.tracked.filter(t => t.state === "tracked"), ...activated]);
    const activeIds = new Set(this.tracked.map(t => t.id));
    this.lost = unique([...this.lost, ...remaining.tracks]).filter(t => !activeIds.has(t.id) && t.state !== "removed");
    const dropTracked = new Set<number>(), dropLost = new Set<number>();
    for (const a of this.tracked) for (const b of this.lost) if (1 - overlap(a.box, b.box, 1) < .15) {
      if (a.frame - a.start > b.frame - b.start) dropLost.add(b.id); else dropTracked.add(a.id);
    }
    this.tracked = this.tracked.filter(t => !dropTracked.has(t.id)); this.lost = this.lost.filter(t => !dropLost.has(t.id));
    return this.tracked.filter(t => t.frame === this.frame).map(t => ({ detection: detections[t.index], rawTrackId: t.id, feature: features[t.index] }));
  }
}
