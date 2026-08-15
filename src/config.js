/**
 * QUEEN'S TUG — Configuration
 * Spec §3 (Authoritative Initial Configuration), §25 step 2.
 *
 * Every tunable value in the game lives here. Nothing else in the codebase
 * may hard-code a rule constant. Playtesting (§27) tunes THIS FILE ONLY.
 */

export const DIRECTIONS = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/** Row 0 is the top row. UP decreases row index. (§4) */
export const VECTORS = {
  UP: { dr: -1, dc: 0 },
  DOWN: { dr: 1, dc: 0 },
  LEFT: { dr: 0, dc: -1 },
  RIGHT: { dr: 0, dc: 1 },
};

export const OPPOSITE = {
  UP: 'DOWN',
  DOWN: 'UP',
  LEFT: 'RIGHT',
  RIGHT: 'LEFT',
};

export const PHASES = {
  LOBBY: 'LOBBY',
  PLAN: 'PLAN',
  RESOLVE: 'RESOLVE',
  FINISHED: 'FINISHED',
};

export const STATUS = {
  LOBBY: 'LOBBY',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
};

export const CONTROL_MODE = { HUMAN: 'HUMAN', AI: 'AI' };
export const CONNECTION = { CONNECTED: 'CONNECTED', DISCONNECTED: 'DISCONNECTED', ABSENT: 'ABSENT' };

export const DEFAULT_CONFIG = {
  /** §3 — Exactly 4 players. */
  playerCount: 4,

  /** §3 — 12 × 12 board. */
  boardWidth: 12,
  boardHeight: 12,

  /** Starting coins per player. Tune here — there is no in-game setting. */
  startingCoins: 50,

  /** Replenishment amount when all four players are exhausted (§11). */
  replenishCoins: 50,

  /** Seconds a player gets to plan each round. Tune here. */
  decisionTimerMs: 20000,

  /**
   * §4.1 — Conservative safety margin. Hidden objects must be at least this
   * many full cells away from the board boundary. On 12×12 with margin 1 this
   * yields rows 1–10 and columns 1–10 (zero-based).
   */
  boundaryMargin: 1,

  /**
   * Every bonus stack starts at this value and decays by the queen's actual
   * travel distance each round (§10.2). One number, not a band.
   */
  bonusStartReward: 50,

  /** §10.2 — Bonus decays by actual queen movement, clamped at this floor. */
  bonusMinReward: 0,

  /** §3 — No game time limit. §26 forbids introducing one. */
  gameTimeLimitMs: null,

  /**
   * ─── DOCUMENTED DEVIATION SWITCH — DEFAULT OFF (spec-exact) ───────────────
   *
   * §11 replenishes coins only when ALL FOUR players are exhausted, and §26
   * forbids a game time limit. Those two rules together allow a permanent
   * stalemate: if three players are at zero and the fourth simply declines to
   * bid, nothing can ever change. No rule in the specification can break it.
   * Headless simulation reproduced this in 20% of AI games before the AI was
   * taught to spend when the table goes quiet.
   *
   * `null` = specification behaviour exactly. Set to a number N to replenish
   * everyone after N consecutive rounds in which the entire table bid zero.
   * Recommended playtest value: 3. Leave it null unless you are deliberately
   * testing the change, and record the change per §25 step 24.
   */
  stalemateReplenishRounds: null,
};

/** Presentation-only pacing values. These never affect rules. */
export const UI_TIMING = {
  cancelAnimMs: 900,
  travelMsPerCell: 110,
  travelMinMs: 420,
  resolutionHoldMs: 1400,
  aiThinkMinMs: 700,
  aiThinkMaxMs: 2600,
  /** Sequential (pass-and-play) mode: computer seats answer briskly. */
  aiSequentialMs: 450,
  replayStepMs: 260,
};

/**
 * Scale every animation and AI-pacing delay by a factor. Presentation only —
 * no rule, timer deadline or resolution depends on these numbers, so speeding
 * them up cannot change the outcome of a game. Used by `?turbo=N` for
 * automated UI tests and for running fast playtest sessions (§27).
 */
export function setPacing(multiplier) {
  const m = Math.max(0.02, Math.min(4, Number(multiplier) || 1));
  for (const key of Object.keys(UI_TIMING)) {
    UI_TIMING[key] = Math.max(1, Math.round(UI_TIMING[key] * m));
  }
  return UI_TIMING;
}

/** Ludo-style seat identity: red, green, blue, yellow. */
export const SEAT_COLORS = ['#e0453f', '#3faa54', '#3d86e8', '#e8b021'];
export const SEAT_COLORS_LIGHT = ['#ff8a84', '#7ede8c', '#8dc0ff', '#ffd97a'];
export const SEAT_NAMES = ['You', 'Player 2', 'Player 3', 'Player 4'];
