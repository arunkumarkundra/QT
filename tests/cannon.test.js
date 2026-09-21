/**
 * QUEEN'S TUG — Cannon fire rules
 *
 *   node tests/cannon.test.js
 *
 * Five cannonballs a game, at most one a round, fired in secret and landing
 * before the queen moves. A struck castle knocks its owner out; a struck
 * treasure becomes a ghost that is replaced only when it would have run out;
 * every struck cell is a permanent crater. Last castle standing wins.
 */

import {
  createGame,
  startGame,
  lockBid,
  resolveRound,
  validateBid,
  generateBonus,
  hiddenPlacementCells,
  shouldReplenishCoins,
  sameCell,
  cell,
  emptyBid,
} from '../src/engine.js';
import { createPlayerView, createRevealView, auditViewForLeaks } from '../src/playerView.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || 'Assertion failed');
};
const eq = (a, b, m) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || 'Expected equality'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
  }
};

/**
 * A started game with a fixed, known layout: castles in a row, treasures
 * below them, the queen in the middle.
 */
function board(seed = 'cannon', { players = 4 } = {}) {
  let s = startGame(createGame({ seed, config: { playerCount: players } }), { now: 0 });
  s = structuredClone(s);
  s.castles = [cell(2, 2), cell(2, 9), cell(9, 2), cell(9, 9)].slice(0, players);
  s.activeBonuses = [cell(3, 3), cell(3, 8), cell(8, 3), cell(8, 8)]
    .slice(0, players)
    .map((position) => ({ position, reward: 100 }));
  s.queenPosition = cell(5, 5);
  return s;
}

/** Lock every seat still able to act, with the given plans, then resolve. */
function play(s, plans = {}) {
  for (let seat = 0; seat < s.players.length; seat++) {
    if (s.lockedSeats.includes(seat)) continue;
    const r = lockBid(s, seat, plans[seat] || emptyBid());
    assert(r.ok, `Seat ${seat} could not lock: ${r.error}`);
    s = r.state;
  }
  return resolveRound(s, { now: 0 });
}

const shot = (r, c, coins = {}) => ({ ...emptyBid(), ...coins, shot: { r, c } });

console.log('\n\x1b[1mAiming\x1b[0m');

test('Each player starts with five cannonballs, visible only to themselves', () => {
  const s = board();
  const v = createPlayerView(s, 0);
  eq(v.you.cannonballs, 5);
  eq(v.config.cannonballsPerPlayer, 5);
  for (const o of v.opponents) assert(!('cannonballs' in o), 'A rival cannonball count would name the shooter');
});

test('A shot rides with the bid and survives validation', () => {
  const s = board();
  const r = validateBid(s, 0, shot(6, 6, { UP: 2 }));
  assert(r.ok, r.error);
  eq(r.bid.shot, { r: 6, c: 6 });
  eq(r.bid.UP, 2);
});

test('You cannot fire at your own castle or your own treasure', () => {
  const s = board();
  assert(!validateBid(s, 0, shot(2, 2)).ok, 'Own castle accepted');
  assert(!validateBid(s, 0, shot(3, 3)).ok, 'Own treasure accepted');
  assert(validateBid(s, 1, shot(2, 2)).ok, 'A rival should be able to fire there');
});

test('You cannot fire at the queen, the edge band, or an existing crater', () => {
  let s = board();
  assert(!validateBid(s, 0, shot(5, 5)).ok, 'Queen cell accepted');
  assert(!validateBid(s, 0, shot(0, 4)).ok, 'Edge cell accepted');
  assert(!validateBid(s, 0, shot(4, 11)).ok, 'Edge cell accepted');
  s.craters = [cell(6, 6)];
  assert(!validateBid(s, 0, shot(6, 6)).ok, 'Crater accepted');
});

test('Malformed shots are refused', () => {
  const s = board();
  for (const bad of [{ r: '3', c: 3 }, { r: 3.5, c: 3 }, 'x', { r: 3 }, 7]) {
    assert(!validateBid(s, 0, { ...emptyBid(), shot: bad }).ok, `Accepted ${JSON.stringify(bad)}`);
  }
});

test('No cannonballs left means no shot', () => {
  const s = board();
  s.cannonballs[0] = 0;
  assert(!validateBid(s, 0, shot(6, 6)).ok, 'Fired with an empty rack');
});

console.log('\n\x1b[1mImpact\x1b[0m');

test('A miss leaves a crater and spends one ball', () => {
  const { state, resolution } = play(board(), { 0: shot(6, 6) });
  eq(state.craters, [cell(6, 6)]);
  eq(state.cannonballs, [4, 5, 5, 5]);
  eq(resolution.explosions, [{ position: cell(6, 6), castleSeat: null }]);
});

test('Two balls on one cell make one crater, and both are spent', () => {
  const { state, resolution } = play(board(), { 0: shot(6, 6), 1: shot(6, 6) });
  eq(state.craters.length, 1);
  eq(resolution.explosions.length, 1);
  eq(state.cannonballs, [4, 4, 5, 5]);
});

test('A struck castle knocks its owner out, publicly', () => {
  const { state, resolution } = play(board(), { 0: shot(2, 9) });
  eq(state.eliminatedSeats, [1]);
  eq(resolution.eliminated, [1]);
  eq(resolution.explosions[0].castleSeat, 1);
  const seen = createPlayerView(state, 2);
  assert(seen.opponents.find((o) => o.seat === 1).eliminated, 'Others must see the fall');
  eq(seen.ruins, [{ seat: 1, position: cell(2, 9) }]);
  assert(createPlayerView(state, 1).you.eliminated, 'The fallen player must know');
});

test('Shots are anonymous: nothing in any view names the shooter', () => {
  const { state } = play(board(), { 2: shot(2, 9) });
  for (let seat = 0; seat < 4; seat++) {
    eq(auditViewForLeaks(state, seat), [], `Leak for seat ${seat}`);
    const json = JSON.stringify(createPlayerView(state, seat).lastResolution);
    assert(!/"seat":2[,}]/.test(json.replace(/"castleSeat":\d/g, '')), 'The shooter seat appears in the resolution');
  }
});

test('Bombs land before the queen moves: a castle destroyed this round cannot win', () => {
  let s = board();
  s.queenPosition = cell(2, 7); // two cells left of seat 1's castle at (2,9)
  const { state } = play(s, { 1: { ...emptyBid(), RIGHT: 2 }, 0: shot(2, 9) });
  assert(sameCell(state.queenPosition, cell(2, 9)), 'The queen should still reach the rubble');
  eq(state.winner, null, 'Rubble must not win');
  eq(state.status, 'PLAYING');
});

test('A fallen player bids nothing and fires nothing afterwards', () => {
  let { state } = play(board(), { 0: shot(2, 9) });
  assert(state.lockedSeats.includes(1), 'Fallen seat should be pre-locked');
  eq(state.currentRoundBids[1], emptyBid());
  assert(!validateBid(state, 1, shot(6, 6)).ok, 'A fallen player fired');
});

test("A fallen player's coins bid in the round they fell still count", () => {
  const { resolution } = play(board(), { 0: shot(2, 9), 1: { ...emptyBid(), DOWN: 3 } });
  eq(resolution.totals.DOWN, 3);
});

test("A fallen player's unspent coins never block replenishment", () => {
  let { state } = play(board(), { 0: shot(2, 9) });
  state.coinAllocationState.forEach((a, seat) => (a.coinsRemaining = seat === 1 ? 50 : 0));
  assert(shouldReplenishCoins(state), 'Replenishment blocked by a fallen seat');
});

test('When every standing player is out of coins, all of them refill — but not the fallen', () => {
  let { state } = play(board(), { 0: shot(2, 9) }); // seat 1 falls
  state.coinAllocationState.forEach((a, seat) => (a.coinsRemaining = seat === 1 ? 7 : 0));
  const { state: after } = play(state, {});
  const r = after.config.replenishCoins;
  eq(after.coinAllocationState.map((a) => a.coinsRemaining), [r, 7, r, r]);
  eq(after.metrics.replenishments, 1);
});

console.log('\n\x1b[1mTreasure\x1b[0m');

test('A struck treasure vanishes for its owner and nobody else learns it was there', () => {
  const { state, resolution } = play(board(), { 0: shot(3, 8) });
  const owner = createPlayerView(state, 1);
  eq(owner.you.activeBonus, null);
  assert(owner.you.treasureLost, 'Owner should know the treasure is lost');
  eq(owner.lastResolution.yourTreasureDestroyed, { position: cell(3, 8) });
  for (const seat of [0, 2, 3]) {
    const v = createPlayerView(state, seat);
    eq(v.lastResolution.yourTreasureDestroyed, null, `Seat ${seat} learned of the hit`);
    eq(v.lastResolution.explosions, [{ position: cell(3, 8), castleSeat: null }]);
  }
  eq(resolution.explosions[0].castleSeat, null);
});

test('A ghost treasure cannot be collected', () => {
  let s = board();
  s.queenPosition = cell(3, 6);
  const { state } = play(s, { 0: shot(3, 8), 1: { ...emptyBid(), RIGHT: 2 } });
  assert(sameCell(state.queenPosition, cell(3, 8)), 'Queen should land on the crater');
  eq(state.coinAllocationState[1].coinsRemaining, 98, 'A destroyed treasure paid out');
});

test('A ghost keeps decaying and is replaced only when it would have run out', () => {
  let s = board();
  s.activeBonuses.forEach((b) => (b.reward = 5));
  s.queenPosition = cell(5, 4);
  // Round 1: hit seat 1's treasure, queen moves 2 → every treasure at 3.
  let r = play(s, { 0: shot(3, 8), 2: { ...emptyBid(), RIGHT: 2 } });
  eq(r.state.activeBonuses[1].reward, 3, 'Ghost did not decay');
  assert(r.state.activeBonuses[1].destroyed, 'Ghost was replaced too early');
  // Round 2: queen moves 3 → everything hits 0 and is replaced together.
  r = play(r.state, { 2: { ...emptyBid(), DOWN: 3 } });
  const fresh = r.state.activeBonuses[1];
  assert(!fresh.destroyed, 'Ghost was never replaced');
  eq(fresh.reward, 100);
  assert(!sameCell(fresh.position, cell(3, 8)), 'Replaced onto its own crater');
  for (const seat of [0, 2, 3]) eq(r.state.activeBonuses[seat].reward, 100, 'Replacements out of step');
});

test('No treasure is ever placed on a crater', () => {
  const s = board();
  s.craters = hiddenPlacementCells(s).filter((p) => !(p.r === 7 && p.c === 7));
  s.activeBonuses[0] = null;
  const b = generateBonus(s, 0);
  eq(b.position, cell(7, 7));
});

console.log('\n\x1b[1mNothing left to play\x1b[0m');

test('A seat with no coins and no cannonballs is passed for as the round opens', () => {
  let s = board();
  s.coinAllocationState[2].coinsRemaining = 0;
  s.cannonballs[2] = 0;
  const { state } = play(s, {});
  assert(state.lockedSeats.includes(2), 'An empty-handed seat should be pre-locked');
  eq(state.currentRoundBids[2], emptyBid());
});

test('No coins but a cannonball left: still gets a turn', () => {
  let s = board();
  s.coinAllocationState[2].coinsRemaining = 0;
  const { state } = play(s, {});
  assert(!state.lockedSeats.includes(2), 'A seat that can still fire must be allowed to decide');
  assert(validateBid(state, 2, shot(6, 6)).ok, 'It should be able to fire');
});

test('Cannonballs but coins refilled: gets a turn again', () => {
  let s = board();
  s.cannonballs = [0, 0, 0, 0];
  s.coinAllocationState.forEach((a) => (a.coinsRemaining = 0));
  const { state } = play(s, {});
  // Everyone was empty, so coins refilled at resolution — nobody is passed for.
  eq(state.lockedSeats, [], 'After a refill every seat has a move');
});

console.log('\n\x1b[1mThe end\x1b[0m');

test('Last castle standing: the queen walks straight to it and the game ends', () => {
  let { state } = play(board(), { 0: shot(2, 9) });
  ({ state } = play(state, { 0: shot(9, 2) }));
  const { state: end, resolution } = play(state, { 0: shot(9, 9), 3: { ...emptyBid(), UP: 2 } });
  eq(end.status, 'FINISHED');
  eq(end.winner, 0);
  assert(sameCell(end.queenPosition, cell(2, 2)), 'Queen did not reach the last castle');
  eq(resolution.finale, { seat: 0 });
  eq(resolution.path.length, 6, 'Walk should be the shortest path');
  const reveal = createRevealView(end);
  assert(sameCell(reveal.completeQueenPath.at(-1), cell(2, 2)));
  eq(reveal.craters.length, 3);
});

test('Two players: one castle hit ends the game', () => {
  const { state } = play(board('duel', { players: 2 }), { 1: shot(2, 2) });
  eq(state.status, 'FINISHED');
  eq(state.winner, 1);
});

test('The last castles falling together is a draw', () => {
  const { state, resolution } = play(board('mutual', { players: 2 }), { 0: shot(2, 9), 1: shot(2, 2) });
  eq(state.status, 'FINISHED');
  eq(state.winner, null);
  assert(state.draw && resolution.draw, 'Should be a draw');
});

test('Views stay leak-free through a whole cannon game', () => {
  let s = board('leakfree');
  const plans = [{ 0: shot(6, 6) }, { 1: shot(8, 3) }, { 2: shot(2, 9) }, { 3: shot(4, 4) }];
  for (const p of plans) {
    s = play(s, p).state;
    for (let seat = 0; seat < 4; seat++) eq(auditViewForLeaks(s, seat), [], `Leak for seat ${seat}`);
  }
});

console.log(`\n${'─'.repeat(60)}`);
if (!failures.length) console.log(`\x1b[32m\x1b[1mAll ${passed} cannon tests passed.\x1b[0m`);
else {
  console.log(`\x1b[31m\x1b[1m${failures.length} failed\x1b[0m, ${passed} passed`);
  process.exitCode = 1;
}
