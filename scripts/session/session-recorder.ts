import { projectSnapshot, pairCounts, type MatchPair } from "../game/game-mode";
import type { CompletedAnalysis } from "../processing/basketball-pipeline";
import { compactDetection, createSessionId, type PlaybackFrame, type SessionEvent, type StoredSession } from "../storage/session-store";
export interface SessionRecorderOptions { file: File; width: number; height: number; durationSeconds: number; sourceFramesPerSecond: number; analysedFramesPerSecond: number }
export class SessionRecorder {
  constructor(private options: SessionRecorderOptions) {}
  build(analysis: CompletedAnalysis, pair: MatchPair, thumbnails: Record<string, string> = {}): StoredSession {
    if (!analysis.frames.length) throw new Error("No analysed frames were available to save");
    if (pair[0] !== null && pair[0] === pair[1]) throw new Error("Choose two different participants");
    for (const pid of pair) if (pid !== null && !analysis.statistics.participants[pid]) throw new Error("Unknown match participant");
    const frames: PlaybackFrame[] = analysis.frames.map(f => ({ frameIndex: f.frameIndex, timestampSeconds: f.timestampSeconds, detections: f.detections.map(compactDetection), motion: f.motion, game: projectSnapshot(f.snapshot, pair) }));
    const identify = (pid: number | null) => {
      const index = pid === null ? -1 : pair.indexOf(pid);
      const participantKey = index === 0 ? "A" as const : index === 1 ? "B" as const : null;
      return { participantKey, participantLabel: participantKey ? `Player ${participantKey}` : pid === null ? "Unattributed player" : `Participant ${pid}` };
    };
    const events: SessionEvent[] = [];
    for (const event of analysis.events) {
      if (event.status !== "confirmed" || event.confirmedAt === null) continue;
      const actor = identify(event.actor.participantId);
      if (event.type === "rebound") events.push({ id: event.eventId, timestampSeconds: event.time, type: "rebound", ...actor, text: `${actor.participantLabel} grabbed a rebound` });
      else {
        events.push({ id: `${event.eventId}:attempt`, timestampSeconds: event.confirmedAt, type: "attempt", ...actor, text: `${actor.participantLabel} attempted a shot` });
        if (event.outcomeTime !== null && ["made", "missed", "unresolved"].includes(event.outcome)) {
          const type = event.outcome as "made" | "missed" | "unresolved";
          events.push({ id: `${event.eventId}:outcome`, timestampSeconds: event.outcomeTime, type, ...actor, text: type === "unresolved" ? `${actor.participantLabel}: shot outcome unresolved` : `${actor.participantLabel} ${type} a shot` });
        }
      }
    }
    let previous: number | null = null, possessionCount = 0;
    for (const frame of frames) {
      const pid = frame.game.possession?.participantId ?? null;
      if (pid !== null && pid !== previous) {
        const actor = identify(pid);
        events.push({ id: `possession:${frame.frameIndex}`, timestampSeconds: frame.timestampSeconds, type: "possession", ...actor, text: `${actor.participantLabel} gained possession` });
        if (actor.participantKey) possessionCount++;
      }
      previous = pid;
    }
    events.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    const finalGame = frames[frames.length - 1].game, counts = pairCounts(finalGame), o = this.options;
    return { schemaVersion: 2, identityCorrections: analysis.identityCorrections, pipelineVersion: analysis.version, id: createSessionId(), createdAt: new Date().toISOString(), modeId: "1v1", videoName: o.file.name, videoType: o.file.type || "video/mp4", videoBlob: o.file,
      width: o.width, height: o.height, durationSeconds: o.durationSeconds, sourceFramesPerSecond: o.sourceFramesPerSecond, analysedFramesPerSecond: o.analysedFramesPerSecond,
      frames, events, eventLedger: structuredClone(analysis.events), allStatistics: structuredClone(analysis.statistics), matchPair: pair, identitySegments: analysis.identities, participantThumbnails: thumbnails,
      playerAThumbnail: pair[0] === null ? null : thumbnails[pair[0]] ?? null, playerBThumbnail: pair[1] === null ? null : thumbnails[pair[1]] ?? null,
      finalGame, summary: { possessionCount, totalMakes: counts.makes, totalAttempts: counts.attempts, totalRebounds: counts.rebounds, shootingPercentage: counts.attempts ? Math.round(100 * counts.makes / counts.attempts) : 0 } };
  }
}
