import {
  getFrameDimensions,
  type ClassId,
  type FrameSource,
  type StableDetection,
} from "../core/detections";
import type { GameSnapshot } from "../game/game-mode";
import type { PipelineFrameResult } from "../processing/basketball-pipeline";

export interface DrawOverlayOptions {
  maximumWidth?: number;
  playerLabel?: (
    trackId: number | null,
  ) => string | null;
}

export function drawPipelineFrame(
  canvas: HTMLCanvasElement,
  source: FrameSource,
  result: PipelineFrameResult,
  {
    maximumWidth = 1280,
    playerLabel,
  }: DrawOverlayOptions = {},
): void {
  const context = getCanvasContext(canvas);
  const { width, height } = getFrameDimensions(source);
  const scale = Math.min(maximumWidth / width, 1);

  canvas.width = Math.max(Math.round(width * scale), 1);
  canvas.height = Math.max(Math.round(height * scale), 1);

  context.drawImage(
    source,
    0,
    0,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  drawDetections(
    context,
    result.detections,
    scale,
    canvas.height,
    playerLabel,
  );

  drawGameStatus(
    context,
    result.game,
    result,
    canvas.width,
    canvas.height,
  );
}

function drawDetections(
  context: CanvasRenderingContext2D,
  detections: readonly StableDetection[],
  scale: number,
  canvasHeight: number,
  playerLabel?: (
    trackId: number | null,
  ) => string | null,
): void {
  const lineWidth = Math.max(
    2,
    canvasHeight / 400,
  );

  const fontSize = Math.max(
    13,
    canvasHeight / 40,
  );

  context.lineWidth = lineWidth;
  context.font = `600 ${fontSize}px system-ui`;
  context.textBaseline = "alphabetic";

  for (const detection of detections) {
    const x1 = detection.box[0] * scale;
    const y1 = detection.box[1] * scale;
    const x2 = detection.box[2] * scale;
    const y2 = detection.box[3] * scale;

    const colour = detectionColour(
      detection.classId,
      playerLabel?.(detection.trackId) ?? null,
    );

    context.strokeStyle = colour;
    context.fillStyle = colour;

    context.strokeRect(
      x1,
      y1,
      x2 - x1,
      y2 - y1,
    );

    const participantLabel = playerLabel?.(
      detection.trackId,
    );

    const label = participantLabel
      ? `${participantLabel} · ${detection.className}`
      : `${detection.className} · ID ${detection.trackId}`;

    const textMetrics = context.measureText(label);
    const textHeight = Math.max(fontSize + 9, 24);
    const labelY = Math.max(y1 - textHeight, 0);

    context.fillRect(
      x1,
      labelY,
      textMetrics.width + 16,
      textHeight,
    );

    context.fillStyle = "#ffffff";

    context.fillText(
      label,
      x1 + 8,
      labelY + textHeight - 7,
    );
  }
}

function drawGameStatus(
  context: CanvasRenderingContext2D,
  game: GameSnapshot,
  result: PipelineFrameResult,
  canvasWidth: number,
  canvasHeight: number,
): void {
  const padding = Math.max(12, canvasHeight / 50);
  const titleSize = Math.max(14, canvasHeight / 34);
  const bodySize = Math.max(12, canvasHeight / 45);

  const panelWidth = Math.min(
    Math.max(canvasWidth * 0.44, 300),
    canvasWidth - padding * 2,
  );

  const panelHeight = Math.max(
    titleSize + bodySize * 2 + padding * 2.8,
    86,
  );

  context.fillStyle = "rgba(18, 20, 25, 0.78)";
  context.fillRect(
    padding,
    padding,
    panelWidth,
    panelHeight,
  );

  context.fillStyle = "#ffffff";
  context.font = `700 ${titleSize}px system-ui`;
  context.fillText(
    game.state,
    padding * 1.6,
    padding + titleSize + 4,
  );

  context.font = `600 ${bodySize}px system-ui`;

  const participantText = game.participants
    .map(
      (participant) =>
        `${participant.label}: ${participant.makes}/${participant.attempts}`,
    )
    .join("   ");

  context.fillText(
    participantText,
    padding * 1.6,
    padding + titleSize + bodySize + 14,
  );

  context.font = `500 ${Math.max(bodySize - 1, 11)}px system-ui`;
  context.fillStyle = "rgba(255, 255, 255, 0.82)";

  context.fillText(
    [
      `${result.timings.totalMilliseconds.toFixed(0)} ms/frame`,
      `${result.detections.length} tracked`,
      `${result.timings.recoveryCropCount} recovery crops`,
    ].join(" · "),
    padding * 1.6,
    padding + titleSize + bodySize * 2 + 22,
  );
}

function detectionColour(
  classId: ClassId,
  participantLabel: string | null,
): string {
  if (participantLabel === "Player A") {
    return "#ff8a2a";
  }

  if (participantLabel === "Player B") {
    return "#37a6ff";
  }

  switch (classId) {
    case 0:
      return "#ff4f0a";

    case 1:
      return "#20b35a";

    case 2:
      return "#ffb13b";

    case 3:
      return "#20b35a";

    case 4:
      return "#a45de8";
  }
}

function getCanvasContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Could not create the preview canvas context.",
    );
  }

  return context;
}
