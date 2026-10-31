import type { BoundingBox, StableDetection } from "../core/detections";
export type Affine = [[number, number, number], [number, number, number]];
export interface CameraTransform { valid: boolean; matrix: Affine; residual: number | null; inliers: number; sceneCut: boolean; reason: string }
export const identityMotion = (): CameraTransform => ({ valid: false, matrix: [[1, 0, 0], [0, 1, 0]], residual: null, inliers: 0, sceneCut: false, reason: "initial_frame" });
export function warpBox(box: BoundingBox, m: Affine): BoundingBox {
  const points = [box[0], box[2]].flatMap(x => [box[1], box[3]].map(y => [m[0][0] * x + m[0][1] * y + m[0][2], m[1][0] * x + m[1][1] * y + m[1][2]]));
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}
export interface BallObservation extends StableDetection { trajectorySegment: number; continuous: boolean }
export interface BasketObservation extends StableDetection { referenceId: number; age: number; uncertaintyPx: number; offscreen: boolean; geometryChanged: boolean; outcomeReliable: boolean }
export interface Actor { participantId: number | null; identitySegment: number | null; rawTrackId: number | null; timestamp: number }
export interface Evidence { kind: string; time: number }
export interface ShotEvent {
  eventId: string; type: "shot"; status: "candidate" | "confirmed" | "dismissed"; actor: Actor;
  releaseTime: number; confirmedAt: number | null; outcome: "pending" | "made" | "missed" | "unresolved" | "not_confirmed";
  outcomeTime: number | null; evidence: Evidence[]; basketId: number | null; reason?: string;
}
export interface ReboundEvent { eventId: string; type: "rebound"; status: "confirmed"; actor: Actor; time: number; confirmedAt: number; shotId: string }
export type BasketballEvent = ShotEvent | ReboundEvent;
export interface Counts { attempts: number; makes: number; misses: number; unresolved: number; pending: number; rebounds: number }
export const emptyCounts = (): Counts => ({ attempts: 0, makes: 0, misses: 0, unresolved: 0, pending: 0, rebounds: 0 });
export interface Statistics { totals: Counts; participants: Record<string, Counts>; unattributed: Counts }
export interface EventSnapshot { time: number; state: string; possession: Actor | null; activeEvent: string | null; statistics: Statistics }
export function actorKey(actor: Actor | null): string | null {
  if (!actor) return null;
  return actor.participantId !== null ? `participant:${actor.participantId}` : actor.identitySegment !== null ? `segment:${actor.identitySegment}` : null;
}
export function eventStatistics(events: BasketballEvent[], mapping: ReadonlyMap<number, number>, atTime = Infinity): Statistics {
  const stats: Statistics = { totals: emptyCounts(), participants: {}, unattributed: emptyCounts() };
  for (const pid of mapping.values()) stats.participants[pid] = emptyCounts();
  for (const event of events) {
    if (event.status !== "confirmed" || event.confirmedAt === null || event.confirmedAt > atTime) continue;
    const pid = event.actor.participantId;
    const target = pid === null ? stats.unattributed : (stats.participants[pid] ??= emptyCounts());
    const keys: Array<keyof Counts> = event.type === "rebound" ? ["rebounds"] : ["attempts"];
    if (event.type === "shot") {
      const outcome = event.outcomeTime !== null && event.outcomeTime <= atTime ? event.outcome : "pending";
      keys.push(outcome === "made" ? "makes" : outcome === "missed" ? "misses" : outcome === "unresolved" ? "unresolved" : "pending");
    }
    for (const key of keys) { stats.totals[key]++; target[key]++; }
  }
  return stats;
}
