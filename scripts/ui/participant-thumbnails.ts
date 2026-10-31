import { overlap, type StableDetection } from "../core/detections";
import type { CompletedAnalysis, AnalysisFrame } from "../processing/basketball-pipeline";
import type { MatchPair } from "../game/game-mode";

export function chooseThumbnailFrame(frames: AnalysisFrame[], width: number, height: number, pair?: MatchPair): { frame: AnalysisFrame; players: StableDetection[] } | null {
  const wanted = pair?.filter((id): id is number => id !== null);
  if (wanted && !wanted.length) return null;
  let best: { frame: AnalysisFrame; players: StableDetection[] } | null = null, bestScore = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i], visible = frame.detections.filter(d => d.classId === 1);
    const players = visible.filter(d => {
      if (d.participantId == null || d.confidence < .6 || !["observed", "low_confidence"].includes(d.state ?? "observed")) return false;
      if (wanted && !wanted.includes(d.participantId)) return false;
      const [x1, y1, x2, y2] = d.box;
      if (x1 <= 2 || y1 <= 2 || x2 >= width - 2 || y2 >= height - 2 || x2 - x1 < 24 || y2 - y1 < 60) return false;
      if (visible.some(other => other !== d && overlap(d.box, other.box) > .02)) return false;
      let hits = 0, first = frame.timestampSeconds;
      for (let j = i; j >= 0 && frame.timestampSeconds - frames[j].timestampSeconds <= .65; j--) {
        const matches = frames[j].detections.filter(p => p.classId === 1 && p.participantId === d.participantId && p.identitySegment === d.identitySegment && p.confidence >= .6);
        if (matches.length !== 1) break;
        hits++; first = frames[j].timestampSeconds;
      }
      return hits >= 3 && frame.timestampSeconds - first >= .4;
    });
    if (new Set(players.map(p => p.participantId)).size !== players.length) continue;
    if (wanted ? players.length !== wanted.length : players.length < 2) continue;
    const score = (wanted ? 0 : players.length * 10) + Math.min(...players.map(d => d.confidence * (d.box[3] - d.box[1]) / height));
    if (score > bestScore) { best = { frame, players }; bestScore = score; }
  }
  return best;
}

export class ParticipantThumbnails {
  readonly images: Record<string, string> = {};
  async build(video: HTMLVideoElement, analysis: CompletedAnalysis, pair?: MatchPair, signal?: AbortSignal): Promise<void> {
    for (const key of Object.keys(this.images)) delete this.images[key];
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const selected = chooseThumbnailFrame(analysis.frames, video.videoWidth, video.videoHeight, pair);
    if (!selected) return;
    try { await seek(video, selected.frame.timestampSeconds, signal); }
    catch (error) { if (signal?.aborted) throw error; console.warn("Player photos could not be captured", error); return; }
    const images: Record<string, string> = {};
    for (const d of selected.players) {
      const [x1, y1, x2, y2] = d.box;
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 160;
      const context = canvas.getContext("2d"); if (!context) return;
      const size = Math.min(Math.max((x2 - x1) * 1.15, (y2 - y1) * .42), video.videoWidth, video.videoHeight);
      const x = Math.max(0, Math.min(video.videoWidth - size, (x1 + x2 - size) / 2));
      const y = Math.max(0, Math.min(video.videoHeight - size, y1 + (y2 - y1) * .22 - size / 2));
      context.drawImage(video, x, y, size, size, 0, 0, 160, 160);
      images[d.participantId!] = canvas.toDataURL("image/jpeg", .88);
    }
    Object.assign(this.images, images);
  }
}

function seek(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Cancelled", "AbortError"));
  video.pause();
  if (Math.abs(video.currentTime - time) < .0005 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); video.removeEventListener("seeked", done); video.removeEventListener("error", fail); signal?.removeEventListener("abort", abort); };
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error("Could not seek to the player photo frame")); };
    const abort = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
    const timeout = setTimeout(fail, 10000);
    video.addEventListener("seeked", done, { once: true }); video.addEventListener("error", fail, { once: true }); signal?.addEventListener("abort", abort, { once: true });
    video.currentTime = time;
  });
}
