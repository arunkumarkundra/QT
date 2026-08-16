/**
 * QUEEN'S TUG — Regression tests for the four reported bugs.
 *
 * Each test names the bug it exists to stop coming back. The wall-flash case
 * in particular has regressed once already under a different overlay, so it is
 * asserted structurally (no invisible element may take pointer events over the
 * board) rather than by checking one selector.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGame,
  startGame,
  retireSeat,
  checkWinner,
  allSeatsLocked,
  lockBid,
  resolveRound,
  emptyBid,
} from '../src/engine.js';
import { createHost } from '../src/host.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failed = 0;
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

/* ------------------------------------------------------------------ *
 * BUG 1 — coins could not be staked beside a wall
 * ------------------------------------------------------------------ */

console.log('\n  Wall-adjacent staking (#wall-flash overlay)\n');

test('Every full-bleed board overlay is pointer-transparent', () => {
  const css = read('styles.css');
  /**
   * The bug: #wall-flash is positioned over a 10% strip of the board along
   * whichever wall the queen hit, keeps that geometry after fading to
   * opacity 0, and sits at z-index 6 — above .board-cells. Without
   * pointer-events:none it eats clicks aimed at the cells beside the queen,
   * which are exactly the cells she can still legally be pulled toward.
   */
  for (const selector of ['.wall-flash', '.board-overlay', '.path-layer', '.board-grid-lines']) {
    const rule = css.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`));
    assert(rule, `No rule found for ${selector}`);
    assert(
      /pointer-events:\s*none/.test(rule[0]),
      `${selector} may cover the board but does not set pointer-events:none`
    );
  }
});

test('flashWall clears its geometry instead of leaving a live strip behind', () => {
  const ui = read('src/ui.js');
  const fn = ui.slice(ui.indexOf('function flashWall'), ui.indexOf('function flashWall') + 1600);
  assert(fn.includes('pointerEvents'), 'flashWall does not force pointer-events off inline');
  assert(
    fn.includes('cssText') && fn.split('cssText').length > 2,
    'flashWall never tears its inline geometry back down'
  );
});

test('The built bundle carries the fix, not just the source', () => {
  const dist = read('dist/queens-tug.html');
  const rule = dist.match(/\.wall-flash\s*\{[^}]*\}/);
  assert(rule, 'No .wall-flash rule in the bundle');
  assert(/pointer-events:\s*none/.test(rule[0]), 'The bundle predates the fix — run `npm run build`');
});

/* ------------------------------------------------------------------ *
 * BUG 2 — bots joined a humans-only game
 * ------------------------------------------------------------------ */

console.log('\n  Humans-only games\n');

test('A game can be built with fewer than four seats', () => {
  for (const n of [2, 3, 4]) {
    const s = createGame({ seed: `QT-SIZE${n}`, config: { playerCount: n } });
    assert(s.players.length === n, `Expected ${n} players, got ${s.players.length}`);
    assert(s.castles.length === n, `Expected ${n} castles, got ${s.castles.length}`);
    assert(s.activeBonuses.filter(Boolean).length === n, 'Every seat needs a treasure');
  }
});

test('A two-human game contains no computer player at all', () => {
  const host = createHost({
    seed: 'QT-HUMANS',
    config: { playerCount: 2 },
    seats: [
      { playerId: 'a', displayName: 'You', controlMode: 'HUMAN' },
      { playerId: 'b', displayName: 'Player 2', controlMode: 'HUMAN' },
    ],
  });
  host.start();
  const seats = host.getPublicSummary().seats;
  assert(seats.length === 2, `Expected a two-seat table, got ${seats.length}`);
  assert(
    seats.every((s) => s.controlMode === 'HUMAN'),
    'A humans-only table must contain no AI seat'
  );
  host.dispose();
});

test('A retired seat bids nothing and never has to be waited for', () => {
  let s = startGame(createGame({ seed: 'QT-RETIRE', config: { playerCount: 3 } }));
  s = retireSeat(s, 2);
  assert(s.lockedSeats.includes(2), 'A retired seat should be pre-locked');
  assert(!allSeatsLocked(s), 'The two remaining players still have to act');
  s = lockBid(s, 0, { UP: 1, DOWN: 0, LEFT: 0, RIGHT: 0 }).state;
  s = lockBid(s, 1, emptyBid()).state;
  assert(allSeatsLocked(s), 'The round should resolve once everyone present has locked');
});

test('A departed player cannot win in their absence', () => {
  let s = startGame(createGame({ seed: 'QT-ABSENT', config: { playerCount: 3 } }));
  const absentCastle = s.castles[2];
  assert(checkWinner(s, absentCastle) === 2, 'Baseline: seat 2 owns that castle');
  s = retireSeat(s, 2);
  assert(
    checkWinner(s, absentCastle) === null,
    'The queen landing on a departed player’s castle must not crown them'
  );
  assert(checkWinner(s, s.castles[1]) === 1, 'A player still present must still be able to win');
});

test('Retirement survives a round boundary', () => {
  let s = startGame(createGame({ seed: 'QT-CARRY', config: { playerCount: 3 } }));
  s = retireSeat(s, 2);
  s = lockBid(s, 0, emptyBid()).state;
  s = lockBid(s, 1, emptyBid()).state;
  const r = resolveRound(s, { now: Date.now() });
  assert(!r.error, `Resolution failed: ${r.error}`);
  assert(
    r.state.lockedSeats.includes(2),
    'A retired seat must be re-locked when the next round opens, not waited on again'
  );
});

test('The host reports the humans-only quorum', () => {
  const host = createHost({
    seed: 'QT-QUORUM',
    config: { playerCount: 3 },
    seats: [0, 1, 2].map((i) => ({ playerId: `p${i}`, controlMode: 'HUMAN' })),
  });
  host.start();
  assert(host.getLiveHumanCount() === 3, 'Expected three live humans');
  host.retire(2);
  assert(host.getLiveHumanCount() === 2, 'A retired seat is not a live human');
  assert(host.getActiveSeats().length === 2, 'Retired seats are not active');
  host.abandon();
  assert(host.getPublicSummary().status === 'FINISHED', 'Abandon should end the game');
  assert(host.getView(0).winner === null, 'An abandoned game has no winner');
  host.dispose();
});

/* ------------------------------------------------------------------ *
 * BUG 3 — multiplayer instability
 * ------------------------------------------------------------------ */

console.log('\n  Transport\n');

test('The host does not push a full state blob on every clock tick', () => {
  const mp = read('src/multiplayer.js');
  /**
   * The original bridge did `host.subscribe(() => pushViews())`, and host.js
   * emits `tick` ten times a second. Every joiner was therefore sent a
   * complete serialized PlayerView 10×/s for the whole game, which saturates
   * the data channel and queues the intents travelling the other way behind
   * it — one cause producing both reported symptoms.
   */
  assert(
    /if\s*\(evt\?\.type === 'tick'\)\s*return/.test(mp),
    'tick events must not trigger a network push'
  );
  assert(mp.includes('pushCoalesceMs'), 'Bursts of host events must be coalesced');
});

test('The reveal is only sent once the game has finished', () => {
  const mp = read('src/multiplayer.js');
  const push = mp.slice(mp.indexOf('function pushViews'), mp.indexOf('/* ---------------- inbound'));
  assert(
    push.includes("summary.status === 'FINISHED'"),
    'The reveal — which carries the whole queen path and round log — must not ride every push'
  );
});

test('Intents are idempotent, sequenced and retried', () => {
  const mp = read('src/multiplayer.js');
  assert(mp.includes('appliedSeq'), 'The host must reject replayed intent sequences');
  assert(mp.includes('intentRetryMs'), 'Unacknowledged intents must be re-sent');
  assert(mp.includes('sendAck'), 'The host must acknowledge intents it applied');
  // A retried delta would double-charge a player; the wire format is absolute.
  assert(
    /t: 'bid', bid/.test(mp),
    'A bid must be sent as an absolute placement so a retry is harmless'
  );
});

test('Players are identified durably, not by peerId', () => {
  const mp = read('src/multiplayer.js');
  assert(mp.includes('CLIENT_ID_KEY'), 'A durable client identity is required for reconnection');
  assert(
    mp.includes('peer-returned'),
    'A browser that reconnects must be able to take its own seat back'
  );
});

test('Liveness does not rely on onPeerLeave alone', () => {
  const mp = read('src/multiplayer.js');
  assert(mp.includes('peerTimeoutMs'), 'A silently vanished phone must eventually time out');
  assert(mp.includes('hostSilenceMs'), 'A guest must notice a silent host');
});

test('A humans-only drop retires the seat instead of summoning a bot', () => {
  const mp = read('src/multiplayer.js');
  const release = mp.slice(mp.indexOf('release(peerId'), mp.indexOf('dispose() {'));
  assert(release.includes('onlyHumans'), 'release must branch on the humans-only setting');
  assert(release.includes('retire(seat)'), 'A humans-only drop must retire the seat');
  assert(release.includes('getLiveHumanCount() < 2'), 'Below two players the game must end');
  assert(release.includes("'AI'"), 'A normal game must still fall back to computer cover');
});

/* ------------------------------------------------------------------ *
 * BUG 4 — sound
 * ------------------------------------------------------------------ */

console.log('\n  Sound\n');

test('The audio context is never constructed outside a user gesture', () => {
  const snd = read('src/sound.js');
  /**
   * Safari will not let an AudioContext created outside a gesture reach the
   * running state, and hands back one that is permanently stuck. boot() used
   * to reach ensureContext() at page load through showScreen → startTheme.
   */
  assert(snd.includes('gestureSeen'), 'Construction must be gated on a real gesture');
  assert(
    /if \(!audio\.gestureSeen\) return null/.test(snd),
    'ensureContext must refuse to build a context before any gesture'
  );
});

test('Waking the context is event-driven, not a synchronous state check', () => {
  const snd = read('src/sound.js');
  /**
   * resume() is asynchronous. The old startTheme checked `ctx.state` on the
   * very next line and always lost that race on Safari, so the theme never
   * began — and there was no retry.
   */
  assert(snd.includes('statechange'), 'The context must react to statechange');
  assert(snd.includes('themeWanted'), 'A theme requested while asleep must start on wake');
  assert(snd.includes('resumeIfInterrupted'), 'Safari interruptions must be recoverable');
});

test('The theme request survives being made before any gesture', () => {
  const snd = read('src/sound.js');
  const start = snd.slice(snd.indexOf('startTheme()'), snd.indexOf('stopTheme()'));
  assert(
    start.includes('audio.themeWanted = true'),
    'startTheme must record the intent before it can act on it'
  );
});

console.log('\n' + '─'.repeat(60));
if (failed) {
  console.log(`\x1b[31m\x1b[1m${failed} failed\x1b[0m, ${passed} passed`);
  process.exit(1);
} else {
  console.log(`\x1b[32m\x1b[1mAll ${passed} regression tests passed.\x1b[0m`);
}
