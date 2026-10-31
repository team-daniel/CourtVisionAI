import type { BasketballEvent, CameraTransform, Statistics } from "../events/types";
import type { MatchPair } from "../game/game-mode";
import type {
  BoundingBox,
  ClassId,
  StableDetection,
} from "../core/detections";
import type {
  GameModeId,
  GameSnapshot,
} from "../game/game-mode";

const DATABASE_NAME = "courtvisionai";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";

export type SessionParticipantKey = "A" | "B";
export type SessionEventType =
  | "made"
  | "missed"
  | "rebound"
  | "possession"
  | "attempt"
  | "unresolved";

export interface PlaybackDetection {
  participantId?: number | null;
  identitySegment?: number | null;
  rawTrackId?: number | null;
  identityState?: string;
  state?: StableDetection["state"];
  source?: string;
  legacyClassId?: number;
  classId: ClassId;
  className: string;
  confidence: number;
  box: BoundingBox;
  trackId: number;
}

export interface PlaybackFrame {
  motion?: CameraTransform;
  frameIndex: number;
  timestampSeconds: number;
  detections: PlaybackDetection[];
  game: GameSnapshot;
}

export interface SessionEvent {
  id: string;
  timestampSeconds: number;
  type: SessionEventType;
  participantKey: SessionParticipantKey | null;
  participantLabel: string | null;
  text: string;
}

export interface SessionSummary {
  possessionCount: number;
  totalMakes: number;
  totalAttempts: number;
  totalRebounds: number;
  shootingPercentage: number;
}

export interface StoredSession {
  schemaVersion?: 2;
  identityCorrections?: Array<{ from: number; into: number; reason: string }>;
  pipelineVersion?: string;
  eventLedger?: BasketballEvent[];
  allStatistics?: Statistics;
  matchPair?: MatchPair;
  participantThumbnails?: Record<string, string>;
  identitySegments?: Array<[number, number]>;
  id: string;
  createdAt: string;
  modeId: GameModeId;
  videoName: string;
  videoType: string;
  videoBlob: Blob;
  playerAThumbnail?: string | null;
  playerBThumbnail?: string | null;
  width: number;
  height: number;
  durationSeconds: number;
  sourceFramesPerSecond: number;
  analysedFramesPerSecond: number;
  frames: PlaybackFrame[];
  events: SessionEvent[];
  finalGame: GameSnapshot;
  summary: SessionSummary;
}

export function createSessionId(): string {
  if (
    typeof crypto !== "undefined"
    && typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return [
    Date.now().toString(36),
    Math.random().toString(36).slice(2),
  ].join("-");
}

export function compactDetection(
  detection: StableDetection,
): PlaybackDetection {
  return {
    participantId: detection.participantId, identitySegment: detection.identitySegment, rawTrackId: detection.rawTrackId, identityState: detection.identityState, state: detection.state, source: detection.source,
    classId: detection.classId,
    className: detection.className,
    confidence: roundNumber(detection.confidence, 4),
    box: [
      roundNumber(detection.box[0], 2),
      roundNumber(detection.box[1], 2),
      roundNumber(detection.box[2], 2),
      roundNumber(detection.box[3], 2),
    ],
    trackId: detection.trackId,
  };
}

export async function saveSession(
  session: StoredSession,
): Promise<void> {
  const database = await openDatabase();

  try {
    await runRequest<void>((resolve, reject) => {
      const transaction = database.transaction(
        SESSION_STORE,
        "readwrite",
      );

      const store = transaction.objectStore(SESSION_STORE);
      store.put(session);

      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => {
        reject(
          transaction.error
          ?? new Error("The session could not be saved."),
        );
      });
      transaction.addEventListener("error", () => {
        reject(
          transaction.error
          ?? new Error("The session could not be saved."),
        );
      });
    });
  } finally {
    database.close();
  }
}

export async function getSession(
  sessionId: string,
): Promise<StoredSession | null> {
  const database = await openDatabase();

  try {
    return await runRequest<StoredSession | null>(
      (resolve, reject) => {
        const transaction = database.transaction(
          SESSION_STORE,
          "readonly",
        );

        const request = transaction
          .objectStore(SESSION_STORE)
          .get(sessionId);

        request.addEventListener("success", () => {
          resolve(
            request.result ? normaliseStoredSession(request.result as StoredSession) : null,
          );
        });

        request.addEventListener("error", () => {
          reject(
            request.error
            ?? new Error("The session could not be loaded."),
          );
        });
      },
    );
  } finally {
    database.close();
  }
}

export async function deleteSession(
  sessionId: string,
): Promise<void> {
  const database = await openDatabase();

  try {
    await runRequest<void>((resolve, reject) => {
      const transaction = database.transaction(
        SESSION_STORE,
        "readwrite",
      );

      transaction
        .objectStore(SESSION_STORE)
        .delete(sessionId);

      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("abort", () => {
        reject(
          transaction.error
          ?? new Error("The session could not be deleted."),
        );
      });
      transaction.addEventListener("error", () => {
        reject(
          transaction.error
          ?? new Error("The session could not be deleted."),
        );
      });
    });
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      DATABASE_NAME,
      DATABASE_VERSION,
    );

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        const store = database.createObjectStore(
          SESSION_STORE,
          { keyPath: "id" },
        );

        store.createIndex(
          "createdAt",
          "createdAt",
          { unique: false },
        );
      }
    });

    request.addEventListener("success", () => {
      resolve(request.result);
    });

    request.addEventListener("error", () => {
      reject(
        request.error
        ?? new Error("Browser storage could not be opened."),
      );
    });

    request.addEventListener("blocked", () => {
      reject(
        new Error(
          "Browser storage is busy. Close other CourtVisionAI tabs and try again.",
        ),
      );
    });
  });
}

function runRequest<T>(
  executor: (
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void,
  ) => void,
): Promise<T> {
  return new Promise<T>(executor);
}

function roundNumber(
  value: number,
  decimalPlaces: number,
): number {
  const multiplier = 10 ** decimalPlaces;
  return Math.round(value * multiplier) / multiplier;
}

export interface SessionListItem {
  id: string;
  createdAt: string;
  modeId: GameModeId;
  videoName: string;
  videoBytes: number;
  durationSeconds: number;
  analysedFramesPerSecond: number;
  playerAThumbnail?: string | null;
  playerBThumbnail?: string | null;
  finalGame: GameSnapshot;
  summary: SessionSummary;
}

export async function listSessionSummaries(): Promise<SessionListItem[]> {
  const database = await openDatabase();

  try {
    return await runRequest<SessionListItem[]>((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      const store = transaction.objectStore(SESSION_STORE);
      const index = store.index("createdAt");
      const request = index.openCursor(null, "prev");
      const items: SessionListItem[] = [];

      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(items);
          return;
        }

        const session = cursor.value as StoredSession & {
          playerAThumbnail?: string | null;
          playerBThumbnail?: string | null;
        };

        items.push({
          id: session.id,
          createdAt: session.createdAt,
          modeId: session.modeId,
          videoName: session.videoName,
          videoBytes: session.videoBlob.size,
          durationSeconds: session.durationSeconds,
          analysedFramesPerSecond: session.analysedFramesPerSecond,
          playerAThumbnail: session.playerAThumbnail ?? null,
          playerBThumbnail: session.playerBThumbnail ?? null,
          finalGame: session.finalGame,
          summary: session.summary,
        });

        cursor.continue();
      });

      request.addEventListener("error", () => {
        reject(request.error ?? new Error("Saved sessions could not be loaded."));
      });
    });
  } finally {
    database.close();
  }
}
export function normaliseStoredSession(session: StoredSession): StoredSession {
  if (session.schemaVersion === 2) return session;
  const map = [0, 0, 1, 2, 1] as const;
  return { ...session, schemaVersion: 2, pipelineVersion: "legacy-five-class", frames: session.frames.map(frame => ({ ...frame, detections: frame.detections.map(d => {
    const legacyClassId = d.classId as number;
    if (legacyClassId < 0 || legacyClassId > 4) throw new Error("Unknown legacy detection class");
    return { ...d, classId: map[legacyClassId], legacyClassId, source: "legacy" };
  }) })) };
}
