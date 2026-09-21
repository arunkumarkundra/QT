/**
 * QUEEN'S TUG — Deterministic game engine (Spec §16)
 *
 * This module is PURE. It contains no DOM access, no networking, no timers and
 * no I/O. Every function takes state (plus inputs) and returns state or a
 * derived value. The UI renders state and collects intent; it never decides
 * outcomes. That separation is mandated by §16 and §24.
 *
 * All mutating helpers operate on a *cloned* state and return the new state,
 * so callers can never accidentally half-apply a round.
 */

import {
  DEFAULT_CONFIG,
  DIRECTIONS,
  VECTORS,
  PHASES,
  STATUS,
  CONTROL_MODE,
  CONNECTION,
  SEAT_NAMES,
} from './config.js';
import { rngFor, hashSeed, makeGameNumber } from './rng.js';

/* ------------------------------------------------------------------ *
 * Coordinate and board utilities (§4, §25 step 5)
 * ------------------------------------------------------------------ */

export const cell = (r, c) => ({ r, c });
export const cellKey = (p) => `${p.r},${p.c}`;
export const sameCell = (a, b) => !!a && !!b && a.r === b.r && a.c === b.c;

export function inBounds(state, p) {
  return p.r >= 0 && p.r < state.boardHeight && p.c >= 0 && p.c < state.boardWidth;
}

/**
 * §4.1 — Hidden objects may only occupy the inner region defined by the
 * boundary safety margin. On 12×12 with margin 1: rows 1–10, columns 1–10.
 */
export function isValidHiddenCell(state, p) {
  const m = state.config.boundaryMargin;
  return (
    p.r >= m && p.r <= state.boardHeight - 1 - m && p.c >= m && p.c <= state.boardWidth - 1 - m
  );
}

export function hiddenPlacementCells(state) {
  const out = [];
  const m = state.config.boundaryMargin;
  for (let r = m; r <= state.boardHeight - 1 - m; r++) {
    for (let c = m; c <= state.boardWidth - 1 - m; c++) out.push(cell(r, c));
  }
  return out;
}

/** The four orthogonal neighbours of the queen. Diagonals are never valid. (§4) */
export function adjacentCells(state, p = state.queenPosition) {
  const out = {};
  for (const d of DIRECTIONS) {
    const n = cell(p.r + VECTORS[d].dr, p.c + VECTORS[d].dc);
    out[d] = inBounds(state, n) ? n : null;
  }
  return out;
}

const clone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

export const emptyBid = () => ({ UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 });
export const bidTotal = (bid) => DIRECTIONS.reduce((s, d) => s + (bid?.[d] || 0), 0);

/* ------------------------------------------------------------------ *
 * Placement (§4.1, §9, §10.1, §25 step 6)
 * ------------------------------------------------------------------ */

/** Cells that a new hidden object must avoid. */
function occupiedHiddenCells(state, { includeQueen = true, exceptSeat = -1 } = {}) {
  const taken = new Set();
  state.castles.forEach((p) => p && taken.add(cellKey(p)));
  state.activeBonuses.forEach((b, i) => {
    if (b && i !== exceptSeat) taken.add(cellKey(b.position));
  });
  if (includeQueen && state.queenPosition) taken.add(cellKey(state.queenPosition));
  // A cannonball crater is scorched for the rest of the game: nothing new
  // may ever be placed there.
  (state.craters || []).forEach((p) => taken.add(cellKey(p)));
  return taken;
}

/** §6 — one hidden castle per player, never overlapping, never on the margin. */
export function generateCastles(state) {
  const rng = rngFor(state);
  const pool = rng.shuffle(hiddenPlacementCells(state));
  const taken = new Set();
  const castles = [];
  for (let seat = 0; seat < state.config.playerCount; seat++) {
    const spot = pool.find((p) => !taken.has(cellKey(p)));
    if (!spot) throw new Error('No valid castle placement remains');
    taken.add(cellKey(spot));
    castles.push(cell(spot.r, spot.c));
  }
  return castles;
}

/**
 * §10.1 — Generate one private bonus for a seat.
 * The target must satisfy the castle placement constraints, must not overlap a
 * castle, the queen, or another active bonus, and must differ from that
 * player's immediately previous bonus cell.
 */
export function generateBonus(state, seat) {
  const rng = rngFor(state);
  const taken = occupiedHiddenCells(state, { exceptSeat: seat });
  const previous = state.previousBonusCell?.[seat] || null;

  let candidates = hiddenPlacementCells(state).filter(
    (p) => !taken.has(cellKey(p)) && !(previous && sameCell(p, previous))
  );
  // Degenerate fallback: if the "different from previous" rule leaves nothing,
  // drop only that constraint — overlap constraints are never relaxed.
  if (candidates.length === 0) {
    candidates = hiddenPlacementCells(state).filter((p) => !taken.has(cellKey(p)));
  }
  if (candidates.length === 0) throw new Error('No valid bonus placement remains');

  return {
    position: rng.pick(candidates),
    reward: state.config.bonusStartReward,
  };
}

/** §6 — Queen starts on a random valid cell that overlaps no hidden object. */
export function pickQueenStart(state) {
  const rng = rngFor(state);
  const taken = occupiedHiddenCells(state, { includeQueen: false });
  const all = [];
  for (let r = 0; r < state.boardHeight; r++) {
    for (let c = 0; c < state.boardWidth; c++) {
      const p = cell(r, c);
      if (!taken.has(cellKey(p))) all.push(p);
    }
  }
  return rng.pick(all);
}

/* ------------------------------------------------------------------ *
 * Game creation (§6, §17, §25 steps 3–6)
 * ------------------------------------------------------------------ */

export function createGame({ seed, config = {}, players = [] } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const resolvedSeed = seed ?? `qt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  const state = {
    gameId: null,
    seed: String(resolvedSeed),
    rngState: hashSeed(resolvedSeed) | 0,
    status: STATUS.LOBBY,
    phase: PHASES.LOBBY,
    config: cfg,
    boardWidth: cfg.boardWidth,
    boardHeight: cfg.boardHeight,
    queenPosition: null,
    roundNumber: 0,
    timerDeadline: null,

    players: [],
    castles: [],
    activeBonuses: [],
    coinAllocationState: [],
    previousBonusCell: [],

    currentRoundBids: [],
    lockedSeats: [],
    /**
     * Seats that have left a humans-only game and are not being covered by a
     * computer. A retired seat always bids nothing and its castle can no
     * longer win, so the remaining players finish the game between them
     * instead of losing to an absent opponent's castle. Empty in every other
     * mode, which is why nothing else in the engine changes.
     */
    retiredSeats: [],

    /* ---- Cannon fire ---- */
    /** Cannonballs each seat still holds. Private: counting them would reveal who fired. */
    cannonballs: [],
    /** Every cell a cannonball has struck. Public, and permanent. */
    craters: [],
    /** Seats whose castle was destroyed. Public. They bid nothing and can never win. */
    eliminatedSeats: [],
    /** True when the last standing castles fell together and nobody won. */
    draw: false,

    completeQueenPath: [], // authoritative only — never in a PlayerView (§5.3)
    bonusLedger: [], // authoritative only — for the end reveal (§18)
    /**
     * Per-round snapshot used to replay the finished game as a public movie
     * (§18). Authoritative only: it contains every player's bonus position, so
     * it must never appear in a PlayerView.
     */
    roundLog: [],
    lastResolution: null,
    winner: null,
    consecutiveZeroBidRounds: 0,
    metrics: {
      rounds: 0,
      noMoveRounds: 0,
      splitBidDecisions: 0,
      bidDecisions: 0,
      bonusesCollected: 0,
      replenishments: 0,
      cellsTravelled: 0,
      wallBlocks: 0,
      coinsSpent: 0,
      shotsFired: 0,
      castlesDestroyed: 0,
      treasuresDestroyed: 0,
    },
  };

  const rng = rngFor(state);
  state.gameId = makeGameNumber(rng);

  for (let seat = 0; seat < cfg.playerCount; seat++) {
    const p = players[seat] || {};
    state.players.push({
      playerId: p.playerId || `seat-${seat}`,
      seat,
      displayName: p.displayName || SEAT_NAMES[seat],
      connectionStatus: p.connectionStatus || CONNECTION.CONNECTED,
      controlMode: p.controlMode || CONTROL_MODE.AI,
      /** Set when a human seat is being covered by the computer (§13). */
      takeoverReason: null,
    });
    state.coinAllocationState.push({
      coinsRemaining: cfg.startingCoins,
      allocationNumber: 1,
      spentThisAllocation: 0,
    });
    state.currentRoundBids.push(null);
    state.cannonballs.push(cfg.cannonballsPerPlayer);
    state.previousBonusCell.push(null);
    state.activeBonuses.push(null);
  }

  state.castles = generateCastles(state);
  state.queenPosition = pickQueenStart(state);
  state.completeQueenPath = [cell(state.queenPosition.r, state.queenPosition.c)];

  for (let seat = 0; seat < cfg.playerCount; seat++) {
    state.activeBonuses[seat] = generateBonus(state, seat);
    state.previousBonusCell[seat] = state.activeBonuses[seat].position;
    state.bonusLedger.push({
      seat,
      position: state.activeBonuses[seat].position,
      startReward: state.activeBonuses[seat].reward,
      round: 1,
      outcome: 'ACTIVE',
    });
  }

  return state;
}

/** §6 final step — leave the lobby and open Round 1. */
export function startGame(state, { now = Date.now() } = {}) {
  const s = clone(state);
  s.status = STATUS.PLAYING;
  s.roundNumber = 1;
  s.phase = PHASES.PLAN;
  s.timerDeadline = now + s.config.decisionTimerMs;
  s.lockedSeats = [];
  s.currentRoundBids = s.players.map(() => null);
  return applyRetirements(s);
}

/**
 * A retired seat is pre-locked on an empty bid every round, so the round can
 * complete the moment the remaining players have locked. Called wherever a new
 * round opens.
 */
export function applyRetirements(state) {
  const retired = [
    ...(state.retiredSeats || []),
    ...(state.eliminatedSeats || []),
    // Nothing to play with: no coins to stake and no cannonball to fire. The
    // only possible move is a pass, so make it for them rather than hold the
    // table to the timer. Balances only change when a round resolves, so this
    // is decided once, as the round opens, and cannot go stale mid-round.
    ...state.players
      .map((p) => p.seat)
      .filter(
        (seat) =>
          state.coinAllocationState[seat].coinsRemaining <= 0 && !((state.cannonballs || [])[seat] > 0)
      ),
  ];
  if (!retired.length) return state;
  const s = {
    ...state,
    currentRoundBids: state.currentRoundBids.slice(),
    lockedSeats: state.lockedSeats.slice(),
  };
  for (const seat of retired) {
    s.currentRoundBids[seat] = emptyBid();
    if (!s.lockedSeats.includes(seat)) s.lockedSeats.push(seat);
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * Bidding (§8, §12, §21, §25 step 7)
 * ------------------------------------------------------------------ */

/** Seats still in the game: not eliminated by cannon fire and not retired. */
export const standingSeats = (state) =>
  state.players
    .map((p) => p.seat)
    .filter((seat) => !(state.eliminatedSeats || []).includes(seat) && !(state.retiredSeats || []).includes(seat));

/**
 * Validate a cannon shot. A seat may fire at most once per round (one `shot`
 * per bid), only while it holds a cannonball, and only at a cell where a
 * castle or treasure could possibly be: inside the placement margin, not a
 * crater, not the queen's square, and never at its own castle or treasure.
 */
export function validateShot(state, seat, shot) {
  if (!shot || typeof shot !== 'object' || !Number.isInteger(shot.r) || !Number.isInteger(shot.c)) {
    return { ok: false, error: 'Malformed cannon shot.' };
  }
  const p = cell(shot.r, shot.c);
  if ((state.eliminatedSeats || []).includes(seat)) {
    return { ok: false, error: 'Your castle has fallen. You can no longer fire.' };
  }
  if (!((state.cannonballs || [])[seat] > 0)) return { ok: false, error: 'You have no cannonballs left.' };
  if (!inBounds(state, p) || !isValidHiddenCell(state, p)) {
    return { ok: false, error: 'Nothing can stand on the edge of the board. Aim further in.' };
  }
  if ((state.craters || []).some((c) => sameCell(c, p))) return { ok: false, error: 'That cell is already a crater.' };
  if (sameCell(state.queenPosition, p)) return { ok: false, error: 'You cannot fire at the queen.' };
  if (sameCell(state.castles[seat], p)) return { ok: false, error: 'That is your own castle.' };
  const own = state.activeBonuses[seat];
  if (own && !own.destroyed && sameCell(own.position, p)) return { ok: false, error: 'That is your own treasure.' };
  return { ok: true, shot: p };
}

/**
 * §8, §21, §24 — Validate a client-submitted bid. The client submits INTENT
 * only. Anything malformed, over-budget, negative, non-integer or aimed at a
 * non-adjacent cell is rejected outright.
 */
export function validateBid(state, seat, bid) {
  if (state.status !== STATUS.PLAYING || state.phase !== PHASES.PLAN) {
    return { ok: false, error: 'Bidding is closed for this round.' };
  }
  const player = state.players[seat];
  if (!player) return { ok: false, error: 'Unknown seat.' };
  if (state.lockedSeats.includes(seat)) {
    return { ok: false, error: 'This bid is already locked for the round.' };
  }
  if (!bid || typeof bid !== 'object') return { ok: false, error: 'Malformed bid.' };

  const normalised = emptyBid();
  const neighbours = adjacentCells(state);
  for (const d of DIRECTIONS) {
    const v = bid[d] ?? 0;
    if (!Number.isInteger(v) || v < 0) {
      return { ok: false, error: 'Coin counts must be whole numbers of zero or more.' };
    }
    // §21 — reject bids aimed at cells that are off the board.
    if (v > 0 && !neighbours[d]) {
      return { ok: false, error: `The queen has no cell to the ${d.toLowerCase()}.` };
    }
    normalised[d] = v;
  }
  for (const k of Object.keys(bid)) {
    if (k === 'shot') continue;
    if (!DIRECTIONS.includes(k)) return { ok: false, error: 'Bids may only target the four adjacent cells.' };
  }

  // The round's cannon shot, if any, travels with the bid: one plan, one lock.
  if (bid.shot != null) {
    const aim = validateShot(state, seat, bid.shot);
    if (!aim.ok) return aim;
    normalised.shot = aim.shot;
  }

  const total = bidTotal(normalised);
  const balance = state.coinAllocationState[seat].coinsRemaining;
  if (total > balance) {
    return { ok: false, error: `That is ${total - balance} more coins than you hold.` };
  }
  return { ok: true, bid: normalised };
}

/** Store an uncommitted placement without locking it (§12). */
export function stageBid(state, seat, bid) {
  const check = validateBid(state, seat, bid);
  if (!check.ok) return { state, ...check };
  const s = clone(state);
  s.currentRoundBids[seat] = check.bid;
  return { state: s, ok: true, bid: check.bid };
}

/** §7 LOCK — makes a bid final for the round. */
export function lockBid(state, seat, bid = undefined) {
  const proposed = bid === undefined ? state.currentRoundBids[seat] || emptyBid() : bid;
  const check = validateBid(state, seat, proposed);
  if (!check.ok) return { state, ...check };
  const s = clone(state);
  s.currentRoundBids[seat] = check.bid;
  if (!s.lockedSeats.includes(seat)) s.lockedSeats.push(seat);
  return { state: s, ok: true, bid: check.bid };
}

/**
 * §12 — Timer expiry locks whatever is currently placed. A seat with no
 * placement locks an all-zero bid.
 */
export function lockExpiredSeats(state) {
  let s = state;
  for (let seat = 0; seat < s.players.length; seat++) {
    if (!s.lockedSeats.includes(seat)) {
      const r = lockBid(s, seat, s.currentRoundBids[seat] || emptyBid());
      s = r.ok ? r.state : lockBid(s, seat, emptyBid()).state;
    }
  }
  return s;
}

export const allSeatsLocked = (state) => state.lockedSeats.length >= state.players.length;

/* ------------------------------------------------------------------ *
 * Movement resolution (§8.1, §8.3, §25 steps 8–9)
 * ------------------------------------------------------------------ */

/**
 * §8.1 — Cancel opposite directions, then take the single largest surviving
 * force. A tie for the largest surviving force means no movement.
 */
export function calculateNetMovement(bids) {
  const totals = emptyBid();
  for (const bid of bids) {
    if (!bid) continue;
    for (const d of DIRECTIONS) totals[d] += bid[d] || 0;
  }

  const verticalNet = totals.UP - totals.DOWN;
  const horizontalNet = totals.RIGHT - totals.LEFT;

  const surviving = {
    UP: Math.max(0, verticalNet),
    DOWN: Math.max(0, -verticalNet),
    RIGHT: Math.max(0, horizontalNet),
    LEFT: Math.max(0, -horizontalNet),
  };

  const best = Math.max(surviving.UP, surviving.DOWN, surviving.LEFT, surviving.RIGHT);
  const winners = DIRECTIONS.filter((d) => surviving[d] === best && best > 0);

  // best === 0 → everything cancelled or nothing was bid.
  // winners.length > 1 → two surviving forces are equal.
  const tie = best === 0 || winners.length !== 1;

  return {
    totals,
    verticalNet,
    horizontalNet,
    surviving,
    direction: tie ? null : winners[0],
    requestedDistance: tie ? 0 : best,
    tie,
  };
}

/**
 * §8.3 — The requested distance is a maximum, not a promise. The queen walks
 * cell by cell and stops dead at the wall; unused steps are discarded.
 */
export function moveQueen(state, direction, distance) {
  const path = [];
  let pos = cell(state.queenPosition.r, state.queenPosition.c);
  if (!direction || distance <= 0) {
    return { finalPosition: pos, actualDistance: 0, path, blockedByBoundary: false };
  }
  const v = VECTORS[direction];
  let steps = 0;
  let blocked = false;
  for (let i = 0; i < distance; i++) {
    const next = cell(pos.r + v.dr, pos.c + v.dc);
    if (!inBounds(state, next)) {
      blocked = true;
      break;
    }
    pos = next;
    path.push(cell(pos.r, pos.c));
    steps++;
  }
  return { finalPosition: pos, actualDistance: steps, path, blockedByBoundary: blocked };
}

/** §9, §22 step 8 — a castle is won only by *landing* on it. */
export function checkWinner(state, finalPosition) {
  const retired = state.retiredSeats || [];
  for (let seat = 0; seat < state.castles.length; seat++) {
    // A player who has left cannot be handed the crown in their absence.
    if (retired.includes(seat)) continue;
    // A destroyed castle is rubble: the queen stopping there wins nothing.
    if ((state.eliminatedSeats || []).includes(seat)) continue;
    if (sameCell(state.castles[seat], finalPosition)) return seat;
  }
  return null;
}

/**
 * Remove a seat from play without disturbing the board. Used when a human
 * leaves a humans-only game: nobody takes their place, they simply stop
 * bidding and stop being able to win. The seat still holds a castle so the
 * geometry of the board is unchanged mid-game, and the end-of-game reveal
 * still shows where everyone was.
 */
export function retireSeat(state, seat) {
  if (!state.players[seat]) return state;
  const s = clone(state);
  s.retiredSeats = s.retiredSeats || [];
  if (!s.retiredSeats.includes(seat)) s.retiredSeats.push(seat);
  s.currentRoundBids[seat] = emptyBid();
  if (!s.lockedSeats.includes(seat)) s.lockedSeats.push(seat);
  return s;
}

/** Seats still able to act this round. */
export const activeSeats = (state) => standingSeats(state);

/** §10.2 — reduce every remaining active bonus by the actual distance moved. */
export function decayBonuses(state, actualDistanceMoved) {
  const s = clone(state);
  if (actualDistanceMoved <= 0) return { state: s, decayed: [] };
  const decayed = [];
  s.activeBonuses.forEach((bonus, seat) => {
    if (!bonus) return;
    const before = bonus.reward;
    bonus.reward = Math.max(s.config.bonusMinReward, before - actualDistanceMoved);
    decayed.push({ seat, before, after: bonus.reward });
  });
  return { state: s, decayed };
}

/** §10.2, §10.3, §22 step 11 — replace collected or fully-decayed bonuses. */
export function replaceExpiredBonuses(state, collectedSeats = []) {
  let s = clone(state);
  const replaced = [];
  for (let seat = 0; seat < s.activeBonuses.length; seat++) {
    // A fallen player gets no more treasure.
    if ((s.eliminatedSeats || []).includes(seat)) continue;
    const bonus = s.activeBonuses[seat];
    const wasCollected = collectedSeats.includes(seat);
    if (!wasCollected && bonus && bonus.reward > s.config.bonusMinReward) continue;

    /**
     * A treasure destroyed by cannon fire stays in play as a ghost — unseen,
     * uncollectable, but still decaying with the others — and is replaced
     * only when it would have run out anyway. Losing a treasure must never
     * be a shortcut to a fresh, full one.
     */
    const entry = s.bonusLedger.filter((e) => e.seat === seat && e.outcome === 'ACTIVE').pop();
    if (entry) entry.outcome = wasCollected ? 'COLLECTED' : 'DECAYED';

    s.activeBonuses[seat] = null;
    const fresh = generateBonus(s, seat);
    s.activeBonuses[seat] = fresh;
    s.previousBonusCell[seat] = fresh.position;
    s.bonusLedger.push({
      seat,
      position: fresh.position,
      startReward: fresh.reward,
      round: s.roundNumber + 1,
      outcome: 'ACTIVE',
    });
    replaced.push({ seat, reason: wasCollected ? 'COLLECTED' : bonus?.destroyed ? 'RESTORED' : 'DECAYED', bonus: fresh });
  }
  return { state: s, replaced };
}

/** §11 — replenishment is a four-player condition, never a single-player one. */
export function shouldReplenishCoins(state) {
  // Only seats still in the game count. A fallen player's unspent coins must
  // not hold everyone else's replenishment hostage.
  const seats = standingSeats(state);
  if (!seats.length) return false;
  return seats.every((seat) => state.coinAllocationState[seat].coinsRemaining <= 0);
}

/**
 * Opt-in stalemate valve. Returns false unless config.stalemateReplenishRounds
 * has been deliberately enabled, in which case §11 is widened — a documented
 * deviation, never a silent one. See config.js for the full rationale.
 */
export function shouldBreakStalemate(state) {
  const n = state.config.stalemateReplenishRounds;
  if (!n) return false;
  return state.consecutiveZeroBidRounds >= n;
}

export function replenishCoins(state) {
  const s = clone(state);
  s.coinAllocationState.forEach((a) => {
    a.coinsRemaining += s.config.replenishCoins;
    a.allocationNumber += 1;
    a.spentThisAllocation = 0;
  });
  s.metrics.replenishments += 1;
  return s;
}

/* ------------------------------------------------------------------ *
 * Round resolution — the exact ordering mandated by §22
 * ------------------------------------------------------------------ */

/**
 * Resolve every cannon shot in the round's bids. Shots are simultaneous: two
 * balls on one cell make one crater. A castle on a struck cell falls and its
 * owner is out; a treasure on a struck cell becomes a ghost (see
 * replaceExpiredBonuses). Returns public explosions, the seats knocked out,
 * and the private list of treasure hits, which only each owner may learn of.
 */
export function fireCannons(state, bids) {
  const s = state;
  s.craters = s.craters || [];
  s.eliminatedSeats = s.eliminatedSeats || [];
  s.cannonballs = s.cannonballs || s.players.map(() => 0);

  const targets = new Map();
  bids.forEach((bid, seat) => {
    if (!bid?.shot) return;
    // Re-checked here: a plan is only as good as the board it lands on.
    const aim = validateShot(s, seat, bid.shot);
    if (!aim.ok) return;
    s.cannonballs[seat] -= 1;
    s.metrics.shotsFired = (s.metrics.shotsFired || 0) + 1;
    targets.set(cellKey(aim.shot), aim.shot);
  });

  const explosions = [];
  const eliminated = [];
  const treasureHits = [];
  const events = [];

  for (const p of targets.values()) {
    s.craters.push(cell(p.r, p.c));

    let castleSeat = null;
    s.castles.forEach((c, seat) => {
      if (castleSeat === null && sameCell(c, p) && !s.eliminatedSeats.includes(seat)) castleSeat = seat;
    });
    if (castleSeat !== null) {
      s.eliminatedSeats.push(castleSeat);
      eliminated.push(castleSeat);
      s.metrics.castlesDestroyed = (s.metrics.castlesDestroyed || 0) + 1;
      events.push({ type: 'CASTLE_DESTROYED', seat: castleSeat, position: cell(p.r, p.c) });
    }

    s.activeBonuses.forEach((b, seat) => {
      if (!b || b.destroyed || !sameCell(b.position, p)) return;
      b.destroyed = true;
      treasureHits.push({ seat, position: cell(p.r, p.c) });
      s.metrics.treasuresDestroyed = (s.metrics.treasuresDestroyed || 0) + 1;
      const entry = s.bonusLedger.filter((e) => e.seat === seat && e.outcome === 'ACTIVE').pop();
      if (entry) entry.outcome = 'DESTROYED';
    });

    explosions.push({ position: cell(p.r, p.c), castleSeat });
  }

  // A fallen player's treasure goes with their castle.
  for (const seat of eliminated) {
    const b = s.activeBonuses[seat];
    if (b && !b.destroyed) {
      const entry = s.bonusLedger.filter((e) => e.seat === seat && e.outcome === 'ACTIVE').pop();
      if (entry) entry.outcome = 'LOST';
    }
    s.activeBonuses[seat] = null;
  }

  if (explosions.length) events.unshift({ type: 'CANNON_FIRE', count: explosions.length });
  return { state: s, explosions, eliminated, treasureHits, events };
}

/**
 * The finale's walk: straight to the last castle, rows first, then columns,
 * one cell at a time so the board can animate it like any other move.
 */
export function walkToCastle(state, target) {
  let pos = cell(state.queenPosition.r, state.queenPosition.c);
  const path = [];
  if (!target) return { finalPosition: pos, actualDistance: 0, path, blockedByBoundary: false };
  while (pos.r !== target.r) {
    pos = cell(pos.r + Math.sign(target.r - pos.r), pos.c);
    path.push(pos);
  }
  while (pos.c !== target.c) {
    pos = cell(pos.r, pos.c + Math.sign(target.c - pos.c));
    path.push(pos);
  }
  return { finalPosition: pos, actualDistance: path.length, path, blockedByBoundary: false };
}

export function resolveRound(state, { now = Date.now() } = {}) {
  if (state.status !== STATUS.PLAYING) {
    return { state, error: 'Game is not in progress.' };
  }
  let s = clone(state);
  s.phase = PHASES.RESOLVE;

  const startPosition = cell(s.queenPosition.r, s.queenPosition.c);

  // 1. Validate and consume each player's committed bid.
  const bids = [];
  for (let seat = 0; seat < s.players.length; seat++) {
    let bid = s.currentRoundBids[seat] || emptyBid();
    const total = bidTotal(bid);
    const alloc = s.coinAllocationState[seat];
    if (total > alloc.coinsRemaining) bid = emptyBid(); // defensive: never trust a stale bid
    const spent = bidTotal(bid);
    alloc.coinsRemaining -= spent;
    alloc.spentThisAllocation += spent;
    s.metrics.coinsSpent += spent;
    bids.push(bid);

    s.metrics.bidDecisions += 1;
    if (DIRECTIONS.filter((d) => bid[d] > 0).length > 1) s.metrics.splitBidDecisions += 1;
  }

  /**
   * Snapshot the board as it stood for THIS round: where every bonus sat and
   * what it was worth before anything resolved. The replay needs this to show
   * the state players were actually reacting to.
   */
  const bonusesAtRoundStart = s.activeBonuses.map((b, seat) =>
    b && !b.destroyed ? { seat, position: cell(b.position.r, b.position.c), reward: b.reward } : null
  );

  const events = [];

  // 1b. Cannon fire. Every shot lands before the queen moves.
  const cannon = fireCannons(s, bids);
  s = cannon.state;
  events.push(...cannon.events);

  // 2–5. Totals → cancellation → winning direction → requested distance.
  const net = calculateNetMovement(bids);

  /**
   * The last castle standing. Once cannon fire leaves a single castle, the
   * game has only one possible ending, so it is played out at once: the queen
   * walks straight to it, with no more bidding. If the last castles fell
   * together, nobody is left to win.
   */
  const standing = standingSeats(s);
  const finale = (s.eliminatedSeats || []).length > 0 && standing.length <= 1;

  // 6–7. Move until exhausted or the wall, and record the actual distance.
  const movement = finale
    ? walkToCastle(s, standing.length ? s.castles[standing[0]] : null)
    : moveQueen(s, net.direction, net.requestedDistance);
  s.queenPosition = movement.finalPosition;
  s.completeQueenPath.push(...movement.path);

  // 8. Castle landing ends the game immediately.
  const winnerSeat = finale ? (standing.length ? standing[0] : null) : checkWinner(s, s.queenPosition);

  let collectedSeats = [];
  let collection = null;

  if (finale && winnerSeat === null) {
    s.draw = true;
    s.status = STATUS.FINISHED;
    s.phase = PHASES.FINISHED;
    s.timerDeadline = null;
    events.push({ type: 'DRAW' });
  } else if (winnerSeat !== null) {
    s.winner = winnerSeat;
    s.status = STATUS.FINISHED;
    s.phase = PHASES.FINISHED;
    s.timerDeadline = null;
    events.push({ type: 'CASTLE_WIN', seat: winnerSeat, position: s.queenPosition });
  } else {
    // 9. Bonus landing — exact landing only, using the reward value that exists
    //    immediately before collection is resolved (§10.3, §21).
    for (let seat = 0; seat < s.activeBonuses.length; seat++) {
      const bonus = s.activeBonuses[seat];
      if (bonus && !bonus.destroyed && sameCell(bonus.position, s.queenPosition)) {
        const reward = bonus.reward;
        s.coinAllocationState[seat].coinsRemaining += reward;
        collectedSeats.push(seat);
        collection = { seat, reward, position: cell(bonus.position.r, bonus.position.c) };
        s.metrics.bonusesCollected += 1;
        events.push({ type: 'BONUS_COLLECTED', seat, reward });
        break; // placement rules guarantee at most one bonus per cell
      }
    }

    // 10. Decay every *remaining* active bonus by the actual distance moved.
    if (collectedSeats.length) {
      const held = s.activeBonuses[collectedSeats[0]];
      s.activeBonuses[collectedSeats[0]] = null; // a collected bonus does not decay
      const d = decayBonuses(s, movement.actualDistance);
      s = d.state;
      s.activeBonuses[collectedSeats[0]] = held;
    } else {
      const d = decayBonuses(s, movement.actualDistance);
      s = d.state;
    }

    // 11. Replace every bonus that was collected or has reached 0.
    const rep = replaceExpiredBonuses(s, collectedSeats);
    s = rep.state;
    for (const r of rep.replaced) {
      if (r.reason === 'DECAYED') events.push({ type: 'BONUS_DECAYED', seat: r.seat });
    }

    // Track dead rounds for the opt-in stalemate valve (see config.js).
    const tableSpentNothing = bids.every((b) => bidTotal(b) === 0);
    s.consecutiveZeroBidRounds = tableSpentNothing ? (s.consecutiveZeroBidRounds || 0) + 1 : 0;

    // 12. Replenish only when all four players are exhausted.
    if (shouldReplenishCoins(s)) {
      s = replenishCoins(s);
      events.push({ type: 'COINS_REPLENISHED' });
    } else if (shouldBreakStalemate(s)) {
      s = replenishCoins(s);
      s.consecutiveZeroBidRounds = 0;
      events.push({ type: 'COINS_REPLENISHED', stalemate: true });
    }
  }

  s.metrics.rounds += 1;
  if (movement.actualDistance === 0) s.metrics.noMoveRounds += 1;
  s.metrics.cellsTravelled += movement.actualDistance;
  if (movement.blockedByBoundary) s.metrics.wallBlocks += 1;

  /**
   * §5.1 / §19 — the resolution summary is PUBLIC, but it is aggregate only.
   * It never names who contributed what. Per-seat bids are deliberately absent
   * from this object so they cannot leak through a PlayerView.
   */
  const resolution = {
    roundNumber: s.roundNumber,
    startPosition,
    totals: net.totals,
    surviving: net.surviving,
    verticalNet: net.verticalNet,
    horizontalNet: net.horizontalNet,
    direction: finale ? null : net.direction,
    requestedDistance: finale ? 0 : net.requestedDistance,
    actualDistance: movement.actualDistance,
    blockedByBoundary: movement.blockedByBoundary,
    tie: finale ? false : net.tie,
    finalPosition: cell(s.queenPosition.r, s.queenPosition.c),
    path: movement.path,
    winner: s.winner,
    draw: !!s.draw,
    /**
     * Public: where the cannonballs landed and which castles fell. Never who
     * fired — shots are anonymous. Whether a crater hid a treasure is known
     * only to that treasure's owner, via the private slice below.
     */
    explosions: cannon.explosions.map((e) => ({ position: cell(e.position.r, e.position.c), castleSeat: e.castleSeat })),
    eliminated: cannon.eliminated.slice(),
    /** The last castle standing: the queen walked to it without a bid. */
    finale: finale && winnerSeat !== null ? { seat: winnerSeat } : null,
    /** Private slice, filtered per seat by createPlayerView. */
    _private: { collection, treasureHits: cannon.treasureHits },
    events,
  };
  s.lastResolution = resolution;

  s.roundLog.push({
    roundNumber: resolution.roundNumber,
    startPosition,
    path: movement.path.map((p) => cell(p.r, p.c)),
    finalPosition: cell(s.queenPosition.r, s.queenPosition.c),
    direction: net.direction,
    actualDistance: movement.actualDistance,
    blockedByBoundary: movement.blockedByBoundary,
    bonuses: bonusesAtRoundStart,
    collected: collection ? { seat: collection.seat, position: collection.position, reward: collection.reward } : null,
    explosions: resolution.explosions.map((e) => ({ ...e })),
    finale: resolution.finale,
    winner: s.winner,
  });

  // 13. Begin the next round unless the game has ended.
  if (s.status === STATUS.PLAYING) {
    s.roundNumber += 1;
    s.phase = PHASES.PLAN;
    s.lockedSeats = [];
    s.currentRoundBids = s.players.map(() => null);
    s.timerDeadline = now + s.config.decisionTimerMs;
    // Seats that have left never bid again, so lock them straight away rather
    // than making everyone else wait out the timer for a player who is gone.
    Object.assign(s, applyRetirements(s));
  }

  return { state: s, resolution };
}

/* ------------------------------------------------------------------ *
 * Human / computer takeover (§13)
 * ------------------------------------------------------------------ */

export function setControlMode(state, seat, controlMode, { reason = null, connectionStatus } = {}) {
  const s = clone(state);
  const p = s.players[seat];
  if (!p) return s;
  p.controlMode = controlMode;
  p.takeoverReason = controlMode === CONTROL_MODE.AI ? reason : null;
  if (connectionStatus) p.connectionStatus = connectionStatus;
  return s;
}
