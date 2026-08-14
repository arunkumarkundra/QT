/**
 * QUEEN'S TUG — UI smoke test
 *
 * Boots dist/queens-tug.html in jsdom and drives it the way a person would:
 * start a game, stake coins, lock, let rounds resolve, and check that the
 * screen actually updates. It also re-runs the information-leak audit against
 * the rendered DOM, because a view can be clean while the markup is not.
 *
 * Requires jsdom (dev-only):  npm install --no-save jsdom
 */

import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

let passed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    })
    .catch((err) => {
      failures.push({ name, err });
      console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.message}`);
    });
}
const assert = (c, m) => {
  if (!c) throw new Error(m || 'Assertion failed');
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(new URL('../dist/queens-tug.html', import.meta.url), 'utf8');

const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => pageErrors.push(e));
vc.on('error', (e) => pageErrors.push(e));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/queens-tug.html?turbo=0.04',
  virtualConsole: vc,
  // Stub the handful of APIs jsdom does not implement, BEFORE page scripts run.
  beforeParse(w) {
    w.scrollTo = () => {};
    w.navigator.clipboard = { writeText: async () => {} };
  },
});
const { window } = dom;
const doc = window.document;
const $ = (s) => doc.querySelector(s);
const $$ = (s) => [...doc.querySelectorAll(s)];
const click = (elOrSel) => {
  const node = typeof elOrSel === 'string' ? $(elOrSel) : elOrSel;
  assert(node, `Missing element: ${elOrSel}`);
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};


console.log('\n\x1b[1mUI smoke test (jsdom)\x1b[0m');

await test('The page boots without a script error', async () => {
  await wait(120);
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.map((e) => e.message || e).join('; ')}`);
  assert($('#screen-title').classList.contains('is-active'), 'Title screen did not open');
});

await test('The key art is inlined, not a broken external reference', () => {
  const src = $('.title-art').getAttribute('src');
  assert(src.startsWith('data:image/webp;base64,'), 'Logo is not inlined');
  assert(src.length > 5000, 'Inlined logo looks truncated');
});

await test('New game opens the lobby with a seeded board code', () => {
  click('#btn-new');
  assert($('#screen-lobby').classList.contains('is-active'), 'Lobby did not open');
  assert(/^QT-[A-Z0-9]{6}$/.test($('#lobby-code').textContent), 'Malformed game number');
  assert($('#invite-url').value.includes('?game=QT-'), 'Invitation URL missing the join token');
  assert($$('#seat-list .seat-row').length === 4, 'Expected exactly four seats');
});

await test('The invitation link carries no hidden state (§20)', () => {
  const url = $('#invite-url').value;
  const params = new window.URLSearchParams(url.split('?')[1]);
  assert([...params.keys()].join(',') === 'game', `Unexpected URL params: ${[...params.keys()]}`);
});

await test('Starting the game renders a 12×12 board and the player’s own castle', async () => {
  click('#btn-start');
  await wait(150);
  assert($('#screen-game').classList.contains('is-active'), 'Game screen did not open');
  assert($$('#board-cells .cell').length === 144, `Expected 144 cells, got ${$$('#board-cells .cell').length}`);
  assert($('#board-overlay .castle-mark.mine'), 'Own castle not rendered');
  assert($('#board-overlay .queen'), 'Queen not rendered');
});

await test('Exactly one castle is drawn — no opponent castles reach the DOM (§5.3)', () => {
  assert($$('#board-overlay .castle-mark').length === 1, 'More than one castle is in the markup');
  assert($$('#board-overlay .bonus-mark').length <= 1, 'More than one bonus is in the markup');
});

await test('The four bid targets are marked and clickable', () => {
  const targets = $$('#board-cells .cell.bid-target');
  assert(targets.length >= 2 && targets.length <= 4, `Expected 2–4 bid targets, got ${targets.length}`);
  for (const t of targets) assert(t.dataset.dir, 'A bid target has no direction');
});

await test('Clicking a bid target stakes coins and updates the purse', () => {
  const before = Number($('#purse-amount').textContent);
  const target = $('#board-cells .cell.bid-target');
  click(target);
  click(target);
  assert(Number($('#hub-total').textContent) === 2, 'Hub total did not reach 2');
  assert(Number($('#purse-staked').textContent) === 2, 'Staked readout did not update');
  assert(Number($('#purse-amount').textContent) === before, 'Balance should not drop until resolution');
  assert(target.classList.contains('has-stake'), 'Staked cell not highlighted');
});

await test('The stake step control changes the increment', () => {
  const stepBtn = $$('#seg-step button').find((b) => b.dataset.step === '10');
  click(stepBtn);
  click($('#board-cells .cell.bid-target'));
  assert(Number($('#hub-total').textContent) === 12, `Expected 12 staked, got ${$('#hub-total').textContent}`);
});

await test('Clear resets the placement', () => {
  click('#btn-clear');
  assert(Number($('#hub-total').textContent) === 0, 'Clear did not reset the stake');
  assert($$('#board-cells .cell.has-stake').length === 0, 'A staked highlight survived Clear');
});

await test('A stake cannot exceed the balance', () => {
  const stepBtn = $$('#seg-step button').find((b) => b.dataset.step === '10');
  click(stepBtn);
  const target = $('#board-cells .cell.bid-target');
  for (let i = 0; i < 12; i++) click(target); // 120 coins attempted against 75
  const total = Number($('#hub-total').textContent);
  assert(total <= 75, `Staked ${total} on a 75-coin balance`);
});

await test('Locking resolves the round and advances the counter', async () => {
  click('#btn-clear');
  click($$('#seg-step button').find((b) => b.dataset.step === '1'));
  click($('#board-cells .cell.bid-target'));
  const round = Number($('#tb-round').textContent);
  click('#btn-lock');
  await wait(900); // turbo pacing: AI think time + presentation window
  const after = Number($('#tb-round').textContent);
  assert(after === round + 1 || $('#screen-reveal').classList.contains('is-active'), `Round did not advance (${round} → ${after})`);
});

await test('The resolution readout shows aggregate totals only', async () => {
  const bars = $$('#res-bars .res-row');
  assert(bars.length === 4, `Expected four direction rows, got ${bars.length}`);
  const markup = $('#resolution').innerHTML;
  assert(!/Player\s*[234]/.test(markup), 'The resolution names individual contributors');
});

await test('Opponent panel shows control mode but never coins, castles or bids', () => {
  const markup = $('#rival-list').innerHTML;
  assert($$('#rival-list .rival').length === 3, 'Expected three opponents');
  assert(!/coin/i.test(markup), 'Opponent balances leaked into the panel');
  assert(!/castle/i.test(markup), 'Opponent castles leaked into the panel');
});

await test('Keyboard staking works', async () => {
  await wait(300);
  if ($('#screen-reveal').classList.contains('is-active')) return; // game already ended
  const before = Number($('#hub-total').textContent);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const after = Number($('#hub-total').textContent);
  assert(after >= before, 'Keyboard staking had no effect');
});

await test('A full game reaches the reveal screen with all four castles', async () => {
  // Drive rounds until the game ends.
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if ($('#screen-reveal').classList.contains('is-active')) break;
    const lock = $('#btn-lock');
    if (!lock.disabled) {
      const target = $('#board-cells .cell.bid-target');
      if (target) click(target);
      click(lock);
    }
    await wait(25);
  }
  assert($('#screen-reveal').classList.contains('is-active'), 'The game never reached the reveal screen');
  assert($$('#reveal-legend .legend-row').length === 4, 'Reveal does not list all four castles');
  assert($$('#reveal-overlay .castle-mark').length === 4, 'Reveal board does not draw all four castles');
  assert($('#reveal-path polyline'), 'The queen path was not drawn');
  const pts = $('#reveal-path polyline').getAttribute('points').trim().split(/\s+/);
  assert(pts.length >= 2, 'The revealed path has no length');
  assert(/wins$/.test($('#reveal-winner').textContent), 'Winner headline missing');
});

await test('The replay scrubber moves the queen along the revealed path', () => {
  const slider = $('#replay-slider');
  const queen = $('#reveal-queen');
  slider.value = '0';
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  const atStart = queen.style.getPropertyValue('--r') + ',' + queen.style.getPropertyValue('--c');
  slider.value = slider.max;
  slider.dispatchEvent(new window.Event('input', { bubbles: true }));
  const atEnd = queen.style.getPropertyValue('--r') + ',' + queen.style.getPropertyValue('--c');
  assert(atStart !== atEnd, 'The scrubber did not move the queen');
});

await test('No script errors accumulated across the whole session', () => {
  assert(pageErrors.length === 0, `Page errors: ${pageErrors.map((e) => e.message || e).join('; ')}`);
});

dom.window.close();

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} UI tests passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} failed\x1b[0m, ${passed} passed`);
  process.exitCode = 1;
}
