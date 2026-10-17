
import {
  CLASS_GROUPS,
  CLASS_NAMES,
  type Detection,
  type BoundingBox,
} from "./detections";
import { boxArea, boxCenter, boxIou } from "./geometry";

const SAME_CLASS_DUPLICATE_IOU = 0.85;


export function samePlayerBox(a: BoundingBox, b: BoundingBox): boolean {
  if (boxIou(a, b) >= 0.70) return true;

  const areaA = boxArea(a);
  const areaB = boxArea(b);
  if (!areaA || !areaB) return false;

  const intersection =
    Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

  const containment = intersection / Math.min(areaA, areaB);
  const sizeRatio = Math.min(areaA, areaB) / Math.max(areaA, areaB);
  const [ax, ay] = boxCenter(a);
  const [bx, by] = boxCenter(b);
  const width = Math.max(a[2] - a[0], b[2] - b[0]);
  const height = Math.max(a[3] - a[1], b[3] - b[1]);

  return containment >= 0.90
    && sizeRatio >= 0.30
    && Math.abs(ax - bx) <= width * 0.15
    && Math.abs(ay - by) <= height * 0.18;
}


export function deduplicateDetections<T extends Detection>(
  detections: readonly T[],
): T[] {
  const ordered = [...detections].sort(
    (a, b) => b.confidence - a.confidence,
  );

  const kept: T[] = [];

  for (const detection of ordered) {
    const group = CLASS_GROUPS[detection.classId];

    const index = kept.findIndex((existing) => {
      const samePlayerGroup =
        group === "player"
        && CLASS_GROUPS[existing.classId] === "player";

      if (samePlayerGroup) {
        return samePlayerBox(existing.box, detection.box);
      }

      return (
        existing.classId === detection.classId
        && boxIou(existing.box, detection.box) >= SAME_CLASS_DUPLICATE_IOU
      );
    });

    if (index === -1) {
      kept.push({
        ...detection,
        box: [...detection.box],
      } as T);
      continue;
    }

    const existing = kept[index];
    const shooting = group === "player"
      && (existing.classId === 4 || detection.classId === 4);

    kept[index] = {
      ...existing,
      classId: shooting ? 4 : existing.classId,
      className: shooting ? CLASS_NAMES[4] : existing.className,
      confidence: Math.max(
        existing.confidence,
        detection.confidence,
      ),
    } as T;
  }

  return kept;
}
