import { center, distance, type Detection, type Point, type StableDetection } from "../core/detections";
import { identityMotion, warpBox, type BallObservation, type BasketObservation, type CameraTransform } from "./types";
export class ObjectObservations {
  private ball: BallObservation | null = null;
  private ballTime: number | null = null;
  private velocity: Point = [0, 0];
  private segment = 0;
  private basket: BasketObservation | null = null;
  private basketTime = 0;
  private basketSegment = 0;
  private uncertainty = 0;
  private untrackedSeconds = 0;
  private lastTime: number | null = null;
  reset(): void { this.ball = this.basket = null; this.ballTime = this.lastTime = null; this.velocity = [0, 0]; this.segment = this.basketSegment = this.uncertainty = this.untrackedSeconds = 0; }
  update(detections: Detection[], now: number, width: number, height: number, motion: CameraTransform = identityMotion(), lockedReference: number | null = null): { ball: BallObservation | null; basket: BasketObservation | null } {
    const dtFrame = this.lastTime === null ? 0 : Math.max(0, now - this.lastTime);
    this.lastTime = now;
    if (motion.sceneCut) { this.ball = this.basket = null; this.ballTime = null; }
    if (motion.valid && !motion.sceneCut) {
      const m = motion.matrix;
      if (this.basket) { this.basket.box = warpBox(this.basket.box, m); this.uncertainty = Math.hypot(this.uncertainty, Math.max(.2, motion.residual ?? 0)); }
      if (this.ball) this.ball = { ...this.ball, box: warpBox(this.ball.box, m) };
      const [vx, vy] = this.velocity; this.velocity = [m[0][0] * vx + m[0][1] * vy, m[1][0] * vx + m[1][1] * vy];
    } else if (this.basket) this.untrackedSeconds += dtFrame;
    const observed = detections.filter(d => !["predicted", "interpolated", "reference"].includes(d.state ?? "") && d.confidence > 0);
    let baskets = observed.filter(d => d.classId === 2 && d.confidence >= .15), nearby: Detection[] = [], changed = false;
    if (baskets.length) {
      if (this.basket) {
        const b = this.basket.box, scale = Math.max(Math.hypot(b[2] - b[0], b[3] - b[1]), 1);
        nearby = baskets.filter(d => distance(center(d.box), center(b)) <= scale);
      }
      if (!nearby.length && this.basket && lockedReference === this.basket.referenceId && now - this.basketTime <= 12 && this.untrackedSeconds <= .8) baskets = [];
    }
    if (baskets.length) {
      const chosen = [...(nearby.length ? nearby : baskets)].sort((a, b) => b.confidence - a.confidence)[0];
      if (!this.basket || !nearby.length) { this.basketSegment++; changed = this.basket !== null; }
      this.basket = { ...chosen, box: [...chosen.box], source: "detector", state: "observed", trackId: -4000000 - this.basketSegment, referenceId: this.basketSegment, age: 0, uncertaintyPx: 0, offscreen: false, geometryChanged: changed, outcomeReliable: true };
      this.basketTime = now; this.uncertainty = this.untrackedSeconds = 0;
    }
    let basket: BasketObservation | null = null;
    if (this.basket) {
      const age = now - this.basketTime, size = Math.max(this.basket.box[2] - this.basket.box[0], 1);
      if (age <= 12 && this.untrackedSeconds <= .8 && this.uncertainty <= size * .65) {
        const b = this.basket.box, offscreen = b[2] < 0 || b[0] > width || b[3] < 0 || b[1] > height;
        basket = { ...this.basket, box: [...b], age, uncertaintyPx: this.uncertainty, offscreen, geometryChanged: changed, outcomeReliable: !offscreen && (baskets.length > 0 || (this.uncertainty < size * .15 && (age <= .4 || (age <= 3 && motion.valid && this.untrackedSeconds <= .1)))), state: baskets.length ? "observed" : "reference", source: baskets.length ? "detector" : motion.valid ? "camera_motion" : "short_hold" };
      }
    }
    let balls = observed.filter(d => d.classId === 0 && d.confidence >= .15), chosen: Detection | undefined, continuous = false;
    const dt = this.ballTime === null ? Infinity : now - this.ballTime;
    if (balls.length && this.ball && dt > 0 && dt <= .25) {
      const previous = center(this.ball.box), predicted: Point = [previous[0] + this.velocity[0] * dt, previous[1] + this.velocity[1] * dt];
      const gate = Math.hypot(width, height) * (.015 + (dt <= .08 ? 3 : 1) * dt), old = this.ball.box, area = Math.max((old[2] - old[0]) * (old[3] - old[1]), 1);
      const comparable = balls.filter(d => { const ratio = (d.box[2] - d.box[0]) * (d.box[3] - d.box[1]) / area; return ratio >= .35 && ratio <= 2.8; });
      if (comparable.length) balls = comparable;
      const candidates = balls.filter(d => distance(center(d.box), previous) <= gate && distance(center(d.box), predicted) <= gate);
      if (candidates.length) {
        const score = (d: Detection) => distance(center(d.box), predicted) / gate - .15 * d.confidence;
        chosen = candidates.sort((a, b) => score(a) - score(b))[0]; continuous = true;
      }
    }
    if (!chosen && balls.length) chosen = [...balls].sort((a, b) => b.confidence - a.confidence)[0];
    let ball: BallObservation | null = null;
    if (chosen) {
      if (continuous && this.ball) { const point = center(chosen.box), old = center(this.ball.box); this.velocity = [(point[0] - old[0]) / dt, (point[1] - old[1]) / dt]; }
      else { this.segment++; this.velocity = [0, 0]; }
      ball = { ...chosen, box: [...chosen.box], source: "detector", state: "observed", trackId: -3000000 - this.segment, trajectorySegment: this.segment, continuous };
      this.ball = ball; this.ballTime = now;
    }
    return { ball, basket };
  }
}
