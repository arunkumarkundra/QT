/**
 * QUEEN'S TUG — Pass-and-play flow test
 *
 * Four humans on one device is the configuration the playtesting plan (§27)
 * actually calls for. The information rules of §5 still apply, so the handoff
 * curtain has to be airtight: at no moment may two players' castles be in the
 * DOM at once, and the board must swap completely between turns.
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const html = readFileSync(new URL('../dist/queens-tug.html', import.meta.url), 'utf8');
const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => pageErrors.push(e));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://example.test/queens-tug.html?turbo=0.04',
  virtualConsole: vc,
  beforeParse(w) {
    w.scrollTo = () => {};
    w.navigator.clipboard = { writeText: async () => {} };
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

const castleCell = () => {
  const m = $('#board-overlay .castle-mark');
  return m ? `${m.style.getPropertyValue('--r')},${m.style.getPropertyValue('--c')}` : null;
};


/**
 * Play the current turn the way a person would: read this seat's own castle
 * (the only one on screen) and stake toward it. Everything used here is
 * information the DOM legitimately holds for the seat currently in control.
 */
function playTurnTowardOwnCastle() {
  const queen = $('#board-overlay .queen');
  const castle = $('#board-overlay .castle-mark');
  const lock = $('#btn-lock');
  if (!queen || !castle || !lock || lock.disabled) return false;

  const num = (node, prop) => Number(node.style.getPropertyValue(prop));
  const qr = num(queen, '--r');
  const qc = num(queen, '--c');
  const cr = num(castle, '--r');
  const cc = num(castle, '--c');

  let dir;
  let dist;
  if (cr !== qr) {
    dir = cr < qr ? 'UP' : 'DOWN';
    dist = Math.abs(cr - qr);
  } else {
    dir = cc < qc ? 'LEFT' : 'RIGHT';
    dist = Math.abs(cc - qc);
  }

  const step1 = $$('#seg-step button').find((b) => b.dataset.step === '1');
  if (step1 && !step1.classList.contains('is-on')) click(step1);

  let target = $(`#board-cells .cell.bid-target[data-dir="${dir}"]`);
  if (!target) target = $('#board-cells .cell.bid-target');
  if (target) for (let i = 0; i < Math.min(dist || 1, 8); i++) click(target);

  click(lock);
  return true;
}

console.log('\n\x1b[1mPass-and-play handoff (§5, §27)\x1b[0m');

await wait(80);

await test('Two humans can be seated from the lobby', () => {
  click('#btn-new');
  // Flip seat 2 (index 1) from Computer to Human.
  const seatRows = $$('#seat-list .seat-row');
  assert(seatRows.length === 4, 'Expected four seat rows');
  const humanBtn = seatRows[1].querySelectorAll('.toggle button')[0];
  click(humanBtn);
  const refreshed = $$('#seat-list .seat-row')[1];
  assert(refreshed.querySelectorAll('.toggle button')[0].classList.contains('is-on'), 'Seat 2 did not switch to Human');
  assert(/2 humans/.test($('#seat-summary').textContent), `Summary did not update: ${$('#seat-summary').textContent}`);
});

await test('Starting with two humans opens the handoff curtain first', async () => {
  click('#btn-start');
  await wait(120);
  assert($('#screen-game').classList.contains('is-active'), 'Game screen did not open');
  assert($('#curtain').classList.contains('is-open'), 'The curtain did not open before play');
  assert(/you go first|Pass the device/.test($('#curtain-title').textContent), 'Curtain has no handoff message');
});

let firstCastle = null;

await test('Dismissing the curtain reveals exactly one castle — the first player’s', async () => {
  click('#curtain-go');
  await wait(80);
  assert(!$('#curtain').classList.contains('is-open'), 'Curtain did not close');
  assert($$('#board-overlay .castle-mark').length === 1, 'More than one castle is on the board');
  firstCastle = castleCell();
  assert(firstCastle, 'No castle rendered for the first player');
});

await test('Locking the first player hands off to the second behind the curtain', async () => {
  const target = $('#board-cells .cell.bid-target');
  if (target) click(target);
  click('#btn-lock');
  await wait(200);
  assert($('#curtain').classList.contains('is-open'), 'The curtain did not close over the first player’s board');
  assert(/Pass the device/.test($('#curtain-title').textContent), 'Curtain is not asking for a handoff');
});

await test('The second player sees their own castle, never the first player’s', async () => {
  click('#curtain-go');
  await wait(80);
  assert($$('#board-overlay .castle-mark').length === 1, 'Two castles are visible at once');
  const secondCastle = castleCell();
  assert(secondCastle, 'No castle rendered for the second player');
  assert(secondCastle !== firstCastle, 'The second player is being shown the first player’s castle');
  assert($('#tb-seat').textContent !== '', 'The seat readout did not update');
});

await test('The second player’s staked coins start from zero, not inherited', () => {
  assert(Number($('#hub-total').textContent) === 0, 'A placement carried across the handoff');
  assert($$('#board-cells .cell.has-stake').length === 0, 'A staked cell survived the handoff');
});

await test('A full two-human game completes and reveals four castles', async () => {
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if ($('#screen-reveal').classList.contains('is-active')) break;
    if ($('#curtain').classList.contains('is-open')) {
      click('#curtain-go');
      await wait(20);
      continue;
    }
    playTurnTowardOwnCastle();
    await wait(10);
  }
  assert($('#screen-reveal').classList.contains('is-active'), 'The two-human game never finished');
  assert($$('#reveal-legend .legend-row').length === 4, 'Reveal is missing castles');
});

await test('No script errors across the pass-and-play session', () => {
  assert(pageErrors.length === 0, pageErrors.map((e) => e.message || e).join('; '));
});

dom.window.close();

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1mAll ${passed} pass-and-play tests passed.\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m${failures.length} failed\x1b[0m, ${passed} passed`);
  process.exitCode = 1;
}
