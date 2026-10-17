import {
  CLASS_GROUPS,
  getFrameDimensions,
  type BoundingBox,
  type FrameSource,
  type Point,
  type StableDetection,
} from "../core/detections";
import { boxCenter, boxIou, pointDistance } from "../core/geometry";

type Observation = { detection: StableDetection; appearance: Float32Array };
type Participant = {
  id: -2 | -1;
  sourceId: number;
  box: BoundingBox;
  velocity: Point;
  appearance: Float32Array;
  lastSeen: number;
};
type Candidate = { hits: number; lastSeen: number; centre: Point; travel: number };

export interface ParticipantReconnection {
  sourceId: number;
  participantId: -2 | -1;
  fromFrame: number;
  toFrame: number;
}

type PendingMatch = { sourceId: number; hits: number; firstFrame: number; lastFrame: number };
type MatchResult = { indices: [number, number]; margins: [number, number]; costs: [number, number] };

export class ParticipantIdentityTracker {
  private frame = 0;
  private fps = 30;
  private participants: Participant[] = [];
  private candidates = new Map<number, Candidate>();
  private contactFrames = 0;
  private pending = new Map<number, PendingMatch>();
  private reconnections: ParticipantReconnection[] = [];
  private unconfirmedSources = new Map<number, { firstFrame: number; lastFrame: number }>();
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;

  constructor() {
    this.canvas.width = 32;
    this.canvas.height = 64;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create participant appearance canvas.");
    this.context = context;
  }

  configureTiming(fps: number): void {
    this.fps = Math.max(1, fps);
  }

  reset(): void {
    this.frame = 0;
    this.participants = [];
    this.candidates.clear();
    this.pending.clear();
    this.reconnections = [];
    this.unconfirmedSources.clear();
    this.contactFrames = 0;
  }

  takeReconnections(): ParticipantReconnection[] {
    return this.reconnections.splice(0);
  }

  update(source: FrameSource, detections: readonly StableDetection[]): StableDetection[] {
    this.frame += 1;
    const { height } = getFrameDimensions(source);
    const other = detections.filter((d) => CLASS_GROUPS[d.classId] !== "player");
    const players: Observation[] = detections
      .filter((d) => CLASS_GROUPS[d.classId] === "player")
      .map((detection) => ({ detection, appearance: this.describe(source, detection.box) }));

    if (!this.participants.length) this.acquire(players, height);
    if (!this.participants.length) return [...other, ...players.map((p) => ({
      ...p.detection, className: "Player (unconfirmed)",
    }))];

    const close = players.some((a, i) => players.some((b, j) =>
      i < j && boxIou(a.detection.box, b.detection.box) > 0.08,
    ));
    this.contactFrames = close
      ? Math.max(2, Math.ceil(this.fps * 0.12))
      : Math.max(0, this.contactFrames - 1);

    const { indices, margins, costs } = this.match(players);
    const output = [...other];
    const shown = new Set<number>();

    for (let i = 0; i < 2; i += 1) {
      const index = indices[i];
      if (index < 0) {
        this.pending.delete(i);
        continue;
      }

      const participant = this.participants[i];
      const { detection, appearance } = players[index];
      const changed = detection.trackId !== participant.sourceId;
      const appearanceCost = appearanceDistance(participant.appearance, appearance);
      const overlap = players.some((p, j) =>
        j !== index && boxIou(p.detection.box, detection.box) > 0.08,
      );

      let firstUnconfirmedFrame = this.frame;
      if (changed) {
        const previous = this.pending.get(i);
        const contiguous = previous?.sourceId === detection.trackId
          && previous.lastFrame === this.frame - 1;
        const pending: PendingMatch = {
          sourceId: detection.trackId,
          hits: contiguous ? previous.hits + 1 : 1,
          firstFrame: contiguous ? previous.firstFrame : this.frame,
          lastFrame: this.frame,
        };
        this.pending.set(i, pending);

        const decisive = costs[i] < 0.28 && margins[i] > 0.14
          && appearanceCost < 0.28 && !overlap;
        const consistent = !overlap && pending.hits >= 2
          && margins[i] > 0.045 && appearanceCost < 0.45;
        if (!decisive && !consistent) continue;
        firstUnconfirmedFrame = pending.firstFrame;
      }
      this.pending.delete(i);

      const unresolved = this.unconfirmedSources.get(detection.trackId);
      if (changed || unresolved) {
        this.reconnections.push({
          sourceId: detection.trackId,
          participantId: participant.id,
          fromFrame: Math.min(firstUnconfirmedFrame, unresolved?.firstFrame ?? this.frame) - 1,
          toFrame: this.frame - 1,
        });
      }
      this.unconfirmedSources.delete(detection.trackId);

      const age = Math.max(this.frame - participant.lastSeen, 1);
      const old = boxCenter(participant.box);
      const current = boxCenter(detection.box);
      participant.velocity = [
        participant.velocity[0] * 0.65 + (current[0] - old[0]) / age * 0.35,
        participant.velocity[1] * 0.65 + (current[1] - old[1]) / age * 0.35,
      ];
      const clear = !overlap && this.contactFrames === 0;
      if (clear && appearanceCost < 0.35) {
        for (let j = 0; j < appearance.length; j += 1) {
          participant.appearance[j] = participant.appearance[j] * 0.95 + appearance[j] * 0.05;
        }
      }
      participant.box = [...detection.box];
      participant.sourceId = detection.trackId;
      participant.lastSeen = this.frame;
      shown.add(index);
      output.push({ ...detection, trackId: participant.id, box: [...detection.box] });
    }

    for (let i = 0; i < players.length; i += 1) {
      if (shown.has(i)) continue;
      const detection = players[i].detection;
      const nearby = this.participants.some((participant) =>
        pointDistance(boxCenter(detection.box), boxCenter(participant.box))
        < Math.max(participant.box[3] - participant.box[1], 1) * 1.2,
      );
      if (nearby) {
        const previous = this.unconfirmedSources.get(detection.trackId);
        this.unconfirmedSources.set(detection.trackId, {
          firstFrame: previous && previous.lastFrame >= this.frame - 2
            ? previous.firstFrame : this.frame,
          lastFrame: this.frame,
        });
        output.push({ ...detection, className: "Player (unconfirmed)" });
      }
    }

    for (const [id, pending] of this.unconfirmedSources) {
      if (this.frame - pending.lastFrame > this.fps * 3) this.unconfirmedSources.delete(id);
    }
    return output;
  }

  private acquire(players: readonly Observation[], frameHeight: number): void {
    for (const { detection } of players) {
      const centre = boxCenter(detection.box);
      const old = this.candidates.get(detection.trackId);
      this.candidates.set(detection.trackId, {
        hits: old?.lastSeen === this.frame - 1 ? old.hits + 1 : 1,
        lastSeen: this.frame,
        centre,
        travel: (old?.travel ?? 0) + (old ? pointDistance(centre, old.centre) : 0),
      });
    }
    for (const [id, candidate] of this.candidates) {
      if (this.frame - candidate.lastSeen > this.fps) this.candidates.delete(id);
    }

    const ready = players.filter(({ detection }) => {
      const height = detection.box[3] - detection.box[1];
      const candidate = this.candidates.get(detection.trackId);
      return height >= frameHeight * 0.10
        && !!candidate
        && candidate.hits >= Math.max(3, Math.round(this.fps * 0.3));
    });
    const pairs: Array<{ first: Observation; second: Observation; score: number }> = [];
    for (let i = 0; i < ready.length; i += 1) {
      for (let j = i + 1; j < ready.length; j += 1) {
        const first = ready[i];
        const second = ready[j];
        if (looksLikeSamePlayer(first.detection.box, second.detection.box)) continue;
        const a = this.candidates.get(first.detection.trackId)!;
        const b = this.candidates.get(second.detection.trackId)!;
        const size = first.detection.box[3] - first.detection.box[1]
          + second.detection.box[3] - second.detection.box[1];
        pairs.push({ first, second, score: size / frameHeight + 0.1 * (a.travel + b.travel) / frameHeight });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    const selected = pairs[0];
    if (!selected) return;
    const ordered = [selected.first, selected.second].sort(
      (a, b) => boxCenter(a.detection.box)[0] - boxCenter(b.detection.box)[0],
    );
    this.participants = ordered.map(({ detection, appearance }, index) => ({
      id: index === 0 ? -2 : -1,
      sourceId: detection.trackId,
      box: [...detection.box],
      velocity: [0, 0],
      appearance: new Float32Array(appearance),
      lastSeen: this.frame,
    }));
    this.candidates.clear();
  }

  private match(players: readonly Observation[]): MatchResult {
    const costs = this.participants.map((p) => players.map((o) => this.cost(p, o)));
    const choices: Array<{ a: number; b: number; cost: number }> = [];

    for (let a = -1; a < players.length; a += 1) {
      for (let b = -1; b < players.length; b += 1) {
        if (a >= 0 && a === b) continue;
        if (a >= 0 && b >= 0 && looksLikeSamePlayer(players[a].detection.box, players[b].detection.box)) continue;
        const costA = a < 0 ? 0.62 : costs[0][a];
        const costB = b < 0 ? 0.62 : costs[1][b];
        if (Number.isFinite(costA) && Number.isFinite(costB)) {
          choices.push({ a, b, cost: costA + costB });
        }
      }
    }

    choices.sort((a, b) => a.cost - b.cost);
    const best = choices[0];
    if (!best) return { indices: [-1, -1], margins: [0, 0], costs: [Infinity, Infinity] };

    const indices: [number, number] = [best.a, best.b];
    const margins: [number, number] = [0, 0];
    const selectedCosts: [number, number] = [Infinity, Infinity];

    for (let i = 0; i < 2; i += 1) {
      const index = indices[i];
      if (index < 0) continue;
      const selected = costs[i][index];
      const alternatives = costs[i].filter((_, j) => j !== index);
      const alternative = Math.min(0.62, ...alternatives);
      selectedCosts[i] = selected;
      margins[i] = alternative - selected;

    }

    return { indices, margins, costs: selectedCosts };
  }

  private cost(participant: Participant, observation: Observation): number {
    const { detection, appearance } = observation;
    const age = Math.max(this.frame - participant.lastSeen, 1);
    const old = boxCenter(participant.box);
    const predicted: Point = [
      old[0] + participant.velocity[0] * Math.min(age, 8),
      old[1] + participant.velocity[1] * Math.min(age, 8),
    ];
    const height = Math.max(participant.box[3] - participant.box[1], 1);
    const currentHeight = Math.max(detection.box[3] - detection.box[1], 1);
    const motion = pointDistance(predicted, boxCenter(detection.box)) / height;
    const appearanceCost = appearanceDistance(participant.appearance, appearance);
    const sameId = participant.sourceId === detection.trackId;
    const size = Math.min(Math.abs(Math.log(currentHeight / height)), 2);

    if (motion > (age > this.fps ? 4 : 2.5) || appearanceCost > 0.65) {
      return Infinity;
    }

    const trustedId = sameId && this.contactFrames === 0 && appearanceCost < 0.3;
    const cost = appearanceCost * (this.contactFrames > 0 ? 0.65 : 0.53)
      + Math.min(motion, 3) * (this.contactFrames > 0 ? 0.12 : 0.18)
      + size * 0.07 - (trustedId ? 0.08 : 0);
    return cost <= 0.65 ? cost : Infinity;
  }

  private describe(source: FrameSource, box: BoundingBox): Float32Array {
    const histogram = new Float32Array(256);
    const width = box[2] - box[0];
    const height = box[3] - box[1];
    if (width < 2 || height < 2) return histogram;

    this.context.drawImage(source, box[0], box[1], width, height, 0, 0, 32, 64);
    const pixels = this.context.getImageData(0, 0, 32, 64).data;
    const counts = [0, 0, 0, 0];

    for (let y = 0; y < 64; y += 1) {
      const region = y < 15 ? 0 : y < 35 ? 1 : y < 53 ? 2 : 3;
      for (let x = 6; x < 26; x += 1) {
        const offset = (y * 32 + x) * 4;
        const bin = (pixels[offset] >> 6) * 16
          + (pixels[offset + 1] >> 6) * 4 + (pixels[offset + 2] >> 6);
        histogram[region * 64 + bin] += 1;
        counts[region] += 1;
      }
    }

    for (let i = 0; i < histogram.length; i += 1) {
      histogram[i] /= counts[Math.floor(i / 64)] || 1;
    }
    return histogram;
  }
}

function appearanceDistance(a: Float32Array, b: Float32Array): number {
  const weights = [0.15, 0.25, 0.35, 0.25];
  let distance = 0;

  for (let region = 0; region < 4; region += 1) {
    let similarity = 0;
    for (let i = region * 64; i < (region + 1) * 64; i += 1) {
      similarity += Math.sqrt(a[i] * b[i]);
    }
    distance += weights[region] * Math.sqrt(Math.max(0, 1 - similarity));
  }

  return distance;
}

function looksLikeSamePlayer(a: BoundingBox, b: BoundingBox): boolean {
  if (boxIou(a, b) >= 0.72) return true;
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const areaA = Math.max((a[2] - a[0]) * (a[3] - a[1]), 1);
  const areaB = Math.max((b[2] - b[0]) * (b[3] - b[1]), 1);
  const [ax, ay] = boxCenter(a);
  const [bx, by] = boxCenter(b);
  return intersection / Math.min(areaA, areaB) >= 0.9
    && Math.min(areaA, areaB) / Math.max(areaA, areaB) >= 0.35
    && Math.abs(ax - bx) <= Math.max(a[2] - a[0], b[2] - b[0]) * 0.18
    && Math.abs(ay - by) <= Math.max(a[3] - a[1], b[3] - b[1]) * 0.18;
}