import {
  getFrameDimensions,
  type ByteTrackedDetection,
  type Detection,
  type FrameSource,
  type StableDetection,
} from "../core/detections";
import {
  createGameMode,
  type GameMode,
  type GameModeId,
  type GameSnapshot,
} from "../game/game-mode";
import {
  BasketballYolo,
  type BasketballYoloOptions,
  type ExecutionProvider,
} from "../inference/basketball-yolo";
import {
  ByteTracker,
  type ByteTrackerOptions,
} from "../tracking/byte-tracker";
import {
  CropRecovery,
  type CropRecoveryOptions,
} from "../tracking/crop-recovery";
import {
  StableIdentityTracker,
  type StableIdentityTrackerOptions,
} from "../tracking/stable-identity-tracker";
import { ParticipantIdentityTracker } from "../tracking/participant-identity";

export interface BasketballPipelineOptions {
  gameMode?: GameModeId;
  effectiveFps?: number;
  detector?: BasketballYolo;
  detectorOptions?: BasketballYoloOptions;
  byteTrackerOptions?: ByteTrackerOptions;
  stableTrackerOptions?: StableIdentityTrackerOptions;
  recoveryOptions?: CropRecoveryOptions;
  analysisMode?: AnalysisMode;
}

export interface PipelineTimings {
  detectorMilliseconds: number;
  recoveryMilliseconds: number;
  trackingMilliseconds: number;
  gameMilliseconds: number;
  totalMilliseconds: number;
  recoveryCropCount: number;
}

export interface FrameCorrection {
  frameIndex: number;
  detections: StableDetection[];
  game: GameSnapshot;
}

interface HistoricalFrame {
  frameIndex: number;
  detections: StableDetection[];
  game: GameSnapshot | null;
}

export interface PipelineFrameResult {
  frameIndex: number;
  timestampSeconds: number;
  rawDetections: Detection[];
  byteDetections: ByteTrackedDetection[];
  detections: StableDetection[];
  game: GameSnapshot;
  corrections: FrameCorrection[];
  executionProvider: ExecutionProvider;
  outputShape: number[];
  timings: PipelineTimings;
}

export type AnalysisMode = "fast" | "balanced" | "quality";

export class BasketballPipeline {
  private readonly detector: BasketballYolo;
  private readonly byteTracker: ByteTracker;
  private readonly stableTracker: StableIdentityTracker;
  private readonly participants = new ParticipantIdentityTracker();
  private readonly recovery: CropRecovery;
  private gameMode: GameMode;
  private effectiveFps: number;
  private readonly history: HistoricalFrame[] = [];

  constructor({
    gameMode = "1v1",
    effectiveFps = 30,
    detector,
    detectorOptions,
    byteTrackerOptions,
    stableTrackerOptions,
    recoveryOptions,
    analysisMode = "balanced",
  }: BasketballPipelineOptions = {}) {
    this.effectiveFps = Math.max(effectiveFps, 0.01);

    this.detector = detector ?? new BasketballYolo({
      confidence: 0.10,
      ...detectorOptions,
    });

    this.byteTracker = new ByteTracker({
      effectiveFps: this.effectiveFps,
      ...byteTrackerOptions,
    });

    this.stableTracker = new StableIdentityTracker({
      effectiveFps: this.effectiveFps,
      confirmHits: 5,
      minimumConfirmations: 3,
      maxMissingFrames: 75,
      ...stableTrackerOptions,
    });


    const recoveryProfiles: Record<AnalysisMode, CropRecoveryOptions> = {
      fast: {
        enabled: false,
        ballSearchEnabled: true,
      },
      balanced: {
        enabled: true,
        discoveryEnabled: false,
        recoveryIntervalFrames: 2,
        maxCropsPerFrame: 1,
        ballSearchEnabled: true,
      },
      quality: {
        enabled: true,
        discoveryEnabled: true,
        recoveryIntervalFrames: 1,
        maxCropsPerFrame: 3,
        ballSearchEnabled: true,
      },
    };

    this.recovery = new CropRecovery(this.detector, {
      effectiveFps: this.effectiveFps,
      ...recoveryProfiles[analysisMode],
      ...recoveryOptions,
    });


    this.gameMode = createGameMode(
      gameMode,
      this.effectiveFps,
    );
    this.participants.configureTiming(this.effectiveFps);
  }

  async load(): Promise<void> {
    await this.detector.load();
  }

  configureTiming(effectiveFps: number): void {
    this.effectiveFps = Math.max(effectiveFps, 0.01);
    this.byteTracker.configureTiming(this.effectiveFps);
    this.stableTracker.configureTiming(this.effectiveFps);
    this.recovery.configureTiming(this.effectiveFps);
    this.gameMode.configureTiming(this.effectiveFps);
    this.participants.configureTiming(this.effectiveFps);
  }

  setGameMode(gameModeId: GameModeId): void {
    if (this.gameMode.id === gameModeId) {
      return;
    }

    this.gameMode = createGameMode(
      gameModeId,
      this.effectiveFps,
    );
    this.reset();
  }

  reset(): void {
    this.byteTracker.reset();
    this.stableTracker.reset();
    this.recovery.reset();
    this.gameMode.reset();
    this.participants.reset();
    this.history.length = 0;
  }

  async processFrame(
    source: FrameSource,
    frameIndex: number,
    timestampSeconds: number,
  ): Promise<PipelineFrameResult> {
    const totalStartedAt = performance.now();
    const { width, height } = getFrameDimensions(source);

    // 1. Full-frame ONNX detection.
    const detectorResult = await this.detector.detect(source, 0.10);

    const trackingStartedAt = performance.now();

    // 2. Only genuine full-frame detections enter ByteTrack.
    const byteDetections = this.byteTracker.update(
      detectorResult.detections,
      width,
      height,
    );

    // 3. Convert ByteTrack IDs to stable public IDs.
    this.stableTracker.beginFrame(
      byteDetections,
      source,
      width,
      height,
    );

    const recoveryTargets = this.stableTracker.getRecoveryTargets().sort(
      (a, b) => Number(b.group === "ball") - Number(a.group === "ball"),
    );
    const preparedFullDetections =
      this.stableTracker.getPreparedFullFrameDetections();

    // 4. Isolated crop inference. These detections never enter ByteTrack.
    const recoveryResult = await this.recovery.process(
      source,
      preparedFullDetections,
      recoveryTargets,
      this.stableTracker.isSceneAcquired(),
      (byteTrackId) => (
        this.stableTracker.stableIdForByteTrack(byteTrackId)
      ),
    );

    // 5. Targeted recoveries update their existing stable identity directly.
    for (const recovery of recoveryResult.recoveries) {
      this.stableTracker.applyRecovery(
        recovery.stableId,
        recovery.detection,
      );
    }

    // 6. Crop detections may refine current tracks or become tentative
    // discoveries exactly as in the Python stable-ID layer.
    this.stableTracker.mergeCropDetections(
      recoveryResult.mappedDetections,
      width,
      height,
    );

    const stableDetections = this.stableTracker.finishFrame(source);
    const detections = this.gameMode.id === "1v1"
      ? this.participants.update(source, stableDetections)
      : stableDetections;
    const trackingMilliseconds = performance.now() - trackingStartedAt;

    const gameStartedAt = performance.now();
    const gameDetections = this.gameMode.id === "1v1"
      ? detections.filter((d) =>
          (d.classId !== 2 && d.classId !== 4)
          || d.trackId === -2 || d.trackId === -1,
        )
      : detections;

    this.history.push({ frameIndex, detections: cloneDetections(detections), game: null });
    const reconnections = this.participants.takeReconnections();
    let firstChanged = this.history.length;

    for (const reconnect of reconnections) {
      let fromFrame = reconnect.fromFrame;
      let gaps = 0;
      for (let i = this.history.length - 1; i >= 0; i -= 1) {
        const frame = this.history[i];
        if (frame.frameIndex >= fromFrame) continue;
        if (reconnect.toFrame - frame.frameIndex > this.effectiveFps * 3) break;
        const unconfirmed = frame.detections.some((d) =>
          (d.classId === 2 || d.classId === 4) && d.trackId === reconnect.sourceId,
        );
        if (unconfirmed) {
          fromFrame = frame.frameIndex;
          gaps = 0;
        } else if (++gaps > 1) {
          break;
        }
      }

      for (let i = 0; i < this.history.length; i += 1) {
        const frame = this.history[i];
        if (frame.frameIndex < fromFrame || frame.frameIndex > reconnect.toFrame) continue;
        if (frame.detections.some((d) => d.trackId === reconnect.participantId)) continue;

        const candidate = frame.detections.find((d) =>
          (d.classId === 2 || d.classId === 4) && d.trackId === reconnect.sourceId,
        );
        if (!candidate) continue;
        candidate.trackId = reconnect.participantId;
        candidate.className = candidate.classId === 4 ? "Player Shooting" : "Player";
        firstChanged = Math.min(firstChanged, i);
      }
    }

    let game: GameSnapshot;
    const corrections: FrameCorrection[] = [];

    if (firstChanged < this.history.length - 1) {
      this.gameMode = createGameMode(this.gameMode.id, this.effectiveFps);
      for (let i = 0; i < this.history.length; i += 1) {
        const frame = this.history[i];
        const input = frame.detections.filter((d) =>
          (d.classId !== 2 && d.classId !== 4)
          || d.trackId === -2 || d.trackId === -1,
        );
        frame.game = this.gameMode.update(input);
        if (i >= firstChanged && i < this.history.length - 1) {
          corrections.push({
            frameIndex: frame.frameIndex,
            detections: cloneDetections(frame.detections),
            game: frame.game,
          });
        }
      }
      game = this.history[this.history.length - 1].game!;
    } else {
      game = this.gameMode.update(gameDetections);
      this.history[this.history.length - 1].game = game;
    }
    const gameMilliseconds = performance.now() - gameStartedAt;

    return {
      frameIndex,
      timestampSeconds,
      rawDetections: detectorResult.detections.map(copyDetection),
      byteDetections: byteDetections.map((detection) => ({
        ...detection,
        box: [...detection.box],
      })),
      detections,
      game,
      corrections,
      executionProvider: detectorResult.executionProvider,
      outputShape: detectorResult.outputShape,
      timings: {
        detectorMilliseconds: detectorResult.inferenceMilliseconds,
        recoveryMilliseconds: recoveryResult.recoveryMilliseconds,
        trackingMilliseconds,
        gameMilliseconds,
        totalMilliseconds: performance.now() - totalStartedAt,
        recoveryCropCount: recoveryResult.cropCount,
      },
    };
  }

  playerLabel(trackId: number | null): string | null {
    return this.gameMode.playerLabel(trackId);
  }
}

function copyDetection(detection: Detection): Detection {
  return {
    ...detection,
    box: [...detection.box],
  };
}

function cloneDetections(detections: readonly StableDetection[]): StableDetection[] {
  return detections.map((d) => ({ ...d, box: [...d.box] }));
}
