import { getFrameDimensions, type Detection, type FrameSource, type StableDetection } from "../core/detections";
import { BasketballYolo, type BasketballYoloOptions } from "../inference/basketball-yolo";
import { OSNetEncoder } from "../inference/osnet";
import { DeepEIoU } from "../tracking/deep-eiou";
import { ParticipantAssigner } from "../tracking/participants";
import { CameraMotion } from "../events/camera-motion";
import { ObjectObservations } from "../events/observations";
import { BasketballFSM } from "../events/basketball-fsm";
import { projectSnapshot, type GameModeId, type GameSnapshot } from "../game/game-mode";
import type { BasketballEvent, CameraTransform, EventSnapshot, Statistics } from "../events/types";

export interface PipelineTimings { detectorMilliseconds: number; recoveryMilliseconds: number; trackingMilliseconds: number; gameMilliseconds: number; totalMilliseconds: number; recoveryCropCount: number }
export interface FrameCorrection { frameIndex: number; detections: StableDetection[]; game: GameSnapshot }
export interface PipelineFrameResult {
  frameIndex: number; timestampSeconds: number; rawDetections: Detection[]; detections: StableDetection[];
  game: GameSnapshot; corrections: FrameCorrection[]; executionProvider: string; outputShape: number[]; timings: PipelineTimings; motion: CameraTransform;
}
export interface AnalysisFrame { frameIndex: number; timestampSeconds: number; detections: StableDetection[]; snapshot: EventSnapshot; motion: CameraTransform }
export interface CompletedAnalysis { identityCorrections: Array<{ from: number; into: number; reason: string }>; frames: AnalysisFrame[]; events: BasketballEvent[]; statistics: Statistics; identities: Array<[number, number]>; version: string }
interface HistoryFrame { frameIndex: number; time: number; raw: Detection[]; players: StableDetection[]; motion: CameraTransform; width: number; height: number }
export interface BasketballPipelineOptions { detector?: BasketballYoloOptions; osnetUrl?: string; effectiveFps?: number; gameMode?: GameModeId; analysisMode?: "fast" | "balanced" | "quality" }
export class BasketballPipeline {
  private detector: BasketballYolo;
  private encoder: OSNetEncoder;
  private tracker = new DeepEIoU();
  private participants = new ParticipantAssigner();
  private motion = new CameraMotion();
  private observations = new ObjectObservations();
  private fsm = new BasketballFSM();
  private history: HistoryFrame[] = [];
  private fps: number;
  private lastTime: number | null = null;
  private busy = false;
  constructor(options: BasketballPipelineOptions = {}) { this.detector = new BasketballYolo(options.detector); this.encoder = new OSNetEncoder(options.osnetUrl); this.fps = options.effectiveFps ?? 30; }
  async load(): Promise<void> { await this.motion.load(); await this.detector.load(); await this.encoder.load(); }
  configureTiming(fps: number): void { if (!Number.isFinite(fps) || fps <= 0) throw new Error("Invalid analysis frame rate"); this.fps = fps; }
  setGameMode(mode: GameModeId): void { if (mode !== "1v1") throw new Error("Only 1v1 is available"); }
  reset(): void { this.tracker.reset(); this.participants.reset(); this.motion.reset(); this.observations.reset(); this.fsm = new BasketballFSM(); this.history = []; this.lastTime = null; }
  playerLabel(trackId: number | null): string | null { return trackId !== null && trackId > 0 ? `Participant ${trackId}` : null; }
  async processFrame(source: FrameSource, frameIndex: number, timestampSeconds: number): Promise<PipelineFrameResult> {
    if (this.busy) throw new Error("Frames must be analysed sequentially");
    if (!Number.isFinite(timestampSeconds) || (this.lastTime !== null && timestampSeconds <= this.lastTime)) throw new Error("Video timestamps must increase");
    this.busy = true;
    try {
      const start = performance.now(), { width, height } = getFrameDimensions(source);
      const raw = await this.detector.detect(source), detectedAt = performance.now();
      const people = raw.filter(d => d.classId === 1).sort((a, b) => b.confidence - a.confidence);
      const features = await this.encoder.encode(source, people.map(d => d.box));
      const dt = this.lastTime === null ? 30 / this.fps : (timestampSeconds - this.lastTime) * 30;
      const players = this.participants.update(this.tracker.update(people, features, dt), timestampSeconds, width, height);
      const motion = this.motion.update(source, raw), trackedAt = performance.now();
      const lock = this.fsm.active?.status === "confirmed" ? this.fsm.active.basketId : null;
      const { ball, basket } = this.observations.update(raw, timestampSeconds, width, height, motion, lock);
      this.fsm.resolveIdentities(this.participants.confirmedSegments);
      const snapshot = this.fsm.update(players, timestampSeconds, ball, basket, motion);
      const ids = [...this.participants.participants.keys()];
      const game = projectSnapshot(snapshot, [ids[0] ?? null, ids[1] ?? null]);
      const end = performance.now(); this.lastTime = timestampSeconds;
      this.history.push({ frameIndex, time: timestampSeconds, raw, players, motion, width, height });
      return { frameIndex, timestampSeconds, rawDetections: raw, detections: [...players, ...(ball ? [ball] : []), ...(basket ? [basket] : [])], game, corrections: [], executionProvider: `YOLO ${this.detector.executionProvider} · OSNet ${this.encoder.executionProvider}`, outputShape: this.detector.outputShape, motion,
        timings: { detectorMilliseconds: detectedAt - start, trackingMilliseconds: trackedAt - detectedAt, gameMilliseconds: end - trackedAt, totalMilliseconds: end - start, recoveryMilliseconds: 0, recoveryCropCount: 0 } };
    } finally { this.busy = false; }
  }
  async finish(cancelled: () => boolean = () => false): Promise<CompletedAnalysis> {
    const fsm = new BasketballFSM(), observations = new ObjectObservations(), frames: AnalysisFrame[] = [];
    fsm.resolveIdentities(this.participants.confirmedSegments, true);
    for (let i = 0; i < this.history.length; i++) {
      if (cancelled()) throw new DOMException("Analysis cancelled", "AbortError");
      const frame = this.history[i], players = this.participants.backfill(frame.players);
      const lock = fsm.active?.status === "confirmed" ? fsm.active.basketId : null;
      const { ball, basket } = observations.update(frame.raw, frame.time, frame.width, frame.height, frame.motion, lock);
      const snapshot = fsm.update(players, frame.time, ball, basket, frame.motion);
      frames.push({ frameIndex: frame.frameIndex, timestampSeconds: frame.time, detections: [...players, ...(ball ? [ball] : []), ...(basket ? [basket] : [])], snapshot, motion: frame.motion });
      if (i % 100 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    fsm.finish(); fsm.resolveIdentities(this.participants.confirmedSegments, true);
    if (frames.length) frames[frames.length - 1].snapshot = fsm.snapshot(frames[frames.length - 1].timestampSeconds);
    return { identityCorrections: [], frames, events: structuredClone(fsm.events), statistics: fsm.snapshot(Infinity).statistics, identities: [...this.participants.confirmedSegments], version: "deep-eiou-participants-v2-events-v3-ts1" };
  }
  async dispose(): Promise<void> { this.motion.reset(); this.history = []; await this.encoder.dispose(); await this.detector.dispose(); }
}
