/**
 * QUEEN'S TUG — User interface (Spec §16, §19)
 *
 * This layer renders state and collects input. It contains NO game rules.
 * Every fact it draws comes from `host.getView(seat)` — a PlayerView — so the
 * browser physically does not hold another player's castle, coins, bonus or
 * bid. Search this file for `castles`, `activeBonuses` or `currentRoundBids`:
 * there are no hits, because the UI has no access to them.
 */

import { createHost, TURN_MODE } from './host.js';
import { DIRECTIONS, SEAT_COLORS, UI_TIMING, CONTROL_MODE, setPacing } from './config.js';
import { aiLabel } from './ai.js';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const DIR_LABEL = { UP: 'Up', DOWN: 'Down', LEFT: 'Left', RIGHT: 'Right' };
const DIR_GLYPH = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
const dirVar = (d) => `var(--${d.toLowerCase()})`;

const GLYPH = {
  queen: `<svg viewBox="0 0 32 40" aria-hidden="true"><defs><linearGradient id="qg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#c9a961"/></linearGradient></defs><path fill="url(#qg)" stroke="#6b5320" stroke-width="1" d="M6 9 4 3l6 4 6-6 6 6 6-4-2 6a4 4 0 0 1-1 3l-2 8h-14l-2-8a4 4 0 0 1-1-3z"/><rect x="9" y="21" width="14" height="3" rx="1" fill="url(#qg)" stroke="#6b5320" stroke-width=".8"/><path fill="url(#qg)" stroke="#6b5320" stroke-width=".8" d="M11 24h10l2 9H9z"/><rect x="6" y="33" width="20" height="5" rx="1.6" fill="url(#qg)" stroke="#6b5320" stroke-width=".8"/></svg>`,
  castle: (color) =>
    `<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="${color}" stroke="rgba(0,0,0,.55)" stroke-width="1" d="M4 12V6h4v3h3V6h4v3h3V6h4v6l2 2v14H2V14z"/><rect x="13" y="20" width="6" height="8" fill="rgba(0,0,0,.45)"/></svg>`,
  crown: `<svg viewBox="0 0 32 24" aria-hidden="true"><path fill="#f4d491" stroke="#7c5c1e" stroke-width="1" d="M3 21 1 4l8 6 7-9 7 9 8-6-2 17z"/></svg>`,
};

function toast(msg, kind = '') {
  const stack = $('#toasts');
  const t = el('div', `toast ${kind}`, msg);
  stack.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .3s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 320);
  }, 2600);
}

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === id));
  // Guarded: not every embedding environment implements scrollTo.
  try {
    window.scrollTo(0, 0);
  } catch {
    /* no-op */
  }
}

/* ------------------------------------------------------------------ *
 * Application state (presentation only — never game rules)
 * ------------------------------------------------------------------ */

const app = {
  host: null,
  /** Which seat this device is currently showing. */
  viewSeat: 0,
  /** Coins added per tap. */
  stakeStep: 1,
  turnMode: TURN_MODE.SIMULTANEOUS,
  humanSeats: [0],
  animating: false,
  unsub: null,
  replayTimer: null,
  setup: {
    mode: 'solo',
    timerMs: 20000,
    startingCoins: 75,
    seatNames: ['You', 'Player 2', 'Player 3', 'Player 4'],
    seatHuman: [true, false, false, false],
    seed: '',
    stalemateValve: false,
  },
};

/* ================================================================== *
 * TITLE + LOBBY
 * ================================================================== */

function initTitle() {
  $('#btn-new').onclick = () => {
    buildLobby();
    showScreen('screen-lobby');
  };
  $('#btn-rules').onclick = () => openModal('modal-rules');
  $('#btn-join').onclick = () => {
    const code = prompt('Enter a game number or invitation code:');
    if (!code) return;
    app.setup.seed = code.trim().toUpperCase();
    buildLobby();
    showScreen('screen-lobby');
    toast(`Board seeded from ${app.setup.seed}. Everyone using this code gets the same board.`, 'gold');
  };
}

function buildLobby() {
  const s = app.setup;
  if (!s.seed) s.seed = randomCode();

  $('#lobby-code').textContent = s.seed;
  $('#invite-url').value = inviteUrl(s.seed);

  // Seats
  const list = $('#seat-list');
  list.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const row = el('div', 'seat-row');
    const pip = el('span', 'seat-pip');
    pip.style.color = SEAT_COLORS[i];
    pip.style.background = SEAT_COLORS[i];

    const name = el('input', 'seat-name');
    name.value = s.seatNames[i];
    name.setAttribute('aria-label', `Name for seat ${i + 1}`);
    name.oninput = () => (s.seatNames[i] = name.value || `Player ${i + 1}`);

    const toggle = el('div', 'toggle');
    const human = el('button', s.seatHuman[i] ? 'is-on' : '', 'Human');
    const ai = el('button', !s.seatHuman[i] ? 'is-on' : '', 'Computer');
    human.onclick = () => {
      s.seatHuman[i] = true;
      buildLobby();
    };
    ai.onclick = () => {
      s.seatHuman[i] = false;
      buildLobby();
    };
    toggle.append(human, ai);

    row.append(pip, name, toggle);
    list.appendChild(row);
  }

  const humans = s.seatHuman.filter(Boolean).length;
  $('#seat-summary').textContent =
    humans === 1
      ? 'One human, three computer players. The computer sees exactly what you see.'
      : `${humans} humans sharing this device, ${4 - humans} computer ${4 - humans === 1 ? 'player' : 'players'}. Each human plans in private behind a handoff screen.`;

  segControl('#seg-timer', [15000, 20000, 30000], s.timerMs, (v) => (s.timerMs = v), (v) => `${v / 1000}s`);
  segControl('#seg-coins', [50, 75, 100], s.startingCoins, (v) => (s.startingCoins = v), (v) => `${v}`);

  $('#chk-valve').checked = s.stalemateValve;
  $('#chk-valve').onchange = (e) => (s.stalemateValve = e.target.checked);

  $('#btn-start').onclick = beginGame;
  $('#btn-back-title').onclick = () => showScreen('screen-title');
  $('#btn-copy-invite').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('#invite-url').value);
      toast('Invitation link copied.', 'gold');
    } catch {
      $('#invite-url').select();
      toast('Press ⌘C or Ctrl+C to copy.');
    }
  };
  $('#btn-reroll').onclick = () => {
    s.seed = randomCode();
    buildLobby();
  };
}

function segControl(sel, values, current, onPick, fmt) {
  const box = $(sel);
  box.innerHTML = '';
  for (const v of values) {
    const b = el('button', v === current ? 'is-on' : '', fmt(v));
    b.onclick = () => {
      onPick(v);
      buildLobby();
    };
    box.appendChild(b);
  }
}

function randomCode() {
  const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return `QT-${out}`;
}

/** §20 — the join token carries no hidden state, only the board seed. */
function inviteUrl(code) {
  const base = location.origin + location.pathname;
  return `${base}?game=${encodeURIComponent(code)}`;
}

/* ================================================================== *
 * GAME START
 * ================================================================== */

function beginGame() {
  const s = app.setup;
  app.humanSeats = [0, 1, 2, 3].filter((i) => s.seatHuman[i]);
  if (app.humanSeats.length === 0) app.humanSeats = [0];
  app.turnMode = app.humanSeats.length > 1 ? TURN_MODE.SEQUENTIAL : TURN_MODE.SIMULTANEOUS;
  app.viewSeat = app.humanSeats[0];

  if (app.host) app.host.dispose();
  if (app.unsub) app.unsub();

  app.host = createHost({
    seed: s.seed,
    turnMode: app.turnMode,
    config: {
      decisionTimerMs: s.timerMs,
      startingCoins: s.startingCoins,
      replenishCoins: s.startingCoins,
      stalemateReplenishRounds: s.stalemateValve ? 3 : null,
    },
    seats: [0, 1, 2, 3].map((i) => ({
      playerId: `seat-${i}`,
      displayName: s.seatNames[i],
      controlMode: s.seatHuman[i] ? CONTROL_MODE.HUMAN : CONTROL_MODE.AI,
    })),
  });

  app.unsub = app.host.subscribe(onHostEvent);
  buildBoard();
  showScreen('screen-game');
  app.host.start();

  if (app.turnMode === TURN_MODE.SEQUENTIAL) {
    openCurtain(app.humanSeats[0], true);
  } else {
    render();
  }
}

function onHostEvent(evt) {
  switch (evt.type) {
    case 'resolution':
      playResolution();
      break;
    case 'round-open':
      app.animating = false;
      $('#resolution').classList.remove('is-open');
      if (app.turnMode === TURN_MODE.SEQUENTIAL) {
        const first = app.host.getActiveSeat();
        if (first !== null) openCurtain(first);
      }
      render();
      break;
    case 'active-seat':
      if (app.turnMode === TURN_MODE.SEQUENTIAL && evt.seat !== null && !app.animating) {
        openCurtain(evt.seat);
      }
      render();
      break;
    case 'finished':
      setTimeout(showReveal, UI_TIMING.resolutionHoldMs + 900);
      break;
    case 'tick':
      renderTimer();
      break;
    default:
      render();
  }
}

/* ================================================================== *
 * BOARD
 * ================================================================== */

function buildBoard() {
  const view = app.host.getView(app.viewSeat);
  const board = $('#board');
  board.style.setProperty('--cols', view.board.width);
  board.style.setProperty('--rows', view.board.height);

  const cells = $('#board-cells');
  cells.innerHTML = '';
  const m = view.board.boundaryMargin;
  for (let r = 0; r < view.board.height; r++) {
    for (let c = 0; c < view.board.width; c++) {
      const cell = el('div', 'cell');
      cell.dataset.r = r;
      cell.dataset.c = c;
      // The outer ring where no castle or bonus may ever sit (§4.1).
      if (r < m || c < m || r >= view.board.height - m || c >= view.board.width - m) {
        cell.classList.add('edge-band');
      }
      cells.appendChild(cell);
    }
  }
  cells.onclick = onBoardClick;
  cells.oncontextmenu = (e) => {
    e.preventDefault();
    onBoardClick(e, true);
  };
}

function cellAt(r, c) {
  return $(`#board-cells .cell[data-r="${r}"][data-c="${c}"]`);
}

function onBoardClick(e, remove = false) {
  const cell = e.target.closest('.cell');
  if (!cell || !cell.classList.contains('bid-target')) return;
  adjustStake(cell.dataset.dir, remove || e.shiftKey ? -app.stakeStep : app.stakeStep);
}

/* ================================================================== *
 * RENDER
 * ================================================================== */

function render() {
  if (!app.host) return;
  const view = app.host.getView(app.viewSeat);

  renderTopbar(view);
  renderMarkers(view);
  renderBidTargets(view);
  renderCompass(view);
  renderPurse(view);
  renderRivals(view);
  renderBonusCard(view);
  renderTimer();
  renderPhase(view);
}

function renderTopbar(view) {
  $('#tb-round').textContent = view.roundNumber;
  $('#tb-game').textContent = view.gameId;
  $('#tb-seat').textContent = view.you.displayName;
  $('#tb-seat').style.color = SEAT_COLORS[view.you.seat];
}

function renderMarkers(view) {
  const layer = $('#board-overlay');
  layer.innerHTML = '';

  // Your castle — and only yours (§5.2, §19).
  const castle = el('div', 'marker castle-mark mine', GLYPH.castle(SEAT_COLORS[view.you.seat]));
  castle.style.setProperty('--r', view.you.castlePosition.r);
  castle.style.setProperty('--c', view.you.castlePosition.c);
  castle.title = 'Your castle — hidden from everyone else';
  layer.appendChild(castle);

  // Your private bonus.
  if (view.you.activeBonus) {
    const b = view.you.activeBonus;
    const mark = el('div', 'marker bonus-mark');
    const coin = el('div', `coin${b.reward === 0 ? ' spent' : ''}`, String(b.reward));
    mark.appendChild(coin);
    mark.style.setProperty('--r', b.position.r);
    mark.style.setProperty('--c', b.position.c);
    mark.title = `Your private bonus — land here for ${b.reward} coins`;
    layer.appendChild(mark);
  }

  // The queen.
  const queen = el('div', 'marker queen');
  queen.id = 'queen';
  queen.innerHTML = `<div class="queen-halo"></div>${GLYPH.queen}`;
  queen.style.setProperty('--r', view.queenPosition.r);
  queen.style.setProperty('--c', view.queenPosition.c);
  layer.appendChild(queen);
}

function renderBidTargets(view) {
  $$('#board-cells .cell').forEach((c) => {
    c.classList.remove('bid-target', 'has-stake');
    c.style.removeProperty('--dir-color');
    delete c.dataset.dir;
    const s = c.querySelector('.cell-stake');
    if (s) s.remove();
  });

  const planning = canPlan(view);
  for (const d of DIRECTIONS) {
    const target = view.adjacent[d];
    if (!target) continue;
    const cell = cellAt(target.r, target.c);
    if (!cell) continue;
    cell.style.setProperty('--dir-color', dirVar(d));
    cell.dataset.dir = d;
    if (planning) cell.classList.add('bid-target');

    const staked = view.you.currentBid[d] || 0;
    if (staked > 0) {
      cell.classList.add('has-stake');
      cell.appendChild(el('div', 'cell-stake', String(staked)));
    }
  }
}

function renderCompass(view) {
  const planning = canPlan(view);
  for (const d of DIRECTIONS) {
    const pad = $(`#pad-${d.toLowerCase()}`);
    const staked = view.you.currentBid[d] || 0;
    const available = !!view.adjacent[d];
    pad.disabled = !planning || !available;
    pad.classList.toggle('staked', staked > 0);
    pad.title = available
      ? `${DIR_LABEL[d]} — ${staked} coin${staked === 1 ? '' : 's'} staked`
      : `No cell ${DIR_LABEL[d].toLowerCase()} of the queen — the board ends here`;
    const stake = pad.querySelector('.stake');
    stake.textContent = available ? staked : '—';
    stake.classList.toggle('zero', staked === 0);
  }
  $('#hub-total').textContent = view.you.currentBidTotal;
  $('#btn-clear').disabled = !planning || view.you.currentBidTotal === 0;
  $('#btn-lock').disabled = !planning;
  $('#btn-lock').textContent = view.you.locked ? 'Locked' : 'Lock bid';
}

function renderPurse(view) {
  $('#purse-amount').textContent = view.you.coinsRemaining;
  $('#purse-staked').textContent = view.you.currentBidTotal;
  $('#purse-alloc').textContent = `Allocation ${view.you.allocationNumber}`;
}

function renderRivals(view) {
  const box = $('#rival-list');
  box.innerHTML = '';
  for (const o of view.opponents) {
    const row = el('div', 'rival');
    const pip = el('span', 'seat-pip');
    pip.style.color = SEAT_COLORS[o.seat];
    pip.style.background = SEAT_COLORS[o.seat];
    row.appendChild(pip);
    row.appendChild(el('span', 'who', o.displayName));
    if (o.controlMode === CONTROL_MODE.AI) {
      row.appendChild(el('span', 'tag ai', o.takeoverReason ? 'Away · AI' : aiLabel(o.seat)));
    } else {
      row.appendChild(el('span', 'tag', 'Human'));
    }
    row.appendChild(el('span', `lock-state${o.locked ? ' locked' : ''}`, o.locked ? '● locked' : '○ planning'));
    box.appendChild(row);
  }

  // §13 — takeover must be explicit.
  const away = view.opponents.filter((o) => o.takeoverReason);
  const banner = $('#takeover-banner');
  banner.classList.toggle('is-open', away.length > 0);
  if (away.length) {
    banner.textContent =
      away.map((o) => o.displayName).join(', ') +
      (away.length === 1 ? ' is away — the computer is playing for them.' : ' are away — the computer is playing for them.');
  }
}

function renderBonusCard(view) {
  const b = view.you.activeBonus;
  const card = $('#bonus-card');
  if (!b) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'flex';
  const face = $('#bonus-face');
  face.textContent = b.reward;
  face.classList.toggle('fading', b.reward <= 5);
  $('#bonus-text').innerHTML =
    b.reward > 0
      ? `Land the queen exactly on <b>row ${b.position.r}, col ${b.position.c}</b> to claim <b>${b.reward}</b> coins. Passing over it collects nothing. The reward drops by one for every cell the queen travels.`
      : `This challenge has decayed to nothing. A new one arrives next round.`;
}

function renderPhase(view) {
  const label = $('#phase-label');
  const sub = $('#phase-sub');

  if (app.animating) {
    label.textContent = 'Resolving';
    sub.textContent = 'Opposing stakes cancel, then the strongest survivor pulls.';
    return;
  }
  if (view.you.locked) {
    label.textContent = 'Locked';
    const waiting = view.opponents.filter((o) => !o.locked).length;
    sub.textContent = waiting ? `Waiting on ${waiting} more ${waiting === 1 ? 'player' : 'players'}.` : 'Resolving now.';
    return;
  }
  label.textContent = 'Plan';
  sub.textContent =
    app.turnMode === TURN_MODE.SEQUENTIAL
      ? `${view.you.displayName} — place your coins, then lock.`
      : 'Place coins on the cells around the queen, then lock.';
}

function renderTimer() {
  if (!app.host) return;
  const view = app.host.getView(app.viewSeat);
  const ring = $('#timer-ring');
  const CIRC = 2 * Math.PI * 22;

  let remain = 0;
  let frac = 0;
  if (app.animating || app.host.isPresenting()) {
    remain = Math.ceil((view.timerDeadline - app.host.presentingUntil()) / 1000);
    frac = 1;
  } else if (view.timerDeadline) {
    remain = Math.max(0, (view.timerDeadline - Date.now()) / 1000);
    frac = Math.max(0, Math.min(1, remain / (view.config.decisionTimerMs / 1000)));
  } else {
    // Paused between turns in pass-and-play — show a full, calm ring.
    remain = view.config.decisionTimerMs / 1000;
    frac = 1;
  }
  $('#timer-digits').textContent = Math.ceil(remain);
  $('#timer-fill').style.strokeDasharray = String(CIRC);
  $('#timer-fill').style.strokeDashoffset = String(CIRC * (1 - frac));
  ring.classList.toggle('urgent', remain <= 5 && !app.animating && !view.you.locked);
}

function canPlan(view) {
  if (app.animating || app.host.isPresenting()) return false;
  if (view.status !== 'PLAYING') return false;
  if (view.you.locked) return false;
  if (app.turnMode === TURN_MODE.SEQUENTIAL && app.host.getActiveSeat() !== view.you.seat) return false;
  return true;
}

/* ================================================================== *
 * BIDDING INPUT — submits intent to the host, never an outcome
 * ================================================================== */

function adjustStake(dir, delta) {
  const view = app.host.getView(app.viewSeat);
  if (!canPlan(view)) return;

  const next = { ...view.you.currentBid };
  next[dir] = Math.max(0, (next[dir] || 0) + delta);

  const total = DIRECTIONS.reduce((s, d) => s + next[d], 0);
  if (total > view.you.coinsRemaining) {
    // Clamp to the balance rather than bouncing the whole placement.
    next[dir] -= total - view.you.coinsRemaining;
    if (next[dir] < 0) next[dir] = 0;
    toast(`You only hold ${view.you.coinsRemaining} coins.`, 'bad');
  }

  const r = app.host.stageBid(app.viewSeat, next);
  if (!r.ok && r.error) toast(r.error, 'bad');
  render();
}

function clearStake() {
  const r = app.host.stageBid(app.viewSeat, { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 });
  if (!r.ok && r.error) toast(r.error, 'bad');
  render();
}

function lockIn() {
  const view = app.host.getView(app.viewSeat);
  if (!canPlan(view)) return;
  const r = app.host.lock(app.viewSeat);
  if (!r.ok) {
    toast(r.error, 'bad');
    return;
  }
  render();
}

/* ================================================================== *
 * RESOLUTION ANIMATION (§19 — aggregate only, no contributors named)
 * ================================================================== */

async function playResolution() {
  app.animating = true;
  const res = app.host.getLastResolution();
  const view = app.host.getView(app.viewSeat);
  if (!res) return;

  const panel = $('#resolution');
  panel.classList.add('is-open');
  $('#resolution-title').textContent = `Round ${res.roundNumber}`;
  renderPhase(view);
  $$('#board-cells .cell').forEach((c) => c.classList.remove('bid-target'));

  const max = Math.max(1, ...DIRECTIONS.map((d) => res.totals[d]));
  const bars = $('#res-bars');
  bars.innerHTML = '';
  const rows = {};
  for (const d of DIRECTIONS) {
    const row = el('div', 'res-row');
    row.style.setProperty('--dir-color', dirVar(d));
    row.innerHTML = `
      <span class="glyph">${DIR_GLYPH[d]}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(res.totals[d] / max) * 100}%"></span></span>
      <span class="val">${res.totals[d]}</span>`;
    bars.appendChild(row);
    rows[d] = row;
  }
  $('#res-verdict').innerHTML = '<span class="small">Opposing stakes cancel…</span>';

  await wait(650);

  // Show the cancellation collapsing each opposed pair down to its survivor.
  for (const d of DIRECTIONS) {
    const surviving = res.surviving[d];
    const row = rows[d];
    row.querySelector('.bar-fill').style.width = `${(surviving / max) * 100}%`;
    row.querySelector('.val').textContent = surviving;
    row.classList.toggle('cancelled', surviving === 0 && res.totals[d] > 0);
  }

  await wait(UI_TIMING.cancelAnimMs);

  // Verdict.
  if (res.tie) {
    const reason =
      Object.values(res.totals).every((v) => v === 0)
        ? 'Nobody spent a coin.'
        : 'Two directions survived with equal force, so the queen holds her ground. Every coin committed is still spent.';
    $('#res-verdict').innerHTML = `The queen does not move.<span class="small">${reason}</span>`;
  } else {
    const d = res.direction;
    let note = `${res.actualDistance} cell${res.actualDistance === 1 ? '' : 's'}.`;
    if (res.blockedByBoundary) {
      const lost = res.requestedDistance - res.actualDistance;
      note = `Stopped at the wall after ${res.actualDistance}. ${lost} step${lost === 1 ? '' : 's'} discarded.`;
    }
    $('#res-verdict').innerHTML =
      `<span style="color:${dirVar(d)}">${DIR_GLYPH[d]} ${DIR_LABEL[d]}</span> survives with ${res.requestedDistance}` +
      `<span class="small">${note}</span>`;
    await animateQueen(res);
  }

  // Private outcome, shown only to the seat it belongs to.
  if (view.lastResolution?.yourBonusCollected) {
    toast(`Bonus claimed — ${view.lastResolution.yourBonusCollected.reward} coins.`, 'gold');
  }

  await wait(UI_TIMING.resolutionHoldMs);
  render();
}

function animateQueen(res) {
  return new Promise((resolve) => {
    const queen = $('#queen');
    if (!queen || !res.path.length) return resolve();
    const stepMs = Math.max(70, UI_TIMING.travelMsPerCell - res.path.length * 4);
    queen.style.setProperty('--step-ms', `${stepMs}ms`);
    queen.classList.add('is-moving');

    let i = 0;
    const step = () => {
      if (i >= res.path.length) {
        queen.classList.remove('is-moving');
        if (res.blockedByBoundary) flashWall(res.direction);
        return resolve();
      }
      const p = res.path[i++];
      queen.style.setProperty('--r', p.r);
      queen.style.setProperty('--c', p.c);
      setTimeout(step, stepMs);
    };
    setTimeout(step, 90);
  });
}

function flashWall(dir) {
  const flash = $('#wall-flash');
  const thick = '9%';
  Object.assign(flash.style, { top: '', bottom: '', left: '', right: '', width: '', height: '' });
  if (dir === 'UP') Object.assign(flash.style, { top: 0, left: 0, right: 0, height: thick, '--flash-dir': '180deg' });
  if (dir === 'DOWN') Object.assign(flash.style, { bottom: 0, left: 0, right: 0, height: thick, '--flash-dir': '0deg' });
  if (dir === 'LEFT') Object.assign(flash.style, { left: 0, top: 0, bottom: 0, width: thick, '--flash-dir': '90deg' });
  if (dir === 'RIGHT') Object.assign(flash.style, { right: 0, top: 0, bottom: 0, width: thick, '--flash-dir': '270deg' });
  flash.classList.remove('fire');
  void flash.offsetWidth;
  flash.classList.add('fire');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * HANDOFF CURTAIN — keeps pass-and-play honest
 * ================================================================== */

function openCurtain(seat, first = false) {
  const summary = app.host.getPublicSummary();
  const who = summary.seats[seat];
  const curtain = $('#curtain');
  const badge = $('#curtain-badge');
  badge.textContent = seat + 1;
  badge.style.background = SEAT_COLORS[seat];
  badge.style.color = '#0d1016';
  $('#curtain-title').textContent = first ? `${who.displayName}, you go first` : `Pass the device to ${who.displayName}`;
  $('#curtain-note').textContent = first
    ? 'Only your castle and your bonus will be shown. Nobody else can see them.'
    : 'Look away until the device is handed over — the next screen shows a private castle and bonus.';
  $('#curtain-go').textContent = `I am ${who.displayName}`;
  $('#curtain-go').onclick = () => {
    // The seat may have moved on while the curtain was up (a timer expiry, or
    // the round resolving). Always defer to the host's current active seat.
    const active = app.host.getActiveSeat();
    const target = active === null ? seat : active;
    curtain.classList.remove('is-open');
    app.viewSeat = target;
    // Only now does this player's decision timer start — handoff time is not
    // thinking time.
    app.host.beginTurn(target);
    buildBoard();
    render();
  };
  curtain.classList.add('is-open');
}

/* ================================================================== *
 * REVEAL (§18)
 * ================================================================== */

function showReveal() {
  const reveal = app.host.getReveal();
  showScreen('screen-reveal');

  $('#reveal-winner').textContent = `${reveal.winnerName} wins`;
  $('#reveal-sub').textContent = `The queen came to rest on their castle at row ${
    reveal.castles[reveal.winner].r
  }, column ${reveal.castles[reveal.winner].c}.`;

  $('#stat-rounds').textContent = reveal.roundsPlayed;
  $('#stat-cells').textContent = reveal.completeQueenPath.length - 1;
  $('#stat-bonuses').textContent = reveal.bonusLedger.filter((b) => b.outcome === 'COLLECTED').length;
  $('#stat-allocs').textContent = Math.max(...reveal.players.map((p) => p.allocationNumber));

  // Legend of every castle, now public.
  const legend = $('#reveal-legend');
  legend.innerHTML = '';
  for (const p of reveal.players) {
    const row = el('div', `legend-row${p.seat === reveal.winner ? ' is-winner' : ''}`);
    const sw = el('span', 'swatch');
    sw.style.background = SEAT_COLORS[p.seat];
    row.append(sw, el('span', '', `${p.displayName}${p.controlMode === 'AI' ? ' · computer' : ''}`));
    row.appendChild(el('span', 'coord', `r${p.castlePosition.r} c${p.castlePosition.c}`));
    legend.appendChild(row);
  }

  buildRevealBoard(reveal);

  $('#btn-replay').onclick = () => runReplay(reveal);
  $('#btn-again').onclick = () => {
    app.setup.seed = randomCode();
    buildLobby();
    showScreen('screen-lobby');
  };
  $('#btn-share').onclick = () => shareResult(reveal);

  const slider = $('#replay-slider');
  slider.max = String(reveal.completeQueenPath.length - 1);
  slider.value = slider.max;
  slider.oninput = () => drawPath(reveal, Number(slider.value));

  drawPath(reveal, reveal.completeQueenPath.length - 1);
}

function buildRevealBoard(reveal) {
  const board = $('#reveal-board');
  board.style.setProperty('--cols', reveal.board.width);
  board.style.setProperty('--rows', reveal.board.height);

  const cells = $('#reveal-cells');
  cells.innerHTML = '';
  for (let r = 0; r < reveal.board.height; r++) {
    for (let c = 0; c < reveal.board.width; c++) cells.appendChild(el('div', 'cell'));
  }

  const layer = $('#reveal-overlay');
  layer.innerHTML = '';
  for (const p of reveal.players) {
    const mark = el('div', 'marker castle-mark', GLYPH.castle(SEAT_COLORS[p.seat]));
    mark.style.setProperty('--r', p.castlePosition.r);
    mark.style.setProperty('--c', p.castlePosition.c);
    mark.title = `${p.displayName}'s castle`;
    if (p.seat === reveal.winner) mark.classList.add('mine');
    layer.appendChild(mark);
  }

  const queen = el('div', 'marker queen');
  queen.id = 'reveal-queen';
  queen.innerHTML = GLYPH.queen;
  layer.appendChild(queen);
}

function drawPath(reveal, upto) {
  const svg = $('#reveal-path');
  const w = reveal.board.width;
  svg.setAttribute('viewBox', `0 0 ${w} ${reveal.board.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const pts = reveal.completeQueenPath.slice(0, upto + 1).map((p) => `${p.c + 0.5},${p.r + 0.5}`).join(' ');
  const start = reveal.completeQueenPath[0];
  svg.innerHTML = `
    <polyline points="${pts}" fill="none" stroke="rgba(255,233,168,.75)" stroke-width="0.13"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"
      style="filter:drop-shadow(0 0 3px rgba(255,220,140,.7))"/>
    <circle cx="${start.c + 0.5}" cy="${start.r + 0.5}" r="0.19" fill="none"
      stroke="rgba(255,233,168,.9)" stroke-width="0.07"/>`;

  const p = reveal.completeQueenPath[upto];
  const queen = $('#reveal-queen');
  if (queen && p) {
    queen.style.setProperty('--r', p.r);
    queen.style.setProperty('--c', p.c);
  }
  $('#replay-step').textContent = `${upto} / ${reveal.completeQueenPath.length - 1}`;
}

function runReplay(reveal) {
  clearInterval(app.replayTimer);
  const slider = $('#replay-slider');
  let i = 0;
  slider.value = '0';
  drawPath(reveal, 0);
  app.replayTimer = setInterval(() => {
    i++;
    if (i >= reveal.completeQueenPath.length) {
      clearInterval(app.replayTimer);
      return;
    }
    slider.value = String(i);
    drawPath(reveal, i);
  }, UI_TIMING.replayStepMs);
}

async function shareResult(reveal) {
  const text =
    `QUEEN'S TUG ${reveal.gameId}\n` +
    `${reveal.winnerName} won in ${reveal.roundsPlayed} rounds.\n` +
    `The queen travelled ${reveal.completeQueenPath.length - 1} cells across a ${reveal.board.width}×${reveal.board.height} board.\n` +
    `Same board: ${inviteUrl(reveal.gameId)}`;
  try {
    if (navigator.share) await navigator.share({ title: "Queen's Tug", text });
    else {
      await navigator.clipboard.writeText(text);
      toast('Result copied to the clipboard.', 'gold');
    }
  } catch {
    /* the person dismissed the share sheet */
  }
}

/* ================================================================== *
 * MODALS + KEYBOARD
 * ================================================================== */

function openModal(id) {
  $(`#${id}`).classList.add('is-open');
}
function closeModals() {
  $$('.modal').forEach((m) => m.classList.remove('is-open'));
}

function initShell() {
  $$('[data-close-modal]').forEach((b) => (b.onclick = closeModals));
  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m) closeModals();
    });
  });

  $('#btn-help').onclick = () => openModal('modal-rules');
  $('#btn-quit').onclick = () => {
    if (confirm('Leave this game and return to the title screen?')) {
      app.host?.dispose();
      app.unsub?.();
      app.host = null;
      showScreen('screen-title');
    }
  };

  for (const d of DIRECTIONS) {
    const pad = $(`#pad-${d.toLowerCase()}`);
    pad.onclick = (e) => adjustStake(d, e.shiftKey ? -app.stakeStep : app.stakeStep);
    pad.oncontextmenu = (e) => {
      e.preventDefault();
      adjustStake(d, -app.stakeStep);
    };
  }
  $('#btn-clear').onclick = clearStake;
  $('#btn-lock').onclick = lockIn;

  $$('#seg-step button').forEach((b) => {
    b.onclick = () => {
      app.stakeStep = Number(b.dataset.step);
      $$('#seg-step button').forEach((x) => x.classList.toggle('is-on', x === b));
    };
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return closeModals();
    if (!app.host || !$('#screen-game').classList.contains('is-active')) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

    const map = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT' };
    if (map[e.key]) {
      e.preventDefault();
      adjustStake(map[e.key], e.shiftKey ? -app.stakeStep : app.stakeStep);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      lockIn();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      clearStake();
    } else if (['1', '2', '3'].includes(e.key)) {
      const steps = { 1: 1, 2: 5, 3: 10 };
      app.stakeStep = steps[e.key];
      $$('#seg-step button').forEach((x) => x.classList.toggle('is-on', Number(x.dataset.step) === app.stakeStep));
    }
  });

  const params = new URLSearchParams(location.search);

  /**
   * `?turbo=N` scales animation and AI-thinking delays. Presentation only —
   * game rules, resolution and timer deadlines are untouched. Handy for fast
   * playtest sessions and required by the automated UI test.
   */
  if (params.has('turbo')) {
    const factor = Number(params.get('turbo'));
    setPacing(Number.isFinite(factor) && factor > 0 ? factor : 0.05);
  }

  // §20 — an invitation link carries only the board seed.
  const joinCode = params.get('game');
  if (joinCode) {
    app.setup.seed = joinCode.toUpperCase();
    buildLobby();
    showScreen('screen-lobby');
    toast(`Joined board ${app.setup.seed}.`, 'gold');
    return;
  }
  showScreen('screen-title');
}

/* ---------------- boot ---------------- */

initShell();
initTitle();
