import {
  CLASS_GROUPS,
  SPECIFIC_CLASSES,
  getFrameDimensions,
  type BoundingBox,
  type ByteTrackedDetection,
  type ClassId,
  type Detection,
  type DetectionGroup,
  type FrameSource,
  type Point,
  type RecoveryTarget,
  type StableDetection,
} from "../core/detections";
import {
  boxArea,
  boxCenter,
  boxDiagonal,
  boxIou,
  boxesIntersect,
  pointDistance,
  translateBox,
} from "../core/geometry";

export interface StableIdentityTrackerOptions {
  maxMissingFrames?: number;
  confirmHits?: number;
  minimumConfirmations?: number;
  tentativeMaxMissingFrames?: number;
  predictionMaximumSteps?: number;
  reidentificationMaximumDistance?: number;
  effectiveFps?: number;
}

interface CandidateDetection
  extends Omit<Detection, "trackId"> {
  trackId: number | null;
  source: string;
}

interface StableTrackRecord {
  group: DetectionGroup;
  box: BoundingBox;
  velocity: Point;
  classId: ClassId;
  className: string;
  confidence: number;
  byteTrackId: number | null;
  missing: number;
  lastSeenFrame: number;
  appearanceHistogram: Float32Array | null;
}

interface TentativeTrackRecord extends StableTrackRecord {
  hits: number;
  source: string;
}

interface Promotion {
  stableId: number;
  detection: StableDetection;
}

const REFERENCE_FPS = 30;
const GROUP_DUPLICATE_IOU = 0.40;
const SAME_CLASS_DUPLICATE_IOU = 0.85;
const NEW_OBJECT_CONFIDENCE = 0.50;

export class StableIdentityTracker {
  private readonly referenceMaxMissingFrames: number;
  private readonly referenceConfirmHits: number;
  private readonly minimumConfirmations: number;
  private readonly referenceTentativeMaxMissingFrames: number;
  private readonly referencePredictionMaximumSteps: number;
  private readonly reidentificationMaximumDistance: number;

  private effectiveFps = REFERENCE_FPS;
  private maxMissingFrames = 30;
  private confirmHits = 3;
  private tentativeMaxMissingFrames = 3;
  private predictionMaximumSteps = 8;

  private readonly tracks = new Map<number, StableTrackRecord>();
  private readonly byteToStable = new Map<number, number>();
  private readonly tentativeTracks = new Map<number, TentativeTrackRecord>();
  private readonly byteToTentative = new Map<number, number>();

  private nextStableId = 0;
  private nextTentativeId = 0;
  private frameIndex = -1;

  private readonly activePlayerCrossings = new Set<string>();
  private readonly observedPlayerCrossings = new Set<string>();

  private preparedFullDetections: ByteTrackedDetection[] = [];
  private currentOutput = new Map<number, StableDetection>();
  private frameOpen = false;

  private readonly histogramCanvas: HTMLCanvasElement;
  private readonly histogramContext: CanvasRenderingContext2D;

  constructor({
    maxMissingFrames = 30,
    confirmHits = 3,
    minimumConfirmations = 2,
    tentativeMaxMissingFrames = 3,
    predictionMaximumSteps = 8,
    reidentificationMaximumDistance = 0.12,
    effectiveFps = REFERENCE_FPS,
  }: StableIdentityTrackerOptions = {}) {
    this.referenceMaxMissingFrames = maxMissingFrames;
    this.referenceConfirmHits = confirmHits;
    this.minimumConfirmations = Math.max(
      Math.floor(minimumConfirmations),
      1,
    );
    this.referenceTentativeMaxMissingFrames =
      tentativeMaxMissingFrames;
    this.referencePredictionMaximumSteps = predictionMaximumSteps;
    this.reidentificationMaximumDistance =
      reidentificationMaximumDistance;

    this.histogramCanvas = document.createElement("canvas");
    this.histogramCanvas.width = 48;
    this.histogramCanvas.height = 96;

    const context = this.histogramCanvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    if (!context) {
      throw new Error(
        "Could not create the stable-ID appearance canvas.",
      );
    }

    this.histogramContext = context;
    this.configureTiming(effectiveFps);
  }

  configureTiming(effectiveFps: number): void {
    this.effectiveFps = Math.max(effectiveFps, 0.01);
    this.maxMissingFrames = this.scaleFrames(
      this.referenceMaxMissingFrames,
      1,
    );
    this.confirmHits = this.scaleFrames(
      this.referenceConfirmHits,
      this.minimumConfirmations,
    );
    this.tentativeMaxMissingFrames = this.scaleFrames(
      this.referenceTentativeMaxMissingFrames,
      1,
    );
    this.predictionMaximumSteps = this.scaleFrames(
      this.referencePredictionMaximumSteps,
      1,
    );
  }

  reset(): void {
    this.tracks.clear();
    this.byteToStable.clear();
    this.tentativeTracks.clear();
    this.byteToTentative.clear();
    this.activePlayerCrossings.clear();
    this.observedPlayerCrossings.clear();
    this.preparedFullDetections = [];
    this.currentOutput.clear();
    this.nextStableId = 0;
    this.nextTentativeId = 0;
    this.frameIndex = -1;
    this.frameOpen = false;
  }

  beginFrame(
    inputDetections: readonly ByteTrackedDetection[],
    source: FrameSource,
    frameWidth: number,
    frameHeight: number,
  ): StableDetection[] {
    if (this.frameOpen) {
      throw new Error(
        "finishFrame() must be called before beginning another frame.",
      );
    }

    this.frameOpen = true;
    this.frameIndex += 1;
    this.preparedFullDetections = this.prepareDetections(
      inputDetections,
    );
    this.currentOutput.clear();

    this.markPredictedPlayerCrossings();

    const crossingTrackIds = new Set<number>();

    for (const pairKey of this.activePlayerCrossings) {
      const [stableIdA, stableIdB] = parsePairKey(pairKey);

      if (this.tracks.has(stableIdA)) {
        crossingTrackIds.add(stableIdA);
      }

      if (this.tracks.has(stableIdB)) {
        crossingTrackIds.add(stableIdB);
      }
    }

    const snapshots = new Map<number, StableTrackRecord>();

    for (const stableId of crossingTrackIds) {
      const track = this.tracks.get(stableId);

      if (track) {
        snapshots.set(stableId, cloneTrack(track));
      }
    }

    const assignedStableIds = new Set<number>();
    const assignedDetectionIndices = new Set<number>();
    const output: StableDetection[] = [];

    // 1. Reuse valid ByteTrack-to-stable mappings.
    for (
      let detectionIndex = 0;
      detectionIndex < this.preparedFullDetections.length;
      detectionIndex += 1
    ) {
      const detection = this.preparedFullDetections[detectionIndex];
      const stableId = this.byteToStable.get(detection.trackId);

      if (
        stableId === undefined
        || !this.tracks.has(stableId)
        || assignedStableIds.has(stableId)
      ) {
        continue;
      }

      const track = this.tracks.get(stableId)!;

      if (track.group !== CLASS_GROUPS[detection.classId]) {
        continue;
      }

      const mappedScore = this.associationScore(
        detection,
        track,
        frameWidth,
        frameHeight,
      );

      if (mappedScore === null) {
        this.unbindByteTrack(detection.trackId, stableId);
        continue;
      }

      let betterMatchExists = false;

      for (const [otherStableId, otherTrack] of this.tracks) {
        if (
          otherStableId === stableId
          || assignedStableIds.has(otherStableId)
        ) {
          continue;
        }

        const otherScore = this.associationScore(
          detection,
          otherTrack,
          frameWidth,
          frameHeight,
        );

        if (
          otherScore !== null
          && otherScore < mappedScore
        ) {
          betterMatchExists = true;
          break;
        }
      }

      if (betterMatchExists) {
        this.unbindByteTrack(detection.trackId, stableId);
        continue;
      }

      output.push(
        this.updateStableTrack(
          stableId,
          toCandidate(detection, "full_frame"),
          true,
        ),
      );
      assignedStableIds.add(stableId);
      assignedDetectionIndices.add(detectionIndex);
    }

    // 2. Reconnect changed ByteTrack IDs using stable motion.
    const candidates: Array<{
      score: number;
      stableId: number;
      detectionIndex: number;
    }> = [];

    for (
      let detectionIndex = 0;
      detectionIndex < this.preparedFullDetections.length;
      detectionIndex += 1
    ) {
      if (assignedDetectionIndices.has(detectionIndex)) {
        continue;
      }

      const detection = this.preparedFullDetections[detectionIndex];

      for (const [stableId, track] of this.tracks) {
        if (assignedStableIds.has(stableId)) {
          continue;
        }

        const score = this.associationScore(
          detection,
          track,
          frameWidth,
          frameHeight,
        );

        if (score !== null) {
          candidates.push({
            score,
            stableId,
            detectionIndex,
          });
        }
      }
    }

    candidates.sort(
      (candidateA, candidateB) => candidateA.score - candidateB.score,
    );

    for (const candidate of candidates) {
      if (
        assignedStableIds.has(candidate.stableId)
        || assignedDetectionIndices.has(candidate.detectionIndex)
      ) {
        continue;
      }

      const detection = this.preparedFullDetections[
        candidate.detectionIndex
      ];

      output.push(
        this.updateStableTrack(
          candidate.stableId,
          toCandidate(detection, "full_frame_reid"),
          true,
        ),
      );
      assignedStableIds.add(candidate.stableId);
      assignedDetectionIndices.add(candidate.detectionIndex);
    }

    // 3. Unmatched detections remain tentative until repeated hits.
    for (
      let detectionIndex = 0;
      detectionIndex < this.preparedFullDetections.length;
      detectionIndex += 1
    ) {
      if (assignedDetectionIndices.has(detectionIndex)) {
        continue;
      }

      const promoted = this.handleUnmatchedDetection(
        toCandidate(
          this.preparedFullDetections[detectionIndex],
          "full_frame_tentative",
        ),
        frameWidth,
        frameHeight,
      );

      if (promoted) {
        output.push(promoted.detection);
        assignedStableIds.add(promoted.stableId);
      }
    }

    // Missing is incremented exactly once per processed video frame.
    for (const [stableId, track] of this.tracks) {
      if (!assignedStableIds.has(stableId)) {
        track.missing += 1;
      }
    }

    const correctedOutput = this.resolvePlayerCrossings(
      source,
      output,
      snapshots,
    );

    for (const detection of correctedOutput) {
      this.currentOutput.set(detection.trackId, detection);
    }

    return cloneStableDetections(correctedOutput);
  }

  getPreparedFullFrameDetections(): ByteTrackedDetection[] {
    return this.preparedFullDetections.map((detection) => ({
      ...detection,
      box: [...detection.box],
    }));
  }

  stableIdForByteTrack(byteTrackId: number): number | null {
    const stableId = this.byteToStable.get(byteTrackId);

    return (
      stableId !== undefined
      && this.tracks.has(stableId)
    )
      ? stableId
      : null;
  }

  getRecoveryTargets(): RecoveryTarget[] {
    this.requireOpenFrame();
    const targets: RecoveryTarget[] = [];

    for (const [stableId, track] of this.tracks) {
      if (
        track.missing <= 0
        || track.missing > this.maxMissingFrames
      ) {
        continue;
      }

      targets.push({
        stableId,
        group: track.group,
        predictedBox: this.predictedBox(track),
        missingFrames: track.missing,
      });
    }

    return targets;
  }

  applyRecovery(
    stableId: number,
    detection: Detection,
  ): void {
    this.requireOpenFrame();

    if (!this.tracks.has(stableId)) {
      return;
    }

    const recovered = this.updateStableTrack(
      stableId,
      {
        ...detection,
        box: [...detection.box],
        trackId: null,
        source: "recovery_crop",
      },
      false,
    );

    this.currentOutput.set(stableId, recovered);
  }

  mergeCropDetections(
    detections: readonly Detection[],
    frameWidth: number,
    frameHeight: number,
  ): void {
    this.requireOpenFrame();

    const mappedDetections = this.deduplicateGroupDetections(
      detections.map((detection) => ({
        ...detection,
        box: [...detection.box],
        trackId: null,
        source: detection.source ?? "crop_detection",
      })),
    );

    for (const cropDetection of mappedDetections) {
      if (cropDetection.confidence < NEW_OBJECT_CONFIDENCE) {
        continue;
      }

      let matchedStableId: number | null = null;

      for (const [stableId, currentDetection] of this.currentOutput) {
        if (this.detectionsMatch(cropDetection, currentDetection)) {
          matchedStableId = stableId;
          break;
        }
      }

      if (matchedStableId === null) {
        const stableCandidates: Array<{
          score: number;
          stableId: number;
        }> = [];

        for (const [stableId, track] of this.tracks) {
          const score = this.associationScore(
            cropDetection,
            track,
            frameWidth,
            frameHeight,
          );

          if (score !== null) {
            stableCandidates.push({ score, stableId });
          }
        }

        stableCandidates.sort(
          (candidateA, candidateB) => candidateA.score - candidateB.score,
        );

        matchedStableId = stableCandidates[0]?.stableId ?? null;
      }

      if (matchedStableId !== null) {
        const existing = this.currentOutput.get(matchedStableId);

        if (!existing) {
          const recovered = this.updateStableTrack(
            matchedStableId,
            {
              ...cropDetection,
              source: "recovery_crop",
            },
            false,
          );
          this.currentOutput.set(matchedStableId, recovered);
          continue;
        }

        if (cropDetection.confidence > existing.confidence) {
          const refined = this.updateStableTrack(
            matchedStableId,
            {
              ...cropDetection,
              source: "crop_refinement",
            },
            false,
          );
          this.currentOutput.set(matchedStableId, refined);
        }

        continue;
      }

      const promoted = this.handleUnmatchedDetection(
        {
          ...cropDetection,
          source: "crop_tentative",
        },
        frameWidth,
        frameHeight,
      );

      if (promoted) {
        this.currentOutput.set(
          promoted.stableId,
          promoted.detection,
        );
      }
    }
  }

  finishFrame(source: FrameSource): StableDetection[] {
    this.requireOpenFrame();

    this.ageTentativeTracks();
    this.removeExpiredTracks();

    for (const stableId of Array.from(this.currentOutput.keys())) {
      if (!this.tracks.has(stableId)) {
        this.currentOutput.delete(stableId);
      }
    }

    const output = Array.from(this.currentOutput.values()).sort(
      (detectionA, detectionB) => detectionA.trackId - detectionB.trackId,
    );

    this.updatePlayerAppearanceHistograms(source, output);
    this.frameOpen = false;

    return cloneStableDetections(output);
  }

  isSceneAcquired(): boolean {
    const groups = Array.from(this.tracks.values()).map(
      (track) => track.group,
    );

    return (
      groups.filter((group) => group === "player").length >= 2
      && groups.includes("ball")
      && groups.includes("basket")
    );
  }

  private requireOpenFrame(): void {
    if (!this.frameOpen) {
      throw new Error("No stable-tracker frame is currently open.");
    }
  }

  private scaleFrames(
    referenceFrames: number,
    minimum: number,
  ): number {
    return Math.max(
      minimum,
      Math.ceil(
        referenceFrames
        * this.effectiveFps
        / REFERENCE_FPS,
      ),
    );
  }

  private prepareDetections(
    detections: readonly ByteTrackedDetection[],
  ): ByteTrackedDetection[] {
    const bestByByteId = new Map<number, ByteTrackedDetection>();

    for (const detection of detections) {
      const current = bestByByteId.get(detection.trackId);

      if (
        !current
        || detection.confidence > current.confidence
      ) {
        bestByByteId.set(detection.trackId, {
          ...detection,
          box: [...detection.box],
        });
      }
    }

    return this.deduplicateGroupDetections(
      Array.from(bestByByteId.values()),
    ) as ByteTrackedDetection[];
  }

  private deduplicateGroupDetections<T extends CandidateDetection>(
    detections: readonly T[],
  ): T[] {
    const ordered = detections
      .map((detection) => ({
        ...detection,
        box: [...detection.box] as BoundingBox,
      }))
      .sort(
        (detectionA, detectionB) => (
          detectionB.confidence - detectionA.confidence
        ),
      ) as T[];

    const kept: T[] = [];

    for (const detection of ordered) {
      const group = CLASS_GROUPS[detection.classId];
      let duplicate: T | null = null;

      for (const existing of kept) {
        if (CLASS_GROUPS[existing.classId] !== group) {
          continue;
        }

        const iou = boxIou(detection.box, existing.box);
        const threshold = detection.classId === existing.classId
          ? SAME_CLASS_DUPLICATE_IOU
          : GROUP_DUPLICATE_IOU;

        if (iou >= threshold) {
          duplicate = existing;
          break;
        }
      }

      if (!duplicate) {
        kept.push(detection);
        continue;
      }

      if (
        SPECIFIC_CLASSES.has(detection.classId)
        && !SPECIFIC_CLASSES.has(duplicate.classId)
      ) {
        duplicate.classId = detection.classId;
        duplicate.className = detection.className;
      }

      duplicate.confidence = Math.max(
        duplicate.confidence,
        detection.confidence,
      );
    }

    return kept;
  }

  private associationScore(
    detection: Pick<Detection, "classId" | "box">,
    track: StableTrackRecord | TentativeTrackRecord,
    frameWidth: number,
    frameHeight: number,
  ): number | null {
    if (CLASS_GROUPS[detection.classId] !== track.group) {
      return null;
    }

    const predictedBox = this.predictedBox(track);
    const frameDiagonal = Math.max(
      Math.hypot(frameWidth, frameHeight),
      1,
    );

    const centreDistance = pointDistance(
      boxCenter(detection.box),
      boxCenter(predictedBox),
    ) / frameDiagonal;

    if (centreDistance > this.reidentificationMaximumDistance) {
      return null;
    }

    const iou = boxIou(detection.box, predictedBox);
    const detectionArea = Math.max(boxArea(detection.box), 1);
    const predictedArea = Math.max(boxArea(predictedBox), 1);
    const sizeChange = Math.min(
      Math.abs(Math.log(detectionArea / predictedArea)),
      3,
    );

    return (
      centreDistance
      + 0.03 * (1 - iou)
      + 0.01 * sizeChange
    );
  }

  private predictedBox(
    track: StableTrackRecord | TentativeTrackRecord,
  ): BoundingBox {
    const elapsedFrames = Math.max(
      this.frameIndex - track.lastSeenFrame,
      track.missing,
      1,
    );

    const steps = Math.min(
      elapsedFrames,
      this.predictionMaximumSteps,
    );

    return translateBox(
      track.box,
      track.velocity[0] * steps,
      track.velocity[1] * steps,
    );
  }

  private bindByteTrack(
    byteTrackId: number,
    stableId: number,
  ): void {
    const previousStableId = this.byteToStable.get(byteTrackId);

    if (
      previousStableId !== undefined
      && previousStableId !== stableId
    ) {
      const previousTrack = this.tracks.get(previousStableId);

      if (previousTrack) {
        previousTrack.byteTrackId = null;
      }
    }

    for (const [oldByteId, mappedStableId] of this.byteToStable) {
      if (
        mappedStableId === stableId
        && oldByteId !== byteTrackId
      ) {
        this.byteToStable.delete(oldByteId);
      }
    }

    this.byteToStable.set(byteTrackId, stableId);

    const track = this.tracks.get(stableId);

    if (track) {
      track.byteTrackId = byteTrackId;
    }
  }

  private unbindByteTrack(
    byteTrackId: number,
    stableId: number,
  ): void {
    this.byteToStable.delete(byteTrackId);

    const track = this.tracks.get(stableId);

    if (track?.byteTrackId === byteTrackId) {
      track.byteTrackId = null;
    }
  }

  private createStableTrack(
    detection: CandidateDetection,
  ): number {
    const stableId = this.nextStableId;
    this.nextStableId += 1;

    this.tracks.set(stableId, {
      group: CLASS_GROUPS[detection.classId],
      box: [...detection.box],
      velocity: [0, 0],
      classId: detection.classId,
      className: detection.className,
      confidence: detection.confidence,
      byteTrackId: detection.trackId,
      missing: 0,
      lastSeenFrame: this.frameIndex,
      appearanceHistogram: null,
    });

    if (detection.trackId !== null) {
      this.bindByteTrack(detection.trackId, stableId);
    }

    return stableId;
  }

  private updateStableTrack(
    stableId: number,
    detection: CandidateDetection,
    seenByByteTrack: boolean,
  ): StableDetection {
    const track = this.tracks.get(stableId);

    if (!track) {
      throw new Error(`Stable track ${stableId} does not exist.`);
    }

    const oldCenter = boxCenter(track.box);
    const newCenter = boxCenter(detection.box);
    const elapsedFrames = Math.max(
      this.frameIndex - track.lastSeenFrame,
      1,
    );

    if (track.lastSeenFrame !== this.frameIndex) {
      const measuredVelocity: Point = [
        (newCenter[0] - oldCenter[0]) / elapsedFrames,
        (newCenter[1] - oldCenter[1]) / elapsedFrames,
      ];

      track.velocity = [
        0.60 * track.velocity[0] + 0.40 * measuredVelocity[0],
        0.60 * track.velocity[1] + 0.40 * measuredVelocity[1],
      ];
    }

    track.box = [...detection.box];
    track.classId = detection.classId;
    track.className = detection.className;
    track.confidence = detection.confidence;
    track.missing = 0;
    track.lastSeenFrame = this.frameIndex;

    if (seenByByteTrack && detection.trackId !== null) {
      this.bindByteTrack(detection.trackId, stableId);
    }

    return {
      classId: detection.classId,
      className: detection.className,
      confidence: detection.confidence,
      box: [...detection.box],
      trackId: stableId,
      byteTrackId: seenByByteTrack
        ? detection.trackId
        : track.byteTrackId,
      source: detection.source,
    };
  }

  private createTentativeTrack(
    detection: CandidateDetection,
  ): number {
    const tentativeId = this.nextTentativeId;
    this.nextTentativeId += 1;

    this.tentativeTracks.set(tentativeId, {
      group: CLASS_GROUPS[detection.classId],
      box: [...detection.box],
      velocity: [0, 0],
      classId: detection.classId,
      className: detection.className,
      confidence: detection.confidence,
      byteTrackId: detection.trackId,
      hits: 1,
      missing: 0,
      lastSeenFrame: this.frameIndex,
      appearanceHistogram: null,
      source: detection.source,
    });

    if (detection.trackId !== null) {
      this.bindTentativeByteTrack(
        detection.trackId,
        tentativeId,
      );
    }

    return tentativeId;
  }

  private bindTentativeByteTrack(
    byteTrackId: number,
    tentativeId: number,
  ): void {
    const previousTentativeId = this.byteToTentative.get(byteTrackId);

    if (
      previousTentativeId !== undefined
      && previousTentativeId !== tentativeId
    ) {
      const previousTrack = this.tentativeTracks.get(
        previousTentativeId,
      );

      if (previousTrack) {
        previousTrack.byteTrackId = null;
      }
    }

    for (const [oldByteId, mappedTentativeId] of this.byteToTentative) {
      if (
        mappedTentativeId === tentativeId
        && oldByteId !== byteTrackId
      ) {
        this.byteToTentative.delete(oldByteId);
      }
    }

    this.byteToTentative.set(byteTrackId, tentativeId);

    const track = this.tentativeTracks.get(tentativeId);

    if (track) {
      track.byteTrackId = byteTrackId;
    }
  }

  private updateTentativeTrack(
    tentativeId: number,
    detection: CandidateDetection,
  ): void {
    const track = this.tentativeTracks.get(tentativeId);

    if (!track) {
      return;
    }

    const oldCenter = boxCenter(track.box);
    const newCenter = boxCenter(detection.box);
    const elapsedFrames = Math.max(
      this.frameIndex - track.lastSeenFrame,
      1,
    );

    if (track.lastSeenFrame !== this.frameIndex) {
      const measuredVelocity: Point = [
        (newCenter[0] - oldCenter[0]) / elapsedFrames,
        (newCenter[1] - oldCenter[1]) / elapsedFrames,
      ];

      track.velocity = [
        0.60 * track.velocity[0] + 0.40 * measuredVelocity[0],
        0.60 * track.velocity[1] + 0.40 * measuredVelocity[1],
      ];
      track.hits += 1;
    }

    if (
      track.lastSeenFrame !== this.frameIndex
      || detection.confidence >= track.confidence
    ) {
      track.box = [...detection.box];
      track.classId = detection.classId;
      track.className = detection.className;
      track.confidence = detection.confidence;
      track.source = detection.source;
    }

    track.missing = 0;
    track.lastSeenFrame = this.frameIndex;

    if (detection.trackId !== null) {
      this.bindTentativeByteTrack(
        detection.trackId,
        tentativeId,
      );
    }
  }

  private handleUnmatchedDetection(
    detection: CandidateDetection,
    frameWidth: number,
    frameHeight: number,
  ): Promotion | null {
    let tentativeId = detection.trackId === null
      ? undefined
      : this.byteToTentative.get(detection.trackId);

    if (
      tentativeId !== undefined
      && !this.tentativeTracks.has(tentativeId)
    ) {
      tentativeId = undefined;
    }

    if (tentativeId === undefined) {
      let bestScore = Number.POSITIVE_INFINITY;

      for (const [candidateId, track] of this.tentativeTracks) {
        const score = this.associationScore(
          detection,
          track,
          frameWidth,
          frameHeight,
        );

        if (score !== null && score < bestScore) {
          bestScore = score;
          tentativeId = candidateId;
        }
      }
    }

    if (tentativeId === undefined) {
      tentativeId = this.createTentativeTrack(detection);
    } else {
      this.updateTentativeTrack(tentativeId, detection);
    }

    const tentative = this.tentativeTracks.get(tentativeId);

    if (!tentative || tentative.hits < this.confirmHits) {
      return null;
    }

    const promotedCandidate: CandidateDetection = {
      classId: tentative.classId,
      className: tentative.className,
      confidence: tentative.confidence,
      box: [...tentative.box],
      trackId: tentative.byteTrackId,
      source: tentative.source,
    };

    const stableId = this.createStableTrack(promotedCandidate);
    const stableTrack = this.tracks.get(stableId)!;
    stableTrack.velocity = [...tentative.velocity];
    this.removeTentativeTrack(tentativeId);

    return {
      stableId,
      detection: {
        classId: stableTrack.classId,
        className: stableTrack.className,
        confidence: stableTrack.confidence,
        box: [...stableTrack.box],
        trackId: stableId,
        byteTrackId: stableTrack.byteTrackId,
        source: "confirmed_new_track",
      },
    };
  }

  private ageTentativeTracks(): void {
    for (const [tentativeId, track] of this.tentativeTracks) {
      if (track.lastSeenFrame === this.frameIndex) {
        continue;
      }

      track.missing += 1;

      if (track.missing > this.tentativeMaxMissingFrames) {
        this.removeTentativeTrack(tentativeId);
      }
    }
  }

  private removeTentativeTrack(tentativeId: number): void {
    this.tentativeTracks.delete(tentativeId);

    for (const [byteTrackId, mappedTentativeId] of this.byteToTentative) {
      if (mappedTentativeId === tentativeId) {
        this.byteToTentative.delete(byteTrackId);
      }
    }
  }

  private removeExpiredTracks(): void {
    for (const [stableId, track] of this.tracks) {
      if (track.missing <= this.maxMissingFrames) {
        continue;
      }

      this.tracks.delete(stableId);
      this.currentOutput.delete(stableId);

      for (const [byteTrackId, mappedStableId] of this.byteToStable) {
        if (mappedStableId === stableId) {
          this.byteToStable.delete(byteTrackId);
        }
      }

      for (const pairKey of Array.from(this.activePlayerCrossings)) {
        const pair = parsePairKey(pairKey);

        if (pair.includes(stableId)) {
          this.activePlayerCrossings.delete(pairKey);
          this.observedPlayerCrossings.delete(pairKey);
        }
      }
    }
  }

  private detectionsMatch(
    detectionA: Pick<Detection, "classId" | "box">,
    detectionB: Pick<Detection, "classId" | "box">,
  ): boolean {
    const groupA = CLASS_GROUPS[detectionA.classId];
    const groupB = CLASS_GROUPS[detectionB.classId];

    if (groupA !== groupB) {
      return false;
    }

    const iou = boxIou(detectionA.box, detectionB.box);

    if (iou >= 0.35) {
      return true;
    }

    const centreA = boxCenter(detectionA.box);
    const centreB = boxCenter(detectionB.box);
    const normalisedDistance = pointDistance(centreA, centreB) / Math.max(
      boxDiagonal(detectionA.box),
      boxDiagonal(detectionB.box),
      1,
    );

    const areaA = boxArea(detectionA.box);
    const areaB = boxArea(detectionB.box);
    const areaRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB, 1);

    if (
      normalisedDistance <= 0.20
      && areaRatio >= 0.40
    ) {
      return true;
    }

    if (groupA === "basket") {
      const centreAInsideB = (
        centreA[0] >= detectionB.box[0]
        && centreA[0] <= detectionB.box[2]
        && centreA[1] >= detectionB.box[1]
        && centreA[1] <= detectionB.box[3]
      );
      const centreBInsideA = (
        centreB[0] >= detectionA.box[0]
        && centreB[0] <= detectionA.box[2]
        && centreB[1] >= detectionA.box[1]
        && centreB[1] <= detectionA.box[3]
      );

      return (
        normalisedDistance <= 0.35
        && (centreAInsideB || centreBInsideA)
      );
    }

    return false;
  }

  private markPredictedPlayerCrossings(): void {
    const playerTrackIds = Array.from(this.tracks.entries())
      .filter(([, track]) => track.group === "player")
      .map(([stableId]) => stableId);

    for (
      let indexA = 0;
      indexA < playerTrackIds.length;
      indexA += 1
    ) {
      for (
        let indexB = indexA + 1;
        indexB < playerTrackIds.length;
        indexB += 1
      ) {
        const stableIdA = playerTrackIds[indexA];
        const stableIdB = playerTrackIds[indexB];
        const trackA = this.tracks.get(stableIdA)!;
        const trackB = this.tracks.get(stableIdB)!;
        const pairKey = makePairKey(stableIdA, stableIdB);
        const actualOverlap = boxesIntersect(trackA.box, trackB.box);
        const predictedOverlap = boxesIntersect(
          this.predictedBox(trackA),
          this.predictedBox(trackB),
        );

        if (actualOverlap || predictedOverlap) {
          this.activePlayerCrossings.add(pairKey);
        }

        if (actualOverlap) {
          this.observedPlayerCrossings.add(pairKey);
        }
      }
    }
  }

  private resolvePlayerCrossings(
    source: FrameSource,
    output: readonly StableDetection[],
    snapshots: ReadonlyMap<number, StableTrackRecord>,
  ): StableDetection[] {
    const outputById = new Map<number, StableDetection>();

    for (const detection of output) {
      outputById.set(detection.trackId, detection);
    }

    const playerIds = Array.from(outputById.entries())
      .filter(([, detection]) => (
        CLASS_GROUPS[detection.classId] === "player"
      ))
      .map(([stableId]) => stableId);

    for (let indexA = 0; indexA < playerIds.length; indexA += 1) {
      for (
        let indexB = indexA + 1;
        indexB < playerIds.length;
        indexB += 1
      ) {
        const stableIdA = playerIds[indexA];
        const stableIdB = playerIds[indexB];
        const detectionA = outputById.get(stableIdA)!;
        const detectionB = outputById.get(stableIdB)!;

        if (boxesIntersect(detectionA.box, detectionB.box)) {
          const pairKey = makePairKey(stableIdA, stableIdB);
          this.activePlayerCrossings.add(pairKey);
          this.observedPlayerCrossings.add(pairKey);
        }
      }
    }

    for (const pairKey of Array.from(this.activePlayerCrossings)) {
      const [stableIdA, stableIdB] = parsePairKey(pairKey);

      if (
        !this.tracks.has(stableIdA)
        || !this.tracks.has(stableIdB)
      ) {
        this.activePlayerCrossings.delete(pairKey);
        this.observedPlayerCrossings.delete(pairKey);
        continue;
      }

      const detectionA = outputById.get(stableIdA);
      const detectionB = outputById.get(stableIdB);

      if (!detectionA || !detectionB) {
        continue;
      }

      if (boxesIntersect(detectionA.box, detectionB.box)) {
        continue;
      }

      if (!this.observedPlayerCrossings.has(pairKey)) {
        this.activePlayerCrossings.delete(pairKey);
        continue;
      }

      const snapshotA = snapshots.get(stableIdA);
      const snapshotB = snapshots.get(stableIdB);

      if (!snapshotA || !snapshotB) {
        this.activePlayerCrossings.delete(pairKey);
        this.observedPlayerCrossings.delete(pairKey);
        continue;
      }

      const previousHistogramA = snapshotA.appearanceHistogram;
      const previousHistogramB = snapshotB.appearanceHistogram;
      const currentHistogramA = this.playerHistogram(
        source,
        detectionA.box,
      );
      const currentHistogramB = this.playerHistogram(
        source,
        detectionB.box,
      );

      if (
        previousHistogramA
        && previousHistogramB
        && currentHistogramA
        && currentHistogramB
      ) {
        const currentCost = (
          histogramDistance(previousHistogramA, currentHistogramA)
          + histogramDistance(previousHistogramB, currentHistogramB)
        );
        const swappedCost = (
          histogramDistance(previousHistogramA, currentHistogramB)
          + histogramDistance(previousHistogramB, currentHistogramA)
        );

        if (swappedCost < currentCost) {
          this.tracks.set(stableIdA, cloneTrack(snapshotA));
          this.tracks.set(stableIdB, cloneTrack(snapshotB));

          for (const [byteTrackId, mappedStableId] of this.byteToStable) {
            if (
              mappedStableId === stableIdA
              || mappedStableId === stableIdB
            ) {
              this.byteToStable.delete(byteTrackId);
            }
          }

          this.tracks.get(stableIdA)!.byteTrackId = null;
          this.tracks.get(stableIdB)!.byteTrackId = null;

          const correctedA = this.applyCrossingDetection(
            stableIdA,
            detectionB,
          );
          const correctedB = this.applyCrossingDetection(
            stableIdB,
            detectionA,
          );

          outputById.set(stableIdA, correctedA);
          outputById.set(stableIdB, correctedB);
        }
      }

      this.activePlayerCrossings.delete(pairKey);
      this.observedPlayerCrossings.delete(pairKey);
    }

    return Array.from(outputById.values());
  }

  private applyCrossingDetection(
    stableId: number,
    detection: StableDetection,
  ): StableDetection {
    const track = this.tracks.get(stableId)!;

    track.box = [...detection.box];
    track.classId = detection.classId;
    track.className = detection.className;
    track.confidence = detection.confidence;
    track.missing = 0;
    track.lastSeenFrame = this.frameIndex;
    track.byteTrackId = detection.byteTrackId;

    if (detection.byteTrackId !== null) {
      this.bindByteTrack(detection.byteTrackId, stableId);
    }

    return {
      ...detection,
      box: [...detection.box],
      trackId: stableId,
      source: `${detection.source}_appearance_corrected`,
    };
  }

  private updatePlayerAppearanceHistograms(
    source: FrameSource,
    detections: readonly StableDetection[],
  ): void {
    const players = detections.filter(
      (detection) => CLASS_GROUPS[detection.classId] === "player",
    );

    const crossingTrackIds = new Set<number>();

    for (const pairKey of this.activePlayerCrossings) {
      const [stableIdA, stableIdB] = parsePairKey(pairKey);
      crossingTrackIds.add(stableIdA);
      crossingTrackIds.add(stableIdB);
    }

    for (const detection of players) {
      if (crossingTrackIds.has(detection.trackId)) {
        continue;
      }

      const overlapsAnotherPlayer = players.some(
        (other) => (
          other.trackId !== detection.trackId
          && boxesIntersect(detection.box, other.box)
        ),
      );

      if (overlapsAnotherPlayer) {
        continue;
      }

      const histogram = this.playerHistogram(
        source,
        detection.box,
      );
      const track = this.tracks.get(detection.trackId);

      if (histogram && track) {
        track.appearanceHistogram = histogram;
      }
    }
  }

  private playerHistogram(
    source: FrameSource,
    box: BoundingBox,
  ): Float32Array | null {
    const frame = getFrameDimensions(source);
    const x1 = Math.max(
      0,
      Math.min(Math.trunc(box[0]), frame.width - 1),
    );
    const y1 = Math.max(
      0,
      Math.min(Math.trunc(box[1]), frame.height - 1),
    );
    const x2 = Math.max(
      x1 + 1,
      Math.min(Math.trunc(box[2]), frame.width),
    );
    const y2 = Math.max(
      y1 + 1,
      Math.min(Math.trunc(box[3]), frame.height),
    );
    const cropWidth = x2 - x1;
    const cropHeight = y2 - y1;

    if (cropWidth <= 0 || cropHeight <= 0) {
      return null;
    }

    this.histogramCanvas.width = cropWidth;
    this.histogramCanvas.height = cropHeight;
    this.histogramContext.clearRect(0, 0, cropWidth, cropHeight);

    try {
      this.histogramContext.drawImage(
        source,
        x1,
        y1,
        cropWidth,
        cropHeight,
        0,
        0,
        cropWidth,
        cropHeight,
      );
    } catch {
      return null;
    }

    const imageData = this.histogramContext.getImageData(
      0,
      0,
      cropWidth,
      cropHeight,
    );

    const hueBins = 180;
    const saturationBins = 256;
    const histogram = new Float32Array(
      hueBins * saturationBins,
    );

    const centerX = Math.floor(cropWidth / 2);
    const centerY = Math.floor(cropHeight / 2);
    const radiusX = Math.max(Math.floor(cropWidth / 2) - 1, 1);
    const radiusY = Math.max(Math.floor(cropHeight / 2) - 1, 1);
    let total = 0;

    for (let y = 0; y < cropHeight; y += 1) {
      for (let x = 0; x < cropWidth; x += 1) {
        const normalisedX = (x - centerX) / radiusX;
        const normalisedY = (y - centerY) / radiusY;

        if (
          normalisedX * normalisedX
          + normalisedY * normalisedY
          > 1
        ) {
          continue;
        }

        const pixelIndex = (y * cropWidth + x) * 4;
        const [hue, saturation] = rgbToOpenCvHueSaturation(
          imageData.data[pixelIndex],
          imageData.data[pixelIndex + 1],
          imageData.data[pixelIndex + 2],
        );

        histogram[hue * saturationBins + saturation] += 1;
        total += 1;
      }
    }

    if (total <= 0) {
      return null;
    }

    for (let index = 0; index < histogram.length; index += 1) {
      histogram[index] /= total;
    }

    return histogram;
  }
}

function toCandidate(
  detection: ByteTrackedDetection,
  source: string,
): CandidateDetection {
  return {
    classId: detection.classId,
    className: detection.className,
    confidence: detection.confidence,
    box: [...detection.box],
    trackId: detection.trackId,
    source,
  };
}

function cloneTrack(track: StableTrackRecord): StableTrackRecord {
  return {
    ...track,
    box: [...track.box],
    velocity: [...track.velocity],
    appearanceHistogram: track.appearanceHistogram
      ? new Float32Array(track.appearanceHistogram)
      : null,
  };
}

function cloneStableDetections(
  detections: readonly StableDetection[],
): StableDetection[] {
  return detections.map((detection) => ({
    ...detection,
    box: [...detection.box],
  }));
}

function makePairKey(
  stableIdA: number,
  stableIdB: number,
): string {
  return stableIdA < stableIdB
    ? `${stableIdA}:${stableIdB}`
    : `${stableIdB}:${stableIdA}`;
}

function parsePairKey(pairKey: string): [number, number] {
  const [first, second] = pairKey.split(":");
  return [Number(first), Number(second)];
}

function rgbToOpenCvHueSaturation(
  redByte: number,
  greenByte: number,
  blueByte: number,
): [number, number] {
  const red = redByte / 255;
  const green = greenByte / 255;
  const blue = blueByte / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;

  let hueDegrees = 0;

  if (delta !== 0) {
    if (maximum === red) {
      hueDegrees = 60 * (((green - blue) / delta) % 6);
    } else if (maximum === green) {
      hueDegrees = 60 * ((blue - red) / delta + 2);
    } else {
      hueDegrees = 60 * ((red - green) / delta + 4);
    }

    if (hueDegrees < 0) {
      hueDegrees += 360;
    }
  }

  const saturation = maximum === 0
    ? 0
    : delta / maximum;

  return [
    Math.min(Math.max(Math.floor(hueDegrees / 2), 0), 179),
    Math.min(Math.max(Math.round(saturation * 255), 0), 255),
  ];
}

function histogramDistance(
  histogramA: Float32Array,
  histogramB: Float32Array,
): number {
  let coefficient = 0;

  for (let index = 0; index < histogramA.length; index += 1) {
    coefficient += Math.sqrt(
      histogramA[index] * histogramB[index],
    );
  }

  return Math.sqrt(Math.max(1 - coefficient, 0));
}
