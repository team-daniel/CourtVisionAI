import { overlap, center, distance, type BoundingBox, type StableDetection } from "../core/detections";
import { cosine, normalise, type RawPlayer } from "./deep-eiou";
import { linearAssignment } from "./linear-assignment";

interface Participant { id: number; box: BoundingBox; lastSeen: number; sourceId: number; gallery: number[][]; lastGalleryUpdate: number }
interface Pending { target: number | null; segment: number; firstSeen: number; lastSeen: number; features: number[][] }
interface Continuity { box: BoundingBox; lastSeen: number; feature: number[] | null; trustedAt: number; stableHits: number }
export class ParticipantAssigner {
  readonly participants = new Map<number, Participant>();
  readonly confirmedSegments = new Map<number, number>();
  private bindings = new Map<number, number>();
  private pending = new Map<number, Pending>();
  private segments = new Map<number, number>();
  private continuity = new Map<number, Continuity>();
  private unresolvedSince = new Map<number, number>();
  private nextId = 1;
  private nextSegment = 1;
  reset(): void {
    this.participants.clear(); this.confirmedSegments.clear(); this.bindings.clear(); this.pending.clear(); this.segments.clear(); this.continuity.clear(); this.unresolvedSince.clear(); this.nextId = this.nextSegment = 1;
  }
  private continuous(raw: number, box: BoundingBox, now: number): boolean {
    const state = this.continuity.get(raw);
    if (!state || now - state.lastSeen < 0 || now - state.lastSeen > .5) return false;
    const w = Math.max(state.box[2] - state.box[0], 1), h = Math.max(state.box[3] - state.box[1], 1);
    const rw = (box[2] - box[0]) / w, rh = (box[3] - box[1]) / h;
    return rw > .5 && rw < 2 && rh > .5 && rh < 2 && (overlap(state.box, box) >= .2 || distance(center(box), center(state.box)) <= .5 * h);
  }
  private evidence(raw: number, target: number | null, feature: number[], now: number): Pending {
    let pending = this.pending.get(raw);
    if (!pending || pending.target !== target || now - pending.lastSeen > .5) {
      let segment = this.segments.get(raw)!;
      if (this.confirmedSegments.has(segment) || (pending && pending.target !== target) || (!pending && now - (this.unresolvedSince.get(raw) ?? now) > .5)) {
        segment = this.nextSegment++; this.segments.set(raw, segment);
      }
      pending = { target, segment, firstSeen: now, lastSeen: now, features: [] };
    }
    if (pending.features.length) {
      const mean = normalise(feature.map((_, k) => pending!.features.reduce((sum, f) => sum + f[k], 0) / pending!.features.length));
      if (!mean || cosine(mean, feature) > .35) {
        pending.features = []; pending.firstSeen = now; pending.segment = this.nextSegment++; this.segments.set(raw, pending.segment);
      }
    }
    pending.lastSeen = now; pending.features.push([...feature]); pending.features = pending.features.slice(-3); this.pending.set(raw, pending);
    return pending;
  }
  update(observations: RawPlayer[], now: number, width: number, height: number): StableDetection[] {
    const ids = [...this.participants.keys()], features = observations.map(d => normalise(d.feature));
    const reliable = observations.map(({ detection: d }, i) => features[i] !== null && d.confidence >= .3 && d.box[2] - d.box[0] >= 12 && d.box[3] - d.box[1] >= 24 && !observations.some((o, j) => j !== i && overlap(d.box, o.detection.box) > .2));
    const learnable = observations.map(({ detection: d }, i) => {
      const edge = Math.max(2, Math.min(width, height) * .005), b = d.box, ratio = (b[3] - b[1]) / Math.max(b[2] - b[0], 1);
      return reliable[i] && b[0] > edge && b[1] > edge && b[2] < width - edge && b[3] < height - edge && ratio >= .8 && ratio <= 5;
    });
    const appearance = features.map(f => ids.map(id => {
      const gallery = this.participants.get(id)!.gallery;
      if (!f || !gallery.length) return 2;
      const distances = gallery.map(v => cosine(v, f)).sort((a, b) => a - b).slice(0, 3);
      return distances.reduce((a, b) => a + b, 0) / distances.length;
    }));
    const continuous = observations.map(d => this.continuous(d.rawTrackId, d.detection.box, now));
    const proposals = new Map<number, number>();
    for (let i = 0; i < observations.length; i++) if (reliable[i] && ids.length) {
      const best = Math.min(...appearance[i]), j = appearance[i].indexOf(best);
      const other = appearance[i].filter((_, k) => k !== j), gap = other.length ? Math.min(...other) - best : 2;
      if (best <= .30 && gap >= .05) proposals.set(i, ids[j]);
    }
    const costs = appearance.map(row => row.map(() => Infinity));
    const retained = new Map<number, { pid: number; trusted: boolean; adaptive: boolean }>();
    for (let i = 0; i < observations.length; i++) {
      const { rawTrackId: raw, detection: d } = observations[i], previous = this.bindings.get(raw), state = this.continuity.get(raw);
      if (!this.segments.has(raw) || !continuous[i]) { this.segments.set(raw, this.nextSegment++); this.pending.delete(raw); }
      else if (this.pending.has(raw) && now - this.pending.get(raw)!.lastSeen > .5) this.pending.delete(raw);
      if (previous === undefined || !continuous[i] || this.participants.get(previous)!.sourceId !== raw || !state) continue;
      const j = ids.indexOf(previous), contrary = proposals.has(i) && proposals.get(i) !== previous;
      const stepOk = reliable[i] && state.feature !== null && cosine(state.feature, features[i]!) <= .20;
      const competing = observations.some((o, k) => k !== i && overlap(d.box, o.detection.box) > .2);
      const alternatives = appearance[i].filter((_, k) => k !== j), bestOther = Math.min(...alternatives);
      const distinctive = !alternatives.length || bestOther > .30 || bestOther - appearance[i][j] >= .05;
      const adaptive = learnable[i] && stepOk && !competing && !contrary && distinctive;
      const trusted = proposals.get(i) === previous || adaptive;
      if (!contrary && (trusted || now - state.trustedAt <= .5)) { retained.set(i, { pid: previous, trusted, adaptive }); costs[i][j] = -.1; }
    }
    for (const [i, pid] of proposals) if (!retained.has(i)) costs[i][ids.indexOf(pid)] = appearance[i][ids.indexOf(pid)];
    const selected = new Map(linearAssignment(costs, .4, ids.length).matches.map(([i, j]) => [i, ids[j]]));
    const claimed = new Set<number>(), output: StableDetection[] = [];
    for (let i = 0; i < observations.length; i++) {
      const { rawTrackId: raw, detection: d } = observations[i], feature = features[i], previous = this.bindings.get(raw);
      let state = this.continuity.get(raw), target = selected.get(i), pid: number | null = null, trusted = false;
      if (target !== undefined && !retained.has(i)) {
        const j = ids.indexOf(target);
        if ([...proposals].some(([k, rival]) => k !== i && rival === target && !retained.has(k) && appearance[k][j] - appearance[i][j] < .05)) target = undefined;
      }
      if (target !== undefined && !claimed.has(target)) {
        const retainedValue = retained.get(i);
        if (retainedValue) { pid = retainedValue.pid; trusted = retainedValue.trusted; this.pending.delete(raw); }
        else {
          const pending = this.evidence(raw, target, feature!, now);
          if (pending.features.length >= 3) { pid = target; trusted = true; }
        }
      } else if (previous === undefined && learnable[i]) {
        const occupied = new Set([...retained].filter(([k, v]) => k !== i && selected.get(k) === v.pid).map(([, v]) => v.pid));
        const available = ids.map((pid, j) => ({ pid, j })).filter(v => !occupied.has(v.pid));
        const distinct = !available.length || Math.min(...available.map(v => appearance[i][v.j])) > .42;
        const separate = !observations.some((o, k) => k !== i && overlap(d.box, o.detection.box) > .2);
        if (distinct && separate) {
          const pending = this.evidence(raw, null, feature!, now);
          if (pending.features.length >= 3) {
            pid = this.nextId++; trusted = true;
            this.participants.set(pid, { id: pid, box: [...d.box], lastSeen: now, sourceId: raw, gallery: pending.features.map(f => [...f]), lastGalleryUpdate: now });
          }
        }
      }
      let segment = this.segments.get(raw)!;
      if (pid !== null) {
        claimed.add(pid); this.unresolvedSince.delete(raw);
        const participant = this.participants.get(pid)!;
        participant.box = [...d.box]; participant.lastSeen = now; participant.sourceId = raw;
        this.bindings.set(raw, pid); this.confirmedSegments.set(segment, pid); this.pending.delete(raw);
        const stable = state && continuous[i] && previous === pid ? state.stableHits + 1 : 1;
        if (trusted && learnable[i] && stable >= 3 && (!retained.has(i) || retained.get(i)!.adaptive) && feature && now - participant.lastGalleryUpdate >= .2 && !participant.gallery.some(v => cosine(v, feature) < .015)) {
          participant.gallery.push([...feature]); participant.gallery = participant.gallery.slice(-30); participant.lastGalleryUpdate = now;
        }
        if (trusted && reliable[i]) state = { box: [...d.box], lastSeen: now, feature: [...feature!], trustedAt: now, stableHits: stable };
        else if (state) state = { ...state, box: [...d.box], lastSeen: now, stableHits: 0 };
      } else {
        if (!this.unresolvedSince.has(raw)) this.unresolvedSince.set(raw, now);
        if (this.confirmedSegments.has(segment)) { segment = this.nextSegment++; this.segments.set(raw, segment); }
        state = !state || !continuous[i] ? { box: [...d.box], lastSeen: now, feature: null, trustedAt: -1, stableHits: 0 } : { ...state, box: [...d.box], lastSeen: now, stableHits: 0 };
      }
      this.continuity.set(raw, state!);
      output.push({ ...d, trackId: pid ?? -raw, rawTrackId: raw, participantId: pid, identitySegment: segment, identityState: pid !== null ? "confirmed" : previous !== undefined ? "uncertain" : "pending", state: d.confidence >= .3 ? "observed" : "low_confidence", source: "deep-eiou" });
    }
    for (const [raw, pending] of this.pending) if (now - pending.lastSeen > .5) this.pending.delete(raw);
    return output;
  }
  backfill(detections: StableDetection[]): StableDetection[] {
    const claimed = new Set(detections.map(d => d.participantId).filter(id => id != null));
    return detections.map(d => {
      const pid = d.identitySegment == null ? undefined : this.confirmedSegments.get(d.identitySegment);
      if (d.classId !== 1 || d.participantId != null || pid === undefined || claimed.has(pid)) return d;
      claimed.add(pid);
      return { ...d, trackId: pid, participantId: pid, identityState: "backfilled" };
    });
  }
}
