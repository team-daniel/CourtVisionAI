import {
  CLASS_GROUPS,
  SPECIFIC_CLASSES,
  getFrameDimensions,
  type BoundingBox,
  type ByteTrackedDetection,
  type Detection,
  type FrameSource,
  type RecoveryTarget,
} from "../core/detections";
import {
  boxCenter,
  boxIou,
  pointDistance,
} from "../core/geometry";
import { BasketballYolo } from "../inference/basketball-yolo";

export interface CropRecoveryOptions {
  enabled?: boolean;
  discoveryEnabled?: boolean;
  recoveryConfidence?: number;
  newObjectConfidence?: number;
  cropScale?: number;
  minimumCropSize?: number;
  recoveryMaximumDistance?: number;
  discoveryIntervalFrames?: number;
  effectiveFps?: number;
}

export interface RecoveredStableDetection {
  stableId: number;
  detection: Detection;
}

export interface CropRecoveryResult {
  recoveries: RecoveredStableDetection[];
  mappedDetections: Detection[];
  cropCount: number;
  recoveryMilliseconds: number;
}

interface CropRequest {
  cropBox: BoundingBox;
  target: RecoveryTarget | null;
}

const REFERENCE_FPS = 30;
const GROUP_DUPLICATE_IOU = 0.40;
const SAME_CLASS_DUPLICATE_IOU = 0.85;

export class CropRecovery {
  private readonly detector: BasketballYolo;
  private readonly enabled: boolean;
  private readonly discoveryEnabled: boolean;
  private readonly recoveryConfidence: number;
  private readonly newObjectConfidence: number;
  private readonly cropScale: number;
  private readonly minimumCropSize: number;
  private readonly recoveryMaximumDistance: number;
  private readonly referenceDiscoveryIntervalFrames: number;

  private effectiveFps = REFERENCE_FPS;
  private discoveryIntervalFrames = 15;
  private frameIndex = -1;

  private readonly cropCanvas: HTMLCanvasElement;
  private readonly cropContext: CanvasRenderingContext2D;

  constructor(
    detector: BasketballYolo,
    {
      enabled = true,
      discoveryEnabled = true,
      recoveryConfidence = 0.10,
      newObjectConfidence = 0.50,
      cropScale = 2.5,
      minimumCropSize = 320,
      recoveryMaximumDistance = 0.35,
      discoveryIntervalFrames = 15,
      effectiveFps = REFERENCE_FPS,
    }: CropRecoveryOptions = {},
  ) {
    this.detector = detector;
    this.enabled = enabled;
    this.discoveryEnabled = discoveryEnabled;
    this.recoveryConfidence = recoveryConfidence;
    this.newObjectConfidence = newObjectConfidence;
    this.cropScale = cropScale;
    this.minimumCropSize = minimumCropSize;
    this.recoveryMaximumDistance = recoveryMaximumDistance;
    this.referenceDiscoveryIntervalFrames =
      discoveryIntervalFrames;

    this.cropCanvas = document.createElement("canvas");

    const context = this.cropCanvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    if (!context) {
      throw new Error("Could not create the crop-recovery canvas.");
    }

    this.cropContext = context;
    this.configureTiming(effectiveFps);
  }

  configureTiming(effectiveFps: number): void {
    this.effectiveFps = Math.max(effectiveFps, 0.01);
    this.discoveryIntervalFrames = Math.max(
      1,
      Math.ceil(
        this.referenceDiscoveryIntervalFrames
        * this.effectiveFps
        / REFERENCE_FPS,
      ),
    );
  }

  reset(): void {
    this.frameIndex = -1;
  }

  async process(
    source: FrameSource,
    preparedFullDetections: readonly ByteTrackedDetection[],
    recoveryTargets: readonly RecoveryTarget[],
    sceneAcquired: boolean,
    stableIdForByteTrack: (byteTrackId: number) => number | null,
  ): Promise<CropRecoveryResult> {
    this.frameIndex += 1;

    if (!this.enabled) {
      return {
        recoveries: [],
        mappedDetections: [],
        cropCount: 0,
        recoveryMilliseconds: 0,
      };
    }

    const startedAt = performance.now();
    const { width, height } = getFrameDimensions(source);
    const requests: CropRequest[] = [];
    const cropKeys = new Set<string>();

    const addRequest = (
      box: BoundingBox,
      target: RecoveryTarget | null,
    ): void => {
      const cropBox = makeCropBox(
        box,
        width,
        height,
        this.cropScale,
        this.minimumCropSize,
      );

      const cropKey = cropBox
        .map((value) => Math.round(value))
        .join(":");

      if (cropKeys.has(cropKey)) {
        return;
      }

      cropKeys.add(cropKey);
      requests.push({ cropBox, target });
    };

    // Match Python: discovery/refinement crops are selected from prepared
    // full-frame tracked detections before missing-track recovery crops.
    if (this.discoveryEnabled) {
      const runDiscoverySweep = (
        !sceneAcquired
        || this.frameIndex % this.discoveryIntervalFrames === 0
      );

      for (const detection of preparedFullDetections) {
        const alreadyStable = (
          stableIdForByteTrack(detection.trackId) !== null
        );
        const group = CLASS_GROUPS[detection.classId];
        const lowConfidence = (
          detection.confidence < this.newObjectConfidence
        );

        const shouldCrop = (
          runDiscoverySweep
          || !alreadyStable
          || group === "ball"
          || lowConfidence
        );

        if (shouldCrop) {
          addRequest(detection.box, null);
        }
      }
    }

    for (const target of recoveryTargets) {
      addRequest(target.predictedBox, target);
    }

    const recoveries: RecoveredStableDetection[] = [];
    const mappedDetections: Detection[] = [];

    for (const request of requests) {
      const [cropX1, cropY1, cropX2, cropY2] = request.cropBox;
      const cropWidth = Math.max(Math.round(cropX2 - cropX1), 1);
      const cropHeight = Math.max(Math.round(cropY2 - cropY1), 1);

      this.cropCanvas.width = cropWidth;
      this.cropCanvas.height = cropHeight;
      this.cropContext.clearRect(0, 0, cropWidth, cropHeight);
      this.cropContext.drawImage(
        source,
        cropX1,
        cropY1,
        cropX2 - cropX1,
        cropY2 - cropY1,
        0,
        0,
        cropWidth,
        cropHeight,
      );

      // This intentionally uses the existing 960 ONNX model. Swapping in a
      // fixed 512 recovery model later requires no tracking changes.
      const result = await this.detector.detect(
        this.cropCanvas,
        this.recoveryConfidence,
      );

      const localDetections = deduplicateGroupDetections(
        result.detections,
      );

      const mapped = localDetections.map(
        (detection): Detection => ({
          ...detection,
          box: [
            detection.box[0] + cropX1,
            detection.box[1] + cropY1,
            detection.box[2] + cropX1,
            detection.box[3] + cropY1,
          ],
          trackId: null,
          source: "crop_detection",
        }),
      );

      mappedDetections.push(...mapped);

      if (!request.target) {
        continue;
      }

      const target = request.target;
      const targetCenter = boxCenter(target.predictedBox);
      const cropDiagonal = Math.max(
        Math.hypot(cropWidth, cropHeight),
        1,
      );

      const candidates = mapped
        .filter((detection) => (
          CLASS_GROUPS[detection.classId] === target.group
        ))
        .map((detection) => {
          const distance = pointDistance(
            boxCenter(detection.box),
            targetCenter,
          ) / cropDiagonal;

          return {
            detection,
            distance,
            score: distance - 0.20 * detection.confidence,
          };
        })
        .filter((candidate) => (
          candidate.distance <= this.recoveryMaximumDistance
        ))
        .sort(
          (candidateA, candidateB) => (
            candidateA.score - candidateB.score
          ),
        );

      const best = candidates[0]?.detection;

      if (best) {
        recoveries.push({
          stableId: target.stableId,
          detection: {
            ...best,
            box: [...best.box],
            source: "recovery_crop",
          },
        });
      }
    }

    return {
      recoveries,
      mappedDetections,
      cropCount: requests.length,
      recoveryMilliseconds: performance.now() - startedAt,
    };
  }
}

function makeCropBox(
  box: BoundingBox,
  frameWidth: number,
  frameHeight: number,
  cropScale: number,
  minimumCropSize: number,
): BoundingBox {
  const centerX = (box[0] + box[2]) / 2;
  const centerY = (box[1] + box[3]) / 2;
  const boxWidth = Math.max(box[2] - box[0], 1);
  const boxHeight = Math.max(box[3] - box[1], 1);

  const side = Math.min(
    Math.max(
      Math.max(boxWidth, boxHeight) * cropScale,
      minimumCropSize,
    ),
    Math.min(frameWidth, frameHeight),
  );

  const cropX1 = Math.min(
    Math.max(centerX - side / 2, 0),
    Math.max(frameWidth - side, 0),
  );
  const cropY1 = Math.min(
    Math.max(centerY - side / 2, 0),
    Math.max(frameHeight - side, 0),
  );

  return [
    Math.round(cropX1),
    Math.round(cropY1),
    Math.round(cropX1 + side),
    Math.round(cropY1 + side),
  ];
}

function deduplicateGroupDetections(
  detections: readonly Detection[],
): Detection[] {
  const ordered = detections
    .map((detection) => ({
      ...detection,
      box: [...detection.box] as BoundingBox,
    }))
    .sort(
      (detectionA, detectionB) => (
        detectionB.confidence - detectionA.confidence
      ),
    );

  const kept: Detection[] = [];

  for (const detection of ordered) {
    const group = CLASS_GROUPS[detection.classId];
    let duplicate: Detection | null = null;

    for (const existing of kept) {
      if (CLASS_GROUPS[existing.classId] !== group) {
        continue;
      }

      const threshold = detection.classId === existing.classId
        ? SAME_CLASS_DUPLICATE_IOU
        : GROUP_DUPLICATE_IOU;

      if (boxIou(detection.box, existing.box) >= threshold) {
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
