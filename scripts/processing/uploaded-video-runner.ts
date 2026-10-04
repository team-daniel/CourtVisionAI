import type { PipelineFrameResult } from "./basketball-pipeline";
import { BasketballPipeline } from "./basketball-pipeline";

export interface UploadedVideoInfo {
  width: number;
  height: number;
  durationSeconds: number;
  framesPerSecond: number;
  frameRateSource: "estimated" | "fallback";
}

export interface UploadedVideoProgress {
  frameIndex: number;
  sourceFrameIndex: number;
  totalFrames: number;
  progress: number;
  result: PipelineFrameResult;
  frameCanvas: HTMLCanvasElement;
}

export interface AnalyseUploadedVideoOptions {
  /** Source video FPS, before applying frameStride. */
  framesPerSecond: number;
  /** Use the same value as Python infer_video_with_fsm(frame_stride=...). */
  frameStride?: number;
  onFrame?: (
    progress: UploadedVideoProgress,
  ) => void | Promise<void>;
}

export class UploadedVideoRunner {
  private cancelled = false;
  private readonly frameCanvas: HTMLCanvasElement;
  private readonly frameContext: CanvasRenderingContext2D;

  constructor() {
    this.frameCanvas = document.createElement("canvas");

    const context = this.frameCanvas.getContext(
      "2d",
      { willReadFrequently: true },
    );

    if (!context) {
      throw new Error(
        "Could not create the uploaded-video frame canvas.",
      );
    }

    this.frameContext = context;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async analyse(
    video: HTMLVideoElement,
    pipeline: BasketballPipeline,
    {
      framesPerSecond,
      frameStride = 1,
      onFrame,
    }: AnalyseUploadedVideoOptions,
  ): Promise<PipelineFrameResult | null> {
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("The uploaded video has no valid dimensions.");
    }

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error("The uploaded video has no valid duration.");
    }

    const sourceFps = Math.max(framesPerSecond, 1);
    const stride = Math.max(Math.floor(frameStride), 1);
    const effectiveFps = sourceFps / stride;
    const totalSourceFrames = Math.max(
      Math.floor(video.duration * sourceFps),
      1,
    );
    const sourceFrameIndices: number[] = [];

    for (
      let sourceFrameIndex = 0;
      sourceFrameIndex < totalSourceFrames;
      sourceFrameIndex += stride
    ) {
      sourceFrameIndices.push(sourceFrameIndex);
    }

    const totalFrames = Math.max(sourceFrameIndices.length, 1);

    this.cancelled = false;
    this.frameCanvas.width = video.videoWidth;
    this.frameCanvas.height = video.videoHeight;

    pipeline.configureTiming(effectiveFps);
    pipeline.reset();

    let finalResult: PipelineFrameResult | null = null;

    for (
      let processedFrameIndex = 0;
      processedFrameIndex < sourceFrameIndices.length;
      processedFrameIndex += 1
    ) {
      if (this.cancelled) {
        break;
      }

      const sourceFrameIndex = sourceFrameIndices[processedFrameIndex];
      const timestampSeconds = Math.min(
        sourceFrameIndex / sourceFps,
        Math.max(video.duration - 0.001, 0),
      );

      await seekVideo(video, timestampSeconds);

      this.frameContext.drawImage(
        video,
        0,
        0,
        this.frameCanvas.width,
        this.frameCanvas.height,
      );

      finalResult = await pipeline.processFrame(
        this.frameCanvas,
        processedFrameIndex,
        timestampSeconds,
      );

      if (onFrame) {
        await onFrame({
          frameIndex: processedFrameIndex,
          sourceFrameIndex,
          totalFrames,
          progress: (processedFrameIndex + 1) / totalFrames,
          result: finalResult,
          frameCanvas: this.frameCanvas,
        });
      }

      await yieldToBrowser();
    }

    return finalResult;
  }
}

export async function inspectUploadedVideo(
  video: HTMLVideoElement,
): Promise<UploadedVideoInfo> {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("The uploaded video has no valid dimensions.");
  }

  const estimatedFps = await estimateVideoFrameRate(video);

  return {
    width: video.videoWidth,
    height: video.videoHeight,
    durationSeconds: video.duration,
    framesPerSecond: estimatedFps ?? 30,
    frameRateSource: estimatedFps === null
      ? "fallback"
      : "estimated",
  };
}

async function estimateVideoFrameRate(
  video: HTMLVideoElement,
): Promise<number | null> {
  if (!("requestVideoFrameCallback" in video)) {
    return null;
  }

  const originalTime = video.currentTime;
  const originalPlaybackRate = video.playbackRate;
  const originalMuted = video.muted;
  const mediaTimes: number[] = [];
  let callbackId: number | null = null;
  let timeoutId: number | null = null;

  try {
    await seekVideo(video, 0);
    video.muted = true;
    video.playbackRate = 1;

    await new Promise<void>((resolve) => {
      const finish = (): void => {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        resolve();
      };

      const onFrame = (
        _now: DOMHighResTimeStamp,
        metadata: VideoFrameCallbackMetadata,
      ): void => {
        if (
          mediaTimes.length === 0
          || metadata.mediaTime > mediaTimes[mediaTimes.length - 1]
        ) {
          mediaTimes.push(metadata.mediaTime);
        }

        if (mediaTimes.length >= 31 || metadata.mediaTime >= 1) {
          finish();
          return;
        }

        callbackId = video.requestVideoFrameCallback(onFrame);
      };

      callbackId = video.requestVideoFrameCallback(onFrame);
      timeoutId = window.setTimeout(finish, 1800);
      void video.play().catch(finish);
    });
  } catch {
    return null;
  } finally {
    video.pause();

    if (callbackId !== null) {
      video.cancelVideoFrameCallback(callbackId);
    }

    video.playbackRate = originalPlaybackRate;
    video.muted = originalMuted;

    try {
      await seekVideo(video, originalTime);
    } catch {
      video.currentTime = originalTime;
    }
  }

  const deltas: number[] = [];

  for (let index = 1; index < mediaTimes.length; index += 1) {
    const delta = mediaTimes[index] - mediaTimes[index - 1];

    if (delta > 0.001 && delta < 0.2) {
      deltas.push(delta);
    }
  }

  if (deltas.length < 3) {
    return null;
  }

  deltas.sort((valueA, valueB) => valueA - valueB);
  const medianDelta = deltas[Math.floor(deltas.length / 2)];
  return snapFrameRate(1 / medianDelta);
}

function snapFrameRate(frameRate: number): number {
  const commonFrameRates = [
    23.976,
    24,
    25,
    29.97,
    30,
    50,
    59.94,
    60,
    120,
  ];

  const closest = commonFrameRates.reduce(
    (best, candidate) => (
      Math.abs(candidate - frameRate) < Math.abs(best - frameRate)
        ? candidate
        : best
    ),
  );

  return Math.abs(closest - frameRate) <= 1.5
    ? closest
    : Math.max(1, Math.round(frameRate));
}

function seekVideo(
  video: HTMLVideoElement,
  timeSeconds: number,
): Promise<void> {
  if (
    Math.abs(video.currentTime - timeSeconds) < 0.0005
    && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };

    const onSeeked = (): void => {
      cleanup();
      resolve();
    };

    const onError = (): void => {
      cleanup();
      reject(new Error("The video seek failed."));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = timeSeconds;
  });
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}
