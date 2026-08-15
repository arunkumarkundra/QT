/**
 * QUEEN'S TUG — User interface
 *
 * Renders state, collects intent. No game rules live here. Every fact drawn on
 * screen comes from `host.getView(seat)` — a PlayerView — so the browser never
 * holds another player's castle, treasure, balance or bid.
 *
 * Interaction model: the BOARD is the controller. There is no bidding panel.
 * Clicking a cell beside the queen drops one coin on it. Clicking the opposite
 * cell takes a coin back off the pile first, which is why there is no separate
 * "remove" control — pulling the other way is the natural undo.
 */

import { createHost } from './host.js';
import { DIRECTIONS, OPPOSITE, SEAT_COLORS, UI_TIMING, CONTROL_MODE, setPacing } from './config.js';
import { sound } from './sound.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dirVar = (d) => `var(--${d.toLowerCase()})`;
const DIR_WORD = { UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right' };

/* ------------------------------------------------------------------ *
 * Artwork — inline SVG so there are no image requests
 * ------------------------------------------------------------------ */

const ART = {
  queen: `<svg viewBox="0 0 40 46" aria-hidden="true">
    <defs>
      <linearGradient id="qgold" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fffbf0"/><stop offset=".45" stop-color="#f2d492"/><stop offset="1" stop-color="#b98d33"/>
      </linearGradient>
    </defs>
    <g stroke="#5c4416" stroke-width="1.1" stroke-linejoin="round">
      <path fill="url(#qgold)" d="M6 13 3 4l7.5 5L15 1.5 20 8l5-6.5L29.5 9 37 4l-3 9a5 5 0 0 1-1.4 2.4l-1.6 6.6H9L7.4 15.4A5 5 0 0 1 6 13z"/>
      <circle cx="3" cy="4" r="2.2" fill="#fff6dd"/><circle cx="37" cy="4" r="2.2" fill="#fff6dd"/>
      <circle cx="20" cy="6.5" r="2.4" fill="#fff6dd"/>
      <rect x="8" y="21" width="24" height="3.6" rx="1.4" fill="url(#qgold)"/>
      <path fill="url(#qgold)" d="M11 25h18l2.6 11H8.4z"/>
      <rect x="5" y="36" width="30" height="6" rx="2.2" fill="url(#qgold)"/>
    </g>
  </svg>`,

  castle: (color) => `<svg viewBox="0 0 36 34" aria-hidden="true">
    <g stroke="rgba(0,0,0,.55)" stroke-width="1.1" stroke-linejoin="round">
      <path fill="${color}" d="M3 13V5h4.5v3.2H12V5h4.5v3.2H21V5h4.5v3.2H30V5h3v8l2 2.4V32H1V15.4z"/>
      <path fill="rgba(0,0,0,.34)" stroke="none" d="M14.5 22h7v10h-7z"/>
      <path fill="rgba(255,255,255,.22)" stroke="none" d="M3 13h30l2 2.4H1z"/>
    </g>
  </svg>`,

  /** A stack of coins. The number is drawn over it by the caller. */
  treasure: `<svg viewBox="0 0 36 36" aria-hidden="true">
    <defs>
      <linearGradient id="tg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffeeb8"/><stop offset=".5" stop-color="#e0b040"/><stop offset="1" stop-color="#8a6420"/>
      </linearGradient>
    </defs>
    <g stroke="#5c4416" stroke-width="1">
      <ellipse cx="18" cy="27" rx="13" ry="5" fill="url(#tg)"/>
      <ellipse cx="18" cy="22.5" rx="11" ry="4.3" fill="url(#tg)"/>
      <ellipse cx="18" cy="18" rx="9" ry="3.6" fill="url(#tg)"/>
      <ellipse cx="18" cy="13.5" rx="6.5" ry="2.8" fill="url(#tg)"/>
    </g>
  </svg>`,

  human: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="7.6" r="4.1"/>
    <path d="M12 13.6c-4.3 0-7.6 2.4-7.6 5.5V22h15.2v-2.9c0-3.1-3.3-5.5-7.6-5.5z"/>
  </svg>`,

  bot: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="4" y="8" width="16" height="12" rx="3.4"/>
    <rect x="10.9" y="2.4" width="2.2" height="4" rx="1.1"/>
    <circle cx="12" cy="2.4" r="1.7"/>
    <circle cx="9" cy="13.4" r="1.9" fill="#0b0f17"/>
    <circle cx="15" cy="13.4" r="1.9" fill="#0b0f17"/>
    <rect x="9.4" y="16.8" width="5.2" height="1.5" rx=".75" fill="#0b0f17"/>
  </svg>`,

  lockClosed: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 10V7.2a5 5 0 0 1 10 0V10h.6A1.4 1.4 0 0 1 19 11.4v8.2A1.4 1.4 0 0 1 17.6 21H6.4A1.4 1.4 0 0 1 5 19.6v-8.2A1.4 1.4 0 0 1 6.4 10zm2.3 0h5.4V7.2a2.7 2.7 0 0 0-5.4 0z"/>
  </svg>`,

  lockOpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true">
    <rect x="5" y="10.5" width="14" height="10.5" rx="1.8"/>
    <path d="M8.2 10.5V7.4a3.8 3.8 0 0 1 7.3-1.4"/>
  </svg>`,

  chevron: (rot) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M5 15l7-7 7 7"/></svg>`,

  soundOn: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" d="M15.4 9a4.4 4.4 0 0 1 0 6M18 6.6a8 8 0 0 1 0 10.8"/></svg>`,
  soundOff: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="m16 9.5 4.5 5M20.5 9.5 16 14.5"/></svg>`,
  help: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.3-2.6 4" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.05" fill="currentColor" stroke="none"/></svg>`,
  exit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14M10 8l-4 4 4 4M6 12h9"/></svg>`,
  crown: `<svg viewBox="0 0 32 22" aria-hidden="true"><path fill="currentColor" d="M3 20 1 3l8.5 6.2L16 1l6.5 8.2L31 3l-2 17z"/></svg>`,
};

/* ------------------------------------------------------------------ *
 * App state (presentation only)
 * ------------------------------------------------------------------ */

const app = {
  host: null,
  seat: 0,
  code: '',
  animating: false,
  started: false,
  unsub: null,
  replayTimer: null,
  lastBalance: null,
  lastTick: -1,
  reveal: null,
};

function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, 2500);
}

function showScreen(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
}

function randomCode() {
  const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return `QT-${out}`;
}

const inviteUrl = (code) => `${location.origin}${location.pathname}?game=${encodeURIComponent(code)}`;

/* ------------------------------------------------------------------ *
 * Board construction
 * ------------------------------------------------------------------ */

function buildGrid(cellsEl, boardEl, width, height, margin) {
  boardEl.style.setProperty('--cols', width);
  boardEl.style.setProperty('--rows', height);
  cellsEl.innerHTML = '';
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const cell = el('div', 'cell');
      cell.dataset.r = r;
      cell.dataset.c = c;
      if (margin != null && (r < margin || c < margin || r >= height - margin || c >= width - margin)) {
        cell.classList.add('edge-band');
      }
      cellsEl.appendChild(cell);
    }
  }
}

/** The queen element is created ONCE and never rebuilt, so a re-render can
 *  never restart or duplicate a movement animation. */
function ensureQueen(overlay) {
  let q = $('#queen', overlay);
  if (!q) {
    q = el('div', 'marker queen');
    q.id = 'queen';
    q.innerHTML = `<div class="queen-glow"></div>${ART.queen}`;
    overlay.appendChild(q);
  }
  return q;
}

function placeMarker(node, pos) {
  node.style.setProperty('--r', pos.r);
  node.style.setProperty('--c', pos.c);
}

/* ------------------------------------------------------------------ *
 * Game setup
 * ------------------------------------------------------------------ */

function openGame(code) {
  app.code = code || randomCode();
  app.started = false;
  app.animating = false;
  app.lastBalance = null;

  if (app.host) app.host.dispose();
  if (app.unsub) app.unsub();

  app.host = createHost({
    seed: app.code,
    seats: [0, 1, 2, 3].map((i) => ({
      playerId: `seat-${i}`,
      displayName: i === 0 ? 'You' : `Player ${i + 1}`,
      controlMode: i === 0 ? CONTROL_MODE.HUMAN : CONTROL_MODE.AI,
    })),
  });
  app.unsub = app.host.subscribe(onHostEvent);
  app.seat = 0;

  const view = app.host.getView(app.seat);
  buildGrid($('#board-cells'), $('#board'), view.board.width, view.board.height, view.board.boundaryMargin);
  $('#board-overlay').innerHTML = '';
  $('#path-layer').innerHTML = '';

  $('#game-code').textContent = app.code;
  $('#pregame').hidden = false;
  $('#purse-value').textContent = view.config.startingCoins;
  $('#btn-lock').disabled = true;
  $('#status').innerHTML = '';

  renderSeatChips();
  renderTimer();
  showScreen('screen-game');
}

function beginPlay() {
  sound.unlock();
  sound.play('press');
  $('#pregame').hidden = true;
  app.started = true;
  app.host.start();
  sound.play('roundStart');
  render();
}

/* ------------------------------------------------------------------ *
 * Host events
 * ------------------------------------------------------------------ */

function onHostEvent(evt) {
  switch (evt.type) {
    case 'resolution':
      playResolution();
      break;
    case 'round-open':
      app.animating = false;
      sound.play('roundStart');
      render();
      break;
    case 'seat-locked':
      if (evt.seat !== app.seat) sound.play('rivalLock');
      render();
      break;
    case 'finished':
      break;
    case 'tick':
      renderTimer();
      break;
    default:
      render();
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  if (!app.host) return;
  const view = app.host.getView(app.seat);
  renderSeatChips(view);
  renderMarkers(view);
  renderTargets(view);
  renderPurse(view);
  renderLock(view);
  renderStatus(view);
  renderTimer();
}

function renderSeatChips(view) {
  const summary = app.host.getPublicSummary();
  const strip = $('#seat-chips');
  strip.innerHTML = '';
  for (const seat of summary.seats) {
    const chip = el('div', 'seat-chip');
    chip.style.setProperty('--seat', SEAT_COLORS[seat.seat]);
    if (seat.seat === app.seat) chip.classList.add('is-you');
    if (app.started && seat.locked) chip.classList.add('locked');
    if (app.started && !seat.locked && seat.controlMode === CONTROL_MODE.AI) chip.classList.add('thinking');

    const avatar = el('span', 'avatar', seat.controlMode === CONTROL_MODE.HUMAN ? ART.human : ART.bot);
    chip.appendChild(avatar);
    chip.appendChild(el('span', 'who', seat.displayName));
    chip.appendChild(
      el('span', 'lock-badge', app.started && seat.locked ? ART.lockClosed : ART.lockOpen)
    );
    chip.title = `${seat.displayName} — ${seat.controlMode === CONTROL_MODE.HUMAN ? 'human' : 'computer'}${
      app.started ? (seat.locked ? ', locked in' : ', still deciding') : ''
    }`;
    strip.appendChild(chip);
  }
}

function renderMarkers(view) {
  const overlay = $('#board-overlay');
  // Rebuild everything EXCEPT the queen, which must persist across renders.
  for (const node of $$('.castle-mark, .bonus-mark', overlay)) node.remove();

  const castle = el('div', 'marker castle-mark mine', ART.castle(SEAT_COLORS[view.you.seat]));
  castle.style.color = SEAT_COLORS[view.you.seat];
  placeMarker(castle, view.you.castlePosition);
  castle.title = 'Your castle — nobody else can see it';
  overlay.appendChild(castle);

  if (view.you.activeBonus && view.you.activeBonus.reward > 0) {
    const b = view.you.activeBonus;
    const mark = el('div', 'bonus-mark');
    mark.classList.add('marker');
    if (b.reward <= 12) mark.classList.add('fading');
    mark.innerHTML = `<div class="bonus-pile"><div class="glow"></div>${ART.treasure}<span class="value num">${b.reward}</span></div>`;
    placeMarker(mark, b.position);
    mark.title = 'Your treasure — land exactly here to claim it';
    overlay.appendChild(mark);
  }

  const queen = ensureQueen(overlay);
  if (!app.animating) placeMarker(queen, view.queenPosition);
}

function renderTargets(view) {
  for (const cell of $$('#board-cells .cell')) {
    cell.classList.remove('target', 'staked');
    cell.style.removeProperty('--dir');
    delete cell.dataset.dir;
    cell.innerHTML = '';
  }
  if (!app.started) return;

  const canPlan = planningAllowed(view);
  for (const d of DIRECTIONS) {
    const t = view.adjacent[d];
    if (!t) continue;
    const cell = $(`#board-cells .cell[data-r="${t.r}"][data-c="${t.c}"]`);
    if (!cell) continue;
    cell.style.setProperty('--dir', dirVar(d));
    cell.dataset.dir = d;

    const staked = view.you.currentBid[d] || 0;
    if (canPlan) cell.classList.add('target');

    if (staked > 0) {
      cell.classList.add('staked');
      const stack = el('div', 'coin-stack');
      stack.appendChild(el('span', 'disc'));
      stack.appendChild(el('span', 'count num', String(staked)));
      cell.appendChild(stack);
    } else if (canPlan) {
      const rot = { UP: 0, RIGHT: 90, DOWN: 180, LEFT: 270 }[d];
      cell.appendChild(el('div', 'dir-hint', ART.chevron(rot)));
    }
  }
}

function renderPurse(view) {
  const purse = $('#purse');
  const value = $('#purse-value');
  const balance = view.you.coinsRemaining;
  if (app.lastBalance !== null && balance !== app.lastBalance) {
    purse.classList.remove('spending', 'gaining');
    void purse.offsetWidth;
    purse.classList.add(balance < app.lastBalance ? 'spending' : 'gaining');
  }
  app.lastBalance = balance;
  value.textContent = balance;
}

function renderLock(view) {
  const btn = $('#btn-lock');
  if (!app.started) {
    btn.disabled = true;
    btn.textContent = 'Lock in';
    return;
  }
  if (view.you.locked) {
    btn.disabled = true;
    btn.textContent = 'Locked in';
    return;
  }
  btn.disabled = !planningAllowed(view);
  const staked = view.you.currentBidTotal;
  btn.textContent = staked > 0 ? `Lock in ${staked}` : 'Pass this round';
}

function renderStatus(view) {
  const status = $('#status');
  if (!app.started || app.animating) return;

  if (view.you.locked) {
    const waiting = view.opponents.filter((o) => !o.locked).length;
    status.innerHTML = waiting
      ? `Waiting for <b>${waiting}</b> more…`
      : 'Resolving…';
    return;
  }
  if (view.you.coinsRemaining === 0) {
    status.innerHTML = 'You are out of coins. Everyone refills once all four are empty.';
    return;
  }
  status.innerHTML = 'Tap the glowing cells to pull the queen your way.';
}

function renderTimer() {
  if (!app.host) return;
  const view = app.host.getView(app.seat);
  const ring = $('#timer');
  const CIRC = 2 * Math.PI * 18;

  let remain = view.config.decisionTimerMs / 1000;
  let frac = 1;

  if (app.started && !app.animating && !app.host.isPresenting() && view.timerDeadline) {
    remain = Math.max(0, (view.timerDeadline - Date.now()) / 1000);
    frac = Math.max(0, Math.min(1, remain / (view.config.decisionTimerMs / 1000)));
  }

  const secs = Math.ceil(remain);
  $('#timer-digits').textContent = secs;
  $('#timer-fill').style.strokeDasharray = String(CIRC);
  $('#timer-fill').style.strokeDashoffset = String(CIRC * (1 - frac));

  const urgent = app.started && !app.animating && secs <= 5 && !view.you.locked && frac < 1;
  ring.classList.toggle('urgent', urgent);
  if (urgent && secs !== app.lastTick && secs > 0) {
    app.lastTick = secs;
    sound.play('tick');
  }
  if (!urgent) app.lastTick = -1;
}

function planningAllowed(view) {
  return (
    app.started &&
    !app.animating &&
    !app.host.isPresenting() &&
    view.status === 'PLAYING' &&
    !view.you.locked
  );
}

/* ------------------------------------------------------------------ *
 * Bidding — the board IS the control
 * ------------------------------------------------------------------ */

function onBoardClick(e) {
  const cell = e.target.closest('.cell');
  if (!cell || !cell.dataset.dir) return;
  stake(cell.dataset.dir);
}

/**
 * Drop a coin toward `dir`. If coins are already committed the OTHER way, the
 * click takes one of those back instead. Nobody ever wants to pay to pull in
 * two opposite directions at once, so this reads as a natural undo.
 */
function stake(dir) {
  const view = app.host.getView(app.seat);
  if (!planningAllowed(view)) return;

  const bid = { ...view.you.currentBid };
  const opposite = OPPOSITE[dir];
  let removing = false;

  if ((bid[opposite] || 0) > 0) {
    bid[opposite] -= 1;
    removing = true;
  } else {
    if (view.you.currentBidTotal >= view.you.coinsRemaining) {
      sound.play('deny');
      toast('No coins left to place.', 'bad');
      return;
    }
    bid[dir] = (bid[dir] || 0) + 1;
  }

  const r = app.host.stageBid(app.seat, bid);
  if (!r.ok) {
    sound.play('deny');
    if (r.error) toast(r.error, 'bad');
    return;
  }
  sound.play(removing ? 'coinRemove' : 'coinAdd', bid[dir] || 0);
  render();
}

function lockIn() {
  const view = app.host.getView(app.seat);
  if (!planningAllowed(view)) return;
  const r = app.host.lock(app.seat);
  if (!r.ok) {
    sound.play('deny');
    toast(r.error, 'bad');
    return;
  }
  sound.play('lock');
  render();
}

/* ------------------------------------------------------------------ *
 * Resolution — aggregate direction only, never the numbers
 * ------------------------------------------------------------------ */

async function playResolution() {
  const res = app.host.getLastResolution();
  if (!res) return;
  app.animating = true;

  const view = app.host.getView(app.seat);
  const status = $('#status');

  // Clear the staked coins from the board now that they are spent.
  renderTargets({ ...view, you: { ...view.you, currentBid: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 } } });
  renderPurse(view);
  renderSeatChips(view);

  if (res.tie) {
    sound.play(res.actualDistance === 0 && Object.values(res.totals).every((v) => v === 0) ? 'noMove' : 'cancel');
    status.innerHTML = `<span class="verdict">The queen holds her ground</span>`;
    await wait(UI_TIMING.cancelAnimMs + 500);
  } else {
    sound.play('cancel');
    status.innerHTML = `<span class="verdict">The queen is pulled <b>${DIR_WORD[res.direction]}</b></span>`;
    await wait(UI_TIMING.cancelAnimMs);
    await walkQueen(res);
  }

  if (view.lastResolution?.yourBonusCollected) {
    const claimed = $('.bonus-mark', $('#board-overlay'));
    if (claimed) claimed.classList.add('claimed');
    sound.play('bonus');
    toast(`Treasure claimed — ${view.lastResolution.yourBonusCollected.reward} coins`, 'gold');
    await wait(600);
  }

  await wait(UI_TIMING.resolutionHoldMs);

  const after = app.host.getView(app.seat);
  if (after.status === 'FINISHED') {
    app.animating = false;
    sound.play('victory');
    await wait(700);
    showResult();
    return;
  }
  app.animating = false;
  status.innerHTML = '';
  render();
}

/** Slow, deliberate, one cell at a time. */
function walkQueen(res) {
  return new Promise((resolve) => {
    const queen = ensureQueen($('#board-overlay'));
    if (!res.path.length) return resolve();

    const perStep = Math.max(90, UI_TIMING.travelMsPerCell - res.path.length * 8);
    let i = 0;

    const step = () => {
      if (i >= res.path.length) {
        queen.classList.remove('stepping');
        if (res.blockedByBoundary) {
          sound.play('wall');
          flashWall(res.direction);
        }
        return resolve();
      }
      const p = res.path[i];
      placeMarker(queen, p);
      queen.classList.remove('stepping');
      void queen.offsetWidth;
      queen.classList.add('stepping');
      sound.play('step', i);
      i++;
      setTimeout(step, perStep);
    };
    setTimeout(step, 160);
  });
}

function flashWall(dir) {
  const flash = $('#wall-flash');
  const thick = '10%';
  flash.style.cssText = '';
  const grad = (deg) => `linear-gradient(${deg}, rgba(255,205,110,.9), transparent)`;
  if (dir === 'UP') Object.assign(flash.style, { top: 0, left: 0, right: 0, height: thick, background: grad('180deg') });
  if (dir === 'DOWN') Object.assign(flash.style, { bottom: 0, left: 0, right: 0, height: thick, background: grad('0deg') });
  if (dir === 'LEFT') Object.assign(flash.style, { left: 0, top: 0, bottom: 0, width: thick, background: grad('90deg') });
  if (dir === 'RIGHT') Object.assign(flash.style, { right: 0, top: 0, bottom: 0, width: thick, background: grad('270deg') });
  flash.classList.remove('fire');
  void flash.offsetWidth;
  flash.classList.add('fire');
}

/* ------------------------------------------------------------------ *
 * Result + replay movie
 * ------------------------------------------------------------------ */

function showResult() {
  const reveal = app.host.getReveal();
  app.reveal = reveal;
  showScreen('screen-result');

  const seat = reveal.winner;
  const winnerSeat = reveal.players[seat];
  const line = $('#winner-line');
  line.style.setProperty('--seat', SEAT_COLORS[seat]);
  $('#winner-avatar').innerHTML = winnerSeat.controlMode === CONTROL_MODE.HUMAN ? ART.human : ART.bot;
  $('#winner-text').textContent = seat === app.seat ? 'You win' : `${winnerSeat.displayName} wins`;

  $('#stat-rounds').textContent = reveal.roundsPlayed;
  $('#stat-cells').textContent = reveal.completeQueenPath.length - 1;
  $('#stat-bonus').textContent = reveal.bonusLedger.filter((b) => b.outcome === 'COLLECTED').length;

  buildGrid($('#replay-cells'), $('#replay-board'), reveal.board.width, reveal.board.height, null);
  $('#replay-overlay').innerHTML = '';
  $('#replay-path').innerHTML = '';

  const slider = $('#replay-slider');
  slider.max = String(reveal.roundLog.length);
  slider.value = slider.max;
  slider.oninput = () => {
    stopReplay();
    drawReplayFrame(Number(slider.value));
  };

  drawReplayFrame(reveal.roundLog.length);
  setTimeout(() => runReplay(), 700);
}

/**
 * Draw the board exactly as it stood at the END of round `n`.
 * n = 0 is the opening position. Everything is public here (§18).
 */
function drawReplayFrame(n) {
  const reveal = app.reveal;
  if (!reveal) return;
  const overlay = $('#replay-overlay');
  overlay.innerHTML = '';

  const log = reveal.roundLog;
  const upto = Math.max(0, Math.min(n, log.length));

  // Castles — all four, permanently.
  for (const p of reveal.players) {
    const mark = el('div', 'marker castle-mark', ART.castle(SEAT_COLORS[p.seat]));
    mark.style.color = SEAT_COLORS[p.seat];
    placeMarker(mark, p.castlePosition);
    if (p.seat === reveal.winner && upto === log.length) mark.classList.add('mine', 'win');
    overlay.appendChild(mark);
  }

  // Treasure stacks as they stood entering the next round, ringed in the
  // colour of the player they belonged to.
  const frame = log[Math.min(upto, log.length - 1)];
  const bonusSet = upto === 0 ? log[0]?.bonuses : frame?.bonuses;
  for (const b of bonusSet || []) {
    if (!b || b.reward <= 0) continue;
    const mark = el('div', 'marker bonus-mark');
    mark.style.setProperty('--seat', SEAT_COLORS[b.seat]);
    mark.innerHTML = `<div class="bonus-ring"></div><div class="bonus-pile">${ART.treasure}<span class="value num">${b.reward}</span></div>`;
    placeMarker(mark, b.position);
    overlay.appendChild(mark);
  }

  // Trail up to this point.
  const pts = [reveal.completeQueenPath[0]];
  for (let i = 0; i < upto; i++) pts.push(...log[i].path);
  drawTrail(pts, reveal.board);

  const queen = el('div', 'marker queen');
  queen.id = 'replay-queen';
  queen.innerHTML = `<div class="queen-glow"></div>${ART.queen}`;
  placeMarker(queen, pts[pts.length - 1] || reveal.completeQueenPath[0]);
  overlay.appendChild(queen);

  $('#replay-label').textContent = `${upto} / ${log.length}`;
  $('#replay-slider').value = String(upto);
}

function drawTrail(points, board) {
  const svg = $('#replay-path');
  svg.setAttribute('viewBox', `0 0 ${board.width} ${board.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (!points.length) {
    svg.innerHTML = '';
    return;
  }
  const d = points.map((p) => `${p.c + 0.5},${p.r + 0.5}`).join(' ');
  const start = points[0];
  svg.innerHTML = `
    <polyline points="${d}" fill="none" stroke="rgba(255,225,150,.28)" stroke-width="7"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <polyline points="${d}" fill="none" stroke="rgba(255,238,190,.95)" stroke-width="2.4"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${start.c + 0.5}" cy="${start.r + 0.5}" r="0.22" fill="rgba(10,14,20,.9)"
      stroke="rgba(255,235,175,.95)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`;
}

function runReplay() {
  stopReplay();
  const total = app.reveal.roundLog.length;
  let n = 0;
  drawReplayFrame(0);
  app.replayTimer = setInterval(() => {
    n++;
    drawReplayFrame(n);
    if (n >= total) stopReplay();
  }, UI_TIMING.replayRoundMs);
}

function stopReplay() {
  if (app.replayTimer) clearInterval(app.replayTimer);
  app.replayTimer = null;
}

async function shareResult() {
  const r = app.reveal;
  const who = r.winner === app.seat ? 'I' : r.players[r.winner].displayName;
  const text = `Queen's Tug ${r.gameId} — ${who} won in ${r.roundsPlayed} rounds.\nSame board: ${inviteUrl(r.gameId)}`;
  try {
    if (navigator.share) await navigator.share({ title: "Queen's Tug", text });
    else {
      await navigator.clipboard.writeText(text);
      toast('Result copied.', 'gold');
    }
  } catch {
    /* dismissed */
  }
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

const openModal = (id) => ($(`#${id}`).hidden = false);
const closeModals = () => $$('.modal').forEach((m) => (m.hidden = true));

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function boot() {
  const params = new URLSearchParams(location.search);
  if (params.has('turbo')) {
    const f = Number(params.get('turbo'));
    setPacing(Number.isFinite(f) && f > 0 ? f : 0.05);
  }

  // Icons
  $('#btn-help').innerHTML = ART.help;
  $('#btn-exit').innerHTML = ART.exit;
  sound.restorePreference();
  refreshSoundIcon();

  // Title
  $('#btn-play').onclick = () => {
    sound.unlock();
    sound.play('press');
    openGame(randomCode());
  };
  $('#btn-join').onclick = () => {
    sound.unlock();
    sound.play('press');
    openModal('modal-join');
    setTimeout(() => $('#join-input').focus(), 60);
  };
  $('#btn-rules').onclick = () => {
    sound.unlock();
    sound.play('press');
    openModal('modal-rules');
  };

  // Join modal
  $('#btn-join-go').onclick = () => {
    const code = $('#join-input').value.trim().toUpperCase();
    if (!code) return;
    closeModals();
    openGame(code.startsWith('QT-') ? code : `QT-${code}`);
  };
  $('#join-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join-go').click();
  });

  // Game
  $('#board-cells').addEventListener('click', onBoardClick);
  $('#btn-lock').onclick = lockIn;
  $('#btn-start').onclick = beginPlay;
  $('#btn-newcode').onclick = () => {
    sound.play('press');
    openGame(randomCode());
  };
  $('#btn-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl(app.code));
      toast('Link copied — send it to your friends.', 'gold');
    } catch {
      toast(inviteUrl(app.code));
    }
  };
  $('#btn-help').onclick = () => openModal('modal-rules');
  $('#btn-sound').onclick = () => {
    sound.toggle();
    refreshSoundIcon();
    if (!sound.isMuted()) sound.play('press');
  };
  $('#btn-exit').onclick = () => {
    stopReplay();
    app.host?.dispose();
    app.unsub?.();
    app.host = null;
    app.started = false;
    showScreen('screen-title');
  };

  // Result
  $('#btn-replay').onclick = () => {
    sound.play('press');
    runReplay();
  };
  $('#btn-again').onclick = () => {
    stopReplay();
    sound.play('press');
    openGame(randomCode());
  };
  $('#btn-share').onclick = shareResult;

  // Modals
  $$('[data-close]').forEach((b) => (b.onclick = closeModals));
  $$('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m) closeModals();
    })
  );

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeModals();
    if ($('#screen-game').hidden) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const map = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT' };
    if (map[e.key]) {
      e.preventDefault();
      stake(map[e.key]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (!app.started) beginPlay();
      else lockIn();
    }
  });

  const joinCode = params.get('game');
  if (joinCode) {
    openGame(joinCode.toUpperCase());
    toast(`Board ${joinCode.toUpperCase()} loaded.`, 'gold');
  } else {
    showScreen('screen-title');
  }
}

function refreshSoundIcon() {
  $('#btn-sound').innerHTML = sound.isMuted() ? ART.soundOff : ART.soundOn;
}

boot();
