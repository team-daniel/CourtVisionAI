import { center, distance, boxDistance, type BoundingBox, type StableDetection } from "../core/detections";
import { actorKey, eventStatistics, identityMotion, warpBox, type Actor, type BallObservation, type BasketObservation, type BasketballEvent, type CameraTransform, type EventSnapshot, type ShotEvent } from "./types";

export class BasketballFSM {
  readonly events: BasketballEvent[] = [];
  readonly identities = new Map<number, number>();
  owner: Actor | null = null;
  active: ShotEvent | null = null;
  state = "NO POSSESSION";
  private previousBasket: BasketObservation | null = null;
  private ownerBox: BoundingBox | null = null;
  private ownerSeen = -Infinity;
  private possessionCandidate: { key: string; since: number; hits: number } | null = null;
  private previousBall: { ball: BallObservation; time: number; segment: number } | null = null;
  private lastBall: { ball: BallObservation; time: number; segment: number } | null = null;
  private lastTime: number | null = null;
  private outcomeUntil = -Infinity;
  private evidenceHits = 0;
  private lastEvidence = -Infinity;
  private above = false;
  private near = false;
  private crossing: { time: number; segment: number } | null = null;
  private netHits = 0;
  private missHits = 0;
  private launch = false;
  private rise = 0;
  private flightSegment: number | null = null;
  private reboundShot: ShotEvent | null = null;

  private actor(d: StableDetection, now: number): Actor {
    const segment = d.identitySegment ?? null;
    let pid = d.participantId ?? null;
    if (pid !== null && pid > 0) { if (segment !== null) this.identities.set(segment, pid); }
    else pid = segment === null ? null : this.identities.get(segment) ?? null;
    return { participantId: pid, identitySegment: segment, rawTrackId: d.rawTrackId ?? null, timestamp: now };
  }
  resolveIdentities(mapping: ReadonlyMap<number, number>, replace = false): void {
    const entries = [...mapping];
    if (replace) this.identities.clear();
    for (const [segment, pid] of entries) this.identities.set(segment, pid);
    for (const event of this.events) {
      const segment = event.actor.identitySegment;
      if (segment !== null && (replace || this.identities.has(segment))) event.actor.participantId = this.identities.get(segment) ?? null;
    }
    if (this.owner?.identitySegment != null && this.identities.has(this.owner.identitySegment)) this.owner.participantId = this.identities.get(this.owner.identitySegment)!;
  }
  private possession(players: StableDetection[], ball: BallObservation | null, now: number): Actor | null {
    if (!ball) { this.possessionCandidate = null; return null; }
    const candidates = players.map(d => ({ actor: this.actor(d, now), box: d.box, distance: boxDistance(center(ball.box), d.box) / Math.max(d.box[3] - d.box[1], 1) })).filter(c => actorKey(c.actor) !== null).sort((a, b) => a.distance - b.distance);
    if (!candidates.length || candidates[0].distance > .25 || (candidates.length > 1 && candidates[1].distance - candidates[0].distance < .05)) { this.possessionCandidate = null; return null; }
    const { actor, box } = candidates[0], key = actorKey(actor)!;
    if (!this.possessionCandidate || this.possessionCandidate.key !== key) this.possessionCandidate = { key, since: now, hits: 1 };
    else this.possessionCandidate.hits++;
    if ((this.owner && key === actorKey(this.owner)) || (this.possessionCandidate.hits >= 2 && now - this.possessionCandidate.since + 1e-9 >= .08)) {
      this.owner = actor; this.ownerBox = [...box]; this.ownerSeen = now; return actor;
    }
    return null;
  }
  private newRelease(actor: Actor, now: number, basket: BasketObservation | null): void {
    this.active = { eventId: `shot-${String(this.events.length + 1).padStart(4, "0")}`, type: "shot", status: "candidate", actor: { ...actor }, releaseTime: now, confirmedAt: null, outcome: "pending", outcomeTime: null, evidence: [], basketId: basket?.referenceId ?? null };
    this.events.push(this.active); this.evidenceHits = 0; this.lastEvidence = -Infinity; this.above = this.near = false; this.crossing = null; this.missHits = 0; this.launch = false; this.rise = 0; this.flightSegment = null; this.state = "RELEASE CANDIDATE";
  }
  private evidence(kind: string, time: number): void {
    if (this.active && !this.active.evidence.some(e => e.kind === kind)) this.active.evidence.push({ kind, time });
  }
  private finishShot(outcome: "made" | "missed" | "unresolved", now: number, reason: string): void {
    const event = this.active;
    if (!event) return;
    if (event.status === "candidate") { event.status = "dismissed"; event.outcome = "not_confirmed"; } else event.outcome = outcome;
    event.outcomeTime = now; event.reason = reason;
    if (event.status === "confirmed") {
      this.state = outcome === "made" ? "SHOT MADE" : outcome === "missed" ? "SHOT MISSED" : "UNRESOLVED SHOT";
      this.outcomeUntil = now + .35;
      if (outcome === "missed") this.reboundShot = event;
    } else this.state = this.owner ? "POSSESSION" : "NO POSSESSION";
    this.active = null; this.crossing = null;
  }
  private trajectory(ball: BallObservation | null, basket: BasketObservation | null, now: number): void {
    if (!this.active || !ball || !basket) return;
    if (this.active.status === "candidate" && this.flightSegment !== ball.trajectorySegment) { this.flightSegment = ball.trajectorySegment; this.rise = 0; this.launch = false; this.evidenceHits = 0; }
    if (this.active.basketId !== null && this.active.basketId !== basket.referenceId) {
      this.crossing = null; this.above = this.near = false; this.missHits = this.evidenceHits = 0;
      if (this.active.status === "confirmed") { this.finishShot("unresolved", now, "basket_reference_changed"); return; }
    }
    this.active.basketId = basket.referenceId;
    const previous = this.previousBall;
    if (!previous || !ball.continuous || previous.segment !== ball.trajectorySegment || now - previous.time <= 0 || now - previous.time > .25) return;
    const box = basket.box, [x, y] = center(ball.box), [px, py] = center(previous.ball.box);
    const width = Math.max(box[2] - box[0], 1), height = Math.max(box[3] - box[1], 1), [hx, hy] = center(box), radius = Math.max((ball.box[2] - ball.box[0]) / 2, 1);
    const upward = y < py - .5, approaching = distance([x, y], [hx, hy]) < distance([px, py], [hx, hy]) - .5;
    const near = x >= box[0] - 2 * width && x <= box[2] + 2 * width && y >= box[1] - 3 * height && y <= box[3] + 2 * height, above = y <= hy || py <= hy;
    this.above ||= above; this.near ||= near;
    if (above) this.evidence("reached_hoop_height", now);
    if (near) this.evidence("near_hoop", now);
    if (upward && approaching) this.evidence("rising_toward_hoop", now);
    const ownHeight = this.ownerBox ? Math.max(this.ownerBox[3] - this.ownerBox[1], 1) : 1;
    const away = this.ownerBox !== null && boxDistance([x, y], this.ownerBox) / ownHeight > .25;
    if (upward && (approaching || near || above)) this.rise += py - y;
    if (this.rise >= Math.max(3, ownHeight * .08)) { this.launch = true; this.evidence("observed_release_flight", now); }
    const separated = away || (this.ownerBox !== null && y < this.ownerBox[1] + .2 * ownHeight);
    const fresh = this.launch && separated && ((upward && (above || near)) || (above && near && y > py + .5));
    if (this.active.status === "candidate") {
      this.evidenceHits = fresh && now - this.lastEvidence <= .25 ? this.evidenceHits + 1 : Number(fresh);
      if (fresh) this.lastEvidence = now;
      if (this.evidenceHits >= 2) { this.active.status = "confirmed"; this.active.confirmedAt = now; this.active.basketId = basket.referenceId; this.state = "SHOT ATTEMPT"; this.owner = null; this.evidence("shot_confirmed", now); }
    }
    if (this.active.status !== "confirmed") return;
    if (!basket.outcomeReliable) { this.crossing = null; this.missHits = 0; return; }
    const previousHy = this.previousBasket?.referenceId === basket.referenceId ? center(this.previousBasket.box)[1] : hy;
    const previousOffset = py - previousHy, currentOffset = y - hy;
    if (previousOffset <= 0 && currentOffset > 0 && this.near) {
      const crossingX = px + (x - px) * (-previousOffset) / (currentOffset - previousOffset);
      if (crossingX >= box[0] - radius && crossingX <= box[2] + radius) { if (!this.crossing || now - this.crossing.time > .8 || this.crossing.segment !== ball.trajectorySegment) { this.crossing = { time: now, segment: ball.trajectorySegment }; this.netHits = 0; } this.evidence("descending_rim_crossing", now); }
      else this.evidence("passed_beside_rim", now);
    }
    if (this.crossing) {
      const crossed = this.crossing;
      if (now - crossed.time > .8 || crossed.segment !== ball.trajectorySegment || y < box[1] - radius) this.crossing = null;
      else {
        if (x >= box[0] && x <= box[2] && y >= hy - radius * .25 && y <= box[3] + radius) this.netHits++;
        const aligned = x >= box[0] - radius && x <= box[2] + radius;
        const lateralExit = this.netHits >= 2 && x >= box[0] - .75 * width - radius && x <= box[2] + .75 * width + radius;
        if (now > crossed.time && y > box[3] + radius && y > py && (aligned || lateralExit)) {
          this.evidence("observed_below_rim", now); this.finishShot("made", now, aligned ? "descending_crossing_then_below" : "net_entry_then_lateral_exit"); return;
        }
      }
    }
    const beside = this.active.evidence.some(e => e.kind === "passed_beside_rim");
    const missed = beside && this.above && this.near && y > box[3] + radius && y > py && (x < box[0] - radius || x > box[2] + radius);
    this.missHits = missed ? this.missHits + 1 : 0;
    if (this.missHits >= 2) this.finishShot("missed", now, "observed_descent_beside_rim");
  }
  update(detections: StableDetection[], now: number, ball: BallObservation | null, basket: BasketObservation | null, motion: CameraTransform = identityMotion()): EventSnapshot {
    if (!Number.isFinite(now) || (this.lastTime !== null && now <= this.lastTime)) throw new Error("Event timestamps must be finite and strictly increasing");
    if (motion.valid) {
      if (this.previousBasket) this.previousBasket = { ...this.previousBasket, box: warpBox(this.previousBasket.box, motion.matrix) };
      if (this.ownerBox) this.ownerBox = warpBox(this.ownerBox, motion.matrix);
      if (this.lastBall) this.lastBall = { ...this.lastBall, ball: { ...this.lastBall.ball, box: warpBox(this.lastBall.ball.box, motion.matrix) } };
    }
    const players = detections.filter(d => d.classId === 1 && !["predicted", "interpolated"].includes(d.state ?? ""));
    for (const player of players) this.actor(player, now);
    this.resolveIdentities(this.identities);
    const actor = this.active?.actor ?? this.owner;
    if (actor) {
      const matches = players.filter(p => actorKey(this.actor(p, now)) === actorKey(actor)).sort((a, b) => b.confidence - a.confidence);
      if (matches.length) this.ownerBox = [...matches[0].box];
    }
    if (motion.sceneCut || (this.lastTime !== null && now - this.lastTime > .5)) {
      this.finishShot("unresolved", now, "scene_or_time_discontinuity"); this.owner = null; this.ownerBox = null; this.possessionCandidate = null; this.previousBall = this.lastBall = null; this.reboundShot = null;
    }
    if (this.active && now - this.active.releaseTime >= (this.active.status === "candidate" ? 1 : 4)) this.finishShot("unresolved", now, "evidence_timeout");
    this.previousBall = this.lastBall;
    const oldOwner = this.owner ? { ...this.owner } : null, oldSeen = this.ownerSeen;
    const possession = this.possession(players, ball, now);
    if (!this.active && this.reboundShot) {
      if (now - this.reboundShot.outcomeTime! > 2) this.reboundShot = null;
      else if (possession) {
        this.events.push({ eventId: `rebound-${String(this.events.length + 1).padStart(4, "0")}`, type: "rebound", status: "confirmed", actor: { ...possession }, time: now, confirmedAt: now, shotId: this.reboundShot.eventId }); this.reboundShot = null;
      }
    }
    if (this.active && possession && this.active.status === "candidate" && (actorKey(possession) !== actorKey(this.active.actor) || (ball !== null && now - this.active.releaseTime > .12))) this.finishShot("unresolved", now, "possession_recovered_before_shot_confirmation");
    if (!this.active && now >= this.outcomeUntil && oldOwner) {
      const height = this.ownerBox ? Math.max(this.ownerBox[3] - this.ownerBox[1], 1) : 1;
      const released = !ball || (this.ownerBox !== null && boxDistance(center(ball.box), this.ownerBox) / height > .25);
      if (released && now - oldSeen <= .5) this.newRelease(oldOwner, now, basket);
    }
    this.trajectory(ball, basket, now);
    if (ball) this.previousBasket = basket ? { ...basket, box: [...basket.box] } : null;
    if (ball) this.lastBall = { ball: { ...ball, box: [...ball.box] }, time: now, segment: ball.trajectorySegment };
    if (this.owner && now - this.ownerSeen > .5) this.owner = null;
    if (!this.active && now >= this.outcomeUntil) this.state = this.owner ? "POSSESSION" : "NO POSSESSION";
    this.lastTime = now;
    return this.snapshot(now);
  }
  finish(): void { if (this.lastTime !== null) this.finishShot("unresolved", this.lastTime, "end_of_video"); this.resolveIdentities(this.identities); }
  snapshot(now: number): EventSnapshot { return { time: now, state: this.state, possession: this.owner ? { ...this.owner } : null, activeEvent: this.active?.eventId ?? null, statistics: eventStatistics(this.events, this.identities, now) }; }
}
