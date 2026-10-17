import type { GameSnapshot } from "../game/game-mode";
import type { PipelineFrameResult } from "../processing/basketball-pipeline";
import {
  compactDetection,
  createSessionId,
  type PlaybackFrame,
  type SessionEvent,
  type SessionParticipantKey,
  type StoredSession,
} from "../storage/session-store";

interface PendingAttempt {
  timestampSeconds: number;
  participantLabel: string;
}

export interface SessionRecorderOptions {
  file: File;
  width: number;
  height: number;
  durationSeconds: number;
  sourceFramesPerSecond: number;
  analysedFramesPerSecond: number;
}

export class SessionRecorder {
  private readonly options: SessionRecorderOptions;
  private readonly frames: PlaybackFrame[] = [];
  private readonly frameByIndex = new Map<number, PlaybackFrame>();
  private readonly events: SessionEvent[] = [];
  private readonly pendingAttempts = new Map<
    SessionParticipantKey,
    PendingAttempt
  >();

  private previousGame: GameSnapshot | null = null;
  private possessionCount = 0;
  private eventSequence = 0;

  constructor(options: SessionRecorderOptions) {
    this.options = options;
  }

  addFrame(result: PipelineFrameResult): void {
    for (const correction of result.corrections) {
      const frame = this.frameByIndex.get(correction.frameIndex);
      if (!frame) continue;
      frame.detections = correction.detections.map(compactDetection);
      frame.game = cloneGame(correction.game);
    }

    const frame: PlaybackFrame = {
      frameIndex: result.frameIndex,
      timestampSeconds: result.timestampSeconds,
      detections: result.detections.map(compactDetection),
      game: cloneGame(result.game),
    };
    this.frames.push(frame);
    this.frameByIndex.set(result.frameIndex, frame);
  }

  build(): StoredSession {
    if (this.frames.length === 0) {
      throw new Error(
        "No analysed frames were available to save.",
      );
    }

    this.rebuildEvents();

    const finalFrame = this.frames[this.frames.length - 1];
    const finalGame = cloneGame(finalFrame.game);

    this.resolvePendingMisses(
      Math.min(
        finalFrame.timestampSeconds,
        this.options.durationSeconds,
      ),
    );

    const totalMakes = finalGame.participants.reduce(
      (total, participant) => total + participant.makes,
      0,
    );

    const totalAttempts = finalGame.participants.reduce(
      (total, participant) => total + participant.attempts,
      0,
    );
  
    const totalRebounds = finalGame.participants.reduce(
      (total, participant) => total + participant.rebounds,
      0,
    );

    return {
      id: createSessionId(),
      createdAt: new Date().toISOString(),
      modeId: finalGame.modeId,
      videoName: this.options.file.name,
      videoType:
        this.options.file.type || "video/mp4",
      videoBlob: this.options.file,
      width: this.options.width,
      height: this.options.height,
      durationSeconds: this.options.durationSeconds,
      sourceFramesPerSecond:
        this.options.sourceFramesPerSecond,
      analysedFramesPerSecond:
        this.options.analysedFramesPerSecond,
      frames: this.frames,
      events: this.events,
      finalGame,
      summary: {
        possessionCount: this.possessionCount,
        totalMakes,
        totalAttempts,
        totalRebounds,
        shootingPercentage: percentage(
          totalMakes,
          totalAttempts,
        ),
      },
    };
  }

  private rebuildEvents(): void {
    this.events.length = 0;
    this.pendingAttempts.clear();
    this.previousGame = null;
    this.possessionCount = 0;
    this.eventSequence = 0;

    for (const frame of this.frames) {
      this.captureShotEvents(frame.game, frame.timestampSeconds);
      this.captureReboundEvents(frame.game, frame.timestampSeconds);
      this.capturePossession(frame.game, frame.timestampSeconds);
      this.previousGame = frame.game;
    }
  }

  private captureReboundEvents(
    game: GameSnapshot,
    timestampSeconds: number,
  ): void {
    const previousParticipants = new Map(
      (this.previousGame?.participants ?? []).map(
        (participant) => [
          participant.key,
          participant,
        ],
      ),
    );

    for (const participant of game.participants) {
      if (
        participant.key !== "A"
        && participant.key !== "B"
      ) {
        continue;
      }

      const previous =
        previousParticipants.get(participant.key);

      const previousRebounds =
        previous?.rebounds ?? 0;

      if (
        participant.rebounds
        <= previousRebounds
      ) {
        continue;
      }

      this.events.push({
        id: this.nextEventId(),
        timestampSeconds,
        type: "rebound",
        participantKey: participant.key,
        participantLabel: participant.label,
        text: `${participant.label} grabbed a rebound`,
      });
    }
  }

  private capturePossession(
    game: GameSnapshot,
    timestampSeconds: number,
  ): void {
    if (
      game.state !== "PLAYER A POSSESSION"
      && game.state !== "PLAYER B POSSESSION"
    ) {
      return;
    }

    if (this.previousGame?.state === game.state) {
      return;
    }

    const participantKey: SessionParticipantKey =
      game.state === "PLAYER A POSSESSION"
        ? "A"
        : "B";

    const participant = game.participants.find(
      (candidate) => candidate.key === participantKey,
    );

    this.possessionCount += 1;

    this.events.push({
      id: this.nextEventId(),
      timestampSeconds,
      type: "possession",
      participantKey,
      participantLabel:
        participant?.label ?? `Player ${participantKey}`,
      text: `${participant?.label ?? `Player ${participantKey}`} gained possession`,
    });
  }

  private captureShotEvents(
    game: GameSnapshot,
    timestampSeconds: number,
  ): void {
    const previousParticipants = new Map(
      (this.previousGame?.participants ?? []).map(
        (participant) => [participant.key, participant],
      ),
    );

    for (const participant of game.participants) {
      if (
        participant.key !== "A"
        && participant.key !== "B"
      ) {
        continue;
      }

      const participantKey = participant.key;
      const previous = previousParticipants.get(participantKey);
      const previousAttempts = previous?.attempts ?? 0;
      const previousMakes = previous?.makes ?? 0;

      if (participant.attempts > previousAttempts) {
        if (this.pendingAttempts.has(participantKey)) {
          this.addMissEvent(
            participantKey,
            participant.label,
            timestampSeconds,
          );
        }

        this.pendingAttempts.set(participantKey, {
          timestampSeconds,
          participantLabel: participant.label,
        });
      }

      if (participant.makes > previousMakes) {
        this.pendingAttempts.delete(participantKey);

        this.events.push({
          id: this.nextEventId(),
          timestampSeconds,
          type: "made",
          participantKey,
          participantLabel: participant.label,
          text: `${participant.label} made a shot`,
        });
      }
    }

    if (
      this.previousGame?.state === "SHOT ATTEMPT"
      && game.state !== "SHOT ATTEMPT"
      && game.state !== "SHOT MADE"
    ) {
      this.resolvePendingMisses(timestampSeconds);
    }
  }

  private resolvePendingMisses(
    timestampSeconds: number,
  ): void {
    for (const [participantKey, pending] of this.pendingAttempts) {
      this.addMissEvent(
        participantKey,
        pending.participantLabel,
        timestampSeconds,
      );
    }

    this.pendingAttempts.clear();
  }

  private addMissEvent(
    participantKey: SessionParticipantKey,
    participantLabel: string,
    timestampSeconds: number,
  ): void {
    this.events.push({
      id: this.nextEventId(),
      timestampSeconds,
      type: "missed",
      participantKey,
      participantLabel,
      text: `${participantLabel} missed a shot`,
    });
  }

  private nextEventId(): string {
    this.eventSequence += 1;
    return `event-${this.eventSequence}`;
  }
}

function cloneGame(game: GameSnapshot): GameSnapshot {
  return {
    modeId: game.modeId,
    state: game.state,
    participants: game.participants.map((participant) => ({
      ...participant,
    })),
  };
}

function percentage(
  numerator: number,
  denominator: number,
): number {
  if (denominator <= 0) {
    return 0;
  }

  return Math.round((numerator / denominator) * 100);
}
