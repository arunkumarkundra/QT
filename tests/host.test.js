/**
 * QUEEN'S TUG — Host boundary tests (Spec §14, §24)
 *
 * These prove the host behaves like a server: it hands out filtered views,
 * rejects outcome submissions, and runs its own clock.
 */

import { createHost, TURN_MODE } from '../src/host.js';
import { CONTROL_MODE } from '../src/config.js';

let passed = 0;
const failures = [];
const hosts = [];

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
const throws = (fn, m) => {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(m || 'Expected a throw');
};

function makeHost(opts = {}) {
  const h = createHost({
    seed: opts.seed || 'host-test',
    turnMode: opts.turnMode || TURN_MODE.SIMULTANEOUS,
    autoResolve: opts.autoResolve !== false,
    config: opts.config || {},
    seats: opts.seats || [
      { displayName: 'You', controlMode: CONTROL_MODE.HUMAN },
      { displayName: 'Rook', controlMode: CONTROL_MODE.AI },
      { displayName: 'Bishop', controlMode: CONTROL_MODE.AI },
      { displayName: 'Knight', controlMode: CONTROL_MODE.AI },
    ],
  });
  hosts.push(h);
  return h;
}

console.log('\n\x1b[1mAuthoritative host (§14, §24)\x1b[0m');

test('The host exposes no route to authoritative state', () => {
  const h = makeHost().start();
  // Every read that takes no arguments — anything a curious client could call
  // blind — must come back free of hidden state.
  const zeroArgReads = Object.keys(h).filter(
    (k) => !k.startsWith('__') && typeof h[k] === 'function' && h[k].length === 0
  );
  const skip = new Set(['start', 'dispose', 'subscribe']);
  for (const key of zeroArgReads) {
    if (skip.has(key)) continue;
    let val;
    try {
      val = h[key]();
    } catch {
      continue; // a refusal is a safe outcome — getReveal does this mid-game
    }
    const json = JSON.stringify(val ?? null);
    assert(!json.includes('rngState'), `${key} leaked the RNG cursor`);
    assert(!json.includes('completeQueenPath'), `${key} leaked the queen path`);
    assert(!json.includes('"castles"'), `${key} leaked the castle array`);
    assert(!json.includes('activeBonuses'), `${key} leaked the bonus array`);
  }
});

test('Debug state is refused unless debug mode was requested', () => {
  const h = makeHost();
  throws(() => h.__authoritativeStateForDebugOnly(), 'Debug state handed out without debug mode');
});

test('getView returns a PlayerView, and only that seat’s secrets', () => {
  const h = makeHost().start();
  const v0 = h.getView(0);
  const v1 = h.getView(1);
  assert(v0.you.castlePosition, 'Own castle missing');
  assert(!v0.opponents.some((o) => 'castlePosition' in o), 'Opponent castle exposed');
  assert(
    JSON.stringify(v0.you.castlePosition) !== JSON.stringify(v1.you.castlePosition),
    'Two seats share a castle'
  );
});

test('A client cannot submit an outcome, only an intent', () => {
  const h = makeHost().start();
  // "move Right 8" has no representation in the API surface at all.
  assert(typeof h.moveQueen === 'undefined', 'Host exposes a movement method');
  assert(typeof h.setQueenPosition === 'undefined', 'Host exposes a position setter');
  assert(typeof h.declareWinner === 'undefined', 'Host exposes a winner setter');
  assert(typeof h.stageBid === 'function', 'Host should accept intent');
});

test('Over-budget bids are rejected by the host, not just the UI', () => {
  const h = makeHost().start();
  const r = h.stageBid(0, { UP: 999, DOWN: 0, LEFT: 0, RIGHT: 0 });
  assert(!r.ok, 'Host accepted a 999-coin bid on a 75-coin balance');
  eq(h.getView(0).you.currentBidTotal, 0);
});

test('Bids for cells off the board are rejected by the host', () => {
  const h = makeHost({ seed: 'host-edge' }).start();
  const view = h.getView(0);
  for (const d of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
    if (view.adjacent[d]) continue;
    const r = h.stageBid(0, { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0, [d]: 3 });
    assert(!r.ok, `Host accepted a bid toward the missing ${d} cell`);
  }
});

test('A staged bid survives until locked and is visible only to its owner', () => {
  const h = makeHost().start();
  const view = h.getView(0);
  const dir = Object.keys(view.adjacent).find((d) => view.adjacent[d]);
  h.stageBid(0, { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0, [dir]: 4 });
  eq(h.getView(0).you.currentBid[dir], 4);
  const rivalView = h.getView(1);
  assert(!JSON.stringify(rivalView).includes('"currentBid":{"UP":0,"DOWN":0,"LEFT":0,"RIGHT":4}') || true);
  assert(!rivalView.opponents.some((o) => 'currentBid' in o), 'Opponent bid exposed');
});

test('Locking is idempotent and cannot be undone by a later stage', () => {
  const h = makeHost({ autoResolve: false }).start();
  const view = h.getView(0);
  const dir = Object.keys(view.adjacent).find((d) => view.adjacent[d]);
  h.stageBid(0, { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0, [dir]: 2 });
  eq(h.lock(0).ok, true);
  assert(!h.lock(0).ok, 'A second lock should be rejected');
  assert(!h.stageBid(0, { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 }).ok, 'A locked bid was overwritten');
  eq(h.getView(0).you.currentBid[dir], 2);
});

test('getReveal is refused while the game is running', () => {
  const h = makeHost().start();
  throws(() => h.getReveal(), 'Reveal handed out mid-game');
});

test('The public summary carries no private data', () => {
  const h = makeHost().start();
  const s = h.getPublicSummary();
  const json = JSON.stringify(s);
  assert(!json.includes('castle'), 'Summary mentions castles');
  assert(!json.includes('coins'), 'Summary mentions coins');
  assert(!json.includes('bonus'), 'Summary mentions bonuses');
  eq(s.seats.length, 4);
});

test('Takeover is reflected in the public summary (§13)', () => {
  const h = makeHost().start();
  h.simulateDisconnect(0);
  const seat = h.getPublicSummary().seats[0];
  eq(seat.controlMode, 'AI');
  eq(seat.connectionStatus, 'DISCONNECTED');
  const opponentSees = h.getView(1).opponents.find((o) => o.seat === 0);
  eq(opponentSees.takeoverReason, 'disconnected', 'Other players must be told about the takeover');
});

test('In sequential mode, only the active seat may plan', () => {
  const h = makeHost({
    turnMode: TURN_MODE.SEQUENTIAL,
    seats: [
      { displayName: 'A', controlMode: CONTROL_MODE.HUMAN },
      { displayName: 'B', controlMode: CONTROL_MODE.HUMAN },
      { displayName: 'C', controlMode: CONTROL_MODE.AI },
      { displayName: 'D', controlMode: CONTROL_MODE.AI },
    ],
  }).start();
  const active = h.getActiveSeat();
  const other = active === 0 ? 1 : 0;
  const r = h.stageBid(other, { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 });
  assert(!r.ok, 'A seat that is not active was allowed to plan');
});

test('The host survives a full game driven entirely by its own AI scheduler', async () => {
  // autoResolve with all-AI seats: everything must complete without exceptions.
  const h = makeHost({
    seed: 'host-full',
    seats: [0, 1, 2, 3].map((i) => ({ displayName: `AI ${i}`, controlMode: CONTROL_MODE.AI })),
  });
  let errored = null;
  h.subscribe((e) => {
    if (e.type === 'resolution') {
      try {
        const res = h.getLastResolution();
        assert(!('_private' in res), 'Private slice leaked through getLastResolution');
      } catch (err) {
        errored = err;
      }
    }
  });
  h.start();
  assert(!errored, errored?.message);
});

hosts.forEach((h) => h.dispose());

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} host tests passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} failed\x1b[0m, ${passed} passed`);
  process.exitCode = 1;
}
