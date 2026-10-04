export type ClassId = 0 | 1 | 2 | 3 | 4;
export type BoundingBox = [number, number, number, number];
export type Point = [number, number];
export type DetectionGroup = "ball" | "basket" | "player";

export type FrameSource =
  | HTMLVideoElement
  | HTMLImageElement
  | HTMLCanvasElement
  | ImageBitmap
  | OffscreenCanvas;

export interface Detection {
  classId: ClassId;
  className: string;
  confidence: number;
  box: BoundingBox;
  trackId: number | null;
  source?: string;
}

export interface ByteTrackedDetection
  extends Omit<Detection, "trackId"> {
  trackId: number;
  source: string;
}

export interface StableDetection
  extends Omit<Detection, "trackId"> {
  trackId: number;
  byteTrackId: number | null;
  source: string;
}

export interface RecoveryTarget {
  stableId: number;
  group: DetectionGroup;
  predictedBox: BoundingBox;
  missingFrames: number;
}

export const CLASS_NAMES: Record<ClassId, string> = {
  0: "Ball",
  1: "Ball in Basket",
  2: "Player",
  3: "Basket",
  4: "Player Shooting",
};

export const CLASS_GROUPS: Record<ClassId, DetectionGroup> = {
  0: "ball",
  1: "basket",
  2: "player",
  3: "basket",
  4: "player",
};

export const SPECIFIC_CLASSES = new Set<ClassId>([1, 4]);

export function getFrameDimensions(
  source: FrameSource,
): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return {
      width: source.videoWidth,
      height: source.videoHeight,
    };
  }

  if (source instanceof HTMLImageElement) {
    return {
      width: source.naturalWidth,
      height: source.naturalHeight,
    };
  }

  return {
    width: source.width,
    height: source.height,
  };
}

export function cloneDetection<T extends Detection>(
  detection: T,
): T {
  return {
    ...detection,
    box: [...detection.box] as BoundingBox,
  };
}
