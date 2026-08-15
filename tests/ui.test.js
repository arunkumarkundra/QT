/**
 * QUEEN'S TUG — UI tests
 *
 * Boots the BUILT file in jsdom and plays it the way a person would, so a
 * broken bundle fails here rather than in someone's browser.
 *
 *   npm install --no-save jsdom
 */

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(new URL('../dist/queens-tug.html', import.meta.url), 'utf8');
const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => pageErrors.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/queens-tug.html?turbo=0.04',
  virtualConsole: vc,
  beforeParse(w) {
    w.scrollTo = () => {};
    w.navigator.clipboard = { writeText: async () => {} };
    // jsdom has no WebAudio; the sound module must degrade silently.
    // A stub WebAudio implementation, so the sound path is genuinely
    // exercised rather than skipped. Counts every node that gets created.
    w.__audioNodes = 0;
    const P = function () {
      return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} };
    };
    const N = function () {
      w.__audioNodes++;
      return { connect() {}, disconnect() {}, start() {}, stop() {}, frequency: P(), Q: P(), gain: P(), type: '' };
    };
    w.AudioContext = function () {
      return {
        currentTime: 0,
        sampleRate: 48000,
        state: 'running',
        destination: {},
        createOscillator: N,
        createGain: N,
        createBiquadFilter: N,
        createBufferSource: N,
        createBuffer: (c, len) => ({ getChannelData: () => new Float32Array(len) }),
        resume: () => Promise.resolve(),
      };
    };
    w.RTCPeerConnection = function () {};
  },
});
const { window } = dom;
const doc = window.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (sel) => {
  const n = typeof sel === 'string' ? $(sel) : sel;
  assert(n, `Missing element: ${sel}`);
  n.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};

/** Return the board to an empty placement, whatever a previous test left. */
function clearCoins() {
  for (let i = 0; i < 60; i++) {
    const staked = $('#board-cells .cell.staked');
    if (!staked) break;
    staked.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }
}

console.log('\n\x1b[1mUI (jsdom, built bundle)\x1b[0m');

await wait(140);

await test('Boots to the title screen with no script error', () => {
  assert(pageErrors.length === 0, pageErrors.join('; '));
  assert(!$('#screen-title').hidden, 'Title screen not shown');
  assert($('#screen-game').hidden, 'Game screen should be hidden');
  assert($('#screen-result').hidden, 'Result screen should be hidden');
});

await test('Exactly one screen is ever mounted — the page cannot scroll between them', () => {
  const visible = $$('.screen').filter((s) => !s.hidden);
  eq(visible.length, 1, 'More than one screen is mounted at once');
});

await test('The key art is inlined rather than fetched', () => {
  const src = $('.title-art').getAttribute('src');
  assert(src.startsWith('data:image/webp;base64,'), 'Logo not inlined');
});

await test('The start screen carries the logo, seats, code, link and controls', () => {
  assert($('.title-art'), 'Logo missing from the start screen');
  eq($$('#room-seats .seat-chip').length, 4, 'Expected four seats');
  assert(/^QT-[A-Z0-9]{6}$/.test($('#room-code').textContent), 'Malformed game code');
  assert($('#btn-room-copy'), 'Copy-link button missing');
  assert($('#btn-room-invite'), 'Invite button missing');
  assert($('#btn-room-newboard'), 'New-board button missing');
  assert(!$('#btn-room-start').hidden, 'Start button missing');
  assert($('#btn-join'), 'Join-with-code missing');
  assert($('#btn-sound-title').innerHTML.trim(), 'Sound icon not rendered');
  assert($('#btn-rules').innerHTML.trim(), 'Rules icon not rendered');
  assert(!$('#btn-solo'), 'The redundant solo option is still present');
});

await test('One seat is you; the rest wait as computer players', () => {
  const chips = $$('#room-seats .seat-chip');
  eq(chips.filter((c) => c.dataset.kind === 'human').length, 1);
  eq(chips.filter((c) => c.classList.contains('waiting')).length, 3);
});

await test('The start screen has no long link box to overflow small screens', () => {
  assert(!$('#room-link'), 'The full link is still rendered');
  assert(!$('.invite-row'), 'The link row survived');
});

await test('A favicon is declared', () => {
  const icon = doc.querySelector('link[rel="icon"]');
  assert(icon && icon.getAttribute('href').startsWith('data:image/svg+xml'), 'No inline favicon');
});

await test('Changing the board issues a new code', () => {
  const before = $('#room-code').textContent;
  click('#btn-room-newboard');
  assert($('#room-code').textContent !== before, 'New board did not change the code');
});

await test('Starting the game opens the board', () => {
  click('#btn-room-start');
  assert(!$('#screen-game').hidden, 'Game screen did not open');
  assert($('#screen-title').hidden, 'Start screen still mounted');
  assert($$('#board-cells .cell').length === 144, 'Expected a 12×12 board');
});

await test('Only this player’s own pieces are ever drawn', () => {
  eq($$('#board-overlay .castle-mark').length, 1, 'More than one castle is on the board');
  assert($$('#board-overlay .bonus-mark').length <= 1, 'More than one treasure is on the board');
  assert($('#board-overlay .queen'), 'Queen missing');
});

await test('Seats are colour and icon only — no names or numbers', () => {
  const chips = $$('#seat-chips .seat-chip');
  eq(chips.length, 4);
  eq($('#seat-chips').textContent.trim(), '', 'Seat strip contains text');
  eq(chips.filter((c) => c.classList.contains('is-you')).length, 1, 'Exactly one seat is you');
  for (const c of chips) assert(c.style.getPropertyValue('--seat'), 'Seat has no colour');
  eq($$('#seat-chips .lock-badge').length, 4, 'Every seat needs a lock indicator');
});

await test('The coin balance sits at the far left of the top strip', () => {
  const strip = [...$('.seat-strip').children];
  eq(strip[0].id, 'purse', 'The purse should come before the player icons');
  eq(strip[1].id, 'seat-chips', 'Player icons should follow the purse');
  assert(!$('.action-row'), 'The old action row survived');
  assert(!$('#btn-lock'), 'A separate lock button survived');
});

await test('The board has visible grid work', () => {
  assert($$('.board-grid-lines').length >= 1, 'Grid guide lines missing');
});

await test('The cells beside the queen become the controls', () => {
  const targets = $$('#board-cells .cell.target');
  assert(targets.length >= 2 && targets.length <= 4, `Expected 2–4 targets, got ${targets.length}`);
  for (const t of targets) assert(t.dataset.dir, 'A target has no direction');
  assert($$('#board-cells .cell .dir-hint').length >= 2, 'Direction hints missing');
});

let firstDir = null;

await test('Clicking a cell drops a visible coin, not an empty box', () => {
  const target = $('#board-cells .cell.target');
  firstDir = target.dataset.dir;
  click(target);
  eq($$('#board-cells .cell.staked').length, 1, 'No staked cell after a click');
  eq($('#board-cells .cell.staked .count').textContent, '1', 'Coin count wrong');
  const disc = $('#board-cells .cell.staked .disc');
  assert(disc && disc.innerHTML.includes('<svg'), 'The coin disc is empty — no coin artwork');
  assert($('#board-cells .cell.staked .count'), 'Coin count badge missing');
});

await test('The coin balance carries no undo control', () => {
  assert(!$('#btn-undo'), 'The undo button survived');
  assert(!$('.purse .undo'), 'An undo control is still in the purse');
});

await test('The treasure stack is drawn from equal-sized coins', () => {
  const pile = $('#board-overlay .bonus-pile');
  if (!pile) return; // this seat's treasure may be off-screen in a short game
  const radii = [...pile.innerHTML.matchAll(/rx="([\d.]+)"/g)].map((m) => m[1]);
  const coinRadii = radii.filter((r) => r === '16');
  assert(coinRadii.length >= 3, 'Treasure stack should be several identical coins');
});

await test('Sound is actually produced, not silently swallowed', () => {
  const before = window.__audioNodes;
  click($('#board-cells .cell.target'));
  assert(window.__audioNodes > before, 'Placing a coin produced no audio nodes');
  clearCoins();
});

await test('Every game sound produces audio, including timer and victory', () => {
  // Guards against the class of bug where a recipe throws and the catch
  // silently swallows it, leaving the game mute.
  const names = ['tick', 'lock', 'step', 'noMove', 'moveStart', 'moveEnd', 'wall', 'victory', 'bonus', 'gameStart'];
  for (const n of names) {
    const before = window.__audioNodes;
    window.__qtSound.play(n, 1);
    assert(window.__audioNodes > before, `Sound "${n}" produced nothing`);
  }
});

await test('Coins accumulate one per click', () => {
  clearCoins();
  const target = $(`#board-cells .cell[data-dir="${firstDir}"]`);
  click(target);
  click(target);
  click(target);
  eq($('#board-cells .cell.staked .count').textContent, '3');
});

await test('Clicking the opposite cell takes coins back instead of paying both ways', () => {
  clearCoins();
  const opp = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' }[firstDir];
  const oppCell = $(`#board-cells .cell[data-dir="${opp}"]`);
  if (!oppCell) return; // queen against a wall this game
  const target = $(`#board-cells .cell[data-dir="${firstDir}"]`);
  click(target);
  click(target);
  click(target);
  click(oppCell);
  eq($('#board-cells .cell.staked .count').textContent, '2', 'Opposite click did not remove a coin');
  eq($$('#board-cells .cell.staked').length, 1, 'Coins were placed in both directions at once');
  click(oppCell);
  click(oppCell);
  eq($$('#board-cells .cell.staked').length, 0, 'Stack did not empty');
});

await test('Undo takes a coin back even when the queen is against a wall', () => {
  // Reproduces the reported bug: with no opposite cell there was no way to
  // remove a coin. The undo control must work regardless of geometry.
  clearCoins();
  const target = $('#board-cells .cell.target');
  click(target);
  click(target);
  eq($('#board-cells .cell.staked .count').textContent, '2');
  // Right-click on the stack is the wall-safe removal gesture.
  const menu = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(menu);
  eq($('#board-cells .cell.staked .count').textContent, '1', 'Right-click did not remove a coin');
  target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  eq($$('#board-cells .cell.staked').length, 0, 'Right-click did not clear the last coin');
});

await test('Every direction beside the queen accepts and releases coins', () => {
  clearCoins();
  for (const cell of $$('#board-cells .cell.target')) {
    const dir = cell.dataset.dir;
    click(cell);
    const stack = $(`#board-cells .cell[data-dir="${dir}"] .count`);
    assert(stack && stack.textContent === '1', `Direction ${dir} would not accept a coin`);
    cell.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert(!$(`#board-cells .cell[data-dir="${dir}"] .count`), `Direction ${dir} would not release its coin`);
  }
});

await test('The queen is the lock control, and passes when nothing is staked', () => {
  clearCoins();
  const queen = $('#queen');
  assert(queen.classList.contains('armed'), 'Queen is not armed for locking');
  assert(/pass/i.test(queen.title), `Queen should offer to pass: "${queen.title}"`);
  click($('#board-cells .cell.target'));
  assert(/lock/i.test($('#queen').title), 'Queen should offer to lock once coins are placed');
});

await test('The purse shows a balance and never a staked total', () => {
  const purse = $('#purse').textContent;
  assert(/^\s*\d+\s*$/.test(purse), `Purse should show one number, got "${purse}"`);
  assert(!/stake/i.test($('#purse').innerHTML), 'Purse mentions staking');
});

await test('Round number and seat identity are not shown during play', () => {
  const bar = $('#screen-game .bar').textContent;
  assert(!/round/i.test(bar), 'Round counter is on screen');
  assert(!/playing as/i.test($('#screen-game').textContent), 'Seat identity banner is on screen');
});

await test('There is no side panel — the layout is a single column', () => {
  assert(!$('.side'), 'A side panel survived');
  assert(!$('.compass'), 'The bidding compass survived');
  assert(!$$('#screen-game button').some((b) => /\+5|\+10/.test(b.textContent)), 'Coin step buttons survived');
});

await test('Locking in resolves the round without revealing per-direction totals', async () => {
  clearCoins();
  click($('#queen'));
  await wait(1400);
  const status = $('#status').textContent;
  assert(!/\d/.test(status) || /holds her ground/.test(status), `Status leaks numbers: "${status}"`);
  assert(!$('#res-bars'), 'The old totals readout survived');
});

await test('A full game reaches the result screen', async () => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (!$('#screen-result').hidden) break;
    const queen = $('#queen.armed');
    if (queen) {
      const c = $('#board-cells .cell.target');
      if (c) click(c);
      click(queen);
    }
    await wait(12);
  }
  assert(!$('#screen-result').hidden, 'Never reached the result screen');
  assert($('#screen-game').hidden, 'Game screen still mounted');
});

await test('The winner is an avatar plus a short verb, with no player number', () => {
  const text = $('#winner-text').textContent;
  assert(/^(You win|Wins)$/.test(text), `Unexpected winner text: "${text}"`);
  assert($('#winner-avatar svg'), 'Winner avatar missing');
  const colour = $('#winner-line').style.getPropertyValue('--seat');
  assert(colour, 'Winner avatar has no seat colour');
});

await test('The replay shows all four castles, owner-ringed treasure and a trail', () => {
  eq($$('#replay-overlay .castle-mark').length, 4, 'Not all castles revealed');
  assert($$('#replay-overlay .bonus-ring').length > 0, 'No owner rings on historical treasure');
  assert($('#replay-path polyline'), 'No trail drawn');
  assert($('#replay-queen'), 'Replay queen missing');
});

await test('The replay is scrubbed by round, not by single step', () => {
  const slider = $('#replay-slider');
  const rounds = Number($('#replay-slider').max);
  const rounds2 = Number(slider.max);
  assert(rounds2 > 0, 'Slider has no stops');
  slider.value = '0';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  eq($('#replay-label').textContent, `0 / ${rounds}`);
  const at = () => {
    const q = $('#replay-queen');
    return `${q.style.getPropertyValue('--r')},${q.style.getPropertyValue('--c')}`;
  };
  const atStart = at();
  slider.value = String(rounds);
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  eq($('#replay-label').textContent, `${rounds} / ${rounds}`, 'Label did not follow the scrubber');
  // A one-round game can legitimately start and end on the same cell.
  if (rounds > 2) assert(at() !== atStart, 'Scrubbing did not move the queen');
});

await test('The result stats live in the bottom message strip', () => {
  const strip = $('#result-status').textContent;
  assert(/rounds/.test(strip) && /cells travelled/.test(strip), `Stats missing: "${strip}"`);
  assert(!$('.result-stats'), 'The old stats panel survived');
  assert(!/now public/i.test($('#screen-result').textContent), 'Redundant castle list survived');
});

await test('No script errors across the whole session', () => {
  assert(pageErrors.length === 0, pageErrors.join('; '));
});

dom.window.close();

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} UI tests passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} failed\x1b[0m, ${passed} passed`);
  process.exitCode = 1;
}
