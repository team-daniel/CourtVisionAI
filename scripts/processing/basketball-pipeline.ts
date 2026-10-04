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

export interface BasketballPipelineOptions {
  gameMode?: GameModeId;
  effectiveFps?: number;
  detector?: BasketballYolo;
  detectorOptions?: BasketballYoloOptions;
  byteTrackerOptions?: ByteTrackerOptions;
  stableTrackerOptions?: StableIdentityTrackerOptions;
  recoveryOptions?: CropRecoveryOptions;
}

export interface PipelineTimings {
  detectorMilliseconds: number;
  recoveryMilliseconds: number;
  trackingMilliseconds: number;
  gameMilliseconds: number;
  totalMilliseconds: number;
  recoveryCropCount: number;
}

export interface PipelineFrameResult {
  frameIndex: number;
  timestampSeconds: number;
  rawDetections: Detection[];
  byteDetections: ByteTrackedDetection[];
  detections: StableDetection[];
  game: GameSnapshot;
  executionProvider: ExecutionProvider;
  outputShape: number[];
  timings: PipelineTimings;
}

export class BasketballPipeline {
  private readonly detector: BasketballYolo;
  private readonly byteTracker: ByteTracker;
  private readonly stableTracker: StableIdentityTracker;
  private readonly recovery: CropRecovery;

  private gameMode: GameMode;
  private effectiveFps: number;

  constructor({
    gameMode = "1v1",
    effectiveFps = 30,
    detector,
    detectorOptions,
    byteTrackerOptions,
    stableTrackerOptions,
    recoveryOptions,
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
      confirmHits: 3,
      minimumConfirmations: 2,
      ...stableTrackerOptions,
    });

    this.recovery = new CropRecovery(
      this.detector,
      {
        effectiveFps: this.effectiveFps,
        ...recoveryOptions,
      },
    );

    this.gameMode = createGameMode(
      gameMode,
      this.effectiveFps,
    );
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

    const recoveryTargets = this.stableTracker.getRecoveryTargets();
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
    const trackingMilliseconds = performance.now() - trackingStartedAt;

    // 7. The FPS-aware 1v1 FSM receives only final stable IDs.
    const gameStartedAt = performance.now();
    const game = this.gameMode.update(stableDetections);
    const gameMilliseconds = performance.now() - gameStartedAt;

    return {
      frameIndex,
      timestampSeconds,
      rawDetections: detectorResult.detections.map(copyDetection),
      byteDetections: byteDetections.map((detection) => ({
        ...detection,
        box: [...detection.box],
      })),
      detections: stableDetections,
      game,
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
