/**
 * QUEEN'S TUG — Rule tests (Spec §23)
 *
 * "Do not consider the game complete because the UI works."
 *
 * Every bullet in §23 has at least one test below, tagged with its spec
 * section. Zero dependencies: run with `node tests/engine.test.js`.
 */

import {
  createGame,
  startGame,
  stageBid,
  lockBid,
  lockExpiredSeats,
  allSeatsLocked,
  resolveRound,
  calculateNetMovement,
  moveQueen,
  validateBid,
  generateBonus,
  isValidHiddenCell,
  hiddenPlacementCells,
  shouldReplenishCoins,
  replenishCoins,
  checkWinner,
  decayBonuses,
  replaceExpiredBonuses,
  setControlMode,
  sameCell,
  cell,
  cellKey,
  emptyBid,
  adjacentCells,
} from '../src/engine.js';
import { createPlayerView, createRevealView, auditViewForLeaks } from '../src/playerView.js';
import { decideBid } from '../src/ai.js';
import { CONTROL_MODE, DIRECTIONS } from '../src/config.js';

/* ---------------- tiny harness ---------------- */
let passed = 0;
const failures = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ section: currentSection, name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`    ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'Expected equality'}\n      expected: ${b}\n      actual:   ${a}`);
}
function throws(fn, msg) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg || 'Expected a throw');
}

/* ---------------- fixtures ---------------- */

/** A deterministic game with all four seats locked-in and ready to bid. */
function newGame(seed = 'test-seed-1', config = {}) {
  return startGame(createGame({ seed, config }), { now: 0 });
}

/** Force a specific board layout for precise rule tests. */
function rig(state, { queen, castles, bonuses, coins }) {
  const s = structuredClone(state);
  if (queen) s.queenPosition = cell(queen[0], queen[1]);
  if (queen) s.completeQueenPath = [cell(queen[0], queen[1])];
  if (castles) s.castles = castles.map(([r, c]) => cell(r, c));
  if (bonuses) {
    s.activeBonuses = bonuses.map((b) => (b ? { position: cell(b[0], b[1]), reward: b[2] } : null));
    s.previousBonusCell = s.activeBonuses.map((b) => (b ? b.position : null));
  }
  if (coins) s.coinAllocationState.forEach((a, i) => (a.coinsRemaining = coins[i]));
  return s;
}

/** Lock a full table of bids and resolve. */
function playRound(state, bids) {
  let s = state;
  bids.forEach((bid, seat) => {
    const r = lockBid(s, seat, bid);
    assert(r.ok, `lockBid rejected seat ${seat}: ${r.error}`);
    s = r.state;
  });
  return resolveRound(s, { now: 0 });
}

const B = (o = {}) => ({ ...emptyBid(), ...o });

/* ================================================================== *
 * §4.1 / §9 — Placement
 * ================================================================== */
section('Placement — boundary margin and overlap (§4.1, §9, §10.1)');

test('Castle placement never overlaps another castle', () => {
  for (let i = 0; i < 200; i++) {
    const s = createGame({ seed: `castle-${i}` });
    const keys = s.castles.map(cellKey);
    eq(new Set(keys).size, 4, `Duplicate castle on seed castle-${i}`);
  }
});

test('Castle and bonus placement obey the boundary safety margin', () => {
  for (let i = 0; i < 200; i++) {
    const s = createGame({ seed: `margin-${i}` });
    for (const c of s.castles) {
      assert(isValidHiddenCell(s, c), `Castle ${cellKey(c)} violates margin`);
      assert(c.r >= 1 && c.r <= 10 && c.c >= 1 && c.c <= 10, `Castle on outer ring: ${cellKey(c)}`);
    }
    for (const b of s.activeBonuses) {
      assert(isValidHiddenCell(s, b.position), `Bonus ${cellKey(b.position)} violates margin`);
    }
  }
});

test('The inner placement region on 12×12 is exactly rows 1–10, cols 1–10', () => {
  const s = createGame({ seed: 'region' });
  const cells = hiddenPlacementCells(s);
  eq(cells.length, 100, 'Expected 10×10 valid placement cells');
  assert(cells.every((p) => p.r >= 1 && p.r <= 10 && p.c >= 1 && p.c <= 10));
});

test('Queen start never overlaps a hidden object', () => {
  for (let i = 0; i < 300; i++) {
    const s = createGame({ seed: `queen-${i}` });
    const q = cellKey(s.queenPosition);
    assert(!s.castles.some((c) => cellKey(c) === q), 'Queen started on a castle');
    assert(!s.activeBonuses.some((b) => cellKey(b.position) === q), 'Queen started on a bonus');
  }
});

test('Bonuses never overlap castles, the queen, or each other', () => {
  for (let i = 0; i < 200; i++) {
    const s = createGame({ seed: `bonus-overlap-${i}` });
    const bonusKeys = s.activeBonuses.map((b) => cellKey(b.position));
    eq(new Set(bonusKeys).size, 4, 'Two bonuses share a cell');
    for (const k of bonusKeys) {
      assert(!s.castles.some((c) => cellKey(c) === k), 'Bonus sits on a castle');
      assert(k !== cellKey(s.queenPosition), 'Bonus sits on the queen');
    }
  }
});

test('Every bonus stack starts at the configured value', () => {
  for (let i = 0; i < 100; i++) {
    const s = createGame({ seed: `reward-${i}` });
    for (const b of s.activeBonuses) {
      eq(b.reward, s.config.bonusStartReward, `Bad starting reward ${b.reward}`);
    }
  }
});

test('The bonus starting value is configurable', () => {
  const s = createGame({ seed: 'reward-cfg', config: { bonusStartReward: 33 } });
  for (const b of s.activeBonuses) eq(b.reward, 33);
});

/* ================================================================== *
 * §8 — Bidding
 * ================================================================== */
section('Bidding — validation and legality (§8, §12, §21)');

test('Bids cannot exceed available coins', () => {
  const s = newGame('bid-1');
  const start = s.config.startingCoins;
  assert(!validateBid(s, 0, B({ UP: start + 1 })).ok, 'An over-budget bid was accepted');
  assert(validateBid(s, 0, B({ UP: start })).ok, 'A full-balance bid was rejected');
});

test('A split bid across multiple directions is valid', () => {
  const s = newGame('bid-2');
  const r = validateBid(s, 0, B({ UP: 10, LEFT: 5, RIGHT: 3 }));
  assert(r.ok, r.error);
  eq(r.bid, { UP: 10, DOWN: 0, LEFT: 5, RIGHT: 3 });
});

test('Split bids are still capped by the total balance', () => {
  const s = newGame('bid-3');
  const start = s.config.startingCoins;
  const half = Math.ceil(start / 2) + 1; // two halves that overshoot the purse
  assert(
    !validateBid(s, 0, B({ UP: half, DOWN: half })).ok,
    `${half * 2} coins accepted from a ${start}-coin balance`
  );
  assert(validateBid(s, 0, B({ UP: half - 1, DOWN: start - half + 1 })).ok, 'An exact-balance split was rejected');
});

test('A zero bid is valid', () => {
  const s = newGame('bid-4');
  assert(validateBid(s, 0, emptyBid()).ok, 'Zero bid rejected');
});

test('Negative and fractional coin counts are rejected', () => {
  const s = newGame('bid-5');
  assert(!validateBid(s, 0, B({ UP: -3 })).ok, 'Negative bid accepted');
  assert(!validateBid(s, 0, B({ UP: 2.5 })).ok, 'Fractional bid accepted');
});

test('Bids for non-adjacent / off-board cells are rejected', () => {
  let s = newGame('bid-6');
  s = rig(s, { queen: [0, 0] });
  assert(!validateBid(s, 0, B({ UP: 1 })).ok, 'Bid accepted above the top row');
  assert(!validateBid(s, 0, B({ LEFT: 1 })).ok, 'Bid accepted left of column 0');
  assert(validateBid(s, 0, B({ DOWN: 1 })).ok, 'Legal DOWN bid rejected');
  assert(!validateBid(s, 0, { UP: 0, DOWN: 1, LEFT: 0, RIGHT: 0, DIAGONAL: 5 }).ok, 'Diagonal key accepted');
});

test('A locked bid cannot be changed', () => {
  let s = rig(newGame('bid-7'), { queen: [6, 6] });
  const locked = lockBid(s, 0, B({ UP: 5 }));
  assert(locked.ok, locked.error);
  s = locked.state;
  const again = stageBid(s, 0, B({ DOWN: 5 }));
  assert(!again.ok, 'A locked bid was overwritten');
  eq(s.currentRoundBids[0], B({ UP: 5 }));
});

test('Timer expiry locks the current placement; no placement locks zero (§12)', () => {
  let s = newGame('bid-8');
  s = stageBid(s, 1, B({ RIGHT: 4 })).state; // staged, not locked
  s = lockExpiredSeats(s);
  assert(allSeatsLocked(s), 'Expiry did not lock every seat');
  eq(s.currentRoundBids[1], B({ RIGHT: 4 }), 'Staged placement was not preserved on expiry');
  eq(s.currentRoundBids[2], emptyBid(), 'An absent placement did not become a zero bid');
});

test('A bid submitted after resolution is rejected (§24 stale submissions)', () => {
  const s = newGame('bid-9');
  const { state: after } = playRound(s, [emptyBid(), emptyBid(), emptyBid(), emptyBid()]);
  const stale = { ...after, phase: 'RESOLVE' };
  assert(!validateBid(stale, 0, B({ UP: 1 })).ok, 'Bid accepted outside PLAN');
});

/* ================================================================== *
 * §8.1 — Cancellation and direction selection
 * ================================================================== */
section('Resolution — cancellation, ties, distance (§8.1, §8.2)');

test('Opposite bids cancel exactly', () => {
  const n = calculateNetMovement([B({ UP: 7 }), B({ DOWN: 7 }), B(), B()]);
  eq(n.surviving, { UP: 0, DOWN: 0, RIGHT: 0, LEFT: 0 });
  assert(n.tie, 'Full cancellation should produce no movement');
  eq(n.requestedDistance, 0);
});

test('The specification worked example resolves to Right 2 (§8.2)', () => {
  // Up 3, Down 2, Right 2, Left 0 → Up survives 1, Right survives 2 → Right 2.
  const n = calculateNetMovement([B({ UP: 3 }), B({ DOWN: 2 }), B({ RIGHT: 2 }), B()]);
  eq(n.surviving.UP, 1);
  eq(n.surviving.RIGHT, 2);
  eq(n.direction, 'RIGHT');
  eq(n.requestedDistance, 2);
});

test('Equal surviving forces in two directions produce no movement (§8.2)', () => {
  const n = calculateNetMovement([B({ UP: 1 }), B({ RIGHT: 1 }), B(), B()]);
  assert(n.tie, 'Up 1 vs Right 1 should not move the queen');
  eq(n.direction, null);
});

test('All-zero bids produce no movement', () => {
  const n = calculateNetMovement([B(), B(), B(), B()]);
  assert(n.tie);
  eq(n.requestedDistance, 0);
});

test('Movement distance equals the winning surviving force', () => {
  const n = calculateNetMovement([B({ LEFT: 12 }), B({ RIGHT: 4 }), B({ UP: 3 }), B({ DOWN: 3 })]);
  eq(n.direction, 'LEFT');
  eq(n.requestedDistance, 8, 'Left 12 − Right 4 should survive as 8');
});

test('Coins are spent even when the round produces no movement (§8.2, §11)', () => {
  const s = newGame('spend-1');
  const { state } = playRound(s, [B({ UP: 6 }), B({ DOWN: 6 }), B(), B()]);
  eq(state.coinAllocationState[0].coinsRemaining, s.config.startingCoins - 6);
  eq(state.coinAllocationState[1].coinsRemaining, s.config.startingCoins - 6);
  eq(state.lastResolution.actualDistance, 0, 'Queen should not have moved');
});

test('Four-way bids cancel on both axes independently', () => {
  const n = calculateNetMovement([B({ UP: 10, LEFT: 2 }), B({ DOWN: 4 }), B({ RIGHT: 9 }), B({ LEFT: 1 })]);
  // vertical 10−4 = 6 Up; horizontal 9−3 = 6 Right → tie → no movement.
  eq(n.surviving.UP, 6);
  eq(n.surviving.RIGHT, 6);
  assert(n.tie, 'Equal survivors on both axes must not move the queen');
});

/* ================================================================== *
 * §8.3 — Boundary behaviour
 * ================================================================== */
section('Movement — boundary stopping (§8.3, §21)');

test('Boundary stops movement and discards the excess steps', () => {
  let s = newGame('bound-1');
  s = rig(s, { queen: [5, 9] }); // 2 cells of room to the right on a 12-wide board
  const m = moveQueen(s, 'RIGHT', 7);
  eq(m.finalPosition, cell(5, 11));
  eq(m.actualDistance, 2, 'Only 2 of the 7 requested steps are available');
  assert(m.blockedByBoundary, 'Boundary block flag not set');
});

test('A queen already at the wall moves zero cells in that direction', () => {
  let s = newGame('bound-2');
  s = rig(s, { queen: [0, 4] });
  const m = moveQueen(s, 'UP', 5);
  eq(m.actualDistance, 0);
  eq(m.finalPosition, cell(0, 4));
});

test('Actual distance, not requested distance, is recorded on the resolution', () => {
  let s = newGame('bound-3');
  s = rig(s, { queen: [5, 10], castles: [[1, 1], [2, 2], [3, 3], [4, 4]] });
  const { state } = playRound(s, [B({ RIGHT: 9 }), B(), B(), B()]);
  eq(state.lastResolution.requestedDistance, 9);
  eq(state.lastResolution.actualDistance, 1);
  eq(state.queenPosition, cell(5, 11));
});

/* ================================================================== *
 * §9 — Castles
 * ================================================================== */
section('Castles — landing wins, passing does not (§9)');

test('Passing over a castle does not win', () => {
  let s = newGame('castle-pass');
  s = rig(s, {
    queen: [5, 2],
    castles: [[5, 4], [1, 1], [1, 9], [9, 1]], // seat 0 castle is 2 cells right
    bonuses: [[2, 2, 10], [2, 3, 10], [2, 4, 10], [2, 5, 10]],
  });
  const { state } = playRound(s, [B({ RIGHT: 5 }), B(), B(), B()]); // travels through (5,4)
  eq(state.queenPosition, cell(5, 7), 'Queen should have travelled the full 5 cells');
  eq(state.winner, null, 'Passing over a castle must not win');
  assert(state.status === 'PLAYING', 'Game ended on a fly-over');
});

test('Landing on a castle wins', () => {
  let s = newGame('castle-land');
  s = rig(s, {
    queen: [5, 2],
    castles: [[5, 4], [1, 1], [1, 9], [9, 1]],
    bonuses: [[2, 2, 10], [2, 3, 10], [2, 4, 10], [2, 5, 10]],
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]);
  eq(state.queenPosition, cell(5, 4));
  eq(state.winner, 0, 'Landing on your own castle must win');
  eq(state.status, 'FINISHED');
});

test('Any player can be pushed onto any castle — the owner still wins', () => {
  let s = newGame('castle-other');
  s = rig(s, {
    queen: [5, 2],
    castles: [[1, 1], [5, 4], [1, 9], [9, 1]], // the castle belongs to seat 1
    bonuses: [[2, 2, 10], [2, 3, 10], [2, 4, 10], [2, 5, 10]],
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]); // seat 0 did the pushing
  eq(state.winner, 1, 'The castle owner wins regardless of who moved the queen');
});

test('Only the final boundary cell counts for landing resolution (§9)', () => {
  let s = newGame('castle-wall');
  s = rig(s, {
    queen: [5, 8],
    castles: [[5, 10], [1, 1], [1, 9], [9, 1]],
    bonuses: [[2, 2, 10], [2, 3, 10], [2, 4, 10], [2, 5, 10]],
  });
  // Requesting 6 Right overshoots past the castle at col 10 and stops at col 11.
  const { state } = playRound(s, [B({ RIGHT: 6 }), B(), B(), B()]);
  eq(state.queenPosition, cell(5, 11));
  eq(state.winner, null, 'Stopping at the wall past a castle must not win');
});

test('checkWinner matches only exact cells', () => {
  const s = rig(newGame('castle-fn'), { castles: [[3, 3], [4, 4], [5, 5], [6, 6]] });
  eq(checkWinner(s, cell(5, 5)), 2);
  eq(checkWinner(s, cell(5, 6)), null);
});

/* ================================================================== *
 * §10 — Bonuses
 * ================================================================== */
section('Bonuses — collection, decay, replacement (§10)');

test('Passing over a bonus does not collect it', () => {
  let s = newGame('bonus-pass');
  s = rig(s, {
    queen: [6, 2],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[6, 4, 30], [2, 2, 10], [2, 3, 10], [2, 4, 10]],
  });
  const { state } = playRound(s, [B({ RIGHT: 5 }), B(), B(), B()]);
  eq(state.queenPosition, cell(6, 7));
  eq(state.coinAllocationState[0].coinsRemaining, s.config.startingCoins - 5, 'Flying over a bonus must not pay out');
});

test('Landing on a bonus collects it at its pre-decay value', () => {
  let s = newGame('bonus-land');
  s = rig(s, {
    queen: [6, 2],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[6, 4, 30], [2, 2, 10], [2, 3, 10], [2, 4, 10]],
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]);
  // start − 2 spent + 30 collected. The reward is NOT reduced by this move.
  eq(state.coinAllocationState[0].coinsRemaining, s.config.startingCoins - 2 + 30);
});

test('Bonus decay equals the actual movement distance', () => {
  let s = newGame('decay-1');
  s = rig(s, {
    queen: [6, 2],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[3, 3, 30], [3, 4, 20], [3, 5, 30], [3, 6, 20]],
  });
  const { state } = playRound(s, [B({ RIGHT: 7 }), B(), B(), B()]);
  eq(state.lastResolution.actualDistance, 7);
  eq(state.activeBonuses[0].reward, 23, '30 − 7 should be 23');
  eq(state.activeBonuses[1].reward, 13, '20 − 7 should be 13');
});

test('Decay uses actual, not requested, distance when the wall intervenes', () => {
  let s = newGame('decay-wall');
  s = rig(s, {
    queen: [6, 9],
    castles: [[1, 1], [1, 5], [9, 1], [9, 5]],
    bonuses: [[3, 3, 30], [3, 4, 30], [3, 5, 30], [3, 6, 30]],
  });
  const { state } = playRound(s, [B({ RIGHT: 9 }), B(), B(), B()]);
  eq(state.lastResolution.actualDistance, 2);
  eq(state.activeBonuses[0].reward, 28, 'Decay should be 2, not 9');
});

test('No movement means no decay (§10.2)', () => {
  let s = newGame('decay-none');
  s = rig(s, {
    queen: [6, 6],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[3, 3, 30], [3, 4, 20], [3, 5, 10], [3, 6, 20]],
  });
  const { state } = playRound(s, [B({ UP: 4 }), B({ DOWN: 4 }), B(), B()]);
  eq(state.lastResolution.actualDistance, 0);
  eq(state.activeBonuses[0].reward, 30, 'A stationary queen must not decay bonuses');
});

test('The specification decay table is reproduced exactly (§10.2)', () => {
  const table = [
    [30, 7, 23],
    [20, 12, 8],
    [10, 6, 4],
    [10, 15, 0],
  ];
  for (const [start, moved, expected] of table) {
    const s = rig(newGame('decay-table'), { bonuses: [[3, 3, start], null, null, null] });
    const { state } = decayBonuses(s, moved);
    eq(state.activeBonuses[0].reward, expected, `${start} − ${moved} should clamp to ${expected}`);
  }
});

test('A bonus may decay to 0 and is then replaced', () => {
  let s = newGame('decay-zero');
  s = rig(s, {
    queen: [6, 1],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[3, 3, 10], [3, 4, 30], [3, 5, 30], [3, 6, 30]],
  });
  const before = cellKey(s.activeBonuses[0].position);
  const { state } = playRound(s, [B({ RIGHT: 10 }), B(), B(), B()]);
  eq(state.lastResolution.actualDistance, 10);
  eq(state.activeBonuses[0].reward, state.config.bonusStartReward, 'Replacement must reset to the full value');
  assert(cellKey(state.activeBonuses[0].position) !== before, 'Replacement must be at a different cell');
});

test('A collected bonus is replaced at a different valid location', () => {
  let s = newGame('bonus-replace');
  s = rig(s, {
    queen: [6, 2],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[6, 4, 30], [2, 2, 30], [2, 3, 30], [2, 4, 30]],
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]);
  const fresh = state.activeBonuses[0];
  assert(fresh, 'No replacement bonus was generated');
  assert(cellKey(fresh.position) !== '6,4', 'Replacement reused the collected cell');
  assert(isValidHiddenCell(state, fresh.position), 'Replacement violates the placement margin');
  assert(!state.castles.some((c) => sameCell(c, fresh.position)), 'Replacement landed on a castle');
  assert(!sameCell(fresh.position, state.queenPosition), 'Replacement landed under the queen');
});

test('A replacement bonus never collides with another active bonus', () => {
  for (let i = 0; i < 60; i++) {
    let s = newGame(`bonus-collide-${i}`);
    const { state } = replaceExpiredBonuses(s, [0, 1]);
    const keys = state.activeBonuses.map((b) => cellKey(b.position));
    eq(new Set(keys).size, 4, 'Replacement collided with another bonus');
    for (const k of keys) assert(!state.castles.some((c) => cellKey(c) === k), 'Replacement sits on a castle');
  }
});

test('Landing on a bonus does not decay that same bonus before collection (§21)', () => {
  let s = newGame('bonus-order');
  s = rig(s, {
    queen: [6, 2],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[6, 5, 10], [2, 2, 30], [2, 3, 30], [2, 4, 30]],
  });
  // Moving 3 cells would decay a 10-reward bonus to 7 — collection must beat decay.
  const { state } = playRound(s, [B({ RIGHT: 3 }), B(), B(), B()]);
  eq(state.coinAllocationState[0].coinsRemaining, s.config.startingCoins - 3 + 10);
  eq(state.activeBonuses[1].reward, 27, 'Other bonuses still decay by 3');
});

test('A castle win takes precedence over a bonus on the same cell (§21)', () => {
  let s = newGame('precedence');
  s = rig(s, {
    queen: [6, 2],
    castles: [[6, 4], [1, 1], [1, 9], [9, 1]],
    bonuses: [[6, 4, 30], [2, 2, 30], [2, 3, 30], [2, 4, 30]], // deliberately illegal overlap
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]);
  eq(state.winner, 0, 'Castle win must take precedence');
  eq(state.coinAllocationState[0].coinsRemaining, s.config.startingCoins - 2, 'No bonus should have been paid on a winning move');
});

/* ================================================================== *
 * §11 — Coin economy
 * ================================================================== */
section('Coin economy — replenishment (§11)');

test('Replenishment requires all four players to be exhausted', () => {
  let s = newGame('replenish-1');
  s = rig(s, { coins: [0, 0, 0, 5] });
  assert(!shouldReplenishCoins(s), 'One player with coins left must block replenishment');
  s = rig(s, { coins: [0, 0, 0, 0] });
  assert(shouldReplenishCoins(s), 'All four at zero must trigger replenishment');
});

test('One player exhausting their allocation alone does not replenish anyone', () => {
  let s = newGame('replenish-2');
  s = rig(s, { coins: [10, 40, 40, 40], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  const { state } = playRound(s, [B({ UP: 10 }), B({ DOWN: 3 }), B(), B()]);
  eq(state.coinAllocationState[0].coinsRemaining, 0);
  eq(state.coinAllocationState[1].coinsRemaining, 37, 'Seat 1 must not have been topped up');
  eq(state.coinAllocationState[0].allocationNumber, 1, 'No new allocation should have been issued');
});

test('When all four exhaust their allocation, everyone is replenished', () => {
  let s = newGame('replenish-3');
  s = rig(s, { coins: [4, 4, 4, 4], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  const { state } = playRound(s, [B({ UP: 4 }), B({ DOWN: 4 }), B({ LEFT: 4 }), B({ RIGHT: 4 })]);
  for (let i = 0; i < 4; i++) {
    eq(state.coinAllocationState[i].coinsRemaining, state.config.replenishCoins, `Seat ${i} was not replenished`);
    eq(state.coinAllocationState[i].allocationNumber, 2);
  }
});

test('A bonus collected in the same round can prevent replenishment', () => {
  let s = newGame('replenish-4');
  s = rig(s, {
    queen: [6, 2],
    coins: [2, 0, 0, 0],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[6, 4, 20], [2, 2, 30], [2, 3, 30], [2, 4, 30]],
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]);
  eq(state.coinAllocationState[0].coinsRemaining, 20, 'Bonus should have landed in the ordinary balance');
  eq(state.coinAllocationState[0].allocationNumber, 1, 'Replenishment must not have fired');
});

test('DOCUMENTED GAP: one player holding coins can stall the game forever under §11', () => {
  // This test asserts the specification's behaviour, not desirable behaviour.
  // §11 replenishes only when all four are exhausted and §26 forbids a time
  // limit, so a single holdout freezes the game. Recorded so the gap cannot
  // regress silently. See config.stalemateReplenishRounds.
  let s = newGame('stalemate');
  s = rig(s, { queen: [6, 6], coins: [20, 0, 0, 0], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  for (let i = 0; i < 25; i++) {
    s = playRound(s, [emptyBid(), emptyBid(), emptyBid(), emptyBid()]).state;
  }
  eq(s.status, 'PLAYING', 'The game should still be running — that is the problem');
  eq(s.coinAllocationState[1].coinsRemaining, 0, 'No replenishment may fire while seat 0 holds coins');
  eq(s.queenPosition, cell(6, 6), 'The queen never moves');
});

test('The opt-in stalemate valve breaks the deadlock when deliberately enabled', () => {
  let s = newGame('stalemate-valve', { stalemateReplenishRounds: 3 });
  s = rig(s, { queen: [6, 6], coins: [20, 0, 0, 0], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  for (let i = 0; i < 3; i++) {
    s = playRound(s, [emptyBid(), emptyBid(), emptyBid(), emptyBid()]).state;
  }
  eq(s.coinAllocationState[1].coinsRemaining, s.config.replenishCoins, 'Seat 1 should have been topped up by the valve');
  eq(s.coinAllocationState[0].coinsRemaining, 20 + s.config.replenishCoins, 'The holdout keeps their unspent coins');
});

test('The stalemate valve is OFF by default, matching the specification', () => {
  const s = createGame({ seed: 'valve-default' });
  eq(s.config.stalemateReplenishRounds, null, 'Default configuration must be spec-exact');
});

test('A real bid resets the zero-bid counter', () => {
  let s = newGame('stalemate-reset', { stalemateReplenishRounds: 3 });
  s = rig(s, { queen: [6, 6], coins: [20, 20, 20, 20], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  s = playRound(s, [emptyBid(), emptyBid(), emptyBid(), emptyBid()]).state;
  s = playRound(s, [emptyBid(), emptyBid(), emptyBid(), emptyBid()]).state;
  eq(s.consecutiveZeroBidRounds, 2);
  s = playRound(s, [B({ UP: 1 }), emptyBid(), emptyBid(), emptyBid()]).state;
  eq(s.consecutiveZeroBidRounds, 0, 'Any spending must reset the counter');
});

test('AI seats never produce an endless stalemate across many full games', () => {
  let stalled = 0;
  for (let i = 0; i < 25; i++) {
    let s = newGame(`nostall-${i}`);
    let rounds = 0;
    while (s.status === 'PLAYING' && rounds < 300) {
      const bids = [0, 1, 2, 3].map((seat) => decideBid(createPlayerView(s, seat), { rngSeed: `nostall-${i}` }));
      bids.forEach((bid, seat) => (s = lockBid(s, seat, bid).state));
      s = resolveRound(s, { now: 0 }).state;
      rounds++;
    }
    if (s.status !== 'FINISHED') stalled++;
  }
  eq(stalled, 0, `${stalled}/25 AI games stalled — the anti-stall clause has regressed`);
});

test('Bonus rewards use the ordinary coin balance — there is one currency (§11, §26)', () => {
  const s = newGame('currency');
  const view = createPlayerView(s, 0);
  const keys = Object.keys(view.you);
  assert(!keys.some((k) => /gem|token|crystal|premium/i.test(k)), 'A second currency appeared');
});

/* ================================================================== *
 * §5, §14.1 — Information boundary
 * ================================================================== */
section('Information boundary — PlayerView filtering (§5, §14.1, §24)');

test('Only the owner can see their own castle', () => {
  const s = newGame('view-1');
  for (let seat = 0; seat < 4; seat++) {
    const v = createPlayerView(s, seat);
    eq(v.you.castlePosition, s.castles[seat], 'Own castle missing from own view');
    for (const o of v.opponents) assert(!('castlePosition' in o), `Seat ${seat} can see seat ${o.seat}'s castle`);
  }
});

test('Only the owner can see their own private bonus', () => {
  const s = newGame('view-2');
  for (let seat = 0; seat < 4; seat++) {
    const v = createPlayerView(s, seat);
    eq(v.you.activeBonus.position, s.activeBonuses[seat].position);
    for (const o of v.opponents) assert(!('activeBonus' in o), 'Opponent bonus exposed');
  }
});

test('No PlayerView contains another player’s hidden information', () => {
  for (let i = 0; i < 40; i++) {
    const s = newGame(`leak-${i}`);
    for (let seat = 0; seat < 4; seat++) {
      const problems = auditViewForLeaks(s, seat);
      eq(problems, [], `Leaks for seat ${seat}: ${problems.join(', ')}`);
    }
  }
});

test('A PlayerView never carries the seed or RNG cursor', () => {
  const s = newGame('view-seed');
  const json = JSON.stringify(createPlayerView(s, 0));
  assert(!json.includes('rngState'), 'RNG cursor leaked — future placements would be predictable');
  assert(!json.includes(s.seed), 'Seed leaked');
});

test('Opponent coin balances are never visible', () => {
  const s = newGame('view-coins');
  const v = createPlayerView(s, 2);
  eq(v.you.coinsRemaining, s.config.startingCoins);
  for (const o of v.opponents) assert(!('coinsRemaining' in o), 'Opponent balance exposed');
});

test('Opponent bids are never visible, before or after locking', () => {
  let s = newGame('view-bids');
  s = lockBid(s, 1, B({ UP: 9 })).state;
  const v = createPlayerView(s, 0);
  assert(!JSON.stringify(v).includes('"UP":9'), 'An opponent bid leaked into the view');
  const opp = v.opponents.find((o) => o.seat === 1);
  eq(opp.locked, true, 'Lock status should be public so the UI can show who we are waiting on');
});

test('The queen’s complete path is never visible during play (§5.3, §26)', () => {
  let s = rig(newGame('view-path'), {
    queen: [6, 1],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[2, 2, 30], [2, 3, 30], [2, 4, 30], [2, 5, 30]],
  });
  for (let i = 0; i < 3; i++) s = playRound(s, [B({ RIGHT: 1 }), B(), B(), B()]).state;
  const v = createPlayerView(s, 0);
  assert(!('completeQueenPath' in v), 'Full path exposed during live play');
  assert(s.completeQueenPath.length > 3, 'Authoritative state should still be recording the path');
  eq(v.lastResolution.path.length, 1, 'Only the current round segment is public');
});

test('The resolution summary is aggregate and does not identify contributors (§19)', () => {
  const s = newGame('view-agg');
  const { state } = playRound(s, [B({ UP: 3 }), B({ DOWN: 2 }), B({ RIGHT: 2 }), B()]);
  const v = createPlayerView(state, 3);
  eq(v.lastResolution.totals, { UP: 3, DOWN: 2, LEFT: 0, RIGHT: 2 }, 'Aggregate totals are public');
  assert(!('bids' in v.lastResolution), 'Per-seat bids leaked into the resolution');
  assert(!('_private' in v.lastResolution), 'Private resolution slice leaked');
});

test('A bonus collection is reported only to the collector', () => {
  let s = newGame('view-collect');
  s = rig(s, {
    queen: [6, 2],
    castles: [[1, 1], [1, 9], [9, 1], [9, 9]],
    bonuses: [[6, 4, 30], [2, 2, 30], [2, 3, 30], [2, 4, 30]],
  });
  const { state } = playRound(s, [B({ RIGHT: 2 }), B(), B(), B()]);
  eq(createPlayerView(state, 0).lastResolution.yourBonusCollected.reward, 30);
  for (const seat of [1, 2, 3]) {
    eq(createPlayerView(state, seat).lastResolution.yourBonusCollected, null, `Seat ${seat} learned of a rival collection`);
  }
});

test('The reveal is refused while the game is still running (§18)', () => {
  const s = newGame('reveal-guard');
  throws(() => createRevealView(s), 'Reveal was permitted mid-game');
});

/* ================================================================== *
 * §13 — AI parity
 * ================================================================== */
section('Computer players — identical information (§13)');

test('AI receives exactly the same PlayerView shape as a human', () => {
  let s = newGame('ai-shape');
  s = setControlMode(s, 2, CONTROL_MODE.AI, { reason: 'disconnected' });
  const humanView = createPlayerView(s, 0);
  const aiView = createPlayerView(s, 2);
  eq(Object.keys(humanView).sort(), Object.keys(aiView).sort(), 'View shapes diverge');
  eq(Object.keys(humanView.you).sort(), Object.keys(aiView.you).sort(), 'Private slices diverge');
});

test('AI decisions are legal and never exceed the balance it can see', () => {
  for (let i = 0; i < 150; i++) {
    let s = newGame(`ai-legal-${i}`);
    s = rig(s, { coins: [3, 75, 0, 40] });
    for (let seat = 0; seat < 4; seat++) {
      const view = createPlayerView(s, seat);
      const bid = decideBid(view, { rngSeed: `ai-legal-${i}` });
      const check = validateBid(s, seat, bid);
      assert(check.ok, `AI produced an illegal bid on seat ${seat}: ${check.error}`);
    }
  }
});

test('An AI with no coins bids nothing', () => {
  let s = rig(newGame('ai-broke'), { coins: [0, 0, 0, 0] });
  const bid = decideBid(createPlayerView(s, 0));
  eq(bid, emptyBid());
});

test('AI never bids toward a cell off the board', () => {
  for (const q of [[0, 0], [0, 11], [11, 0], [11, 11], [0, 5], [5, 11]]) {
    for (let i = 0; i < 25; i++) {
      let s = rig(newGame(`ai-edge-${q}-${i}`), { queen: q });
      for (let seat = 0; seat < 4; seat++) {
        const bid = decideBid(createPlayerView(s, seat), { rngSeed: `edge-${i}` });
        assert(validateBid(s, seat, bid).ok, `AI bid off-board from ${q}`);
      }
    }
  }
});

test('The AI module cannot reach authoritative state', () => {
  const s = newGame('ai-blind');
  const view = createPlayerView(s, 0);
  // Simulate a hostile call: hand the AI a view and confirm the only castle it
  // could act on is its own.
  const json = JSON.stringify(view);
  for (let seat = 1; seat < 4; seat++) {
    const c = s.castles[seat];
    const ownCastle = s.castles[0];
    if (sameCell(c, ownCastle)) continue;
    const marker = `"r":${c.r},"c":${c.c}`;
    const legitimate =
      sameCell(c, s.queenPosition) ||
      sameCell(c, s.activeBonuses[0].position) ||
      Object.values(adjacentCells(s)).some((a) => a && sameCell(a, c));
    if (!legitimate) assert(!json.includes(marker), `Opponent castle coordinates appear in the view`);
  }
});

/* ================================================================== *
 * §17, §18 — Determinism and reveal
 * ================================================================== */
section('Determinism and end-of-game reveal (§17, §18)');

test('The same seed produces an identical board', () => {
  const a = createGame({ seed: 'repeat-me' });
  const b = createGame({ seed: 'repeat-me' });
  eq(a.castles, b.castles);
  eq(a.queenPosition, b.queenPosition);
  eq(a.activeBonuses, b.activeBonuses);
  eq(a.gameId, b.gameId);
});

test('The same seed and the same bids produce an identical game', () => {
  const run = () => {
    let s = newGame('determinism');
    for (let i = 0; i < 12; i++) {
      const bids = [0, 1, 2, 3].map((seat) => decideBid(createPlayerView(s, seat), { rngSeed: 'determinism' }));
      const r = playRound(s, bids);
      s = r.state;
      if (s.status === 'FINISHED') break;
    }
    return s;
  };
  const a = run();
  const b = run();
  eq(a.completeQueenPath, b.completeQueenPath);
  eq(a.winner, b.winner);
  eq(a.coinAllocationState, b.coinAllocationState);
});

test('Different seeds produce different boards', () => {
  const boards = new Set();
  for (let i = 0; i < 30; i++) {
    const s = createGame({ seed: `variety-${i}` });
    boards.add(s.castles.map(cellKey).join('|') + '/' + cellKey(s.queenPosition));
  }
  assert(boards.size > 25, `Expected varied boards, got ${boards.size} distinct out of 30`);
});

test('The end reveal contains the complete path and all four castles', () => {
  let s = newGame('reveal');
  s = rig(s, {
    queen: [5, 2],
    castles: [[5, 4], [1, 1], [1, 9], [9, 1]],
    bonuses: [[2, 2, 10], [2, 3, 10], [2, 4, 10], [2, 5, 10]],
  });
  s = playRound(s, [B({ RIGHT: 1 }), B(), B(), B()]).state; // (5,2) → (5,3)
  const { state } = playRound(s, [B({ RIGHT: 1 }), B(), B(), B()]); // (5,3) → (5,4) win
  eq(state.winner, 0);
  const reveal = createRevealView(state);
  eq(reveal.castles.length, 4, 'All four castles must be revealed');
  eq(reveal.completeQueenPath, [cell(5, 2), cell(5, 3), cell(5, 4)], 'Path must run start → winning cell');
  eq(reveal.winnerName, state.players[0].displayName);
  assert(reveal.bonusLedger.length >= 4, 'Bonus history should be available for the reveal');
});

test('The queen path records every intermediate cell, not just endpoints', () => {
  let s = newGame('path-detail');
  s = rig(s, { queen: [5, 1], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  const { state } = playRound(s, [B({ RIGHT: 4 }), B(), B(), B()]);
  eq(state.completeQueenPath, [cell(5, 1), cell(5, 2), cell(5, 3), cell(5, 4), cell(5, 5)]);
});

/* ================================================================== *
 * §7, §21 — Lifecycle and edge cases
 * ================================================================== */
section('Round lifecycle and edge cases (§7, §21)');

test('A resolved round opens the next round with cleared bids and a new timer', () => {
  const s = newGame('lifecycle');
  const { state } = playRound(s, [B({ UP: 2 }), B(), B(), B()], 0);
  eq(state.roundNumber, 2);
  eq(state.phase, 'PLAN');
  eq(state.lockedSeats, []);
  eq(state.currentRoundBids, [null, null, null, null]);
  assert(state.timerDeadline !== null, 'A new deadline should be set');
});

test('A finished game refuses further resolution', () => {
  let s = newGame('finished');
  s = rig(s, {
    queen: [5, 3],
    castles: [[5, 4], [1, 1], [1, 9], [9, 1]],
    bonuses: [[2, 2, 10], [2, 3, 10], [2, 4, 10], [2, 5, 10]],
  });
  const { state } = playRound(s, [B({ RIGHT: 1 }), B(), B(), B()]);
  eq(state.status, 'FINISHED');
  const again = resolveRound(state, { now: 0 });
  assert(again.error, 'Resolution should be refused after the game ends');
});

test('A queen boxed into a corner still resolves without error', () => {
  let s = newGame('corner');
  s = rig(s, { queen: [0, 0], castles: [[1, 1], [1, 9], [9, 1], [9, 9]] });
  const { state } = playRound(s, [B({ DOWN: 3 }), B(), B(), B()]);
  eq(state.queenPosition, cell(3, 0));
});

test('Takeover flags are public but change nothing about information access (§13)', () => {
  let s = newGame('takeover');
  s = setControlMode(s, 1, CONTROL_MODE.AI, { reason: 'disconnected', connectionStatus: 'DISCONNECTED' });
  const v = createPlayerView(s, 0);
  const opp = v.opponents.find((o) => o.seat === 1);
  eq(opp.controlMode, 'AI');
  eq(opp.connectionStatus, 'DISCONNECTED');
  assert(!('castlePosition' in opp), 'Takeover must not widen visibility');
});

test('Reconnecting does not overwrite an already locked bid (§21)', () => {
  let s = newGame('reconnect');
  s = setControlMode(s, 1, CONTROL_MODE.AI, { reason: 'disconnected' });
  s = lockBid(s, 1, B({ UP: 6 })).state;
  s = setControlMode(s, 1, CONTROL_MODE.HUMAN, { connectionStatus: 'CONNECTED' });
  const attempt = stageBid(s, 1, B({ DOWN: 6 }));
  assert(!attempt.ok, 'A returning human overwrote a locked authoritative bid');
  eq(s.currentRoundBids[1], B({ UP: 6 }));
});

test('A full AI game reaches a legal conclusion without leaking or crashing', () => {
  let finished = 0;
  for (let i = 0; i < 20; i++) {
    let s = newGame(`sim-${i}`);
    for (let round = 0; round < 400 && s.status === 'PLAYING'; round++) {
      const bids = [0, 1, 2, 3].map((seat) => decideBid(createPlayerView(s, seat), { rngSeed: `sim-${i}` }));
      bids.forEach((bid, seat) => {
        const r = lockBid(s, seat, bid);
        assert(r.ok, `Illegal AI bid: ${r.error}`);
        s = r.state;
      });
      s = resolveRound(s, { now: 0 }).state;
      for (let seat = 0; seat < 4; seat++) eq(auditViewForLeaks(s, seat), [], 'Leak mid-simulation');
    }
    if (s.status === 'FINISHED') {
      finished++;
      const reveal = createRevealView(s);
      eq(reveal.castles.length, 4);
      assert(sameCell(reveal.completeQueenPath.at(-1), reveal.castles[s.winner]), 'Path must end on the winning castle');
    }
  }
  assert(finished >= 15, `Only ${finished}/20 AI games reached a castle within 400 rounds`);
});

/* ---------------- report ---------------- */
console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} rule tests passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} failed\x1b[0m, ${passed} passed`);
  for (const f of failures) console.log(`  • [${f.section}] ${f.name}\n    ${f.err.message}`);
  process.exitCode = 1;
}
