export type ClassId = 0 | 1 | 2;
export type BoundingBox = [number, number, number, number];
export type Point = [number, number];
export type DetectionGroup = "ball" | "player" | "basket";
export type FrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;
export type ObservationState = "observed" | "low_confidence" | "predicted" | "interpolated" | "reference";

export interface Detection {
  classId: ClassId;
  className: string;
  confidence: number;
  box: BoundingBox;
  trackId: number | null;
  source?: string;
  state?: ObservationState;
  rawTrackId?: number | null;
  participantId?: number | null;
  identitySegment?: number | null;
  identityState?: string;
}
export interface StableDetection extends Detection { trackId: number; source: string }
export const CLASS_NAMES: Record<ClassId, string> = { 0: "Ball", 1: "Player", 2: "Basket" };
export const CLASS_GROUPS: Record<ClassId, DetectionGroup> = { 0: "ball", 1: "player", 2: "basket" };
export function getFrameDimensions(source: FrameSource): { width: number; height: number } {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight };
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return { width: source.naturalWidth, height: source.naturalHeight };
  return { width: source.width, height: source.height };
}
export function cloneDetection<T extends Detection>(d: T): T { return { ...d, box: [...d.box] }; }
export function center(b: BoundingBox): Point { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }
export function distance(a: Point, b: Point): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
export function boxDistance(p: Point, b: BoundingBox): number { return Math.hypot(Math.max(b[0] - p[0], 0, p[0] - b[2]), Math.max(b[1] - p[1], 0, p[1] - b[3])); }
export function overlap(a: BoundingBox, b: BoundingBox, inclusive = 0): number {
  const area = (v: BoundingBox) => Math.max(0, v[2] - v[0] + inclusive) * Math.max(0, v[3] - v[1] + inclusive);
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]) + inclusive) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]) + inclusive);
  return intersection / Math.max(area(a) + area(b) - intersection, 1e-12);
}
