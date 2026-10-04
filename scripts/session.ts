import type { GameSnapshot } from "./game/game-mode";
import {
  clearPlaybackOverlay,
  drawPlaybackOverlay,
} from "./rendering/playback-overlay";
import {
  deleteSession,
  getSession,
  type PlaybackFrame,
  type SessionEvent,
  type StoredSession,
} from "./storage/session-store";
import {
  downloadExportedVideo,
  exportSessionVideo,
  type ExportFormat,
} from "./export/export-video";

function getRequiredElement<T extends Element>(
  selector: string,
): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }

  return element;
}

const loadingPanel =
  getRequiredElement<HTMLElement>("#session-loading");

const errorPanel =
  getRequiredElement<HTMLElement>("#session-error");

const sessionContent =
  getRequiredElement<HTMLElement>("#session-content");

const sessionTitle =
  getRequiredElement<HTMLElement>("#session-title");

const sessionSubtitle =
  getRequiredElement<HTMLElement>("#session-subtitle");

const sessionVideo =
  getRequiredElement<HTMLVideoElement>("#session-video");

const videoStage =
  getRequiredElement<HTMLElement>("#video-stage");

const overlayCanvas =
  getRequiredElement<HTMLCanvasElement>("#annotation-overlay");

const possessionValue =
  getRequiredElement<HTMLElement>("#possession-value");

const shotStateValue =
  getRequiredElement<HTMLElement>("#shot-state-value");

const ballStateValue =
  getRequiredElement<HTMLElement>("#ball-state-value");

const playerAName =
  getRequiredElement<HTMLElement>("#player-a-name");

const playerAMakes =
  getRequiredElement<HTMLElement>("#player-a-makes");

const playerAAttempts =
  getRequiredElement<HTMLElement>("#player-a-attempts");

const playerAPercentage =
  getRequiredElement<HTMLElement>("#player-a-percentage");

const playerARebounds =
  getRequiredElement<HTMLElement>("#player-a-rebounds");

const playerBName =
  getRequiredElement<HTMLElement>("#player-b-name");

const playerBMakes =
  getRequiredElement<HTMLElement>("#player-b-makes");

const playerBAttempts =
  getRequiredElement<HTMLElement>("#player-b-attempts");

const playerBPercentage =
  getRequiredElement<HTMLElement>("#player-b-percentage");

const playerBRebounds =
  getRequiredElement<HTMLElement>("#player-b-rebounds");

const possessionCount =
  getRequiredElement<HTMLElement>("#session-possessions");

const totalMakes =
  getRequiredElement<HTMLElement>("#session-makes");

const totalAttempts =
  getRequiredElement<HTMLElement>("#session-attempts");

const totalRebounds =
  getRequiredElement<HTMLElement>("#session-rebounds");
 
const totalPercentage =
  getRequiredElement<HTMLElement>("#session-percentage");

const eventLog =
  getRequiredElement<HTMLElement>("#event-log");

const deleteButton =
  getRequiredElement<HTMLButtonElement>("#delete-session");

const playerAThumbnail =
  getRequiredElement<HTMLImageElement>("#player-a-thumbnail");

const playerAAvatarFallback =
  getRequiredElement<HTMLElement>("#player-a-avatar-fallback");

const playerBThumbnail =
  getRequiredElement<HTMLImageElement>("#player-b-thumbnail");

const playerBAvatarFallback =
  getRequiredElement<HTMLElement>("#player-b-avatar-fallback");

const openExportButton =
  getRequiredElement<HTMLButtonElement>("#open-export");

const exportDialog =
  getRequiredElement<HTMLDialogElement>("#export-dialog");

const closeExportButton =
  getRequiredElement<HTMLButtonElement>("#close-export");

const cancelExportButton =
  getRequiredElement<HTMLButtonElement>("#cancel-export");

const startExportButton =
  getRequiredElement<HTMLButtonElement>("#start-export");

const exportBoxes =
  getRequiredElement<HTMLInputElement>("#export-boxes");

const exportStats =
  getRequiredElement<HTMLInputElement>("#export-stats");

const exportProgressPanel =
  getRequiredElement<HTMLElement>("#export-progress-panel");

const exportProgress =
  getRequiredElement<HTMLProgressElement>("#export-progress");

const exportProgressText =
  getRequiredElement<HTMLElement>("#export-progress-text");

const exportStatus =
  getRequiredElement<HTMLElement>("#export-status");

let session: StoredSession | null = null;
let videoUrl: string | null = null;
let frameCallbackId: number | null = null;
let lastFrameIndex = -1;

void initialise();

async function initialise(): Promise<void> {
  const sessionId = new URLSearchParams(
    window.location.search,
  ).get("id");

  if (!sessionId) {
    showError("No tracked session was selected.");
    return;
  }

  try {
    session = await getSession(sessionId);

    if (!session) {
      showError(
        "This tracked session was not found on this device.",
      );
      return;
    }

    renderSessionShell(session);
    await loadVideo(session);

    loadingPanel.hidden = true;
    sessionContent.hidden = false;
    synchronisePlayback(true);
  } catch (error: unknown) {
    console.error(error);

    showError(
      error instanceof Error
        ? error.message
        : "The tracked session could not be loaded.",
    );
  }
}

function renderSessionShell(currentSession: StoredSession): void {
  sessionTitle.textContent = "Tracked Session";
  sessionSubtitle.textContent = [
    currentSession.videoName,
    formatDuration(currentSession.durationSeconds),
    `${currentSession.analysedFramesPerSecond.toFixed(2)} analysed fps`,
  ].join(" · ");

  renderPlayerThumbnail(
    currentSession.playerAThumbnail,
    playerAThumbnail,
    playerAAvatarFallback,
  );

  renderPlayerThumbnail(
    currentSession.playerBThumbnail,
    playerBThumbnail,
    playerBAvatarFallback,
  );

  videoStage.style.aspectRatio =
    `${currentSession.width} / ${currentSession.height}`;

  overlayCanvas.width = currentSession.width;
  overlayCanvas.height = currentSession.height;

  possessionCount.textContent = "0";
  totalMakes.textContent = "0";
  totalAttempts.textContent = "0";
  totalPercentage.textContent = "0%";
  totalRebounds.textContent = "0";
}

async function loadVideo(
  currentSession: StoredSession,
): Promise<void> {
  videoUrl = URL.createObjectURL(currentSession.videoBlob);
  sessionVideo.src = videoUrl;
  sessionVideo.load();

  await waitForMediaEvent(
    sessionVideo,
    "loadedmetadata",
  );

  sessionVideo.addEventListener(
    "timeupdate",
    () => synchronisePlayback(false),
  );

  sessionVideo.addEventListener(
    "seeking",
    () => synchronisePlayback(true),
  );

  sessionVideo.addEventListener(
    "seeked",
    () => synchronisePlayback(true),
  );

  sessionVideo.addEventListener(
    "play",
    startFrameSynchronisation,
  );

  sessionVideo.addEventListener(
    "pause",
    stopFrameSynchronisation,
  );

  sessionVideo.addEventListener(
    "ended",
    stopFrameSynchronisation,
  );
}

function startFrameSynchronisation(): void {
  stopFrameSynchronisation();

  if (!("requestVideoFrameCallback" in sessionVideo)) {
    return;
  }

  const onVideoFrame = (): void => {
    synchronisePlayback(false);

    if (!sessionVideo.paused && !sessionVideo.ended) {
      frameCallbackId = sessionVideo.requestVideoFrameCallback(
        onVideoFrame,
      );
    }
  };

  frameCallbackId = sessionVideo.requestVideoFrameCallback(
    onVideoFrame,
  );
}

function stopFrameSynchronisation(): void {
  if (frameCallbackId === null) {
    return;
  }

  sessionVideo.cancelVideoFrameCallback(frameCallbackId);
  frameCallbackId = null;
}

function synchronisePlayback(force: boolean): void {
  if (!session || session.frames.length === 0) {
    clearPlaybackOverlay(overlayCanvas);
    return;
  }

  const frameIndex = findFrameAtOrBefore(
    session.frames,
    sessionVideo.currentTime,
  );

  if (!force && frameIndex === lastFrameIndex) {
    return;
  }

  lastFrameIndex = frameIndex;
  const frame = session.frames[frameIndex];

  drawPlaybackOverlay(
    overlayCanvas,
    frame,
    session.width,
    session.height,
  );

  updateCurrentStats(frame);
  updateEventLog(
    session.events,
    frame.timestampSeconds,
  );
}

function updateCurrentStats(frame: PlaybackFrame): void {
  const game = frame.game;
  const playerA = participant(game, "A");
  const playerB = participant(game, "B");

  possessionValue.textContent = possessionLabel(game.state);
  shotStateValue.textContent = shotStateLabel(game.state);

  const ballDetected = frame.detections.some(
    (detection) =>
      detection.classId === 0
      || detection.classId === 1,
  );

  ballStateValue.textContent = ballDetected
    ? "Detected"
    : "Missing";

  ballStateValue.classList.toggle(
    "status-good",
    ballDetected,
  );

  ballStateValue.classList.toggle(
    "status-muted",
    !ballDetected,
  );

  updatePlayerCard(
    playerA,
    playerAName,
    playerAMakes,
    playerAAttempts,
    playerAPercentage,
    playerARebounds,
  );

  updatePlayerCard(
    playerB,
    playerBName,
    playerBMakes,
    playerBAttempts,
    playerBPercentage,
    playerBRebounds,
  );

  const currentMakes = game.participants.reduce(
    (total, participant) => total + participant.makes,
    0,
  );

  const currentAttempts = game.participants.reduce(
    (total, participant) => total + participant.attempts,
    0,
  );

  const currentRebounds = game.participants.reduce(
    (total, participant) => total + (participant.rebounds ?? 0),
    0,
  );

  const currentPossessions = session?.events.filter(
    (event) =>
      event.type === "possession"
      && event.timestampSeconds <= frame.timestampSeconds + 0.001,
  ).length ?? 0;

  possessionCount.textContent = currentPossessions.toString();
  totalMakes.textContent = currentMakes.toString();
  totalAttempts.textContent = currentAttempts.toString();
  totalPercentage.textContent =
    `${percentage(currentMakes, currentAttempts)}%`;
  totalRebounds.textContent = currentRebounds.toString();
}

function updatePlayerCard(
  player: ReturnType<typeof participant>,
  nameElement: HTMLElement,
  makesElement: HTMLElement,
  attemptsElement: HTMLElement,
  percentageElement: HTMLElement,
  reboundsElement: HTMLElement,
): void {
  nameElement.textContent = player?.label ?? "Player";
  makesElement.textContent = (player?.makes ?? 0).toString();
  attemptsElement.textContent = [
    player?.makes ?? 0,
    player?.attempts ?? 0,
  ].join(" / ");

  percentageElement.textContent =
    `${percentage(
      player?.makes ?? 0,
      player?.attempts ?? 0,
    )}%`;

  reboundsElement.textContent = (player?.rebounds ?? 0).toString();
}

function updateEventLog(
  events: readonly SessionEvent[],
  currentTime: number,
): void {
  const visibleEvents = events
    .filter(
      (event) => event.timestampSeconds <= currentTime + 0.001,
    )
    .slice(-5)
    .reverse();

  eventLog.replaceChildren();

  if (visibleEvents.length === 0) {
    const empty = document.createElement("p");
    empty.className = "event-log-empty";
    empty.textContent = "No events yet at this point in the video.";
    eventLog.append(empty);
    return;
  }

  for (const event of visibleEvents) {
    const row = document.createElement("div");
    row.className = `event-row event-${event.type}`;

    const time = document.createElement("span");
    time.className = "event-time";
    time.textContent = formatDuration(event.timestampSeconds);

    const marker = document.createElement("span");
    marker.className = "event-marker";
    marker.textContent = eventMarker(event.type);
    marker.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "event-text";
    text.textContent = event.text;

    row.append(time, marker, text);
    eventLog.append(row);
  }
}

function participant(
  game: GameSnapshot,
  key: "A" | "B",
) {
  return game.participants.find(
    (candidate) => candidate.key === key,
  );
}

function possessionLabel(state: string): string {
  switch (state) {
    case "PLAYER A POSSESSION":
      return "Player A";

    case "PLAYER B POSSESSION":
      return "Player B";

    default:
      return "None";
  }
}

function shotStateLabel(state: string): string {
  switch (state) {
    case "SHOT ATTEMPT":
      return "In flight";

    case "SHOT MADE":
      return "Made";

    default:
      return "Ready";
  }
}

function findFrameAtOrBefore(
  frames: readonly PlaybackFrame[],
  timestampSeconds: number,
): number {
  let low = 0;
  let high = frames.length - 1;
  let answer = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (frames[middle].timestampSeconds <= timestampSeconds) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return answer;
}

function eventMarker(type: SessionEvent["type"]): string {
  switch (type) {
    case "made":
      return "✓";

    case "missed":
      return "×";

    case "possession":
      return "●";

    case "rebound":
      return "↻";
  }
}

function percentage(
  makes: number,
  attempts: number,
): number {
  if (attempts <= 0) {
    return 0;
  }

  return Math.round((makes / attempts) * 100);
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(
    Math.floor(durationSeconds),
    0,
  );

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function showError(message: string): void {
  loadingPanel.hidden = true;
  sessionContent.hidden = true;
  errorPanel.hidden = false;

  const messageElement = errorPanel.querySelector<HTMLElement>(
    "[data-error-message]",
  );

  if (messageElement) {
    messageElement.textContent = message;
  }
}

deleteButton.addEventListener(
  "click",
  async (): Promise<void> => {
    if (!session) {
      return;
    }

    const shouldDelete = window.confirm(
      "Delete this tracked session from this device?",
    );

    if (!shouldDelete) {
      return;
    }

    deleteButton.disabled = true;

    try {
      await deleteSession(session.id);
      window.location.assign("./history.html");
    } catch (error: unknown) {
      console.error(error);
      deleteButton.disabled = false;

      window.alert(
        error instanceof Error
          ? error.message
          : "The session could not be deleted.",
      );
    }
  },
);

openExportButton.addEventListener(
  "click",
  (): void => {
    exportProgressPanel.hidden = true;
    exportProgress.value = 0;
    exportProgressText.textContent = "0%";
    exportStatus.textContent = "Preparing export…";
    startExportButton.disabled = false;
    closeExportButton.disabled = false;
    cancelExportButton.disabled = false;

    exportDialog.showModal();
  },
);

closeExportButton.addEventListener(
  "click",
  (): void => {
    exportDialog.close();
  },
);

cancelExportButton.addEventListener(
  "click",
  (): void => {
    exportDialog.close();
  },
);

startExportButton.addEventListener(
  "click",
  async (): Promise<void> => {
    if (!session) {
      return;
    }

    const selectedFormat =
      exportDialog.querySelector<HTMLInputElement>(
        'input[name="export-format"]:checked',
      )?.value;

    const format: ExportFormat =
      selectedFormat === "portrait"
        ? "portrait"
        : "landscape";

    startExportButton.disabled = true;
    closeExportButton.disabled = true;
    cancelExportButton.disabled = true;

    exportProgressPanel.hidden = false;
    exportStatus.textContent = "Exporting video…";

    try {
      const exported =
        await exportSessionVideo(
          session,
          {
            format,
            showBoxes: exportBoxes.checked,
            showStats: exportStats.checked,
            onProgress: (progress): void => {
              exportProgress.value = progress;
              exportProgressText.textContent =
                `${Math.round(progress * 100)}%`;
            },
          },
        );

      exportStatus.textContent = "Export complete";

      downloadExportedVideo(
        exported,
        session.videoName,
        format,
      );

      window.setTimeout(
        () => exportDialog.close(),
        500,
      );
    } catch (error: unknown) {
      console.error(error);

      exportStatus.textContent =
        error instanceof Error
          ? error.message
          : "The video could not be exported.";

      startExportButton.disabled = false;
      closeExportButton.disabled = false;
      cancelExportButton.disabled = false;
    }
  },
);

window.addEventListener("pagehide", (): void => {
  stopFrameSynchronisation();

  if (videoUrl) {
    URL.revokeObjectURL(videoUrl);
    videoUrl = null;
  }
});

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
      reject(
        new Error(`Video event failed: ${eventName}`),
      );
    };

    target.addEventListener(eventName, onEvent, {
      once: true,
    });

    target.addEventListener("error", onError, {
      once: true,
    });
  });
}

function renderPlayerThumbnail(
  thumbnail: string | null | undefined,
  image: HTMLImageElement,
  fallback: HTMLElement,
): void {
  if (!thumbnail) {
    image.removeAttribute("src");
    image.hidden = true;
    fallback.hidden = false;
    return;
  }

  image.src = thumbnail;
  image.hidden = false;
  fallback.hidden = true;
}