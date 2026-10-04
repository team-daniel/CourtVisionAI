/*
 * Behavioural TypeScript port of Ultralytics 8.4.92 BYTETracker/STrack.
 * Upstream source is AGPL-3.0 licensed.
 */

import {
  CLASS_NAMES,
  type BoundingBox,
  type ByteTrackedDetection,
  type ClassId,
  type Detection,
} from "../core/detections";
import { boxIou } from "../core/geometry";
import {
  KalmanFilterXYAH,
  type Matrix,
  type Vector,
} from "./kalman-filter-xyah";
import { linearAssignment } from "./linear-assignment";

export interface ByteTrackerOptions {
  effectiveFps?: number;
  trackHighThreshold?: number;
  trackLowThreshold?: number;
  newTrackThreshold?: number;
  trackBuffer?: number;
  matchThreshold?: number;
  fuseScore?: boolean;
}

enum TrackState {
  New,
  Tracked,
  Lost,
  Removed,
}

let nextTrackId = 0;

class STrack {
  readonly kalmanFilter: KalmanFilterXYAH;

  trackId = 0;
  isActivated = false;
  state = TrackState.New;
  score: number;
  classId: ClassId;
  detectionIndex: number;
  frameId = 0;
  startFrame = 0;
  trackletLength = 0;
  mean: Vector | null = null;
  covariance: Matrix | null = null;

  private initialTopLeftWidthHeight: [
    number,
    number,
    number,
    number,
  ];

  constructor(
    detection: Detection,
    detectionIndex: number,
    kalmanFilter: KalmanFilterXYAH,
  ) {
    this.kalmanFilter = kalmanFilter;
    this.initialTopLeftWidthHeight = [
      detection.box[0],
      detection.box[1],
      detection.box[2] - detection.box[0],
      detection.box[3] - detection.box[1],
    ];
    this.score = detection.confidence;
    this.classId = detection.classId;
    this.detectionIndex = detectionIndex;
  }

  get endFrame(): number {
    return this.frameId;
  }

  get topLeftWidthHeight(): [number, number, number, number] {
    if (!this.mean) {
      return [...this.initialTopLeftWidthHeight];
    }

    const width = this.mean[2] * this.mean[3];
    const height = this.mean[3];

    return [
      this.mean[0] - width / 2,
      this.mean[1] - height / 2,
      width,
      height,
    ];
  }

  get box(): BoundingBox {
    const [x, y, width, height] = this.topLeftWidthHeight;

    return [
      x,
      y,
      x + width,
      y + height,
    ];
  }

  activate(frameId: number): void {
    nextTrackId += 1;
    this.trackId = nextTrackId;

    const initiated = this.kalmanFilter.initiate(
      this.toXYAH(this.initialTopLeftWidthHeight),
    );

    this.mean = initiated.mean;
    this.covariance = initiated.covariance;
    this.trackletLength = 0;
    this.state = TrackState.Tracked;
    this.isActivated = frameId === 1;
    this.frameId = frameId;
    this.startFrame = frameId;
  }

  predict(): void {
    if (!this.mean || !this.covariance) {
      return;
    }

    const mean = [...this.mean];

    if (this.state !== TrackState.Tracked) {
      mean[7] = 0;
    }

    const prediction = this.kalmanFilter.predict(
      mean,
      this.covariance,
    );

    this.mean = prediction.mean;
    this.covariance = prediction.covariance;
  }

  update(newTrack: STrack, frameId: number): void {
    if (!this.mean || !this.covariance) {
      throw new Error("Cannot update an inactive ByteTrack state.");
    }

    const updated = this.kalmanFilter.update(
      this.mean,
      this.covariance,
      this.toXYAH(newTrack.topLeftWidthHeight),
    );

    this.mean = updated.mean;
    this.covariance = updated.covariance;
    this.frameId = frameId;
    this.trackletLength += 1;
    this.state = TrackState.Tracked;
    this.isActivated = true;
    this.score = newTrack.score;
    this.classId = newTrack.classId;
    this.detectionIndex = newTrack.detectionIndex;
  }

  reactivate(newTrack: STrack, frameId: number): void {
    if (!this.mean || !this.covariance) {
      throw new Error("Cannot reactivate an inactive ByteTrack state.");
    }

    const updated = this.kalmanFilter.update(
      this.mean,
      this.covariance,
      this.toXYAH(newTrack.topLeftWidthHeight),
    );

    this.mean = updated.mean;
    this.covariance = updated.covariance;
    this.trackletLength = 0;
    this.state = TrackState.Tracked;
    this.isActivated = true;
    this.frameId = frameId;
    this.score = newTrack.score;
    this.classId = newTrack.classId;
    this.detectionIndex = newTrack.detectionIndex;
  }

  markLost(): void {
    this.state = TrackState.Lost;
  }

  markRemoved(): void {
    this.state = TrackState.Removed;
  }

  toDetection(): ByteTrackedDetection {
    return {
      classId: this.classId,
      className: CLASS_NAMES[this.classId],
      confidence: this.score,
      box: [...this.box],
      trackId: this.trackId,
      source: "bytetrack_full_frame",
    };
  }

  private toXYAH(
    topLeftWidthHeight: readonly number[],
  ): [number, number, number, number] {
    const [x, y, width, height] = topLeftWidthHeight;

    return [
      x + width / 2,
      y + height / 2,
      width / Math.max(height, 1e-12),
      height,
    ];
  }
}

export class ByteTracker {
  private readonly highThreshold: number;
  private readonly lowThreshold: number;
  private readonly newTrackThreshold: number;
  private readonly trackBuffer: number;
  private readonly matchThreshold: number;
  private readonly shouldFuseScore: boolean;

  private readonly kalmanFilter = new KalmanFilterXYAH();
  private trackedTracks: STrack[] = [];
  private lostTracks: STrack[] = [];
  private removedTracks: STrack[] = [];
  private frameId = 0;

  constructor({
    trackHighThreshold = 0.25,
    trackLowThreshold = 0.10,
    newTrackThreshold = 0.25,
    trackBuffer = 30,
    matchThreshold = 0.80,
    fuseScore = true,
  }: ByteTrackerOptions = {}) {
    this.highThreshold = trackHighThreshold;
    this.lowThreshold = trackLowThreshold;
    this.newTrackThreshold = newTrackThreshold;
    this.trackBuffer = Math.max(Math.round(trackBuffer), 1);
    this.matchThreshold = matchThreshold;
    this.shouldFuseScore = fuseScore;
  }

  configureTiming(_effectiveFps: number): void {
    // Ultralytics 8.4.92 uses track_buffer directly in processed frames.
  }

  reset(): void {
    this.trackedTracks = [];
    this.lostTracks = [];
    this.removedTracks = [];
    this.frameId = 0;
    nextTrackId = 0;
  }

  update(
    detections: readonly Detection[],
    _frameWidth: number,
    _frameHeight: number,
  ): ByteTrackedDetection[] {
    this.frameId += 1;

    const activated: STrack[] = [];
    const refound: STrack[] = [];
    const newlyLost: STrack[] = [];
    const newlyRemoved: STrack[] = [];

    const highDetections = detections
      .map((detection, index) => ({ detection, index }))
      .filter(({ detection }) => (
        detection.confidence >= this.highThreshold
      ));

    const lowDetections = detections
      .map((detection, index) => ({ detection, index }))
      .filter(({ detection }) => (
        detection.confidence > this.lowThreshold
        && detection.confidence < this.highThreshold
      ));

    const highTracks = highDetections.map(({ detection, index }) => (
      new STrack(detection, index, this.kalmanFilter)
    ));

    const lowTracks = lowDetections.map(({ detection, index }) => (
      new STrack(detection, index, this.kalmanFilter)
    ));

    const unconfirmed: STrack[] = [];
    const confirmedTracked: STrack[] = [];

    for (const track of this.trackedTracks) {
      if (track.isActivated) {
        confirmedTracked.push(track);
      } else {
        unconfirmed.push(track);
      }
    }

    const trackPool = jointTracks(
      confirmedTracked,
      this.lostTracks,
    );

    for (const track of trackPool) {
      track.predict();
    }

    const first = linearAssignment(
      this.distanceMatrix(trackPool, highTracks, true),
      this.matchThreshold,
      highTracks.length,
    );

    for (const [trackIndex, detectionIndex] of first.matches) {
      this.applyMatch(
        trackPool[trackIndex],
        highTracks[detectionIndex],
        activated,
        refound,
      );
    }

    const remainingTracked = first.unmatchedRows
      .map((index) => trackPool[index])
      .filter((track) => track.state === TrackState.Tracked);

    const second = linearAssignment(
      this.distanceMatrix(remainingTracked, lowTracks, false),
      0.50,
      lowTracks.length,
    );

    for (const [trackIndex, detectionIndex] of second.matches) {
      this.applyMatch(
        remainingTracked[trackIndex],
        lowTracks[detectionIndex],
        activated,
        refound,
      );
    }

    for (const trackIndex of second.unmatchedRows) {
      const track = remainingTracked[trackIndex];

      if (track.state !== TrackState.Lost) {
        track.markLost();
        newlyLost.push(track);
      }
    }

    const leftoverHigh = first.unmatchedColumns.map(
      (index) => highTracks[index],
    );

    const unconfirmedResult = linearAssignment(
      this.distanceMatrix(unconfirmed, leftoverHigh, true),
      0.70,
      leftoverHigh.length,
    );

    for (
      const [trackIndex, detectionIndex]
      of unconfirmedResult.matches
    ) {
      const track = unconfirmed[trackIndex];
      track.update(leftoverHigh[detectionIndex], this.frameId);
      activated.push(track);
    }

    for (const trackIndex of unconfirmedResult.unmatchedRows) {
      const track = unconfirmed[trackIndex];
      track.markRemoved();
      newlyRemoved.push(track);
    }

    const newTrackCandidates = unconfirmedResult.unmatchedColumns.map(
      (index) => leftoverHigh[index],
    );

    for (const track of newTrackCandidates) {
      if (track.score < this.newTrackThreshold) {
        continue;
      }

      track.activate(this.frameId);
      activated.push(track);
    }

    for (const track of this.lostTracks) {
      if (this.frameId - track.endFrame > this.trackBuffer) {
        track.markRemoved();
        newlyRemoved.push(track);
      }
    }

    this.mergePools(
      activated,
      refound,
      newlyLost,
      newlyRemoved,
    );

    return this.trackedTracks
      .filter((track) => track.isActivated)
      .map((track) => track.toDetection());
  }

  private applyMatch(
    track: STrack,
    detection: STrack,
    activated: STrack[],
    refound: STrack[],
  ): void {
    if (track.state === TrackState.Tracked) {
      track.update(detection, this.frameId);
      activated.push(track);
    } else {
      track.reactivate(detection, this.frameId);
      refound.push(track);
    }
  }

  private distanceMatrix(
    tracks: readonly STrack[],
    detections: readonly STrack[],
    fuseScore: boolean,
  ): number[][] {
    return tracks.map((track) => (
      detections.map((detection) => {
        const iou = boxIou(track.box, detection.box);

        if (fuseScore && this.shouldFuseScore) {
          return 1 - iou * detection.score;
        }

        return 1 - iou;
      })
    ));
  }

  private mergePools(
    activated: STrack[],
    refound: STrack[],
    newlyLost: STrack[],
    newlyRemoved: STrack[],
  ): void {
    this.trackedTracks = this.trackedTracks.filter(
      (track) => track.state === TrackState.Tracked,
    );

    this.trackedTracks = jointTracks(
      this.trackedTracks,
      activated,
    );

    this.trackedTracks = jointTracks(
      this.trackedTracks,
      refound,
    );

    this.lostTracks = subtractTracks(
      this.lostTracks,
      this.trackedTracks,
    );

    this.lostTracks.push(...newlyLost);

    this.lostTracks = subtractTracks(
      this.lostTracks,
      this.removedTracks,
    );

    [this.trackedTracks, this.lostTracks] = removeDuplicates(
      this.trackedTracks,
      this.lostTracks,
    );

    this.removedTracks.push(...newlyRemoved);

    if (this.removedTracks.length > 1000) {
      this.removedTracks = this.removedTracks.slice(-1000);
    }
  }
}

function jointTracks(
  primary: readonly STrack[],
  secondary: readonly STrack[],
): STrack[] {
  const ids = new Set(primary.map((track) => track.trackId));

  return [
    ...primary,
    ...secondary.filter((track) => !ids.has(track.trackId)),
  ];
}

function subtractTracks(
  source: readonly STrack[],
  excluded: readonly STrack[],
): STrack[] {
  const excludedIds = new Set(
    excluded.map((track) => track.trackId),
  );

  return source.filter(
    (track) => !excludedIds.has(track.trackId),
  );
}

function removeDuplicates(
  tracked: readonly STrack[],
  lost: readonly STrack[],
): [STrack[], STrack[]] {
  const removeTracked = new Set<number>();
  const removeLost = new Set<number>();

  for (
    let trackedIndex = 0;
    trackedIndex < tracked.length;
    trackedIndex += 1
  ) {
    for (
      let lostIndex = 0;
      lostIndex < lost.length;
      lostIndex += 1
    ) {
      const iouDistance = 1 - boxIou(
        tracked[trackedIndex].box,
        lost[lostIndex].box,
      );

      if (iouDistance >= 0.15) {
        continue;
      }

      const trackedLifetime = (
        tracked[trackedIndex].frameId
        - tracked[trackedIndex].startFrame
      );

      const lostLifetime = (
        lost[lostIndex].frameId
        - lost[lostIndex].startFrame
      );

      if (trackedLifetime > lostLifetime) {
        removeLost.add(lostIndex);
      } else {
        removeTracked.add(trackedIndex);
      }
    }
  }

  return [
    tracked.filter((_, index) => !removeTracked.has(index)),
    lost.filter((_, index) => !removeLost.has(index)),
  ];
}
