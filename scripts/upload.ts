import type { GameModeId } from "./game/game-mode";
import {
  BasketballPipeline,
  type PipelineFrameResult,
} from "./processing/basketball-pipeline";
import {
  inspectUploadedVideo,
  UploadedVideoRunner,
  type UploadedVideoInfo,
} from "./processing/uploaded-video-runner";
import { drawPipelineFrame } from "./rendering/overlay";
import { SessionRecorder } from "./session/session-recorder";
import { saveSession } from "./storage/session-store";

// Set this to the exact frame_stride used by the Python reference run.
type AnalysisQuality =
  | "full"
  | "balanced"
  | "fast";

const ANALYSIS_TARGET_FPS: Record<
  AnalysisQuality,
  number
> = {
  full: 30,
  balanced: 15,
  fast: 10,
};

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

const videoInput =
  getRequiredElement<HTMLInputElement>("#video-input");
const gameModeSelect =
  getRequiredElement<HTMLSelectElement>("#game-mode");
const analysisQualitySelect =
  getRequiredElement<HTMLSelectElement>(
    "#analysis-quality",
  );
const uploadDropzone =
  getRequiredElement<HTMLElement>("#upload-dropzone");
const recordingGuidance =
  getRequiredElement<HTMLElement>("#recording-guidance");
const analysisPanel =
  getRequiredElement<HTMLElement>("#analysis-panel");
const analysisStatus =
  getRequiredElement<HTMLElement>("#analysis-status");
const analysisDetail =
  getRequiredElement<HTMLElement>("#analysis-detail");
const analysisTime =
  getRequiredElement<HTMLElement>("#analysis-time");
const previewCanvas =
  getRequiredElement<HTMLCanvasElement>("#analysis-preview");
const fileMetadata =
  getRequiredElement<HTMLElement>("#file-metadata");
const cancelButton =
  getRequiredElement<HTMLButtonElement>("#cancel-analysis");
const chooseAnotherButton =
  getRequiredElement<HTMLButtonElement>("#choose-another-video");
const progressElement =
  getRequiredElement<HTMLProgressElement>("#analysis-progress");
const progressText =
  getRequiredElement<HTMLElement>("#analysis-progress-text");
const gameState =
  getRequiredElement<HTMLElement>("#game-state");
const playerAStats =
  getRequiredElement<HTMLElement>("#player-a-stats");
const playerBStats =
  getRequiredElement<HTMLElement>("#player-b-stats");

const pipeline = new BasketballPipeline({
  gameMode: "1v1",
  effectiveFps: 30,
  recoveryOptions: {
    enabled: true,
    discoveryEnabled: true,
  },
});

const runner = new UploadedVideoRunner();
const analysisVideo = document.createElement("video");

analysisVideo.muted = true;
analysisVideo.playsInline = true;
analysisVideo.preload = "auto";

let selectedVideoUrl: string | null = null;
let analysing = false;
let analysisCancelled = false;

videoInput.addEventListener(
  "change",
  async (): Promise<void> => {
    const file = videoInput.files?.[0];

    if (!file) {
      return;
    }

    if (!isVideoFile(file)) {
      showAnalysisPanel();
      showError("Please select an MP4, MOV, M4V or WebM video.");
      return;
    }

    await startAnalysis(file);
  },
);

gameModeSelect.addEventListener("change", (): void => {
  pipeline.setGameMode(getSelectedGameMode());
});

cancelButton.addEventListener("click", (): void => {
  analysisCancelled = true;
  runner.cancel();

  cancelButton.disabled = true;
  analysisStatus.textContent = "Cancelling analysis…";
  analysisDetail.textContent =
    "Finishing the current frame and discarding this session.";
});

chooseAnotherButton.addEventListener("click", (): void => {
  resetUploadPage();
  videoInput.click();
});

window.addEventListener("pagehide", (): void => {
  runner.cancel();
  revokeSelectedVideoUrl();
});

async function startAnalysis(file: File): Promise<void> {
  if (analysing) {
    runner.cancel();
  }

  analysisCancelled = false;
  requestPersistentStorage()

  analysing = true;
  showAnalysisPanel();
  setAnalysingControls();
  resetProgress();

  analysisStatus.textContent = "Opening video…";
  analysisDetail.textContent = "Reading video information";

  try {
    const videoInfo = await loadSelectedVideo(file);

    if (analysisCancelled) {
      resetUploadPage();
      return;
    }

    const targetAnalysisFps =
      getSelectedAnalysisFps();

    const analysisFrameStride =
      getAnalysisStride(
        videoInfo.framesPerSecond,
        targetAnalysisFps,
      );

    const analysedFramesPerSecond =
      videoInfo.framesPerSecond
      / analysisFrameStride;

    pipeline.setGameMode(getSelectedGameMode());
    pipeline.configureTiming(analysedFramesPerSecond);

    fileMetadata.textContent = [
      file.name,
      `${videoInfo.width} × ${videoInfo.height}`,
      `${videoInfo.framesPerSecond.toFixed(2)} source fps`,
      `${analysedFramesPerSecond.toFixed(2)} analysed fps`,
      formatDuration(videoInfo.durationSeconds),
    ].join(" · ");

    analysisStatus.textContent = "Loading the basketball model…";
    analysisDetail.textContent = "The first run can take a little longer";
    await pipeline.load();

    if (analysisCancelled) {
      resetUploadPage();
      return;
    }

    const recorder = new SessionRecorder({
      file,
      width: videoInfo.width,
      height: videoInfo.height,
      durationSeconds: videoInfo.durationSeconds,
      sourceFramesPerSecond: videoInfo.framesPerSecond,
      analysedFramesPerSecond,
    });

    const thumbnailCollector = new PlayerThumbnailCollector();

    analysisStatus.textContent = "Analysing your game…";
    analysisDetail.textContent =
      "Tracking players, ball, basket and shot state";

    const finalResult = await runner.analyse(
      analysisVideo,
      pipeline,
      {
        framesPerSecond: videoInfo.framesPerSecond,
        frameStride: analysisFrameStride,
        onFrame: ({
          frameIndex,
          totalFrames,
          progress,
          result,
          frameCanvas,
        }): void => {
          recorder.addFrame(result);

          thumbnailCollector.update(
            frameCanvas,
            result,
            pipeline,
          );

          drawPipelineFrame(
            previewCanvas,
            frameCanvas,
            result,
            {
              playerLabel: (trackId) =>
                pipeline.playerLabel(trackId),
            },
          );

          progressElement.value = progress;
          progressText.textContent = `${Math.round(progress * 100)}%`;
          analysisTime.textContent =
            `${result.timings.totalMilliseconds.toFixed(0)} ms/frame`;
          analysisDetail.textContent = [
            `Frame ${frameIndex + 1} of ${totalFrames}`,
            result.executionProvider,
            `${result.detections.length} tracked`,
            `${result.timings.recoveryCropCount} recovery crops`,
          ].join(" · ");

          updateGameStats(result.game);
        },
      },
    );

    if (analysisCancelled || !finalResult) {
      resetUploadPage();
      return;
    }

    progressElement.value = 1;
    progressText.textContent = "100%";
    updateGameStats(finalResult.game);
    analysisStatus.textContent = "Saving session…";
    analysisDetail.textContent =
      "Preparing timestamp-synchronised playback";

    if (analysisCancelled) {
      resetUploadPage();
      return;
    }

    const session = recorder.build();
    session.playerAThumbnail = thumbnailCollector.getThumbnail("A");
    session.playerBThumbnail = thumbnailCollector.getThumbnail("B");
    await saveSession(session);

    analysisStatus.textContent = "Analysis complete";
    analysisDetail.textContent = "Opening your tracked session…";
    revokeSelectedVideoUrl();

    window.location.assign(
      `./session.html?id=${encodeURIComponent(session.id)}`,
    );
  } catch (error: unknown) {
    console.error(error);
    showError(
      error instanceof Error
        ? error.message
        : "Video analysis failed.",
    );
  } finally {
    analysing = false;
  }
}

async function loadSelectedVideo(
  file: File,
): Promise<UploadedVideoInfo> {
  revokeSelectedVideoUrl();
  selectedVideoUrl = URL.createObjectURL(file);
  analysisVideo.src = selectedVideoUrl;
  analysisVideo.load();
  await waitForMediaEvent(analysisVideo, "loadedmetadata");
  return inspectUploadedVideo(analysisVideo);
}

function updateGameStats(game: {
  state: string;
  participants: Array<{
    key: string;
    makes: number;
    attempts: number;
  }>;
}): void {
  gameState.textContent = friendlyState(game.state);
  const playerA = game.participants.find(
    (participant) => participant.key === "A",
  );
  const playerB = game.participants.find(
    (participant) => participant.key === "B",
  );

  playerAStats.textContent = playerA
    ? `${playerA.makes} / ${playerA.attempts}`
    : "0 / 0";
  playerBStats.textContent = playerB
    ? `${playerB.makes} / ${playerB.attempts}`
    : "0 / 0";
}

function getSelectedGameMode(): GameModeId {
  switch (gameModeSelect.value) {
    case "1v1":
      return "1v1";
    default:
      throw new Error(
        `Unsupported game mode: ${gameModeSelect.value}`,
      );
  }
}

function getSelectedAnalysisFps(): number {
  const quality =
    analysisQualitySelect.value as AnalysisQuality;

  return ANALYSIS_TARGET_FPS[quality] ?? 30;
}

function getAnalysisStride(
  sourceFps: number,
  targetFps: number,
): number {
  return Math.max(
    1,
    Math.ceil(sourceFps / targetFps),
  );
}

function showAnalysisPanel(): void {
  uploadDropzone.hidden = true;
  recordingGuidance.hidden = true;
  analysisPanel.hidden = false;
}

function resetUploadPage(): void {
  runner.cancel();
  analysing = false;
  revokeSelectedVideoUrl();
  analysisVideo.removeAttribute("src");
  analysisVideo.load();
  videoInput.value = "";
  videoInput.disabled = false;
  gameModeSelect.disabled = false;
  analysisQualitySelect.disabled = false;
  analysisPanel.hidden = true;
  uploadDropzone.hidden = false;
  recordingGuidance.hidden = false;
  cancelButton.hidden = true;
  analysisCancelled = false;
  cancelButton.disabled = false;
  chooseAnotherButton.hidden = true;
  resetProgress();
}

function setAnalysingControls(): void {
  videoInput.disabled = true;
  gameModeSelect.disabled = true;
  analysisQualitySelect.disabled = true;
  cancelButton.hidden = false;
  cancelButton.disabled = false;
  chooseAnotherButton.hidden = true;
}

function setCancelledControls(): void {
  videoInput.disabled = false;
  gameModeSelect.disabled = false;
  analysisQualitySelect.disabled = false;
  cancelButton.hidden = true;
  chooseAnotherButton.hidden = false;
}

function showError(message: string): void {
  analysisStatus.textContent = "Could not analyse video";
  analysisDetail.textContent = message;
  analysisTime.textContent = "";
  cancelButton.hidden = true;
  chooseAnotherButton.hidden = false;
  videoInput.disabled = false;
  gameModeSelect.disabled = false;
  analysisQualitySelect.disabled = false;
}

function resetProgress(): void {
  progressElement.value = 0;
  progressText.textContent = "0%";
  analysisTime.textContent = "";
  fileMetadata.textContent = "";
  gameState.textContent = "No possession";
  playerAStats.textContent = "0 / 0";
  playerBStats.textContent = "0 / 0";
  previewCanvas.getContext("2d")?.clearRect(
    0,
    0,
    previewCanvas.width,
    previewCanvas.height,
  );
}

function friendlyState(state: string): string {
  switch (state) {
    case "PLAYER A POSSESSION":
      return "Player A possession";
    case "PLAYER B POSSESSION":
      return "Player B possession";
    case "SHOT ATTEMPT":
      return "Shot attempt";
    case "SHOT MADE":
      return "Shot made";
    default:
      return "No possession";
  }
}

function isVideoFile(file: File): boolean {
  return (
    file.type.startsWith("video/")
    || /\.(mp4|mov|m4v|webm)$/i.test(file.name)
  );
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(Math.round(durationSeconds), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function revokeSelectedVideoUrl(): void {
  if (selectedVideoUrl) {
    URL.revokeObjectURL(selectedVideoUrl);
    selectedVideoUrl = null;
  }
}

function waitForMediaEvent(
  target: HTMLMediaElement,
  eventName: keyof HTMLMediaElementEventMap,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(`Video event failed: ${eventName}`));
    };

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

type ThumbnailPlayer = "A" | "B";

interface ThumbnailCandidate {
  score: number;
  image: string | null;
}

class PlayerThumbnailCollector {
  private readonly candidates: Record<
    ThumbnailPlayer,
    ThumbnailCandidate
  > = {
    A: {
      score: Number.NEGATIVE_INFINITY,
      image: null,
    },
    B: {
      score: Number.NEGATIVE_INFINITY,
      image: null,
    },
  };

  private captureStartedAt: number | null = null;
  private lastSampleAt = Number.NEGATIVE_INFINITY;

  update(
    frame: HTMLCanvasElement,
    result: PipelineFrameResult,
    pipeline: BasketballPipeline,
  ): void {
    const players = result.detections
      .filter(
        (detection) =>
          detection.classId === 2
          || detection.classId === 4,
      )
      .map((detection) => ({
        detection,
        label: pipeline.playerLabel(
          detection.trackId,
        ),
      }));

    const playerA = players.find(
      (player) =>
        player.label === "Player A",
    )?.detection;

    const playerB = players.find(
      (player) =>
        player.label === "Player B",
    )?.detection;

    // Wait until both players have actually been identified.
    if (!playerA || !playerB) {
      return;
    }

    if (this.captureStartedAt === null) {
      this.captureStartedAt =
        result.timestampSeconds;
    }

    const timeSinceIdentification =
      result.timestampSeconds
      - this.captureStartedAt;

    // Search for the best crop for four seconds.
    if (timeSinceIdentification > 4) {
      return;
    }

    // No need to create a JPEG every single analysed frame.
    if (
      result.timestampSeconds
      - this.lastSampleAt
      < 0.25
    ) {
      return;
    }

    this.lastSampleAt =
      result.timestampSeconds;

    this.considerPlayer(
      "A",
      playerA,
      playerB,
      frame,
    );

    this.considerPlayer(
      "B",
      playerB,
      playerA,
      frame,
    );
  }

  getThumbnail(
    player: ThumbnailPlayer,
  ): string | null {
    return this.candidates[player].image;
  }

  private considerPlayer(
    player: ThumbnailPlayer,
    detection: PipelineFrameResult["detections"][number],
    otherPlayer: PipelineFrameResult["detections"][number],
    frame: HTMLCanvasElement,
  ): void {
    // Don't capture while the players are overlapping.
    if (
      boxesOverlap(
        detection.box,
        otherPlayer.box,
      )
    ) {
      return;
    }

    const [
      x1,
      y1,
      x2,
      y2,
    ] = detection.box;

    const playerWidth =
      Math.max(x2 - x1, 1);

    const playerHeight =
      Math.max(y2 - y1, 1);

    // Avoid detections cut off by the edge of the video.
    if (
      x1 <= 1
      || y1 <= 1
      || x2 >= frame.width - 1
      || y2 >= frame.height - 1
    ) {
      return;
    }

    const relativeHeight =
      playerHeight / frame.height;

    const score =
      detection.confidence
      * relativeHeight;

    if (
      score
      <= this.candidates[player].score
    ) {
      return;
    }

    const thumbnail =
      makePlayerHeadThumbnail(
        frame,
        detection.box,
      );

    if (!thumbnail) {
      return;
    }

    this.candidates[player] = {
      score,
      image: thumbnail,
    };
  }
}

function makePlayerHeadThumbnail(
  frame: HTMLCanvasElement,
  box: readonly number[],
): string | null {
  const [x1, y1, x2, y2] = box;

  const playerWidth =
    Math.max(x2 - x1, 1);

  const playerHeight =
    Math.max(y2 - y1, 1);

  /*
   * Slightly larger crop so we get more of the head
   * and a bit of the shoulders instead of a tight face crop.
   */
  const cropSize = Math.min(
    Math.max(
      playerWidth * 1.05,
      playerHeight * 0.36,
    ),
    playerHeight * 0.70,
    frame.width,
    frame.height,
  );

  if (cropSize < 4) {
    return null;
  }

  const centreX =
    x1 + playerWidth * 0.5;

  /*
   * Move the crop centre slightly lower than before
   * so it includes a bit more of the upper body.
   */
  const centreY =
    y1 + playerHeight * 0.20;

  const cropX = clamp(
    centreX - cropSize / 2,
    0,
    frame.width - cropSize,
  );

  const cropY = clamp(
    centreY - cropSize / 2,
    0,
    frame.height - cropSize,
  );

  const thumbnail =
    document.createElement("canvas");

  thumbnail.width = 160;
  thumbnail.height = 160;

  const context =
    thumbnail.getContext("2d");

  if (!context) {
    return null;
  }

  context.drawImage(
    frame,
    cropX,
    cropY,
    cropSize,
    cropSize,
    0,
    0,
    thumbnail.width,
    thumbnail.height,
  );

  return thumbnail.toDataURL(
    "image/jpeg",
    0.88,
  );
}

function boxesOverlap(
  boxA: readonly number[],
  boxB: readonly number[],
): boolean {
  return (
    Math.min(boxA[2], boxB[2])
      > Math.max(boxA[0], boxB[0])
    && Math.min(boxA[3], boxB[3])
      > Math.max(boxA[1], boxB[1])
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

function requestPersistentStorage(): void {
  if (!navigator.storage?.persist) return;

  void navigator.storage.persist().catch((error: unknown) => {
    console.warn("Persistent storage request failed.", error);
  });
}