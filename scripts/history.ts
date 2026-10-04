import {
  deleteSession,
  listSessionSummaries,
  type SessionListItem,
} from "./storage/session-store";

type HistorySession = SessionListItem & {
  playerAThumbnail?: string | null;
  playerBThumbnail?: string | null;
  summary: SessionListItem["summary"] & {
    totalRebounds?: number;
  };
};

function getRequiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

const loadingPanel = getRequiredElement<HTMLElement>("#history-loading");
const emptyPanel = getRequiredElement<HTMLElement>("#history-empty");
const errorPanel = getRequiredElement<HTMLElement>("#history-error");
const historyList = getRequiredElement<HTMLElement>("#history-list");
const storageSummary = getRequiredElement<HTMLElement>("#session-storage-summary");
const storageDetail = getRequiredElement<HTMLElement>("#history-storage-detail");
const storageFill = getRequiredElement<HTMLElement>("#history-storage-fill");
const protectStorageButton = getRequiredElement<HTMLButtonElement>("#protect-storage");

let sessions: HistorySession[] = [];
void initialise();

async function initialise(): Promise<void> {
  try {
    sessions = (await listSessionSummaries()) as HistorySession[];
    renderSessions();
    await updateStorageInformation();
  } catch (error: unknown) {
    console.error(error);
    showError(error instanceof Error ? error.message : "Your saved sessions could not be loaded.");
  }
}

function renderSessions(): void {
  loadingPanel.hidden = true;
  errorPanel.hidden = true;
  historyList.replaceChildren();

  if (sessions.length === 0) {
    historyList.hidden = true;
    emptyPanel.hidden = false;
    return;
  }

  emptyPanel.hidden = true;
  historyList.hidden = false;
  for (const session of sessions) historyList.append(createSessionCard(session));
}

function createSessionCard(session: HistorySession): HTMLElement {
  const card = document.createElement("article");
  card.className = "history-session-card";
  card.dataset.sessionId = session.id;

  const main = document.createElement("div");
  main.className = "history-session-main";

  const avatars = document.createElement("div");
  avatars.className = "history-avatars";
  avatars.setAttribute("aria-hidden", "true");
  avatars.append(
    createAvatar(session.playerAThumbnail, "A", "history-avatar-a"),
    createAvatar(session.playerBThumbnail, "B", "history-avatar-b"),
  );

  const copy = document.createElement("div");
  copy.className = "history-session-copy";

  const eyebrow = document.createElement("div");
  eyebrow.className = "history-session-eyebrow";

  const mode = document.createElement("span");
  mode.className = "history-mode-badge";
  mode.textContent = modeLabel(session.modeId);

  const date = document.createElement("time");
  date.dateTime = session.createdAt;
  date.textContent = formatSessionDate(session.createdAt);
  eyebrow.append(mode, date);

  const title = document.createElement("h2");
  title.textContent = session.videoName;

  const meta = document.createElement("p");
  meta.textContent = [
    formatDuration(session.durationSeconds),
    `${session.analysedFramesPerSecond.toFixed(0)} analysed FPS`,
  ].join(" · ");

  copy.append(eyebrow, title, meta);
  main.append(avatars, copy);

  const playerA = participant(session, "A");
  const playerB = participant(session, "B");

  const score = document.createElement("div");
  score.className = "history-score";

  const scoreA = document.createElement("span");
  scoreA.textContent = "Player A";
  const scoreValue = document.createElement("strong");
  scoreValue.textContent = `${playerA?.makes ?? 0} – ${playerB?.makes ?? 0}`;
  const scoreB = document.createElement("span");
  scoreB.textContent = "Player B";
  score.append(scoreA, scoreValue, scoreB);

  const stats = document.createElement("div");
  stats.className = "history-session-stats";
  stats.append(
    createStat(`${playerA?.makes ?? 0} / ${playerA?.attempts ?? 0}`, "PLAYER A FGM / FGA"),
    createStat(`${playerB?.makes ?? 0} / ${playerB?.attempts ?? 0}`, "PLAYER B FGM / FGA"),
    createStat(String(totalRebounds(session)), "REBOUNDS"),
    createStat(`${session.summary.shootingPercentage ?? 0}%`, "FG%"),
  );

  const actions = document.createElement("div");
  actions.className = "history-session-actions";

  const view = document.createElement("a");
  view.className = "history-view-button";
  view.href = `./session.html?id=${encodeURIComponent(session.id)}`;
  view.textContent = "View session";

  const remove = document.createElement("button");
  remove.className = "history-delete-button";
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", async (): Promise<void> => {
    const confirmed = window.confirm(`Delete "${session.videoName}" from this device?`);
    if (!confirmed) return;
    remove.disabled = true;
    try {
      await deleteSession(session.id);
      sessions = sessions.filter((candidate) => candidate.id !== session.id);
      renderSessions();
      await updateStorageInformation();
    } catch (error: unknown) {
      console.error(error);
      remove.disabled = false;
      window.alert(error instanceof Error ? error.message : "The session could not be deleted.");
    }
  });

  actions.append(view, remove);
  card.append(main, score, stats, actions);
  return card;
}

function createAvatar(thumbnail: string | null | undefined, fallbackText: string, extraClass: string): HTMLElement {
  const avatar = document.createElement("span");
  avatar.className = `history-avatar ${extraClass}`;
  if (thumbnail) {
    const image = document.createElement("img");
    image.src = thumbnail;
    image.alt = "";
    avatar.append(image);
  } else {
    avatar.textContent = fallbackText;
  }
  return avatar;
}

function createStat(value: string, label: string): HTMLElement {
  const item = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = value;
  const small = document.createElement("span");
  small.textContent = label;
  item.append(strong, small);
  return item;
}

function participant(session: HistorySession, key: "A" | "B") {
  return session.finalGame.participants.find((candidate) => candidate.key === key);
}

function totalRebounds(session: HistorySession): number {
  if (typeof session.summary.totalRebounds === "number") return session.summary.totalRebounds;
  return session.finalGame.participants.reduce((total, participant) => {
    const withRebounds = participant as typeof participant & { rebounds?: number };
    return total + (withRebounds.rebounds ?? 0);
  }, 0);
}

async function updateStorageInformation(): Promise<void> {
  const savedVideoBytes = sessions.reduce((total, session) => total + session.videoBytes, 0);
  storageSummary.textContent = [
    `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`,
    `${formatBytes(savedVideoBytes)} of saved video`,
  ].join(" · ");

  if (!navigator.storage) {
    storageDetail.textContent = "Your videos and analysis are stored locally in this browser.";
    protectStorageButton.hidden = true;
    storageFill.style.width = "0%";
    return;
  }

  try {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    if (quota > 0) {
      const pct = Math.min(Math.max((usage / quota) * 100, 0), 100);
      storageFill.style.width = `${pct}%`;
      storageDetail.textContent = `${formatBytes(usage)} of ${formatBytes(quota)} browser storage used.`;
    } else {
      storageFill.style.width = "0%";
    }

    if ("persisted" in navigator.storage) {
      const persistent = await navigator.storage.persisted();
      if (persistent) {
        protectStorageButton.hidden = true;
        storageDetail.textContent += " Storage is protected from automatic eviction.";
      } else {
        protectStorageButton.hidden = false;
        storageDetail.textContent += " You can ask the browser to keep these sessions on this device.";
      }
    }
  } catch (error: unknown) {
    console.warn("Storage information could not be read.", error);
    protectStorageButton.hidden = true;
  }
}

protectStorageButton.addEventListener("click", async (): Promise<void> => {
  if (!navigator.storage?.persist) {
    protectStorageButton.hidden = true;
    return;
  }
  protectStorageButton.disabled = true;
  try {
    const granted = await navigator.storage.persist();
    if (granted) {
      protectStorageButton.hidden = true;
      await updateStorageInformation();
      return;
    }
    protectStorageButton.textContent = "Storage protection unavailable";
  } catch (error: unknown) {
    console.error(error);
    protectStorageButton.textContent = "Storage protection unavailable";
  } finally {
    protectStorageButton.disabled = false;
  }
});

function modeLabel(modeId: string): string {
  return modeId === "1v1" ? "1 vs 1" : modeId;
}

function formatSessionDate(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "Saved session";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDuration(durationSeconds: number): string {
  const totalSeconds = Math.max(Math.floor(durationSeconds), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return [hours, minutes.toString().padStart(2, "0"), seconds.toString().padStart(2, "0")].join(":");
  return [minutes, seconds.toString().padStart(2, "0")].join(":");
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** exponent);
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function showError(message: string): void {
  loadingPanel.hidden = true;
  emptyPanel.hidden = true;
  historyList.hidden = true;
  errorPanel.hidden = false;
  const messageElement = errorPanel.querySelector<HTMLElement>("[data-history-error]");
  if (messageElement) messageElement.textContent = message;
}
