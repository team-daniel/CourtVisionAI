import type {
  BoundingBox,
  Point,
  StableDetection,
} from "../core/detections";
import {
  boxCenter,
  boxesIntersect,
  distanceFromPointToBox,
  pointInBox,
  segmentIntersectsBox,
} from "../core/geometry";
import type {
  GameMode,
  GameParticipantSnapshot,
  GameSnapshot,
} from "./game-mode";

export type BasketballGameState =
  | "NO POSSESSION"
  | "PLAYER A POSSESSION"
  | "PLAYER B POSSESSION"
  | "SHOT ATTEMPT"
  | "SHOT MADE";

type PlayerKey = "A" | "B";

export interface OneVOneGameModeOptions {
  confirmFrames?: number;
  effectiveFps?: number;
  minimumConfirmations?: number;
  ballMissingGrace?: number;
  maxBallDistance?: number;
  possessionMargin?: number;
  shotConfirmFrames?: number;
  madeConfirmFrames?: number;
  shotTimeoutFrames?: number;
  madeClearFrames?: number;
}

const NO_POSSESSION: BasketballGameState = "NO POSSESSION";
const PLAYER_A_POSSESSION: BasketballGameState = "PLAYER A POSSESSION";
const PLAYER_B_POSSESSION: BasketballGameState = "PLAYER B POSSESSION";
const SHOT_ATTEMPT: BasketballGameState = "SHOT ATTEMPT";
const SHOT_MADE: BasketballGameState = "SHOT MADE";
const REFERENCE_FPS = 30;

export class OneVOneGameMode implements GameMode {
  readonly id = "1v1" as const;

  private readonly referenceConfirmFrames: number;
  private readonly referenceBallMissingGrace: number;
  private readonly referenceShotConfirmFrames: number;
  private readonly referenceMadeConfirmFrames: number;
  private readonly referenceShotTimeoutFrames: number;
  private readonly referenceMadeClearFrames: number;
  private readonly minimumConfirmations: number;
  private readonly maxBallDistance: number;
  private readonly possessionMargin: number;

  private effectiveFps = REFERENCE_FPS;
  private confirmFrames = 3;
  private ballMissingGrace = 15;
  private shotConfirmFrames = 1;
  private madeConfirmFrames = 2;
  private shotTimeoutFrames = 90;
  private madeClearFrames = 6;

  private state: BasketballGameState = NO_POSSESSION;
  private previousState: BasketballGameState = NO_POSSESSION;
  private playerAId: number | null = null;
  private playerBId: number | null = null;
  private candidateState: BasketballGameState | null = null;
  private candidateFrames = 0;
  private ballMissingFrames = 0;
  private ballGapBeforeCurrent = 0;
  private lastBallTrackId: number | null = null;
  private lastObservedState: BasketballGameState = NO_POSSESSION;
  private lastDistances = new Map<PlayerKey, number>();
  private previousDistances = new Map<PlayerKey, number>();
  private currentBallCenter: Point | null = null;
  private previousBallCenter: Point | null = null;
  private currentBasketDistance: number | null = null;
  private previousBasketDistance: number | null = null;
  private lastBasketBox: BoundingBox | null = null;
  private recentShooter: PlayerKey | null = null;
  private recentShootingFrames = 0;
  private releasePending = false;
  private releaseFrom: PlayerKey | null = null;
  private releaseFrames = 0;
  private releaseCandidateState: BasketballGameState | null = null;
  private releaseCandidateFrames = 0;
  private releaseShootingSeen = false;
  private releaseMovedAway = false;
  private releaseApproachedBasket = false;
  private releaseReachedBasketHeight = false;
  private releaseNearBasket = false;
  private releaseBallInBasket = false;
  private releaseBallBelowBasket = false;
  private releaseShotEvidenceFrames = 0;
  private releaseReappearanceCandidate = false;
  private releaseFreshShotEvidence = false;
  private shooter: PlayerKey | null = null;
  private shotFrames = 0;
  private shotMovedAwayFromBasket = false;
  private madePending = false;
  private madePathStart: Point | null = null;
  private madeBelowFrames = 0;
  private madeClearCounter = 0;
  private readonly attempts: Record<PlayerKey, number> = { A: 0, B: 0 };
  private readonly makes: Record<PlayerKey, number> = { A: 0, B: 0 };
  private readonly rebounds: Record<PlayerKey, number> = { A: 0, B: 0 };

  constructor({
    confirmFrames = 3,
    effectiveFps = REFERENCE_FPS,
    minimumConfirmations = 1,
    ballMissingGrace = 15,
    maxBallDistance = 0.25,
    possessionMargin = 0.05,
    shotConfirmFrames = 1,
    madeConfirmFrames = 2,
    shotTimeoutFrames = 90,
    madeClearFrames = 6,
  }: OneVOneGameModeOptions = {}) {
    this.referenceConfirmFrames = confirmFrames;
    this.referenceBallMissingGrace = ballMissingGrace;
    this.referenceShotConfirmFrames = shotConfirmFrames;
    this.referenceMadeConfirmFrames = madeConfirmFrames;
    this.referenceShotTimeoutFrames = shotTimeoutFrames;
    this.referenceMadeClearFrames = madeClearFrames;
    this.minimumConfirmations = Math.max(
      Math.floor(minimumConfirmations),
      1,
    );
    this.maxBallDistance = maxBallDistance;
    this.possessionMargin = possessionMargin;
    this.configureTiming(effectiveFps);
    this.reset();
  }

  configureTiming(effectiveFps: number): void {
    this.effectiveFps = Math.max(effectiveFps, 0.01);
    this.confirmFrames = this.scaleFrames(
      this.referenceConfirmFrames,
      this.minimumConfirmations,
    );
    this.shotConfirmFrames = this.scaleFrames(
      this.referenceShotConfirmFrames,
      this.minimumConfirmations,
    );
    this.madeConfirmFrames = this.scaleFrames(
      this.referenceMadeConfirmFrames,
      this.minimumConfirmations,
    );
    this.ballMissingGrace = this.scaleFrames(
      this.referenceBallMissingGrace,
      1,
    );
    this.shotTimeoutFrames = this.scaleFrames(
      this.referenceShotTimeoutFrames,
      1,
    );
    this.madeClearFrames = this.scaleFrames(
      this.referenceMadeClearFrames,
      1,
    );
  }

  reset(): void {
    this.state = NO_POSSESSION;
    this.previousState = NO_POSSESSION;
    this.playerAId = null;
    this.playerBId = null;
    this.candidateState = null;
    this.candidateFrames = 0;
    this.ballMissingFrames = 0;
    this.ballGapBeforeCurrent = 0;
    this.lastBallTrackId = null;
    this.lastObservedState = NO_POSSESSION;
    this.lastDistances.clear();
    this.previousDistances.clear();
    this.currentBallCenter = null;
    this.previousBallCenter = null;
    this.currentBasketDistance = null;
    this.previousBasketDistance = null;
    this.lastBasketBox = null;
    this.recentShooter = null;
    this.recentShootingFrames = 0;
    this.releasePending = false;
    this.releaseFrom = null;
    this.releaseFrames = 0;
    this.releaseCandidateState = null;
    this.releaseCandidateFrames = 0;
    this.releaseShootingSeen = false;
    this.releaseMovedAway = false;
    this.releaseApproachedBasket = false;
    this.releaseReachedBasketHeight = false;
    this.releaseNearBasket = false;
    this.releaseBallInBasket = false;
    this.releaseBallBelowBasket = false;
    this.releaseShotEvidenceFrames = 0;
    this.releaseReappearanceCandidate = false;
    this.releaseFreshShotEvidence = false;
    this.shooter = null;
    this.shotFrames = 0;
    this.shotMovedAwayFromBasket = false;
    this.madePending = false;
    this.madePathStart = null;
    this.madeBelowFrames = 0;
    this.madeClearCounter = 0;
    this.attempts.A = 0;
    this.attempts.B = 0;
    this.makes.A = 0;
    this.makes.B = 0;
    this.rebounds.A = 0;
    this.rebounds.B = 0;
  }

  update(detections: readonly StableDetection[]): GameSnapshot {
    const geometry = this.updateGeometry(detections);
    const { playerA, playerB, ball, basket } = geometry;

    this.updateRecentShooter(detections);

    const semanticBallInBasket =
      this.semanticBallInBasketAtBasket(detections, basket);
    const ballInBasket = this.ballIsInBasket(
      detections,
      ball,
      basket,
    );

    if (this.state === SHOT_MADE) {
      if (ballInBasket) {
        this.madeClearCounter = 0;
      } else {
        this.madeClearCounter += 1;
      }

      if (this.madeClearCounter >= this.madeClearFrames) {
        this.setState(NO_POSSESSION);
        this.shooter = null;
      }

      this.lastObservedState = this.state;
      return this.snapshot();
    }

    if (this.state === SHOT_ATTEMPT) {
      this.updateShotAttempt(
        playerA,
        playerB,
        ball,
        basket,
        ballInBasket,
      );
      return this.snapshot();
    }

    if (this.releasePending) {
      this.updateReleasePending(
        playerA,
        playerB,
        ball,
        basket,
        ballInBasket,
        semanticBallInBasket,
      );
      return this.snapshot();
    }

    let observedState = this.observePossession(
      playerA,
      playerB,
      ball,
      true,
    );

    if (
      this.playersOverlap(playerA, playerB)
      && isPossessionState(this.state)
    ) {
      observedState = this.state;
    }

    this.lastObservedState = observedState;

    if (isPossessionState(this.state)) {
      const possessor: PlayerKey = this.state === PLAYER_A_POSSESSION
        ? "A"
        : "B";
      const possessorDetection = possessor === "A"
        ? playerA
        : playerB;
      const currentDistance = this.lastDistances.get(possessor);

      const ballReleased = (
        ball === null
        || ballInBasket
        || (
          possessorDetection !== null
          && currentDistance !== undefined
          && currentDistance > this.maxBallDistance
        )
      );

      if (ballReleased) {
        this.startRelease(possessor);
        this.updateReleasePending(
          playerA,
          playerB,
          ball,
          basket,
          ballInBasket,
          semanticBallInBasket,
        );
        return this.snapshot();
      }
    }

    this.setCandidateState(observedState);
    return this.snapshot();
  }

  playerLabel(trackId: number | null): string | null {
    if (trackId === this.playerAId) {
      return "Player A";
    }

    if (trackId === this.playerBId) {
      return "Player B";
    }

    return null;
  }

  private snapshot(): GameSnapshot {
    const participants: GameParticipantSnapshot[] = [
      {
        key: "A",
        label: "Player A",
        trackId: this.playerAId,
        attempts: this.attempts.A,
        makes: this.makes.A,
        rebounds: this.rebounds.A,
      },
      {
        key: "B",
        label: "Player B",
        trackId: this.playerBId,
        attempts: this.attempts.B,
        makes: this.makes.B,
        rebounds: this.rebounds.B,
      },
    ];

    return {
      modeId: this.id,
      state: this.state,
      participants,
    };
  }

  private scaleFrames(referenceFrames: number, minimum: number): number {
    return Math.max(
      minimum,
      Math.ceil(referenceFrames * this.effectiveFps / REFERENCE_FPS),
    );
  }

  private setState(newState: BasketballGameState): void {
    if (newState !== this.state) {
      this.previousState = this.state;
      this.state = newState;
    }

    this.candidateState = null;
    this.candidateFrames = 0;
  }

  private setCandidateState(observedState: BasketballGameState): boolean {
    if (observedState === this.state) {
      this.candidateState = null;
      this.candidateFrames = 0;
      return false;
    }

    if (observedState === this.candidateState) {
      this.candidateFrames += 1;
    } else {
      this.candidateState = observedState;
      this.candidateFrames = 1;
    }

    if (this.candidateFrames < this.confirmFrames) {
      return false;
    }

    this.setState(observedState);
    return true;
  }

  private assignPlayerIds(detections: readonly StableDetection[]): void {
    const playerIds = Array.from(new Set(
      detections
        .filter((detection) => isPlayerClass(detection.classId))
        .map((detection) => detection.trackId),
    )).sort((idA, idB) => idA - idB);

    if (this.playerAId === null && playerIds.length > 0) {
      this.playerAId = playerIds[0];
    }

    if (this.playerBId === null) {
      this.playerBId = playerIds.find(
        (trackId) => trackId !== this.playerAId,
      ) ?? null;
    }
  }

  private playerDetection(
    detections: readonly StableDetection[],
    trackId: number | null,
  ): StableDetection | null {
    if (trackId === null) {
      return null;
    }

    return detections.find((detection) => (
      detection.trackId === trackId
      && isPlayerClass(detection.classId)
    )) ?? null;
  }

  private ballDetection(
    detections: readonly StableDetection[],
  ): StableDetection | null {
    const balls = detections.filter(
      (detection) => detection.classId === 0,
    );

    if (balls.length === 0) {
      return null;
    }

    if (this.lastBallTrackId !== null) {
      const trackedBall = balls.find(
        (detection) => detection.trackId === this.lastBallTrackId,
      );

      if (trackedBall) {
        return trackedBall;
      }
    }

    const ball = [...balls].sort(
      (ballA, ballB) => ballB.confidence - ballA.confidence,
    )[0];
    this.lastBallTrackId = ball.trackId;
    return ball;
  }

  private basketDetection(
    detections: readonly StableDetection[],
  ): StableDetection | null {
    const baskets = detections.filter(
      (detection) => detection.classId === 3,
    );

    return baskets.length === 0
      ? null
      : [...baskets].sort(
        (basketA, basketB) => basketB.confidence - basketA.confidence,
      )[0];
  }

  private playerIsShooting(
    detections: readonly StableDetection[],
    trackId: number | null,
  ): boolean {
    return trackId !== null && detections.some((detection) => (
      detection.trackId === trackId
      && detection.classId === 4
    ));
  }

  private updateRecentShooter(
    detections: readonly StableDetection[],
  ): void {
    const shootingA = this.playerIsShooting(
      detections,
      this.playerAId,
    );
    const shootingB = this.playerIsShooting(
      detections,
      this.playerBId,
    );

    let detectedShooter: PlayerKey | null = null;

    if (this.state === PLAYER_A_POSSESSION && shootingA) {
      detectedShooter = "A";
    } else if (this.state === PLAYER_B_POSSESSION && shootingB) {
      detectedShooter = "B";
    } else if (shootingA && !shootingB) {
      detectedShooter = "A";
    } else if (shootingB && !shootingA) {
      detectedShooter = "B";
    }

    if (detectedShooter !== null) {
      this.recentShooter = detectedShooter;
      this.recentShootingFrames = this.ballMissingGrace;
    } else if (this.recentShootingFrames > 0) {
      this.recentShootingFrames -= 1;

      if (this.recentShootingFrames === 0) {
        this.recentShooter = null;
      }
    }
  }

  private updateGeometry(
    detections: readonly StableDetection[],
  ): {
    playerA: StableDetection | null;
    playerB: StableDetection | null;
    ball: StableDetection | null;
    basket: StableDetection | null;
  } {
    this.assignPlayerIds(detections);

    const playerA = this.playerDetection(detections, this.playerAId);
    const playerB = this.playerDetection(detections, this.playerBId);
    const ball = this.ballDetection(detections);
    const basket = this.basketDetection(detections);

    this.previousDistances = new Map(this.lastDistances);
    this.lastDistances.clear();

    const realBaskets = detections.filter(
      (detection) => detection.classId === 3,
    );

    if (realBaskets.length > 0) {
      const strongestBasket = [...realBaskets].sort(
        (basketA, basketB) => basketB.confidence - basketA.confidence,
      )[0];
      this.lastBasketBox = [...strongestBasket.box];
    }

    if (!ball) {
      this.ballGapBeforeCurrent = 0;
      this.ballMissingFrames += 1;

      if (this.ballMissingFrames > this.ballMissingGrace) {
        this.currentBallCenter = null;
        this.previousBallCenter = null;
        this.currentBasketDistance = null;
        this.previousBasketDistance = null;
      }

      return { playerA, playerB, ball: null, basket };
    }

    this.ballGapBeforeCurrent = this.ballMissingFrames;
    this.ballMissingFrames = 0;

    const newBallCenter = boxCenter(ball.box);

    if (this.currentBallCenter !== null) {
      this.previousBallCenter = [...this.currentBallCenter];
    }

    this.currentBallCenter = newBallCenter;

    for (const [key, player] of [
      ["A", playerA],
      ["B", playerB],
    ] as const) {
      if (!player) {
        continue;
      }

      const playerHeight = Math.max(
        player.box[3] - player.box[1],
        1,
      );
      this.lastDistances.set(
        key,
        distanceFromPointToBox(newBallCenter, player.box)
          / playerHeight,
      );
    }

    const referenceBasketBox = basket?.box ?? this.lastBasketBox;

    if (referenceBasketBox) {
      const basketCenter = boxCenter(referenceBasketBox);
      const basketDiagonal = Math.max(
        Math.hypot(
          referenceBasketBox[2] - referenceBasketBox[0],
          referenceBasketBox[3] - referenceBasketBox[1],
        ),
        1,
      );
      const newBasketDistance = Math.hypot(
        newBallCenter[0] - basketCenter[0],
        newBallCenter[1] - basketCenter[1],
      ) / basketDiagonal;

      if (this.currentBasketDistance !== null) {
        this.previousBasketDistance = this.currentBasketDistance;
      }

      this.currentBasketDistance = newBasketDistance;
    }

    return { playerA, playerB, ball, basket };
  }

  private observePossession(
    playerA: StableDetection | null,
    playerB: StableDetection | null,
    ball: StableDetection | null,
    allowShortHold: boolean,
  ): BasketballGameState {
    if (!ball) {
      if (
        allowShortHold
        && isPossessionState(this.state)
        && this.ballMissingFrames <= this.ballMissingGrace
      ) {
        return this.state;
      }

      return NO_POSSESSION;
    }

    const candidates: Array<{
      distance: number;
      state: BasketballGameState;
    }> = [];

    if (playerA && this.lastDistances.has("A")) {
      candidates.push({
        distance: this.lastDistances.get("A")!,
        state: PLAYER_A_POSSESSION,
      });
    }

    if (playerB && this.lastDistances.has("B")) {
      candidates.push({
        distance: this.lastDistances.get("B")!,
        state: PLAYER_B_POSSESSION,
      });
    }

    if (candidates.length === 0) {
      return NO_POSSESSION;
    }

    candidates.sort(
      (candidateA, candidateB) => candidateA.distance - candidateB.distance,
    );

    const closest = candidates[0];

    if (closest.distance > this.maxBallDistance) {
      return NO_POSSESSION;
    }

    if (candidates.length === 1) {
      return closest.state;
    }

    if (
      candidates[1].distance - closest.distance
      < this.possessionMargin
    ) {
      return isPossessionState(this.state)
        ? this.state
        : NO_POSSESSION;
    }

    return closest.state;
  }

  private playersOverlap(
    playerA: StableDetection | null,
    playerB: StableDetection | null,
  ): boolean {
    return Boolean(
      playerA
      && playerB
      && boxesIntersect(playerA.box, playerB.box),
    );
  }

  private referenceBasketBox(
    basket: StableDetection | null,
  ): BoundingBox | null {
    return this.lastBasketBox
      ? [...this.lastBasketBox]
      : basket
        ? [...basket.box]
        : null;
  }

  private expandedBasketBox(
    basketBox: BoundingBox,
    horizontalScale = 1,
    aboveScale = 1.5,
    belowScale = 0.75,
  ): BoundingBox {
    const width = Math.max(basketBox[2] - basketBox[0], 1);
    const height = Math.max(basketBox[3] - basketBox[1], 1);

    return [
      basketBox[0] - horizontalScale * width,
      basketBox[1] - aboveScale * height,
      basketBox[2] + horizontalScale * width,
      basketBox[3] + belowScale * height,
    ];
  }

  private ballNearBasket(
    ball: StableDetection | null,
    basket: StableDetection | null,
  ): boolean {
    const basketBox = this.referenceBasketBox(basket);

    return Boolean(
      ball
      && basketBox
      && pointInBox(
        boxCenter(ball.box),
        this.expandedBasketBox(basketBox),
      ),
    );
  }

  private ballPathNearBasket(basket: StableDetection | null): boolean {
    const basketBox = this.referenceBasketBox(basket);

    return Boolean(
      this.previousBallCenter
      && this.currentBallCenter
      && basketBox
      && segmentIntersectsBox(
        this.previousBallCenter,
        this.currentBallCenter,
        this.expandedBasketBox(basketBox),
      ),
    );
  }

  private ballReachedBasketHeight(
    basket: StableDetection | null,
  ): boolean {
    const basketBox = this.referenceBasketBox(basket);

    if (!basketBox || !this.currentBallCenter) {
      return false;
    }

    if (this.currentBallCenter[1] <= basketBox[3]) {
      return true;
    }

    return Boolean(
      this.previousBallCenter
      && this.previousBallCenter[1] <= basketBox[3],
    );
  }

  private ballPathCrossedHoop(
    start: Point | null,
    end: Point | null,
    ball: StableDetection | null,
    basket: StableDetection | null,
  ): boolean {
    const basketBox = this.referenceBasketBox(basket);

    if (!start || !end || !ball || !basketBox) {
      return false;
    }

    if (end[1] <= start[1]) {
      return false;
    }

    const hoopY = (basketBox[1] + basketBox[3]) / 2;

    if (!(start[1] <= hoopY && hoopY <= end[1])) {
      return false;
    }

    const crossingFraction = (
      (hoopY - start[1]) / (end[1] - start[1])
    );
    const crossingX = (
      start[0]
      + crossingFraction * (end[0] - start[0])
    );
    const ballRadius = Math.max(
      (ball.box[2] - ball.box[0]) / 2,
      1,
    );

    return (
      crossingX >= basketBox[0] - ballRadius
      && crossingX <= basketBox[2] + ballRadius
    );
  }

  private currentBallCrossedHoop(
    ball: StableDetection | null,
    basket: StableDetection | null,
  ): boolean {
    return this.ballPathCrossedHoop(
      this.previousBallCenter,
      this.currentBallCenter,
      ball,
      basket,
    );
  }

  private madePathStartBeforeEvent(
    ball: StableDetection | null,
  ): Point | null {
    if (ball && this.previousBallCenter) {
      return [...this.previousBallCenter];
    }

    if (this.currentBallCenter) {
      return [...this.currentBallCenter];
    }

    return this.previousBallCenter
      ? [...this.previousBallCenter]
      : null;
  }

  private startMadePending(ball: StableDetection | null): boolean {
    if (this.madePending) {
      return false;
    }

    this.madePending = true;
    this.madePathStart = this.madePathStartBeforeEvent(ball);
    this.madeBelowFrames = 0;
    return true;
  }

  private clearMadePending(): void {
    this.madePending = false;
    this.madePathStart = null;
    this.madeBelowFrames = 0;
  }

  private semanticBallInBasketAtBasket(
    detections: readonly StableDetection[],
    basket: StableDetection | null,
  ): boolean {
    const semanticDetections = detections.filter(
      (detection) => detection.classId === 1,
    );
    const basketBox = this.referenceBasketBox(basket);

    if (semanticDetections.length === 0 || !basketBox) {
      return false;
    }

    const width = Math.max(basketBox[2] - basketBox[0], 1);
    const height = Math.max(basketBox[3] - basketBox[1], 1);
    const validationBox: BoundingBox = [
      basketBox[0] - 0.25 * width,
      basketBox[1] - 0.25 * height,
      basketBox[2] + 0.25 * width,
      basketBox[3] + 0.25 * height,
    ];

    return semanticDetections.some(
      (detection) => pointInBox(boxCenter(detection.box), validationBox),
    );
  }

  private ballAlignedBelowBasket(
    ball: StableDetection | null,
    basket: StableDetection | null,
  ): boolean {
    const basketBox = this.referenceBasketBox(basket);

    if (!ball || !basketBox) {
      return false;
    }

    const [ballX, ballY] = boxCenter(ball.box);
    const ballRadius = Math.max(
      (ball.box[2] - ball.box[0]) / 2,
      1,
    );

    return (
      ballX >= basketBox[0] - ballRadius
      && ballX <= basketBox[2] + ballRadius
      && ballY > basketBox[3]
    );
  }

  private ballIsInBasket(
    detections: readonly StableDetection[],
    ball: StableDetection | null,
    basket: StableDetection | null,
  ): boolean {
    if (!this.semanticBallInBasketAtBasket(detections, basket)) {
      return false;
    }

    const basketBox = this.referenceBasketBox(basket);

    if (!basketBox) {
      return false;
    }

    const width = Math.max(basketBox[2] - basketBox[0], 1);
    const height = Math.max(basketBox[3] - basketBox[1], 1);
    const validationBox: BoundingBox = [
      basketBox[0] - 0.50 * width,
      basketBox[1] - 0.75 * height,
      basketBox[2] + 0.50 * width,
      basketBox[3] + 0.75 * height,
    ];

    if (ball) {
      return pointInBox(boxCenter(ball.box), validationBox);
    }

    if (
      this.currentBallCenter
      && pointInBox(this.currentBallCenter, validationBox)
    ) {
      return true;
    }

    if (
      this.previousBallCenter
      && this.currentBallCenter
      && segmentIntersectsBox(
        this.previousBallCenter,
        this.currentBallCenter,
        validationBox,
      )
    ) {
      return true;
    }

    if (this.state === SHOT_ATTEMPT) {
      return true;
    }

    return (
      this.releasePending
      && this.releaseReachedBasketHeight
      && (
        this.releaseNearBasket
        || (
          this.releaseMovedAway
          && this.releaseApproachedBasket
        )
      )
    );
  }

  private startRelease(shooter: PlayerKey): void {
    this.releasePending = true;
    this.releaseFrom = shooter;
    this.releaseFrames = 0;
    this.releaseCandidateState = null;
    this.releaseCandidateFrames = 0;
    this.releaseShootingSeen = (
      this.recentShooter === shooter
      && this.recentShootingFrames > 0
    );
    this.releaseMovedAway = false;
    this.releaseApproachedBasket = false;
    this.releaseReachedBasketHeight = false;
    this.releaseNearBasket = false;
    this.releaseBallInBasket = false;
    this.releaseBallBelowBasket = false;
    this.releaseShotEvidenceFrames = 0;
    this.releaseReappearanceCandidate = false;
    this.releaseFreshShotEvidence = false;
    this.candidateState = null;
    this.candidateFrames = 0;
  }

  private clearRelease(): void {
    this.releasePending = false;
    this.releaseFrom = null;
    this.releaseFrames = 0;
    this.releaseCandidateState = null;
    this.releaseCandidateFrames = 0;
    this.releaseShootingSeen = false;
    this.releaseMovedAway = false;
    this.releaseApproachedBasket = false;
    this.releaseReachedBasketHeight = false;
    this.releaseNearBasket = false;
    this.releaseBallInBasket = false;
    this.releaseBallBelowBasket = false;
    this.releaseShotEvidenceFrames = 0;
    this.releaseReappearanceCandidate = false;
    this.releaseFreshShotEvidence = false;
  }

  private updateReleaseCandidate(
    observedState: BasketballGameState,
  ): boolean {
    if (!isPossessionState(observedState)) {
      this.releaseCandidateState = null;
      this.releaseCandidateFrames = 0;
      return false;
    }

    if (observedState === this.releaseCandidateState) {
      this.releaseCandidateFrames += 1;
    } else {
      this.releaseCandidateState = observedState;
      this.releaseCandidateFrames = 1;
    }

    return this.releaseCandidateFrames >= this.confirmFrames;
  }

  private updateReleaseEvidence(
    ball: StableDetection | null,
    basket: StableDetection | null,
    ballInBasket: boolean,
  ): boolean {
    if (
      this.recentShooter === this.releaseFrom
      && this.recentShootingFrames > 0
    ) {
      this.releaseShootingSeen = true;
    }

    let freshPhysicalTrajectory = false;
    let freshSemanticThenBelow = false;
    this.releaseFreshShotEvidence = false;

    if (ball) {
      const currentDistance = this.releaseFrom
        ? this.lastDistances.get(this.releaseFrom)
        : undefined;
      const previousDistance = this.releaseFrom
        ? this.previousDistances.get(this.releaseFrom)
        : undefined;

      let movedAwayNow = false;

      if (currentDistance !== undefined) {
        movedAwayNow = (
          currentDistance > this.maxBallDistance
          || (
            previousDistance !== undefined
            && currentDistance > previousDistance
          )
        );

        if (movedAwayNow) {
          this.releaseMovedAway = true;
        }
      }

      const approachedBasketNow = (
        this.currentBasketDistance !== null
        && this.previousBasketDistance !== null
        && this.currentBasketDistance < this.previousBasketDistance
      );

      if (approachedBasketNow) {
        this.releaseApproachedBasket = true;
      }

      const reachedBasketHeightNow =
        this.ballReachedBasketHeight(basket);

      if (reachedBasketHeightNow) {
        this.releaseReachedBasketHeight = true;
      }

      const nearBasketNow = (
        this.ballNearBasket(ball, basket)
        || this.ballPathNearBasket(basket)
      );

      if (nearBasketNow) {
        this.releaseNearBasket = true;
      }

      freshPhysicalTrajectory = (
        reachedBasketHeightNow
        && (
          nearBasketNow
          || (movedAwayNow && approachedBasketNow)
        )
      );
    }

    if (ballInBasket) {
      this.releaseBallInBasket = true;
    }

    if (
      ball
      && this.releaseBallInBasket
      && this.releaseMovedAway
      && this.ballAlignedBelowBasket(ball, basket)
    ) {
      this.releaseBallBelowBasket = true;
      freshSemanticThenBelow = true;
    }

    this.releaseFreshShotEvidence = (
      freshPhysicalTrajectory
      || freshSemanticThenBelow
    );

    return this.releaseFreshShotEvidence;
  }

  private startShot(shooter: PlayerKey | null): void {
    this.shooter = shooter;

    if (shooter) {
      this.attempts[shooter] += 1;
    }

    this.shotFrames = 0;
    this.shotMovedAwayFromBasket = false;
    this.clearMadePending();
    this.madeClearCounter = 0;
    this.clearRelease();
    this.setState(SHOT_ATTEMPT);
  }

  private confirmMadeShot(): void {
    if (this.shooter) {
      this.makes[this.shooter] += 1;
    }

    this.clearMadePending();
    this.madeClearCounter = 0;
    this.setState(SHOT_MADE);
  }

  private updateReleasePending(
    playerA: StableDetection | null,
    playerB: StableDetection | null,
    ball: StableDetection | null,
    basket: StableDetection | null,
    ballInBasket: boolean,
    _semanticBallInBasket: boolean,
  ): BasketballGameState {
    this.releaseFrames += 1;

    const freshShotEvidence = this.updateReleaseEvidence(
      ball,
      basket,
      ballInBasket,
    );

    const observedState = this.observePossession(
      playerA,
      playerB,
      ball,
      false,
    );
    this.lastObservedState = observedState;

    const playersOverlapping = this.playersOverlap(playerA, playerB);
    const observedPlayer: PlayerKey | null =
      observedState === PLAYER_A_POSSESSION
        ? "A"
        : observedState === PLAYER_B_POSSESSION
          ? "B"
          : null;

    if (
      !playersOverlapping
      && observedPlayer !== null
      && observedPlayer !== this.releaseFrom
    ) {
      if (this.updateReleaseCandidate(observedState)) {
        this.clearRelease();
        this.setState(observedState);
      }

      return this.state;
    }

    let requiredEvidenceFrames = this.shotConfirmFrames;

    if (freshShotEvidence) {
      if (
        this.ballGapBeforeCurrent > 0
        && this.confirmFrames > 1
        && !this.releaseReappearanceCandidate
      ) {
        this.releaseReappearanceCandidate = true;
        this.releaseShotEvidenceFrames = 1;
      } else {
        this.releaseShotEvidenceFrames += 1;
      }

      requiredEvidenceFrames = this.releaseReappearanceCandidate
        ? this.confirmFrames
        : this.shotConfirmFrames;
    } else {
      this.releaseShotEvidenceFrames = 0;
      this.releaseReappearanceCandidate = false;
    }

    if (
      freshShotEvidence
      && this.releaseShotEvidenceFrames >= requiredEvidenceFrames
    ) {
      const shooter = this.releaseFrom;
      const madeEvidenceSeen = this.releaseBallInBasket;
      this.startShot(shooter);

      if (madeEvidenceSeen) {
        this.startMadePending(ball);
      }

      return this.state;
    }

    if (
      !playersOverlapping
      && isPossessionState(observedState)
    ) {
      if (this.updateReleaseCandidate(observedState)) {
        this.clearRelease();
        this.setState(observedState);
      }

      return this.state;
    }

    this.releaseCandidateState = null;
    this.releaseCandidateFrames = 0;

    const releaseTimeout = Math.max(
      this.ballMissingGrace * 2,
      this.confirmFrames,
    );

    if (this.releaseFrames >= releaseTimeout) {
      this.clearRelease();
      this.setState(NO_POSSESSION);
    }

    return this.state;
  }

  private updateShotAttempt(
    playerA: StableDetection | null,
    playerB: StableDetection | null,
    ball: StableDetection | null,
    basket: StableDetection | null,
    ballInBasket: boolean,
  ): BasketballGameState {
    this.shotFrames += 1;

    if (
      this.currentBasketDistance !== null
      && this.previousBasketDistance !== null
      && this.currentBasketDistance > this.previousBasketDistance
    ) {
      this.shotMovedAwayFromBasket = true;
    }

    let pendingStartedThisFrame = false;

    if (ballInBasket) {
      pendingStartedThisFrame = this.startMadePending(ball);
    }

    if (this.currentBallCrossedHoop(ball, basket)) {
      this.confirmMadeShot();
      return this.state;
    }

    if (
      this.madePending
      && !pendingStartedThisFrame
      && ball
      && this.currentBallCenter
    ) {
      const basketBox = this.referenceBasketBox(basket);
      let pathResolved = false;

      if (basketBox) {
        const ballRadius = Math.max(
          (ball.box[2] - ball.box[0]) / 2,
          1,
        );
        const currentY = this.currentBallCenter[1];

        if (currentY > basketBox[3] + ballRadius) {
          pathResolved = true;

          if (
            this.ballPathCrossedHoop(
              this.madePathStart,
              this.currentBallCenter,
              ball,
              basket,
            )
          ) {
            this.confirmMadeShot();
            return this.state;
          }
        } else if (currentY < basketBox[1] - ballRadius) {
          pathResolved = true;
        }
      }

      if (pathResolved) {
        this.clearMadePending();
      }
    }

    const observedState = this.observePossession(
      playerA,
      playerB,
      ball,
      false,
    );
    this.lastObservedState = observedState;

    if (
      isPossessionState(observedState)
      && !this.shotMovedAwayFromBasket
    ) {
      this.candidateState = null;
      this.candidateFrames = 0;
      return this.state;
    }

    if (this.playersOverlap(playerA, playerB)) {
      this.candidateState = null;
      this.candidateFrames = 0;
      return this.state;
    }

    if (isPossessionState(observedState)) {
      const observedPlayer: PlayerKey =
        observedState === PLAYER_A_POSSESSION ? "A" : "B";
      const sameShooterStillAtHoop = (
        observedPlayer === this.shooter
        && (
          this.ballNearBasket(ball, basket)
          || this.ballPathNearBasket(basket)
        )
      );

      if (sameShooterStillAtHoop) {
        this.candidateState = null;
        this.candidateFrames = 0;
        return this.state;
      }

      if (this.setCandidateState(observedState)) {
        this.rebounds[observedPlayer] += 1;
        this.shooter = null;
        this.shotFrames = 0;
        this.clearMadePending();
      }

      return this.state;
    }

    this.candidateState = null;
    this.candidateFrames = 0;

    if (this.shotFrames >= this.shotTimeoutFrames) {
      this.setState(NO_POSSESSION);
      this.shooter = null;
      this.shotFrames = 0;
      this.clearMadePending();
    }

    return this.state;
  }
}

function isPlayerClass(classId: number): boolean {
  return classId === 2 || classId === 4;
}

function isPossessionState(
  state: BasketballGameState,
): boolean {
  return (
    state === PLAYER_A_POSSESSION
    || state === PLAYER_B_POSSESSION
  );
}
