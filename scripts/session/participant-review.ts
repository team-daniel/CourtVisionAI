import { eventStatistics } from "../events/types";
import type { CompletedAnalysis } from "../processing/basketball-pipeline";
export function mergeParticipants(analysis: CompletedAnalysis, from: number, into: number): void {
  if (from === into || !analysis.statistics.participants[from] || !analysis.statistics.participants[into]) throw new Error("Choose two different known participants");
  if (analysis.frames.some(f => f.detections.some(d => d.participantId === from) && f.detections.some(d => d.participantId === into))) throw new Error("These participants appear in the same frame, so they cannot be merged here");
  for (const event of analysis.events) if (event.actor.participantId === from) event.actor.participantId = into;
  analysis.identities = analysis.identities.map(([segment, pid]) => [segment, pid === from ? into : pid]);
  const mapping = new Map(analysis.identities);
  for (const frame of analysis.frames) {
    for (const d of frame.detections) if (d.participantId === from) { d.participantId = into; d.trackId = into; d.identityState = "user_merged"; }
    if (frame.snapshot.possession?.participantId === from) frame.snapshot.possession.participantId = into;
    frame.snapshot.statistics = eventStatistics(analysis.events, mapping, frame.timestampSeconds);
  }
  analysis.statistics = eventStatistics(analysis.events, mapping);
  analysis.identityCorrections.push({ from, into, reason: "user_confirmed_same_player" });
}
