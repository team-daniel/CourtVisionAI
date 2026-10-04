import type { StableDetection } from "../core/detections";
import {
  OneVOneGameMode,
  type BasketballGameState,
} from "./one-v-one-fsm";

export type GameModeId = "1v1";

export interface GameParticipantSnapshot {
  key: "A" | "B";
  label: string;
  trackId: number | null;
  attempts: number;
  makes: number;
  rebounds: number;
}

export interface GameSnapshot {
  modeId: GameModeId;
  state: BasketballGameState;
  participants: GameParticipantSnapshot[];
}

export interface GameMode {
  readonly id: GameModeId;
  configureTiming(effectiveFps: number): void;
  reset(): void;
  update(detections: readonly StableDetection[]): GameSnapshot;
  playerLabel(trackId: number | null): string | null;
}

export function createGameMode(
  gameModeId: GameModeId,
  effectiveFps: number,
): GameMode {
  switch (gameModeId) {
    case "1v1":
      return new OneVOneGameMode({
        effectiveFps,
        minimumConfirmations: 2,
      });
  }
}
