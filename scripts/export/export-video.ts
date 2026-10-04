import type {
  PlaybackDetection,
  PlaybackFrame,
  StoredSession,
} from "../storage/session-store";

export type ExportFormat =
  | "landscape"
  | "portrait";

export interface ExportVideoOptions {
  format: ExportFormat;
  showBoxes: boolean;
  showStats: boolean;
  onProgress?: (progress: number) => void;
}

export interface ExportedVideo {
  blob: Blob;
  extension: "mp4" | "webm";
}

interface SourceView {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface Point {
  x: number;
  y: number;
}

const EXPORT_FPS = 30;

const LANDSCAPE_SIZE = {
  width: 1280,
  height: 720,
};

const PORTRAIT_SIZE = {
  width: 720,
  height: 1280,
};

const BALL_CLASS_ID = 0;
const BALL_IN_BASKET_CLASS_ID = 1;

const WATERMARK_ICON_URL = new URL(
  "../../assets/icons/basketball.svg",
  import.meta.url,
).href;

export async function exportSessionVideo(
  session: StoredSession,
  options: ExportVideoOptions,
): Promise<ExportedVideo> {
  const size =
    options.format === "portrait"
      ? PORTRAIT_SIZE
      : LANDSCAPE_SIZE;

  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Could not create the export canvas.",
    );
  }

  const video = document.createElement("video");
  const videoUrl = URL.createObjectURL(
    session.videoBlob,
  );

  video.src = videoUrl;
  video.preload = "auto";
  video.playsInline = true;

  await waitForMediaEvent(
    video,
    "loadedmetadata",
  );

  const watermarkIconImage =
    await loadImage(WATERMARK_ICON_URL);

  const accentColour =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim()
    || "#f06424";

  const watermarkIcon =
    tintImage(
      watermarkIconImage,
      accentColour,
    );

  const canvasStream =
    canvas.captureStream(EXPORT_FPS);

  const audio = await createAudioStream(video);

  const outputStream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audio.stream.getAudioTracks(),
  ]);

  const mimeType =
    chooseRecordingMimeType();

  const recorder = new MediaRecorder(
    outputStream,
    {
      mimeType,
      videoBitsPerSecond:
        options.format === "portrait"
          ? 8_000_000
          : 7_000_000,
      audioBitsPerSecond: 160_000,
    },
  );

  const chunks: Blob[] = [];

  recorder.addEventListener(
    "dataavailable",
    (event: BlobEvent): void => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    },
  );

  let lastBallPosition: Point | null = null;
  let smoothedBallPosition: Point | null = null;
  let stopped = false;

  const render = (): void => {
    if (stopped) {
      return;
    }

    const frame = frameAtOrBefore(
      session.frames,
      video.currentTime,
    );

    const detectedBall =
      frame
        ? ballCentre(frame)
        : null;

    if (detectedBall) {
      lastBallPosition = detectedBall;
    }

    const targetBall =
      detectedBall ?? lastBallPosition;

    if (targetBall) {
      smoothedBallPosition =
        smoothPoint(
          smoothedBallPosition,
          targetBall,
          0.16,
        );
    }

    const sourceView = createSourceView(
      session.width,
      session.height,
      canvas.width,
      canvas.height,
      options.format,
      smoothedBallPosition,
    );

    drawBaseVideo(
      context,
      video,
      sourceView,
      canvas.width,
      canvas.height,
    );

    if (frame && options.showBoxes) {
      drawDetections(
        context,
        frame,
        sourceView,
        canvas.width,
        canvas.height,
      );
    }

    if (frame && options.showStats) {
      drawStats(
        context,
        frame,
        canvas.width,
        canvas.height,
        options.format,
      );
    }

    drawWatermark(
      context,
      watermarkIcon,
      canvas.width,
      canvas.height,
      options.format,
    );

    options.onProgress?.(
      session.durationSeconds > 0
        ? Math.min(
            video.currentTime
              / session.durationSeconds,
            1,
          )
        : 0,
    );

    scheduleNextVideoFrame(
      video,
      render,
    );
  };

  try {
    recorder.start(1000);
    render();

    await audio.resume();

    try {
      await video.play();
    } catch {
      video.muted = true;
      await video.play();
    }

    await waitForMediaEvent(
      video,
      "ended",
    );

    stopped = true;

    await stopRecorder(recorder);

    options.onProgress?.(1);

    const finalMimeType =
      recorder.mimeType || mimeType;

    return {
      blob: new Blob(
        chunks,
        {
          type: finalMimeType,
        },
      ),
      extension:
        finalMimeType.includes("mp4")
          ? "mp4"
          : "webm",
    };
  } finally {
    stopped = true;
    video.pause();

    for (
      const track
      of outputStream.getTracks()
    ) {
      track.stop();
    }

    await audio.close();

    URL.revokeObjectURL(videoUrl);
  }
}

export function downloadExportedVideo(
  exportedVideo: ExportedVideo,
  originalVideoName: string,
  format: ExportFormat,
): void {
  const baseName = originalVideoName
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\- ]+/g, "")
    .trim()
    || "courtvision-session";

  const fileName = [
    baseName,
    format,
    "courtvision",
  ].join("-");

  const url =
    URL.createObjectURL(exportedVideo.blob);

  const anchor =
    document.createElement("a");

  anchor.href = url;
  anchor.download =
    `${fileName}.${exportedVideo.extension}`;

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  window.setTimeout(
    () => URL.revokeObjectURL(url),
    1000,
  );
}

function createSourceView(
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  format: ExportFormat,
  ballPosition: Point | null,
): SourceView {
  if (format === "landscape") {
    const scale = Math.min(
      outputWidth / sourceWidth,
      outputHeight / sourceHeight,
    );

    const width = sourceWidth * scale;
    const height = sourceHeight * scale;

    return {
      sx: 0,
      sy: 0,
      sw: sourceWidth,
      sh: sourceHeight,
      dx: (outputWidth - width) / 2,
      dy: (outputHeight - height) / 2,
      dw: width,
      dh: height,
    };
  }

  const outputAspect =
    outputWidth / outputHeight;

  const sourceAspect =
    sourceWidth / sourceHeight;

  if (sourceAspect >= outputAspect) {
    const cropWidth =
      sourceHeight * outputAspect;

    const desiredCentreX =
      ballPosition?.x
      ?? sourceWidth / 2;

    const sx = clamp(
      desiredCentreX - cropWidth / 2,
      0,
      sourceWidth - cropWidth,
    );

    return {
      sx,
      sy: 0,
      sw: cropWidth,
      sh: sourceHeight,
      dx: 0,
      dy: 0,
      dw: outputWidth,
      dh: outputHeight,
    };
  }

  const cropHeight =
    sourceWidth / outputAspect;

  const desiredCentreY =
    ballPosition?.y
    ?? sourceHeight / 2;

  const sy = clamp(
    desiredCentreY - cropHeight / 2,
    0,
    sourceHeight - cropHeight,
  );

  return {
    sx: 0,
    sy,
    sw: sourceWidth,
    sh: cropHeight,
    dx: 0,
    dy: 0,
    dw: outputWidth,
    dh: outputHeight,
  };
}

function drawBaseVideo(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  view: SourceView,
  outputWidth: number,
  outputHeight: number,
): void {
  context.fillStyle = "#101214";
  context.fillRect(
    0,
    0,
    outputWidth,
    outputHeight,
  );

  context.drawImage(
    video,
    view.sx,
    view.sy,
    view.sw,
    view.sh,
    view.dx,
    view.dy,
    view.dw,
    view.dh,
  );
}

function drawDetections(
  context: CanvasRenderingContext2D,
  frame: PlaybackFrame,
  view: SourceView,
  outputWidth: number,
  outputHeight: number,
): void {
  const labelsByTrackId =
    new Map<number, string>();

  for (
    const participant
    of frame.game.participants
  ) {
    if (participant.trackId !== null) {
      labelsByTrackId.set(
        participant.trackId,
        participant.label,
      );
    }
  }

  context.save();
  context.beginPath();
  context.rect(
    view.dx,
    view.dy,
    view.dw,
    view.dh,
  );
  context.clip();

  for (
    const detection
    of frame.detections
  ) {
    drawDetection(
      context,
      detection,
      labelsByTrackId.get(
        detection.trackId,
      ) ?? null,
      view,
      outputWidth,
      outputHeight,
    );
  }

  context.restore();
}

function drawDetection(
  context: CanvasRenderingContext2D,
  detection: PlaybackDetection,
  participantLabel: string | null,
  view: SourceView,
  outputWidth: number,
  outputHeight: number,
): void {
  const scaleX = view.dw / view.sw;
  const scaleY = view.dh / view.sh;

  const x1 =
    view.dx
    + (detection.box[0] - view.sx)
    * scaleX;

  const y1 =
    view.dy
    + (detection.box[1] - view.sy)
    * scaleY;

  const x2 =
    view.dx
    + (detection.box[2] - view.sx)
    * scaleX;

  const y2 =
    view.dy
    + (detection.box[3] - view.sy)
    * scaleY;

  if (
    x2 < 0
    || y2 < 0
    || x1 > outputWidth
    || y1 > outputHeight
  ) {
    return;
  }

  const colour =
    detectionColour(
      detection.classId,
      participantLabel,
    );

  const lineWidth = Math.max(
    3,
    outputHeight / 320,
  );

  const fontSize = Math.max(
    16,
    outputHeight / 40,
  );

  context.lineWidth = lineWidth;
  context.strokeStyle = colour;
  context.fillStyle = colour;

  context.strokeRect(
    x1,
    y1,
    x2 - x1,
    y2 - y1,
  );

  const label =
    detectionLabel(
      detection,
      participantLabel,
    );

  context.font =
    `700 ${fontSize}px system-ui`;

  context.textBaseline = "alphabetic";

  const metrics =
    context.measureText(label);

  const labelHeight =
    fontSize + 12;

  const labelWidth =
    metrics.width + 18;

  const labelY = Math.max(
    y1 - labelHeight,
    view.dy,
  );

  context.fillRect(
    x1,
    labelY,
    labelWidth,
    labelHeight,
  );

  context.fillStyle = "#ffffff";

  context.fillText(
    label,
    x1 + 9,
    labelY + labelHeight - 8,
  );
}

function drawStats(
  context: CanvasRenderingContext2D,
  frame: PlaybackFrame,
  width: number,
  height: number,
  format: ExportFormat,
): void {
  const playerA =
    frame.game.participants.find(
      (participant) =>
        participant.key === "A",
    );

  const playerB =
    frame.game.participants.find(
      (participant) =>
        participant.key === "B",
    );

  const padding =
    format === "portrait"
      ? 26
      : 22;

  const panelHeight =
    format === "portrait"
      ? 138
      : 94;

  const panelY =
    height - panelHeight - padding;

  roundedRect(
    context,
    padding,
    panelY,
    width - padding * 2,
    panelHeight,
    22,
  );

  context.fillStyle =
    "rgba(16, 18, 20, 0.82)";
  context.fill();

  const scoreFont =
    format === "portrait"
      ? 39
      : 31;

  const smallFont =
    format === "portrait"
      ? 18
      : 15;

  context.textBaseline = "middle";
  context.fillStyle = "#ffffff";
  context.font =
    `800 ${scoreFont}px system-ui`;
  context.textAlign = "center";

  context.fillText(
    `${playerA?.makes ?? 0}  –  ${playerB?.makes ?? 0}`,
    width / 2,
    panelY + panelHeight * 0.42,
  );

  context.font =
    `700 ${smallFont}px system-ui`;
  context.fillStyle =
    "rgba(255,255,255,0.78)";

  context.textAlign = "left";
  context.fillText(
    playerStatLine("A", playerA),
    padding + 22,
    panelY + panelHeight * 0.76,
  );

  context.textAlign = "right";
  context.fillText(
    playerStatLine("B", playerB),
    width - padding - 22,
    panelY + panelHeight * 0.76,
  );
}

function playerStatLine(
  label: "A" | "B",
  participant:
    PlaybackFrame["game"]["participants"][number]
    | undefined,
): string {
  const rebounds =
    (
      participant as
        | (
          typeof participant
          & { rebounds?: number }
        )
        | undefined
    )?.rebounds
    ?? 0;

  return [
    `Player ${label}`,
    `${participant?.makes ?? 0}/${participant?.attempts ?? 0} FG`,
    `${rebounds} REB`,
  ].join(" · ");
}

function drawWatermark(
  context: CanvasRenderingContext2D,
  icon: CanvasImageSource,
  width: number,
  height: number,
  format: ExportFormat,
): void {
  const margin =
    format === "portrait"
      ? 26
      : 22;

  const fontSize =
    format === "portrait"
      ? 24
      : 20;

  const iconSize =
    format === "portrait"
      ? 29
      : 25;

  const text = "CourtVisionAI";

  context.font =
    `800 ${fontSize}px system-ui`;

  const textWidth =
    context.measureText(text).width;

  const pillWidth =
    20
    + iconSize
    + 10
    + textWidth
    + 18;

  const pillHeight = Math.max(
    iconSize + 18,
    fontSize + 22,
  );

  const x =
    width - pillWidth - margin;
  const y = margin;

  roundedRect(
    context,
    x,
    y,
    pillWidth,
    pillHeight,
    pillHeight / 2,
  );

  context.fillStyle =
    "rgba(16, 18, 20, 0.76)";
  context.fill();

  context.drawImage(
    icon,
    x + 10,
    y + (pillHeight - iconSize) / 2,
    iconSize,
    iconSize,
  );

  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "middle";

  context.fillText(
    text,
    x + 10 + iconSize + 10,
    y + pillHeight / 2,
  );
}

function ballCentre(
  frame: PlaybackFrame,
): Point | null {
  const detection =
    frame.detections.find(
      (candidate) =>
        candidate.classId
        === BALL_CLASS_ID,
    )
    ?? frame.detections.find(
      (candidate) =>
        candidate.classId
        === BALL_IN_BASKET_CLASS_ID,
    );

  if (!detection) {
    return null;
  }

  return {
    x:
      (
        detection.box[0]
        + detection.box[2]
      ) / 2,
    y:
      (
        detection.box[1]
        + detection.box[3]
      ) / 2,
  };
}

function smoothPoint(
  current: Point | null,
  target: Point,
  amount: number,
): Point {
  if (!current) {
    return target;
  }

  return {
    x:
      current.x
      + (target.x - current.x)
      * amount,
    y:
      current.y
      + (target.y - current.y)
      * amount,
  };
}

function frameAtOrBefore(
  frames: readonly PlaybackFrame[],
  timestampSeconds: number,
): PlaybackFrame | null {
  if (frames.length === 0) {
    return null;
  }

  let low = 0;
  let high = frames.length - 1;
  let answer = 0;

  while (low <= high) {
    const middle = Math.floor(
      (low + high) / 2,
    );

    if (
      frames[middle].timestampSeconds
      <= timestampSeconds
    ) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return frames[answer];
}

function detectionLabel(
  detection: PlaybackDetection,
  participantLabel: string | null,
): string {
  if (participantLabel) {
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
      return detection.className;
  }
}

function detectionColour(
  classId: number,
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
    case 3:
      return "#25ad55";
    case 2:
      return "#ff9a45";
    case 4:
      return "#9156d8";
    default:
      return "#ffffff";
  }
}

function chooseRecordingMimeType(): string {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  const supported = candidates.find(
    (mimeType) =>
      MediaRecorder.isTypeSupported(
        mimeType,
      ),
  );

  if (!supported) {
    throw new Error(
      "This browser does not support video export.",
    );
  }

  return supported;
}

async function createAudioStream(
  video: HTMLVideoElement,
): Promise<{
  stream: MediaStream;
  resume: () => Promise<void>;
  close: () => Promise<void>;
}> {
  try {
    const audioContext = new AudioContext();

    const source =
      audioContext.createMediaElementSource(
        video,
      );

    const destination =
      audioContext.createMediaStreamDestination();

    source.connect(destination);

    return {
      stream: destination.stream,
      resume: async (): Promise<void> => {
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }
      },
      close: async (): Promise<void> => {
        await audioContext.close();
      },
    };
  } catch (error: unknown) {
    console.warn(
      "Original audio could not be attached to the export.",
      error,
    );

    return {
      stream: new MediaStream(),
      resume: async (): Promise<void> => {},
      close: async (): Promise<void> => {},
    };
  }
}

function scheduleNextVideoFrame(
  video: HTMLVideoElement,
  callback: () => void,
): void {
  if (
    "requestVideoFrameCallback"
    in video
  ) {
    video.requestVideoFrameCallback(
      () => callback(),
    );
    return;
  }

  requestAnimationFrame(callback);
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.roundRect(
    x,
    y,
    width,
    height,
    radius,
  );
}

function stopRecorder(
  recorder: MediaRecorder,
): Promise<void> {
  return new Promise<void>(
    (resolve, reject) => {
      recorder.addEventListener(
        "stop",
        () => resolve(),
        { once: true },
      );

      recorder.addEventListener(
        "error",
        () => {
          reject(
            new Error(
              "The exported video could not be encoded.",
            ),
          );
        },
        { once: true },
      );

      recorder.stop();
    },
  );
}

function loadImage(
  src: string,
): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>(
    (resolve, reject) => {
      const image = new Image();

      image.addEventListener(
        "load",
        () => resolve(image),
        { once: true },
      );

      image.addEventListener(
        "error",
        () => {
          reject(
            new Error(
              "The CourtVisionAI watermark could not be loaded.",
            ),
          );
        },
        { once: true },
      );

      image.src = src;
    },
  );
}

function waitForMediaEvent(
  target: HTMLMediaElement,
  eventName:
    keyof HTMLMediaElementEventMap,
): Promise<void> {
  return new Promise<void>(
    (resolve, reject) => {
      const cleanup = (): void => {
        target.removeEventListener(
          eventName,
          onEvent,
        );
        target.removeEventListener(
          "error",
          onError,
        );
      };

      const onEvent = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        reject(
          new Error(
            `Video event failed: ${eventName}`,
          ),
        );
      };

      target.addEventListener(
        eventName,
        onEvent,
        { once: true },
      );

      target.addEventListener(
        "error",
        onError,
        { once: true },
      );
    },
  );
}

function clamp(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(
    Math.max(value, minimum),
    maximum,
  );
}

function tintImage(
  image: HTMLImageElement,
  colour: string,
): HTMLCanvasElement {
  const canvas =
    document.createElement("canvas");

  canvas.width =
    image.naturalWidth || image.width;

  canvas.height =
    image.naturalHeight || image.height;

  const context =
    canvas.getContext("2d");

  if (!context) {
    return canvas;
  }

  context.drawImage(
    image,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  context.globalCompositeOperation =
    "source-in";

  context.fillStyle = colour;

  context.fillRect(
    0,
    0,
    canvas.width,
    canvas.height,
  );

  context.globalCompositeOperation =
    "source-over";

  return canvas;
}