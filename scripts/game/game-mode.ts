import { emptyCounts, type Actor, type Counts, type EventSnapshot, type Statistics } from "../events/types";
export type GameModeId = "1v1";
export type MatchPair = [number | null, number | null];
export interface GameParticipantSnapshot {
  key: "A" | "B"; label: string; trackId: number | null; attempts: number; makes: number; rebounds: number;
  misses?: number; unresolved?: number; pending?: number;
}
export interface GameSnapshot {
  modeId: GameModeId; state: string; participants: GameParticipantSnapshot[];
  possession?: Actor | null; statistics?: Statistics; activeEvent?: string | null;
}
export function projectSnapshot(snapshot: EventSnapshot, pair: MatchPair): GameSnapshot {
  let state = snapshot.state;
  if (state === "POSSESSION") {
    const pid = snapshot.possession?.participantId;
    state = pid != null && pid === pair[0] ? "PLAYER A POSSESSION" : pid != null && pid === pair[1] ? "PLAYER B POSSESSION" : "OTHER PLAYER POSSESSION";
  }
  return { modeId: "1v1", state, possession: snapshot.possession ? { ...snapshot.possession } : null, statistics: structuredClone(snapshot.statistics), activeEvent: snapshot.activeEvent,
    participants: pair.map((pid, i) => ({ key: i === 0 ? "A" : "B", label: i === 0 ? "Player A" : "Player B", trackId: pid, ...(pid === null ? emptyCounts() : snapshot.statistics.participants[pid] ?? emptyCounts()) })) };
}
export function pairCounts(game: GameSnapshot): Counts {
  const result = emptyCounts();
  for (const p of game.participants) for (const key of Object.keys(result) as Array<keyof Counts>) result[key] += p[key] ?? 0;
  return result;
}
