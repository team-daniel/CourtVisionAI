import type {
  BoundingBox,
  Point,
} from "./detections";

export function boxArea(box: BoundingBox): number {
  return (
    Math.max(box[2] - box[0], 0)
    * Math.max(box[3] - box[1], 0)
  );
}

export function boxCenter(box: BoundingBox): Point {
  return [
    (box[0] + box[2]) / 2,
    (box[1] + box[3]) / 2,
  ];
}

export function boxDiagonal(box: BoundingBox): number {
  return Math.max(
    Math.hypot(
      Math.max(box[2] - box[0], 0),
      Math.max(box[3] - box[1], 0),
    ),
    1,
  );
}

export function boxIou(
  boxA: BoundingBox,
  boxB: BoundingBox,
): number {
  const intersectionX1 = Math.max(boxA[0], boxB[0]);
  const intersectionY1 = Math.max(boxA[1], boxB[1]);
  const intersectionX2 = Math.min(boxA[2], boxB[2]);
  const intersectionY2 = Math.min(boxA[3], boxB[3]);

  const intersectionArea = (
    Math.max(intersectionX2 - intersectionX1, 0)
    * Math.max(intersectionY2 - intersectionY1, 0)
  );

  const unionArea = (
    boxArea(boxA)
    + boxArea(boxB)
    - intersectionArea
  );

  return unionArea <= 0
    ? 0
    : intersectionArea / unionArea;
}

export function boxesIntersect(
  boxA: BoundingBox,
  boxB: BoundingBox,
): boolean {
  return (
    Math.min(boxA[2], boxB[2]) > Math.max(boxA[0], boxB[0])
    && Math.min(boxA[3], boxB[3]) > Math.max(boxA[1], boxB[1])
  );
}

export function clipBox(
  box: BoundingBox,
  width: number,
  height: number,
): BoundingBox {
  return [
    clamp(box[0], 0, width),
    clamp(box[1], 0, height),
    clamp(box[2], 0, width),
    clamp(box[3], 0, height),
  ];
}

export function translateBox(
  box: BoundingBox,
  deltaX: number,
  deltaY: number,
): BoundingBox {
  return [
    box[0] + deltaX,
    box[1] + deltaY,
    box[2] + deltaX,
    box[3] + deltaY,
  ];
}

export function pointDistance(
  pointA: Point,
  pointB: Point,
): number {
  return Math.hypot(
    pointA[0] - pointB[0],
    pointA[1] - pointB[1],
  );
}

export function distanceFromPointToBox(
  point: Point,
  box: BoundingBox,
): number {
  const deltaX = Math.max(
    box[0] - point[0],
    0,
    point[0] - box[2],
  );

  const deltaY = Math.max(
    box[1] - point[1],
    0,
    point[1] - box[3],
  );

  return Math.hypot(deltaX, deltaY);
}

export function pointInBox(
  point: Point,
  box: BoundingBox,
): boolean {
  return (
    point[0] >= box[0]
    && point[0] <= box[2]
    && point[1] >= box[1]
    && point[1] <= box[3]
  );
}

export function segmentIntersectsBox(
  start: Point,
  end: Point,
  box: BoundingBox,
): boolean {
  let minimumT = 0;
  let maximumT = 1;

  const deltaX = end[0] - start[0];
  const deltaY = end[1] - start[1];

  const checks: Array<[number, number]> = [
    [-deltaX, start[0] - box[0]],
    [deltaX, box[2] - start[0]],
    [-deltaY, start[1] - box[1]],
    [deltaY, box[3] - start[1]],
  ];

  for (const [p, q] of checks) {
    if (Math.abs(p) < Number.EPSILON) {
      if (q < 0) {
        return false;
      }
      continue;
    }

    const ratio = q / p;

    if (p < 0) {
      minimumT = Math.max(minimumT, ratio);
    } else {
      maximumT = Math.min(maximumT, ratio);
    }

    if (minimumT > maximumT) {
      return false;
    }
  }

  return true;
}

export function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(value, maximum));
}
