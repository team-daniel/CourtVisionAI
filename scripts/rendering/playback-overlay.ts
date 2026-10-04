import type {
  ClassId,
  BoundingBox,
} from "../core/detections";
import type {
  PlaybackFrame,
  PlaybackDetection,
} from "../storage/session-store";

export function drawPlaybackOverlay(
  canvas: HTMLCanvasElement,
  frame: PlaybackFrame,
  sourceWidth: number,
  sourceHeight: number,
): void {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Could not create the playback overlay context.",
    );
  }

  if (
    canvas.width !== sourceWidth
    || canvas.height !== sourceHeight
  ) {
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
  }

  context.clearRect(0, 0, sourceWidth, sourceHeight);

  const labelsByTrackId = new Map<number, string>();

  for (const participant of frame.game.participants) {
    if (participant.trackId !== null) {
      labelsByTrackId.set(
        participant.trackId,
        participant.label,
      );
    }
  }

  for (const detection of frame.detections) {
    drawDetection(
      context,
      detection,
      labelsByTrackId.get(detection.trackId) ?? null,
      sourceHeight,
    );
  }
}

export function clearPlaybackOverlay(
  canvas: HTMLCanvasElement,
): void {
  const context = canvas.getContext("2d");

  context?.clearRect(
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

function drawDetection(
  context: CanvasRenderingContext2D,
  detection: PlaybackDetection,
  participantLabel: string | null,
  sourceHeight: number,
): void {
  const [x1, y1, x2, y2] = detection.box;
  const colour = detectionColour(
    detection.classId,
    participantLabel,
  );

  const lineWidth = Math.max(3, sourceHeight / 360);
  const fontSize = Math.max(18, sourceHeight / 30);

  context.lineWidth = lineWidth;
  context.strokeStyle = colour;
  context.fillStyle = colour;
  context.strokeRect(
    x1,
    y1,
    x2 - x1,
    y2 - y1,
  );

  const label = detectionLabel(
    detection,
    participantLabel,
  );

  context.font = `700 ${fontSize}px system-ui`;
  context.textBaseline = "alphabetic";

  const metrics = context.measureText(label);
  const labelHeight = fontSize + 14;
  const labelY = Math.max(y1 - labelHeight, 0);
  const labelWidth = metrics.width + 22;

  context.fillRect(
    x1,
    labelY,
    labelWidth,
    labelHeight,
  );

  context.fillStyle = "#ffffff";
  context.fillText(
    label,
    x1 + 11,
    labelY + labelHeight - 9,
  );
}

function detectionLabel(
  detection: PlaybackDetection,
  participantLabel: string | null,
): string {
  if (participantLabel) {
    if (detection.classId === 4) {
      return `${participantLabel} · Shooting`;
    }

    return participantLabel;
  }

  switch (detection.classId) {
    case 0:
      return "Ball";

    case 1:
      return "Ball in basket";

    case 3:
      return "Basket";

    default:
      return `${detection.className} · ${Math.round(
        detection.confidence * 100,
      )}%`;
  }
}

function detectionColour(
  classId: ClassId,
  participantLabel: string | null,
): string {
  if (participantLabel === "Player A") {
    return "#ff5a16";
  }

  if (participantLabel === "Player B") {
    return "#25303a";
  }

  switch (classId) {
    case 0:
      return "#ff5a16";

    case 1:
      return "#25ad55";

    case 2:
      return "#ff9a45";

    case 3:
      return "#25ad55";

    case 4:
      return "#9156d8";
  }
}

export function scaleBox(
  box: BoundingBox,
  scaleX: number,
  scaleY: number,
): BoundingBox {
  return [
    box[0] * scaleX,
    box[1] * scaleY,
    box[2] * scaleX,
    box[3] * scaleY,
  ];
}
