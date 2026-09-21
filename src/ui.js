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
import { DIRECTIONS, OPPOSITE, VECTORS, SEAT_COLORS, UI_TIMING, CONTROL_MODE, DEFAULT_CONFIG, setPacing } from './config.js';
import { sound } from './sound.js';
import { connectRoom, multiplayerSupported } from './net.js';

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

/**
 * SVG gradients live in a document-wide id namespace. Four treasure stacks and
 * a queen all declaring `id="tgTop"` meant the browser resolved every fill to
 * whichever element happened to be first in the document — and when the replay
 * cleared and rebuilt the overlay, those references broke and the shapes
 * rendered unfilled. That is the "ghost" queen and the dark treasure. Every
 * instance now mints its own ids.
 */
let artSeq = 0;
const uid = (prefix) => `${prefix}${(artSeq += 1)}`;

const ART = {
  queen: () => {
    const g = uid('qg');
    return `<svg viewBox="0 0 40 46" aria-hidden="true">
    <defs>
      <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fffbf0"/><stop offset=".45" stop-color="#f2d492"/><stop offset="1" stop-color="#b98d33"/>
      </linearGradient>
    </defs>
    <g stroke="#5c4416" stroke-width="1.1" stroke-linejoin="round">
      <path fill="url(#${g})" d="M6 13 3 4l7.5 5L15 1.5 20 8l5-6.5L29.5 9 37 4l-3 9a5 5 0 0 1-1.4 2.4l-1.6 6.6H9L7.4 15.4A5 5 0 0 1 6 13z"/>
      <circle cx="3" cy="4" r="2.2" fill="#fff6dd"/><circle cx="37" cy="4" r="2.2" fill="#fff6dd"/>
      <circle cx="20" cy="6.5" r="2.4" fill="#fff6dd"/>
      <rect x="8" y="21" width="24" height="3.6" rx="1.4" fill="url(#${g})"/>
      <path fill="url(#${g})" d="M11 25h18l2.6 11H8.4z"/>
      <rect x="5" y="36" width="30" height="6" rx="2.2" fill="url(#${g})"/>
    </g>
  </svg>`;
  },

  castle: (color) => `<svg viewBox="0 0 36 34" aria-hidden="true">
    <g stroke="rgba(0,0,0,.55)" stroke-width="1.1" stroke-linejoin="round">
      <path fill="${color}" d="M3 13V5h4.5v3.2H12V5h4.5v3.2H21V5h4.5v3.2H30V5h3v8l2 2.4V32H1V15.4z"/>
      <path fill="rgba(0,0,0,.34)" stroke="none" d="M14.5 22h7v10h-7z"/>
      <path fill="rgba(255,255,255,.22)" stroke="none" d="M3 13h30l2 2.4H1z"/>
    </g>
  </svg>`,

  /**
   * A cast-iron cannonball: dark and heavy, with one cold highlight and a
   * thin gold rim so it belongs to the same treasury as the coins.
   */
  cannonball: () => {
    const body = uid('cb');
    const sheen = uid('cs');
    return `<svg viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <radialGradient id="${body}" cx="38%" cy="34%" r="70%">
        <stop offset="0" stop-color="#5b6170"/><stop offset=".35" stop-color="#2a2e37"/><stop offset=".8" stop-color="#101217"/><stop offset="1" stop-color="#050608"/>
      </radialGradient>
      <radialGradient id="${sheen}" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".45" stop-color="#dfe6f2" stop-opacity=".5"/><stop offset="1" stop-color="#dfe6f2" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="20" cy="37" rx="13" ry="2.6" fill="rgba(0,0,0,.55)"/>
    <circle cx="20" cy="19.5" r="16.5" fill="url(#${body})"/>
    <path d="M6.2 24.5a14.8 14.8 0 0 0 26.9 1.4" fill="none" stroke="rgba(170,185,210,.35)" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M4.6 17.4c4.2 2.4 9.8 3.6 15.4 3.6s11.2-1.2 15.4-3.6" fill="none" stroke="rgba(0,0,0,.5)" stroke-width="1.1"/>
    <path d="M4.8 18.4c4.2 2.4 9.8 3.6 15.2 3.6s11-1.2 15.2-3.6" fill="none" stroke="rgba(255,255,255,.08)" stroke-width=".8"/>
    <ellipse cx="13.2" cy="11.8" rx="5.6" ry="4" fill="url(#${sheen})" transform="rotate(-35 13.2 11.8)"/>
    <circle cx="12.4" cy="11.2" r="1.5" fill="#fff"/>
  </svg>`;
  },

  /** Where a cannonball landed: scorched stone, a blackened pit, cooling embers. */
  crater: () => {
    const g = uid('cr');
    return `<svg viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <radialGradient id="${g}" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#050608"/><stop offset=".4" stop-color="#2b1d12"/><stop offset=".7" stop-color="#7a5430" stop-opacity=".9"/><stop offset="1" stop-color="#7a5430" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path fill="url(#${g})" d="M20 2l3.2 7.4 7.6-4-2.4 8 8.4.8-6.4 5.6 6.8 5-8.4 1.4 2.6 8-7.6-3.6L20 38l-3.8-7.4-7.6 3.6 2.6-8-8.4-1.4 6.8-5-6.4-5.6 8.4-.8-2.4-8 7.6 4z"/>
    <ellipse cx="20" cy="20.6" rx="8.4" ry="7.4" fill="none" stroke="rgba(255,140,60,.45)" stroke-width="1.6"/>
    <ellipse cx="20" cy="20.6" rx="7.4" ry="6.4" fill="#040506" stroke="rgba(170,120,70,.7)" stroke-width="1"/>
    <g fill="#ff9a3c">
      <circle cx="13.5" cy="15" r=".9" opacity=".75"/><circle cx="27" cy="17" r=".7" opacity=".6"/>
      <circle cx="24.5" cy="27" r=".9" opacity=".7"/><circle cx="14" cy="26" r=".6" opacity=".55"/>
    </g>
  </svg>`;
  },

  /** A castle brought down by cannon fire: broken battlements, a split wall. */
  ruin: (color) => `<svg viewBox="0 0 36 34" aria-hidden="true">
    <g stroke="rgba(0,0,0,.6)" stroke-width="1.1" stroke-linejoin="round">
      <path fill="${color}" d="M3 32V17l2-3.5 2.6 1.8L9 11l3.4 3 1.8-5.4 3.6 4.6L19 22l-3 10zM20 32l2.6-8.4 1.4-7 3.5 2.2L29 14l2.4 3.6L35 16.6V32z"/>
      <path fill="rgba(0,0,0,.45)" stroke="none" d="M12 32l1.6-6h3.2L15.4 32z"/>
    </g>
    <path d="M17.8 11.6l1.6 5.2-2 4.4 2.4 3.8-1.4 7" fill="none" stroke="#0b0d12" stroke-width="1.6" stroke-linecap="round"/>
    <g fill="${color}" stroke="rgba(0,0,0,.55)" stroke-width=".8" opacity=".85">
      <path d="M7 31.4l2.4-1.2 1.4 1.6z"/><path d="M26 31.6l2-2 2 2z"/><path d="M31.5 31.5l1.2-1.4 1 1.4z"/>
    </g>
  </svg>`,

  /** The blast itself: a hot white core inside ragged gold-orange rays. */
  blast: () => {
    const g = uid('bl');
    return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <defs>
      <radialGradient id="${g}" cx="50%" cy="50%" r="50%">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".22" stop-color="#fff3c4"/><stop offset=".5" stop-color="#ffb43c"/><stop offset=".78" stop-color="#e2521f" stop-opacity=".75"/><stop offset="1" stop-color="#e2521f" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <path fill="url(#${g})" d="M50 2l7 26 20-19-8 27 28-4-24 16 25 12-28 2 16 24-24-15-2 29-10-27-12 25 1-28-24 13 16-23-27-4 26-11-22-18 28 6-9-27 21 18z"/>
    <circle cx="50" cy="50" r="13" fill="#fffdf2"/>
  </svg>`;
  },

  /** Over a fallen player's icon. */
  fallen: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>`,

  /** A struck gold coin, milled edge and all. */
  coin: () => {
    const g = uid('cf');
    return `<svg viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <radialGradient id="${g}" cx="36%" cy="30%">
        <stop offset="0" stop-color="#fff6d8"/><stop offset=".5" stop-color="#eec867"/><stop offset="1" stop-color="#a97d22"/>
      </radialGradient>
    </defs>
    <circle cx="20" cy="20" r="19" fill="#7d5a17"/>
    <circle cx="20" cy="20" r="19" fill="none" stroke="#5c4416" stroke-width="1.4" stroke-dasharray="1.6 1.6"/>
    <circle cx="20" cy="19.2" r="17" fill="url(#${g})"/>
    <circle cx="20" cy="19.2" r="13.4" fill="none" stroke="#a97d22" stroke-width="1.1" opacity=".65"/>
    <path fill="#8a6420" opacity=".8" d="M13 23.5 11.7 14l4.9 3.5L20 11.4l3.4 6.1 4.9-3.5-1.3 9.5z"/>
  </svg>`;
  },

  /**
   * A neat stack of identical coins seen slightly from above. Every coin is
   * the same size — an uneven pile reads as a mistake rather than as treasure.
   */
  treasure: () => {
    const top = uid('tt');
    const edge = uid('te');
    return `<svg viewBox="0 0 44 44" aria-hidden="true">
    <defs>
      <linearGradient id="${top}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff3cf"/><stop offset=".5" stop-color="#eec867"/><stop offset="1" stop-color="#b58a2c"/>
      </linearGradient>
      <linearGradient id="${edge}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#d9a441"/><stop offset="1" stop-color="#7d5a17"/>
      </linearGradient>
    </defs>
    <g stroke="#5c4416" stroke-width="1.1" stroke-linejoin="round">
      ${[30.5, 25.5, 20.5, 15.5]
        .map(
          (cy) => `<path fill="url(#${edge})" d="M6 ${cy} a16 5.4 0 0 0 32 0 v-3.4 a16 5.4 0 0 1-32 0 z"/>
                   <ellipse cx="22" cy="${cy - 3.4}" rx="16" ry="5.4" fill="url(#${top})"/>`
        )
        .join('')}
      <ellipse cx="22" cy="12.1" rx="10.6" ry="3.4" fill="none" stroke="#b58a2c" stroke-width=".9" opacity=".75"/>
    </g>
  </svg>`;
  },

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
  undo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h9.5a5.5 5.5 0 0 1 0 11H8"/><path d="M7.5 4 4 8l3.5 4"/></svg>`,
  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="3 3" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>`,
  crown: `<svg viewBox="0 0 32 22" aria-hidden="true"><path fill="currentColor" d="M3 20 1 3l8.5 6.2L16 1l6.5 8.2L31 3l-2 17z"/></svg>`,
};

/* ------------------------------------------------------------------ *
 * App state (presentation only)
 * ------------------------------------------------------------------ */

const app = {
  /** The authoritative host when we run it, or a remote proxy when we don't. */
  game: null,
  /**
   * A local authoritative host. Online games no longer use one — the server is
   * the authority — so this is set only for solo and pass-and-play, and when
   * the network is unavailable.
   */
  host: null,
  /** True while we are connected to a game on the server. */
  online: false,
  /** Server-side flag: only one player may start the game or change settings. */
  isHost: true,
  seat: 0,
  /** Order coins were placed, so a single undo is always possible. */
  placements: [],
  /**
   * The bid this seat had on the board when the round closed. The view clears
   * `currentBid` the moment the round resolves, so the readout would otherwise
   * have no way to tell you what YOUR share of the tug was. Captured on every
   * staking gesture, so it is correct even when the timer locks for you.
   */
  stagedBid: null,
  /** Tap-to-aim: the cannonball rack was tapped and the next board tap aims it. */
  aiming: false,
  /** A cannonball being dragged: { from: 'rack' | 'shot', ghost, x0, y0, moved }. */
  aimDrag: null,
  /** Bumped whenever a game is mounted or torn down; in-flight animations
   *  belonging to an older generation abandon themselves. */
  epoch: 0,
  /** When on, empty seats wait for people instead of being filled by bots. */
  humansOnly: false,
  lobby: null,
  code: '',
  animating: false,
  started: false,
  unsub: null,
  replayTimer: null,
  lastBalance: null,
  lastTick: -1,
  reveal: null,
  /** Guest only: the host has gone quiet and we are waiting for it. */
  linkDown: false,
  wallFlashTimer: null,
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
  // The processional belongs to the start screen only.
  if (id === 'screen-title') sound.startTheme();
  else sound.stopTheme();
}

function randomCode() {
  const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

/**
 * Accept a game code however a person types it. The alphabet already excludes
 * the characters people confuse — no 0/O, no 1/I/L — so the only real work is
 * case, stray spaces, and the `QT-` prefix that used to be mandatory. Links
 * shared before it was dropped still work, because the prefix is simply
 * stripped rather than rejected.
 */
function normaliseCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^QT-?/, '');
}

const inviteUrl = (code) => `${location.origin}${location.pathname}?game=${encodeURIComponent(code)}`;

/* ------------------------------------------------------------------ *
 * Reading a round
 *
 * Three things a new player could not previously work out:
 *   1. that the number of coins IS the distance travelled,
 *   2. what happened to the coins they spent,
 *   3. that passing over a castle is not the same as landing on it.
 *
 * All three are answered here, and all three are answered from information
 * this seat already legitimately holds. The landing preview uses nothing but
 * your own staged bid; the tug readout uses `lastResolution.totals`, which
 * §5.1 makes public and which playerView.js already sends to every seat. No
 * hidden field is read, so the information boundary is untouched.
 * ------------------------------------------------------------------ */

const DIR_ARROW = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
/** The two axes. Each is a pair of opposite pulls that cancels against itself. */
const AXES = [
  { a: 'UP', b: 'DOWN' },
  { a: 'LEFT', b: 'RIGHT' },
];

/** Cancel a bid against itself and take the single strongest survivor. */
function netOf(bid = {}) {
  const vertical = (bid.UP || 0) - (bid.DOWN || 0);
  const horizontal = (bid.RIGHT || 0) - (bid.LEFT || 0);
  const surviving = {
    UP: Math.max(0, vertical),
    DOWN: Math.max(0, -vertical),
    RIGHT: Math.max(0, horizontal),
    LEFT: Math.max(0, -horizontal),
  };
  const best = Math.max(surviving.UP, surviving.DOWN, surviving.LEFT, surviving.RIGHT);
  const winners = DIRECTIONS.filter((d) => surviving[d] === best && best > 0);
  return { surviving, direction: winners.length === 1 ? winners[0] : null, distance: winners.length === 1 ? best : 0 };
}

/**
 * Where the queen would finish if THIS SEAT were the only one pulling. It is
 * a preview of your own intent, not a prediction of the round — the whole
 * point of the game is that you cannot predict the round.
 */
function soloProjection(view) {
  const { direction, distance } = netOf(view.you.currentBid);
  if (!direction) return null;

  const v = VECTORS[direction];
  let { r, c } = view.queenPosition;
  const path = [];
  let blocked = false;
  for (let i = 0; i < distance; i++) {
    const nr = r + v.dr;
    const nc = c + v.dc;
    if (nr < 0 || nr >= view.board.height || nc < 0 || nc >= view.board.width) {
      blocked = true;
      break;
    }
    r = nr;
    c = nc;
    path.push(cellAt(r, c));
  }
  return { direction, requested: distance, path, blocked, landing: cellAt(r, c) };
}

const cellAt = (r, c) => ({ r, c });

/**
 * Draw the ghost queen and her stepping stones. Redrawn from scratch on every
 * staking gesture, which is cheap: it is at most a dozen empty divs.
 */
function renderGhost(view, overlay) {
  for (const node of $$('.ghost-queen, .ghost-step', overlay)) node.remove();
  if (!planningAllowed(view)) return;

  const proj = soloProjection(view);
  if (!proj || !proj.path.length) return;

  const castle = view.you.castlePosition;
  const onCastle = proj.landing.r === castle.r && proj.landing.c === castle.c;

  proj.path.slice(0, -1).forEach((p) => {
    const dot = el('div', 'marker ghost-step');
    dot.style.setProperty('--dir', dirVar(proj.direction));
    placeMarker(dot, p);
    overlay.appendChild(dot);
  });

  const ghost = el('div', 'marker ghost-queen', ART.queen());
  ghost.style.setProperty('--dir', dirVar(proj.direction));
  if (onCastle) ghost.classList.add('on-castle');
  if (proj.blocked) ghost.classList.add('blocked');
  ghost.appendChild(
    el(
      'span',
      'ghost-label num',
      onCastle ? 'WIN' : proj.blocked ? `${proj.path.length} · wall` : String(proj.path.length)
    )
  );
  placeMarker(ghost, proj.landing);
  ghost.title = onCastle
    ? 'Unopposed, this lands her on your castle'
    : 'Where she lands if nobody pulls against you';
  overlay.appendChild(ghost);
}

/**
 * The readout's frame: a carved stone cartouche with a gold plaque naming it.
 * Drawn by both states below so the title never blinks between rounds.
 */
const TUG_TITLE = '<span class="tug-title">The Last Tug</span>';

/**
 * Before the first round, and between games. The panel stays in the layout
 * holding its own height rather than being hidden: if it appeared only once
 * the first round resolved, the board above would resize at that moment.
 */
const clearTug = () => {
  const t = $('#tug');
  if (!t) return;
  t.hidden = false;
  t.classList.add('empty');
  t.innerHTML = `${TUG_TITLE}<div class="tug-empty">No moves yet. Stake coins on a direction, then lock in.</div>`;
};

/**
 * The round, read back as a compass — a picture, not a paragraph.
 *
 * The four arms sit exactly where the four stakeable cells sit on the board,
 * so the readout is a picture of the thing the player just tapped. Each arm is
 * a bar growing out of the queen: its length and number are the coins pulled
 * that way, and the hatched part nearest the queen is your own share. The hub is
 * the queen herself and shows the outcome: which way she went and how far,
 * with a red bar when a wall stopped her short.
 *
 *   lit gold arm  the pull that moved her
 *   dashed arm    equal survivors, so she held her ground
 *   struck arm    survived cancelling but was weaker, so it was thrown away
 *   faded arm     wiped out by the opposite pull
 *
 * Everything here is `lastResolution.totals`, which §5.1 makes public and
 * which playerView.js already sends to every seat. No hidden field is read.
 */
function renderTug(res, myBid, { nearMiss = false } = {}) {
  const tug = $('#tug');
  if (!tug) return;

  const totals = res.totals || {};
  const mine = myBid || {};
  const surviving = res.surviving || netOf(totals).surviving;
  const spent = DIRECTIONS.reduce((s, d) => s + (totals[d] || 0), 0);
  const peak = Math.max(1, ...DIRECTIONS.map((d) => totals[d] || 0));
  /**
   * Your share can never exceed what was pulled that way. If a remembered bid
   * ever disagrees with the public totals, trust the totals rather than draw
   * coins that were not there.
   */
  const yoursOn = (d) => Math.min(mine[d] || 0, totals[d] || 0);
  const youStaked = DIRECTIONS.some((d) => yoursOn(d) > 0);

  const winner = res.tie ? null : res.direction;
  /** Equal survivors: nobody wins, so none of them may be drawn as a loser. */
  const tied = res.tie ? DIRECTIONS.filter((d) => (surviving[d] || 0) > 0) : [];
  /** A surviving pull that still lost, because only the strongest one moves her. */
  const discarded = winner
    ? DIRECTIONS.filter((d) => d !== winner && (surviving[d] || 0) > 0).sort(
        (a, b) => surviving[b] - surviving[a]
      )[0]
    : null;

  const pct = (n) => `${Math.round(n * 1000) / 10}%`;

  /* ---- the arms ---- */

  const arm = (d) => {
    const total = totals[d] || 0;
    const yours = yoursOn(d);
    const cls = ['arm', `arm-${DIR_WORD[d]}`];
    let fate = '';
    if (d === winner) {
      cls.push('won');
      fate = ' — this pull moved her';
    } else if (tied.includes(d)) {
      cls.push('tied');
      fate = ' — equal to another pull, so neither won';
    } else if (d === discarded) {
      cls.push('discarded');
      fate = ' — weaker than the winning pull, so it was discarded';
    } else if (total > 0 && (surviving[d] || 0) === 0) {
      cls.push('cancelled');
      fate = ' — cancelled by the opposite pull';
    }
    if (total === 0) cls.push('idle');
    if (yours > 0) cls.push('mine');

    const title =
      total === 0
        ? `Nobody pulled ${DIR_WORD[d]}`
        : `${total} ${total === 1 ? 'coin' : 'coins'} pulled ${DIR_WORD[d]}${
            yours ? ` (${yours} of them yours)` : ''
          }${fate}`;

    return `<span class="${cls.join(' ')}" style="--dir:${dirVar(d)};--fill:${pct(total / peak)};--you:${pct(
      yours / peak
    )}" title="${title}">
        <span class="arm-fill"></span>
        <span class="arm-you"></span>
        <span class="arm-text"><i>${DIR_ARROW[d]}</i><b class="num">${total}</b></span>
      </span>`;
  };

  /* ---- the hub: where she went ---- */

  let hubCls = 'tug-hub';
  let hubMove = '';
  let hubTitle;
  if (res.finale) {
    hubMove = `<b class="move">${ART.castle(SEAT_COLORS[res.finale.seat])}</b>`;
    hubTitle = 'Only one castle stood, so she went straight to it';
  } else if (res.draw) {
    hubCls += ' still';
    hubTitle = 'No castle was left standing';
  } else if (spent === 0) {
    hubCls += ' still';
    hubTitle = 'Nobody spent a coin, so she stayed put';
  } else if (!winner) {
    hubCls += ' still';
    hubMove = '<b class="num">0</b>';
    hubTitle = 'The pulls cancelled out, so she held her ground';
  } else {
    hubMove = `<b class="move"><i>${DIR_ARROW[winner]}</i><span class="num">${res.actualDistance}</span>${
      res.blockedByBoundary ? '<span class="wall"></span>' : ''
    }</b>`;
    hubTitle = `She moved ${res.actualDistance} ${DIR_WORD[winner]}${
      res.blockedByBoundary ? `, stopped by the wall (${res.requestedDistance - res.actualDistance} lost)` : ''
    }`;
  }

  const compass = `<div class="tug-compass">
      ${DIRECTIONS.map(arm).join('')}
      <span class="${hubCls}" title="${hubTitle}">${ART.crown}${hubMove}</span>
    </div>`;

  /**
   * The only words left on the panel: a key for the hatching, shown when it
   * appears, and — rarely — the rule people most often lose to without
   * noticing. Both sit in the side margins so the compass never moves.
   */
  const key = youStaked
    ? '<span class="tug-key" title="The hatched part of a bar is the coins you staked"><i></i>your coins</span>'
    : '';
  const miss = nearMiss
    ? '<span class="tug-miss" title="She crossed your castle without stopping. She must finish her move on it.">passed your castle</span>'
    : '';

  /** The compass is a picture; screen readers get the same round in words. */
  const summary = [hubTitle + '.'];
  for (const d of DIRECTIONS) if (totals[d]) summary.push(`${totals[d]} pulled ${DIR_WORD[d]}.`);
  if (youStaked) {
    const yours = DIRECTIONS.filter((d) => yoursOn(d) > 0).map((d) => `${yoursOn(d)} ${DIR_WORD[d]}`);
    summary.push(`You staked ${yours.join(' and ')}.`);
  }
  if (nearMiss) summary.push('She crossed your castle without stopping on it.');

  tug.classList.remove('empty');
  tug.innerHTML = `${TUG_TITLE}${compass}${key}${miss}
    <span class="sr-only">${summary.join(' ')}</span>`;
  tug.hidden = false;
}

/**
 * The readout is never wider than the board. The board's size is decided by
 * whichever of width or height binds, which CSS alone cannot hand to a
 * sibling, so its measured width is passed down as a custom property.
 */
function trackBoardWidth() {
  const plate = $('#screen-game .board-plate');
  const tug = $('#tug');
  if (!plate || !tug || typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => {
    const w = plate.getBoundingClientRect().width;
    if (w > 0) tug.style.setProperty('--plate-w', `${Math.round(w)}px`);
  }).observe(plate);
}

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
    q.innerHTML = `<div class="queen-glow"></div>${ART.queen()}`;
    overlay.appendChild(q);
  }
  return q;
}

function placeMarker(node, pos) {
  node.style.setProperty('--r', pos.r);
  node.style.setProperty('--c', pos.c);
}

/* ------------------------------------------------------------------ *
 * Starting a game — solo, hosting, or joining
 * ------------------------------------------------------------------ */

/**
 * Build the authoritative host.
 *
 * `playerCount` matters for humans-only games: the engine is generic over it
 * (castles, treasures, bids, replenishment and locking all iterate the roster
 * rather than assuming four), so a three-person table is a three-seat game
 * with no computer players in it at all — not a four-seat game with a bot
 * quietly filling the gap.
 */
function newLocalHost(code, humanSeats = [0], playerCount = 4) {
  const seats = [];
  for (let i = 0; i < playerCount; i++) {
    seats.push({
      playerId: `seat-${i}`,
      displayName: i === 0 ? 'You' : `Player ${i + 1}`,
      controlMode: humanSeats.includes(i) ? CONTROL_MODE.HUMAN : CONTROL_MODE.AI,
    });
  }
  return createHost({ seed: code, config: { playerCount }, seats });
}

/** Wire whichever game object we have into the board and start listening. */
function mountGame(game, seat) {
  app.epoch++;
  if (app.unsub) app.unsub();
  app.game = game;
  app.seat = seat;
  app.unsub = game.subscribe(onHostEvent);

  const view = game.getView();
  buildGrid($('#board-cells'), $('#board'), view.board.width, view.board.height, view.board.boundaryMargin);
  $('#board-overlay').innerHTML = '';
  $('#path-layer').innerHTML = '';
  $('#pregame').hidden = true;
  clearTug();
  app.lastBalance = null;
  app.placements = [];
  app.stagedBid = null;
  app.started = true;
  app.animating = false;

  showScreen('screen-game');
  sound.play('gameStart');
  render();
}

/** The local host exposes getView(seat); the UI always asks for its own seat. */
function wrapLocal(host, seat) {
  return {
    isRemote: false,
    getView: () => host.getView(seat),
    getPublicSummary: () => host.getPublicSummary(),
    getLastResolution: () => host.getLastResolution(),
    getReveal: () => host.getReveal(),
    isPresenting: () => host.isPresenting(),
    stageBid: (_s, bid) => host.stageBid(seat, bid),
    lock: () => host.lock(seat),
    subscribe: (fn) => host.subscribe(fn),
    dispose: () => host.dispose(),
  };
}

/* ---------------- the start screen doubles as the lobby ---------------- */

/**
 * Reflect the lobby in copy and in whether Start is allowed. With humans-only
 * on, a game cannot begin until at least two people are actually here.
 */
function refreshLobbyState() {
  const lobby = app.lobby || soloLobby();
  const humans = lobby.seats.filter((x) => x.kind === 'human').length;
  const status = $('#room-status');
  const start = $('#btn-room-start');

  // Gating always applies, even while an error notice is on screen.
  start.disabled = app.humansOnly && humans < 2;

  // An error notice outranks the routine status line.
  if (!status.classList.contains('error')) {
    if (app.humansOnly) {
      status.textContent =
        humans < 2
          ? 'Waiting for at least one more player to join. No bots will fill in.'
          : `${humans} players. Start when you are — the game will have ${humans} seats, no bots.`;
    } else {
      status.textContent =
        humans === 1
          ? "Share the code. Empty seats are filled by the court's bots."
          : `${humans} players ready. Start when you are.`;
    }
  }
  renderRoomSeats(lobby, 0);
}

function renderRoomSeats(lobby, mySeat = 0) {
  const box = $('#room-seats');
  const previous = new Set([...box.children].map((c) => c.dataset.kind + c.dataset.seat));
  box.innerHTML = '';
  for (const s of lobby.seats) {
    const chip = el('div', 'seat-chip');
    chip.style.setProperty('--seat', SEAT_COLORS[s.seat]);
    chip.dataset.seat = s.seat;
    chip.dataset.kind = s.kind;
    const open = s.kind !== 'human';
    // 'pending' means the host has not answered yet, so we do not know who is
    // in that seat. Drawing a bot there told every invited player that all four
    // seats were computers, which was simply untrue.
    const unknown = s.kind === 'pending';
    // In humans-only mode an empty seat is a person who has not arrived yet,
    // so it shows a human outline rather than a bot.
    chip.appendChild(el('span', 'avatar', open && !app.humansOnly && !unknown ? ART.bot : ART.human));
    if (unknown) chip.classList.add('unknown');
    if (!open) {
      if (!previous.has('human' + s.seat)) chip.classList.add('joined');
    } else {
      chip.classList.add('waiting');
      if (app.humansOnly) chip.classList.add('open-seat');
    }
    if (s.seat === mySeat) chip.classList.add('is-you');
    chip.title = !open
      ? 'Player'
      : unknown
        ? 'Waiting for the host'
        : app.humansOnly
          ? 'Waiting for a player'
          : "Open seat — one of the court's bots will play it";
    
    box.appendChild(chip);
  }
}

const soloLobby = () => ({
  seats: [0, 1, 2, 3].map((seat) => ({ seat, kind: seat === 0 ? 'human' : 'bot' })),
});

function showCode(code) {
  app.code = code;
  $('#room-code').textContent = code;
}

/**
 * The start screen has two faces. The host can start, change the board and
 * invite. A joiner can only wait or leave — showing them a Start button or a
 * "join with a code" option when they have already joined is just noise.
 */
function setLobbyMode(mode) {
  const hosting = mode === 'host';
  $('#btn-room-start').hidden = !hosting;
  $('#btn-room-newboard').hidden = !hosting;
  $('#btn-join').hidden = !hosting;
  $('#btn-leave-room').hidden = hosting;
  $('#room-status').classList.toggle('waiting', !hosting);
}

/**
 * Enter a game — creating a new one, or joining a code somebody shared.
 *
 * Creating and joining are the same act now. The authoritative game lives on
 * the server, so nobody's browser is special: the first player to arrive is
 * simply granted the right to press Start, and the server says who that is.
 * The old build had to fork here because one browser ran the engine for
 * everybody else.
 *
 * There is deliberately no deadline. Gathering players takes minutes, not
 * seconds: an invite may sit unread, a phone may be locked. The connection
 * stays open indefinitely, reports the stage actually reached, and never flips
 * the player somewhere they did not ask to go.
 */
/** How long to wait for the lobby before giving up and playing the computer. */
const LOBBY_TIMEOUT_MS = 10000;

async function enterRoom(code) {
  leaveRoom();

  app.online = true;
  app.isHost = false;
  app.lobby = null;
  showCode(code);
  setLobbyMode('join');
  $('#room-status').classList.remove('error');
  $('#room-status').textContent = 'Connecting…';

  // Until the server answers we do not know who is at the table. Unknown seats
  // are drawn as outlines, never as bots — telling a player that all four
  // seats are computers when we have not yet asked is simply untrue.
  renderRoomSeats(
    { seats: [{ seat: 0, kind: 'pending' }, ...[1, 2, 3].map((seat) => ({ seat, kind: 'pending' }))] },
    -1
  );

  if (!multiplayerSupported()) {
    goOffline('This browser cannot play online. You can still play against the court’s bots.');
    return;
  }

  let seated = false;

  const remote = connectRoom({
    code,

    onLobby: (lobby) => {
      // The server answered, so the solo fallback is no longer needed.
      clearTimeout(app.joinTimer);
      app.joinTimer = null;

      /**
       * A lobby message while a game is running means the server no longer
       * holds that game — it was redeployed, or the room was torn down after
       * the last player left. The socket will reconnect happily into an empty
       * room and then wait forever for a state that is never coming, so say
       * what happened instead of leaving the player on "Reconnecting…".
       */
      if (app.started) {
        if (!lobby.started && !lobby.inProgress) {
          setTimeout(() => {
            toast('The game server restarted. That game could not be recovered.', 'bad');
            leaveToTitle();
          }, 0);
        }
        return;
      }

      /**
       * The server answered late, after we had already offered solo play.
       * Falling back was a stopgap, not a decision — take the online table
       * back now that there is one.
       */
      if (!app.online) {
        app.online = true;
        app.host?.dispose?.();
        app.host = null;
        app.game = remote;
      }

      app.lobby = lobby;
      app.humansOnly = !!lobby.humansOnly;
      app.isHost = !!lobby.admin;
      $('#chk-humans-only').checked = app.humansOnly;
      $('#room-status').classList.remove('error');

      if (lobby.inProgress) {
        $('#room-status').textContent =
          'That game has already started. Ask for a new code, or start your own board.';
        setLobbyMode('join');
        renderRoomSeats(lobby, -1);
        return;
      }

      const mySeat = Number.isInteger(lobby.yourSeat) ? lobby.yourSeat : -1;
      app.seat = mySeat;

      if (!seated && mySeat >= 0) {
        seated = true;
        sound.play('join');
      }

      // Whoever may press Start sees the host controls. That is decided by the
      // server, not by which browser happened to generate the code.
      setLobbyMode(lobby.admin ? 'host' : 'join');
      renderRoomSeats(lobby, mySeat);
      refreshLobbyState();
    },

    onEvent: (e) => {
      if (e.type === 'error' && e.message) toast(e.message, 'bad');
    },
  });

  app.game = remote;

  /**
   * If the server never answers, fall back to playing the computer rather than
   * leaving a first-time player stranded on "Connecting…" with no Start
   * button. `multiplayerSupported()` only catches a browser with no WebSocket
   * at all; it cannot catch a cold worker, a captive portal, a corporate proxy
   * or a phone that has just lost signal, and net.js retries forever by
   * design. Solo play needs no server, so nobody should have to wait for one.
   */
  clearTimeout(app.joinTimer);
  app.joinTimer = setTimeout(() => {
    if (app.lobby || !app.online) return;
    /**
     * Offer solo play, but do NOT hang up: net.js keeps retrying in the
     * background, and if the server comes back before the player presses
     * Start, `onLobby` above quietly restores the online table. A slow
     * server should cost a first-time player a few seconds, not their game.
     */
    goOffline('Still reaching the game server. Start now to play the court’s bots, or wait a moment.');
  }, LOBBY_TIMEOUT_MS);

  /**
   * The game mounts on the first view that arrives, whoever started it. Both
   * players take this same path now — there is no local branch for the player
   * who created the room.
   */
  const unsub = remote.subscribe(() => {
    if (remote.getView() && $('#screen-game').hidden) {
      unsub();
      sound.stopTheme();
      mountGame(remote, remote.getSeat());
    }
  });
}

/** Creating a game is entering a room nobody is in yet. */
async function prepareHostLobby() {
  await enterRoom(randomCode());
}

/** Joining is entering a room somebody else already opened. */
async function prepareJoinLobby(code) {
  await enterRoom(code);
}

/**
 * The network is unavailable. Solo play against the computer needs no server
 * at all, so the game stays perfectly playable — it just cannot be shared.
 */
function goOffline(message) {
  clearTimeout(app.joinTimer);
  app.joinTimer = null;
  app.online = false;
  app.isHost = true;
  app.lobby = soloLobby();
  if (app.host) app.host.dispose();
  app.host = newLocalHost(app.code);
  setLobbyMode('host');
  $('#room-status').textContent = message;
  $('#room-status').classList.add('error');
  refreshLobbyState();
}

/**
 * The host presses Start.
 *
 * In a normal game any seat still empty is played by the computer, so the
 * four-seat host built in the lobby is already correct.
 *
 * In a humans-only game it is not. The table has to be exactly the people who
 * are actually here, which means two things: the roster is compacted into
 * contiguous seats (a joiner may hold seat 2 while seat 1 sits empty), and the
 * host is rebuilt with `playerCount` equal to the number of players. Both have
 * to happen before `start()`, because castles and treasures are dealt at
 * construction time.
 */
/**
 * Start is pressed.
 *
 * Online, this is a request, not an action: the server builds the game,
 * chooses the seating and deals the castles, then sends everyone their view.
 * We mount when that view arrives, exactly like every other player — which is
 * why there is no local host to construct, no roster to compact and no seats to
 * renumber here any more. The server does all of it, once, for everybody.
 *
 * Offline, there is nobody else to co-ordinate with, so a local host is built
 * and the game plays against the computer as it always has.
 */
function startTheGame() {
  if ($('#btn-room-start').disabled) return;
  sound.unlock();
  sound.stopTheme();
  sound.play('press');

  if (app.online && app.game?.isRemote) {
    if (!app.game.isAdmin()) {
      sound.play('deny');
      toast('Only the player who opened this game can start it.', 'bad');
      return;
    }
    const humans = (app.lobby?.seats || []).filter((s) => s.kind === 'human').length;
    if (app.humansOnly && humans < 2) {
      sound.play('deny');
      toast('A humans-only game needs at least two players.', 'bad');
      return;
    }
    $('#room-status').textContent = 'Dealing the board…';
    app.game.startGame();
    return;
  }

  if (!app.host) app.host = newLocalHost(app.code);
  app.host.start();
  mountGame(wrapLocal(app.host, 0), 0);
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
      app.stagedBid = null;
      app.aiming = false;
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
    /**
     * Guests only. A silent host used to leave the board frozen with no
     * explanation; say so plainly instead, and clear it the moment state
     * starts arriving again.
     */
    case 'link-down':
      app.linkDown = true;
      $('#status').innerHTML = '<span class="verdict">Reconnecting to the host…</span>';
      break;
    case 'link-up':
      if (app.linkDown) {
        app.linkDown = false;
        toast('Reconnected.', 'gold');
      }
      render();
      break;
    /** An intent was never acknowledged. Tell the player rather than silently
     *  showing a coin the host never received. */
    case 'intent-lost':
      toast('That did not reach the host. Try again.', 'bad');
      render();
      break;
    case 'abandoned':
      toast('The game ended: not enough players remain.', 'bad');
      break;
    default:
      render();
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  if (!app.game) return;
  const view = app.game.getView();
  if (!view) return;
  // The round closed, or the last ball is gone: stop aiming.
  if (app.aiming && !canAim(view)) {
    app.aiming = false;
    paintAimCells(null);
  }
  renderSeatChips();
  // While the queen is walking, the board belongs to the animation. Redrawing
  // markers here was making the NEXT round's treasure appear before the queen
  // had finished moving.
  if (!app.animating) {
    renderMarkers(view);
    renderTargets(view);
  }
  renderPurse(view);
  renderAmmo(view);
  renderStatus(view);
  renderTimer();
}

function renderSeatChips() {
  const summary = app.game?.getPublicSummary();
  if (!summary) return;
  const strip = $('#seat-chips');
  strip.innerHTML = '';
  for (const seat of summary.seats) {
    const chip = el('div', 'seat-chip');
    chip.style.setProperty('--seat', SEAT_COLORS[seat.seat]);
    if (seat.seat === app.seat) chip.classList.add('is-you');
    if (app.started) {
      chip.classList.add(seat.locked ? 'locked' : 'pending');
      if (!seat.locked && seat.controlMode === CONTROL_MODE.AI) chip.classList.add('thinking');
    }
    // A retired seat is a person who left a humans-only game. Nobody is
    // playing it, so it must not read as either a live player or a bot.
    if (seat.retired) chip.classList.add('retired');
    // Castle destroyed by cannon fire: still watching, no longer playing.
    if (seat.eliminated) chip.classList.add('fallen');
    chip.appendChild(el('span', 'avatar', seat.controlMode === CONTROL_MODE.HUMAN ? ART.human : ART.bot));
    chip.appendChild(el('span', 'lock-badge', ART.lockClosed));
    if (seat.eliminated) chip.appendChild(el('span', 'fallen-mark', ART.fallen));
    // Identity is carried entirely by colour and icon; the title is for
    // screen readers and hover only.
    chip.title = seat.eliminated
      ? `Castle destroyed — out of the game${seat.seat === app.seat ? ' (you)' : ''}`
      : seat.retired
      ? 'Left the game'
      : `${seat.controlMode === CONTROL_MODE.HUMAN ? 'Player' : 'Computer'}${
          seat.seat === app.seat ? ' (you)' : ''
        }${app.started ? (seat.locked ? ' — locked in' : ' — deciding') : ''}`;
    strip.appendChild(chip);
  }
}

function renderMarkers(view) {
  const overlay = $('#board-overlay');
  // Rebuild everything EXCEPT the queen, which must persist across renders.
  for (const node of $$('.castle-mark, .bonus-mark, .crater-mark, .ruin-mark, .shot-mark', overlay)) node.remove();

  renderCraters(view, overlay);

  // A fallen castle is drawn as rubble with everyone else's, not as yours.
  if (!view.you.eliminated) {
    const castle = el('div', 'marker castle-mark mine', ART.castle(SEAT_COLORS[view.you.seat]));
    castle.style.color = SEAT_COLORS[view.you.seat];
    placeMarker(castle, view.you.castlePosition);
    castle.title = 'Your castle — nobody else can see it';
    overlay.appendChild(castle);
  }

  if (view.you.activeBonus && view.you.activeBonus.reward > 0) {
    const b = view.you.activeBonus;
    const mark = el('div', 'bonus-mark');
    mark.classList.add('marker');
    if (b.reward <= 12) mark.classList.add('fading');
    mark.innerHTML = `<div class="bonus-pile"><div class="glow"></div>${ART.treasure()}<span class="value num">${b.reward}</span></div>`;
    placeMarker(mark, b.position);
    mark.title = 'Your treasure — land exactly here to claim it';
    overlay.appendChild(mark);
  }

  renderShotMark(view, overlay);

  const queen = ensureQueen(overlay);
  if (!app.animating) placeMarker(queen, view.queenPosition);

  // Where your own coins alone would take her. Teaches "coins are distance"
  // without a word of instruction.
  renderGhost(view, overlay);

  // Tapping the queen commits the round. With nothing staked, that is a pass.
  const armed = planningAllowed(view);
  queen.classList.toggle('armed', armed);
  queen.title = armed
    ? view.you.currentBidTotal > 0
      ? 'Tap the queen to lock your bid'
      : 'Tap the queen to pass this round'
    : '';
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
      // The disc was previously empty, which is why staked coins read as a
      // plain coloured box. It carries the struck-coin artwork now.
      stack.appendChild(el('span', 'disc', ART.coin()));
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
  const icon = $('#coin-icon');
  if (icon && !icon.firstChild) icon.innerHTML = ART.coin();
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



function renderStatus(view) {
  const status = $('#status');
  if (!app.started || app.animating) return;

  if (view.you.eliminated) {
    status.innerHTML = 'Your castle has fallen. Watch how the battle ends.';
    return;
  }
  if (app.aiming && canAim(view)) {
    status.innerHTML = 'Tap a cell to aim your cannonball.';
    return;
  }
  if (view.you.locked) {
    const waiting = view.opponents.filter((o) => !o.locked).length;
    status.innerHTML = waiting
      ? `Locked. Waiting for <b>${waiting}</b> ${waiting === 1 ? 'player' : 'players'}…`
      : 'The queen is listening…';
    return;
  }
  if (view.you.coinsRemaining === 0) {
    status.innerHTML = "You're out of coins. Pass. Everyone refills when all four are empty.";
    return;
  }
  if (view.you.currentBidTotal > 0 || view.you.currentBid.shot) {
    status.innerHTML = 'Tap the queen to lock your bid.';
    return;
  }
  status.innerHTML =
    view.you.cannonballs > 0
      ? 'Stake coins to lure the queen. Drag a cannonball to strike others.'
      : 'Stake coins to lure the queen.';
}

function renderTimer() {
  if (!app.game) return;
  const view = app.game.getView();
  if (!view) return;
  const ring = $('#timer');
  const CIRC = 2 * Math.PI * 18;

  let remain = view.config.decisionTimerMs / 1000;
  let frac = 1;

  if (app.started && !app.animating && !app.game.isPresenting() && view.timerDeadline) {
    /**
     * `timerDeadline` is a host wall-clock timestamp. Two devices are rarely
     * within a second of each other, so a guest rendering it against its own
     * clock shows a countdown that is wrong by the skew — sometimes already
     * expired. The offset the transport measures corrects for it.
     */
    const skew = app.game.getClockOffset?.() || 0;
    remain = Math.max(0, (view.timerDeadline - (Date.now() + skew)) / 1000);
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
    !app.game.isPresenting() &&
    view.status === 'PLAYING' &&
    !view.you.locked
  );
}

/* ------------------------------------------------------------------ *
 * Bidding — the board IS the control
 * ------------------------------------------------------------------ */

function onBoardClick(e) {
  const cell = e.target.closest('.cell');
  // Tap-to-aim: the next tap on the board chooses the target, never a coin.
  if (app.aiming) {
    if (cell) aimAt(Number(cell.dataset.r), Number(cell.dataset.c));
    return;
  }
  if (!cell || !cell.dataset.dir) return;
  if (app.suppressClick) {
    app.suppressClick = false;
    return;
  }
  stake(cell.dataset.dir);
}

/**
 * Removing coins. The primary gesture is clicking the opposite direction,
 * which reads naturally because nobody wants to pay to pull both ways at once.
 * When the queen stands against a wall there IS no opposite cell, so a
 * long-press (or right-click) on a stack takes one coin back.
 */
function wireCoinRemoval(root) {
  let timer = null;
  const start = (e) => {
    if (app.aiming) return;
    const cell = e.target.closest?.('.cell');
    if (!cell || !cell.dataset.dir) return;
    timer = setTimeout(() => {
      timer = null;
      app.suppressClick = true;
      undoCoin(cell.dataset.dir);
    }, 420);
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  root.addEventListener('pointerdown', start);
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointerleave', cancel);
  root.addEventListener('pointercancel', cancel);
  root.addEventListener('contextmenu', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || !cell.dataset.dir) return;
    e.preventDefault();
    undoCoin(cell.dataset.dir);
  });
}

/**
 * Drop a coin toward `dir`. If coins are already committed the OTHER way, the
 * click takes one of those back instead — pulling the other way is the natural
 * undo, and nobody ever wants to pay to pull two opposite ways at once.
 *
 * That gesture alone is not enough, though: when the queen stands against a
 * wall the opposite cell does not exist, so there would be no way to take a
 * coin back. The undo control beside the coin balance covers every case.
 */
function stake(dir) {
  const view = app.game.getView();
  if (!planningAllowed(view)) return;

  const bid = { ...view.you.currentBid };
  const opposite = OPPOSITE[dir];

  if ((bid[opposite] || 0) > 0) {
    bid[opposite] -= 1;
    commitBid(bid, { removed: opposite });
    return;
  }
  if (view.you.currentBidTotal >= view.you.coinsRemaining) {
    sound.play('deny');
    toast('No coins left.', 'bad');
    return;
  }
  bid[dir] = (bid[dir] || 0) + 1;
  commitBid(bid, { added: dir });
}

/** Take back a coin: from `preferred` if given, otherwise the last placed. */
function undoCoin(preferred = null) {
  const view = app.game.getView();
  if (!planningAllowed(view) || view.you.currentBidTotal === 0) return;

  const bid = { ...view.you.currentBid };
  // Prefer the genuine last placement; fall back to any direction holding coins
  // so the control always works even after a re-sync.
  let target = preferred && (bid[preferred] || 0) > 0 ? preferred : null;
  for (let i = app.placements.length - 1; target === null && i >= 0; i--) {
    if ((bid[app.placements[i]] || 0) > 0) {
      target = app.placements[i];
      break;
    }
  }
  if (!target) target = DIRECTIONS.find((d) => (bid[d] || 0) > 0);
  if (!target) return;

  bid[target] -= 1;
  commitBid(bid, { removed: target });
}

function commitBid(bid, { added, removed } = {}) {
  const r = app.game.stageBid(app.seat, bid);
  if (!r.ok) {
    sound.play('deny');
    if (r.error) toast(r.error, 'bad');
    return;
  }
  if (added) {
    app.placements.push(added);
    sound.play('coinAdd', bid[added] || 0);
  }
  if (removed) {
    const i = app.placements.lastIndexOf(removed);
    if (i >= 0) app.placements.splice(i, 1);
    sound.play('coinRemove');
  }
  app.stagedBid = { ...bid };
  render();
}

function lockIn() {
  const view = app.game.getView();
  if (!planningAllowed(view)) return;
  const r = app.game.lock(app.seat);
  if (r && !r.ok) {
    sound.play('deny');
    toast(r.error, 'bad');
    return;
  }
  sound.play('lock');
  app.placements = [];
  endAiming();
  render();
}

/* ------------------------------------------------------------------ *
 * Cannon fire — aiming
 *
 * A shot is part of the round's plan: it rides inside the bid as `shot`, is
 * staged and locked with the coins, and the server validates it the same way.
 * Two ways to aim, both always available:
 *   · drag a cannonball from the rack onto a cell (mouse or finger), or
 *   · tap the rack, then tap a cell.
 * An aimed ball sits on its cell with a gold crosshair. Tap it, or drag it
 * off the board, to take it back; drag it to another cell to move it.
 * ------------------------------------------------------------------ */

/** 'three' reads better than '3' in the rules. */
const numberWord = (n) => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);

const sameRC = (a, b) => !!a && !!b && a.r === b.r && a.c === b.c;

function canAim(view) {
  return !!view && planningAllowed(view) && !view.you.eliminated && view.you.cannonballs > 0;
}

/** Mirrors the engine's rule, so the board can show what the server will accept. */
function shotAllowedAt(view, r, c) {
  const m = view.board.boundaryMargin ?? 1;
  if (r < m || c < m || r > view.board.height - 1 - m || c > view.board.width - 1 - m) return false;
  const p = { r, c };
  if (sameRC(p, view.queenPosition)) return false;
  if (sameRC(p, view.you.castlePosition)) return false;
  if (sameRC(p, view.you.activeBonus?.position)) return false;
  if ((view.craters || []).some((q) => sameRC(q, p))) return false;
  return true;
}

function aimAt(r, c) {
  const view = app.game.getView();
  if (!canAim(view)) return endAiming();
  if (!shotAllowedAt(view, r, c)) {
    sound.play('deny');
    toast(aimRefusal(view, r, c), 'bad');
    return;
  }
  endAiming();
  setShot({ r, c });
}

/** Why that cell cannot be aimed at, in the player's words. */
function aimRefusal(view, r, c) {
  const p = { r, c };
  if (sameRC(p, view.you.castlePosition)) return "That's your own castle.";
  if (sameRC(p, view.you.activeBonus?.position)) return "That's your own treasure.";
  if (sameRC(p, view.queenPosition)) return "You can't fire at the queen.";
  if ((view.craters || []).some((q) => sameRC(q, p))) return 'That cell is already a crater.';
  return 'Nothing stands on the edge of the board.';
}

function setShot(target) {
  const view = app.game.getView();
  if (!planningAllowed(view)) return;
  const bid = { ...view.you.currentBid };
  if (target) bid.shot = { r: target.r, c: target.c };
  else delete bid.shot;
  const r = app.game.stageBid(app.seat, bid);
  if (!r.ok) {
    sound.play('deny');
    if (r.error) toast(r.error, 'bad');
    return;
  }
  sound.play(target ? 'cannonLoad' : 'cannonUnload');
  app.stagedBid = { ...bid };
  render();
}

function startAiming() {
  const view = app.game?.getView();
  if (!canAim(view)) return;
  app.aiming = true;
  paintAimCells(view);
  render();
}

function endAiming() {
  const was = app.aiming;
  app.aiming = false;
  paintAimCells(null);
  if (was) render();
}

/** Light the cells a shot may land on; dim everything else. */
function paintAimCells(view) {
  const board = $('#board');
  const on = !!view && (app.aiming || !!app.aimDrag);
  board.classList.toggle('aim-mode', on);
  for (const cell of $$('#board-cells .cell')) {
    cell.classList.toggle('aimable', on && shotAllowedAt(view, Number(cell.dataset.r), Number(cell.dataset.c)));
    cell.classList.remove('aim-hover');
  }
}

/**
 * Your cannonballs, beside your coins: one iron ball and how many are left.
 * The ball itself is the handle — drag it onto the board, or tap it and then
 * tap a cell. A ball aimed this round is already counted as gone.
 */
function renderAmmo(view) {
  const rack = $('#ammo');
  if (!rack) return;
  const total = view.config.cannonballsPerPlayer ?? 0;
  if (!total) {
    rack.hidden = true;
    return;
  }
  rack.hidden = false;
  const left = view.you.cannonballs ?? 0;
  const aimed = !!view.you.currentBid?.shot;
  const ready = Math.max(0, left - (aimed ? 1 : 0));
  const armed = canAim(view);
  rack.classList.toggle('armed', armed && ready > 0);
  rack.classList.toggle('aiming', app.aiming && armed);
  rack.classList.toggle('empty', ready === 0);
  rack.classList.toggle('fallen', !!view.you.eliminated);
  rack.dataset.ready = String(ready);

  if (!rack.firstChild) {
    rack.innerHTML = `<span class="ammo-ball">${ART.cannonball()}</span><span class="ammo-count num"></span>`;
  }
  const count = $('.ammo-count', rack);
  if (count.textContent !== String(ready)) {
    count.textContent = String(ready);
    count.classList.remove('bump');
    void count.offsetWidth;
    count.classList.add('bump');
  }

  rack.title = view.you.eliminated
    ? 'Your castle has fallen'
    : left === 0
    ? 'No cannonballs left'
    : aimed
    ? `Aimed for this round (${ready} left after it) — tap the ball on the board to take it back`
    : armed
    ? `${ready} cannonball${ready === 1 ? '' : 's'} left. Drag one onto a cell, or tap here then tap a cell. One per round.`
    : `${ready} cannonball${ready === 1 ? '' : 's'} left`;
  rack.setAttribute('aria-label', rack.title);
}

function renderCraters(view, overlay) {
  for (const p of view.craters || []) {
    const mark = el('div', 'marker crater-mark', ART.crater());
    placeMarker(mark, p);
    mark.title = 'Crater — a cannonball landed here';
    overlay.appendChild(mark);
  }
  for (const r of view.ruins || []) {
    const mark = el('div', 'marker ruin-mark', ART.ruin(SEAT_COLORS[r.seat]));
    placeMarker(mark, r.position);
    mark.title = r.seat === view.you.seat ? 'Your castle, destroyed' : 'A castle destroyed by cannon fire';
    overlay.appendChild(mark);
  }
}

function renderShotMark(view, overlay) {
  const shot = view.you.currentBid?.shot;
  if (!shot || view.status !== 'PLAYING') return;
  const mark = el('div', 'marker shot-mark', `<span class="crosshair"></span>${ART.cannonball()}`);
  placeMarker(mark, shot);
  const live = planningAllowed(view);
  mark.classList.toggle('live', live);
  mark.title = live ? 'Your cannonball — tap to take it back, or drag it elsewhere' : 'Your cannonball fires when the round resolves';
  overlay.appendChild(mark);
}

/* ---- dragging ---- */

function beginAimDrag(e, from) {
  const view = app.game?.getView();
  if (!canAim(view)) return;
  // An aimed ball can still be re-aimed from the rack; an empty rack cannot.
  if (from === 'rack' && !(Number($('#ammo').dataset.ready) > 0 || view.you.currentBid?.shot)) return;
  e.preventDefault();
  const ghost = el('div', 'drag-ball', ART.cannonball());
  ghost.hidden = true;
  document.body.appendChild(ghost);
  app.aimDrag = { from, ghost, x0: e.clientX, y0: e.clientY, moved: false, pointerId: e.pointerId };
  window.addEventListener('pointermove', moveAimDrag);
  window.addEventListener('pointerup', endAimDrag);
  window.addEventListener('pointercancel', cancelAimDrag);
}

function cellUnder(x, y) {
  const hit = document.elementFromPoint(x, y);
  const cell = hit?.closest?.('#board-cells .cell');
  if (cell) return cell;
  // Markers sit above the cells; fall back to geometry.
  const board = $('#board-cells').getBoundingClientRect();
  if (x < board.left || x > board.right || y < board.top || y > board.bottom) return null;
  const view = app.game.getView();
  const c = Math.floor(((x - board.left) / board.width) * view.board.width);
  const r = Math.floor(((y - board.top) / board.height) * view.board.height);
  return $(`#board-cells .cell[data-r="${r}"][data-c="${c}"]`);
}

function moveAimDrag(e) {
  const d = app.aimDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
  if (!d.moved) {
    d.moved = true;
    d.ghost.hidden = false;
    app.aiming = false;
    paintAimCells(app.game.getView());
    $('.shot-mark', $('#board-overlay'))?.classList.add('lifted');
  }
  d.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  const cell = cellUnder(e.clientX, e.clientY);
  for (const c of $$('#board-cells .cell.aim-hover')) if (c !== cell) c.classList.remove('aim-hover');
  if (cell?.classList.contains('aimable')) cell.classList.add('aim-hover');
}

function endAimDrag(e) {
  const d = app.aimDrag;
  if (!d || e.pointerId !== d.pointerId) return;
  teardownAimDrag();
  if (!d.moved) {
    // A tap, not a drag.
    if (d.from === 'shot') setShot(null);
    else if (app.aiming) endAiming();
    else startAiming();
    return;
  }
  const cell = cellUnder(e.clientX, e.clientY);
  if (cell) {
    aimAt(Number(cell.dataset.r), Number(cell.dataset.c));
    render();
  } else if (d.from === 'shot') {
    setShot(null); // dragged off the board: taken back
  } else {
    render();
  }
}

function cancelAimDrag() {
  teardownAimDrag();
  render();
}

function teardownAimDrag() {
  const d = app.aimDrag;
  if (d?.ghost) d.ghost.remove();
  app.aimDrag = null;
  window.removeEventListener('pointermove', moveAimDrag);
  window.removeEventListener('pointerup', endAimDrag);
  window.removeEventListener('pointercancel', cancelAimDrag);
  paintAimCells(app.aiming ? app.game?.getView() : null);
}

/* ------------------------------------------------------------------ *
 * Resolution — aggregate direction only, never the numbers
 * ------------------------------------------------------------------ */

async function playResolution() {
  const epoch = app.epoch;
  const alive = () => app.game && app.epoch === epoch;
  if (!alive()) return;
  const res = app.game.getLastResolution();
  if (!res) return;
  app.animating = true;

  const view = app.game.getView();
  const status = $('#status');
  const myBid = app.stagedBid;
  /**
   * Spent now. Online, a view can carry a resolution and the next round in
   * one message, so 'round-open' never fires to clear this — and last round's
   * bid would then be reported as this round's. Clear it the moment it is used.
   */
  app.stagedBid = null;

  // Last round's readout belongs to last round. The preview belongs to a bid
  // that has now been spent.
  clearTug();
  for (const node of $$('.ghost-queen, .ghost-step', $('#board-overlay'))) node.remove();

  // Clear the staked coins from the board now that they are spent.
  renderTargets({ ...view, you: { ...view.you, currentBid: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 } } });
  renderPurse(view);
  endAiming();

  // Cannon fire lands first, in front of everyone, before the queen stirs.
  if (res.explosions?.length) {
    await playCannonFire(res, view);
    if (!alive()) return;
  }
  renderSeatChips();

  if (res.draw) {
    sound.play('noMove');
    status.innerHTML = `<span class="verdict">No castle is left standing.</span>`;
    await wait(UI_TIMING.cancelAnimMs + 500);
  } else if (res.finale) {
    sound.play('moveStart');
    status.innerHTML = `<span class="verdict">Only one castle stands. The queen goes to it.</span>`;
    await wait(UI_TIMING.cancelAnimMs + 400);
    await walkQueen(res);
    sound.play('moveEnd');
  } else if (res.tie) {
    // Deliberately unresolved: a stalemate must never sound like progress.
    sound.play('noMove');
    status.innerHTML = `<span class="verdict">The forces cancel. The queen holds her ground.</span>`;
    await wait(UI_TIMING.cancelAnimMs + 500);
  } else {
    sound.play('moveStart');
    status.innerHTML = `<span class="verdict">The queen is pulled <b>${DIR_WORD[res.direction]}</b>.</span>`;
    await wait(UI_TIMING.cancelAnimMs);
    await walkQueen(res);
    if (!res.blockedByBoundary) sound.play('moveEnd');
  }

  if (!alive()) return;

  /**
   * Walking over a castle is not the same as finishing on one, and that is the
   * rule people most often lose to without noticing. It is said once, inside
   * the readout the player is already reading, rather than as a toast that
   * covers the board. Only this seat's own castle is checked, so nothing about
   * anybody else's board is revealed.
   */
  const castle = view.you.castlePosition;
  const passedOver =
    !view.you.eliminated &&
    res.winner === null &&
    res.path.length > 1 &&
    res.path.slice(0, -1).some((p) => p.r === castle.r && p.c === castle.c);
  if (passedOver) {
    const mark = $('.castle-mark', $('#board-overlay'));
    if (mark) {
      mark.classList.remove('near-miss');
      void mark.offsetWidth;
      mark.classList.add('near-miss');
    }
  }

  // The round is now legible: what was pulled, what cancelled, what survived.
  renderTug(res, myBid, { nearMiss: passedOver });

  if (view.lastResolution?.yourBonusCollected) {
    const claimed = $('.bonus-mark', $('#board-overlay'));
    if (claimed) claimed.classList.add('claimed');
    sound.play('bonus');
    toast(`Treasure claimed: +${view.lastResolution.yourBonusCollected.reward} coins`, 'gold');
    await wait(600);
  }

  await wait(UI_TIMING.resolutionHoldMs);
  if (!alive()) return;

  const after = app.game.getView();
  if (after && after.status === 'FINISHED') {
    app.animating = false;
    if (!res.draw) sound.play('victory');
    await wait(700);
    showResult();
    return;
  }
  app.animating = false;
  status.innerHTML = '';
  render();
}

/**
 * The cannonballs land. Every explosion is public, so every player sees the
 * same thing: the blast, the crater it leaves, and any castle it brings down.
 * What they do NOT see is who fired, or whether a crater swallowed somebody's
 * treasure — only that treasure's owner watches it vanish.
 */
async function playCannonFire(res, view) {
  const overlay = $('#board-overlay');
  const plate = $('#screen-game .board-plate');
  const status = $('#status');
  const n = res.explosions.length;
  const lost = view.lastResolution?.yourTreasureDestroyed?.position || null;

  // Your own aimed ball is in the air now.
  for (const m of $$('.shot-mark', overlay)) m.remove();
  status.innerHTML = `<span class="verdict">${
    n === 1 ? 'A cannonball flies…' : `${numberWord(n).replace(/^./, (c) => c.toUpperCase())} cannonballs fly…`
  }</span>`;
  await wait(Math.max(200, UI_TIMING.cancelAnimMs * 0.45));

  res.explosions.forEach((x, i) => {
    setTimeout(() => {
      sound.play('boom');
      plate?.classList.remove('shake');
      void plate?.offsetWidth;
      plate?.classList.add('shake');

      const blast = el('div', 'marker blast-mark', `<span class="shock"></span>${ART.blast()}`);
      placeMarker(blast, x.position);
      overlay.appendChild(blast);
      setTimeout(() => blast.remove(), 1200);

      // The crater is there the moment the smoke clears, and stays.
      setTimeout(() => {
        const crater = el('div', 'marker crater-mark fresh', ART.crater());
        placeMarker(crater, x.position);
        crater.title = 'Crater — a cannonball landed here';
        overlay.appendChild(crater);

        if (x.castleSeat !== null) {
          if (x.castleSeat === app.seat) for (const m of $$('.castle-mark.mine', overlay)) m.remove();
          const ruin = el('div', 'marker ruin-mark fresh', ART.ruin(SEAT_COLORS[x.castleSeat]));
          placeMarker(ruin, x.position);
          overlay.appendChild(ruin);
        }
        if (lost && sameRC(lost, x.position)) {
          for (const m of $$('.bonus-mark', overlay)) m.classList.add('shattered');
        }
      }, 160);
    }, i * 170);
  });

  await wait(n * 170 + 1000);

  const fallen = res.explosions.filter((x) => x.castleSeat !== null).map((x) => x.castleSeat);
  const lines = [];
  if (fallen.includes(app.seat)) lines.push('<b>Your castle has fallen.</b>');
  const others = fallen.filter((s) => s !== app.seat);
  if (others.length) {
    const dots = others.map((s) => `<span class="seat-dot" style="--seat:${SEAT_COLORS[s]}"></span>`).join('');
    lines.push(`${others.length === 1 ? 'A castle falls' : 'Castles fall'}. ${dots} ${others.length === 1 ? 'is' : 'are'} out.`);
  }
  if (lost) lines.push('Your treasure was destroyed.');
  if (!lines.length) lines.push('The smoke clears.');

  if (fallen.length) sound.play('castleFall');
  renderSeatChips();
  status.innerHTML = `<span class="verdict">${lines.join(' ')}</span>`;
  await wait(fallen.length || lost ? 1700 : 700);
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

/**
 * The boundary flash covers a strip of the board along the wall the queen hit.
 * Two rules keep it from stealing input from the cells underneath it:
 *
 *   1. `pointer-events: none`, forced inline as well as in the stylesheet,
 *      because `style.cssText = ''` wipes any inline value set previously.
 *   2. The geometry is torn down once the animation ends, so a faded-out strip
 *      is not left lying across the top row (or first column) of the board.
 *
 * Skipping either one reintroduces the bug where the queen standing against a
 * wall could not be given coins in the directions she *can* still move.
 */
function flashWall(dir) {
  const flash = $('#wall-flash');
  const thick = '10%';
  flash.style.cssText = '';
  flash.style.pointerEvents = 'none';
  const grad = (deg) => `linear-gradient(${deg}, rgba(255,205,110,.9), transparent)`;
  if (dir === 'UP') Object.assign(flash.style, { top: 0, left: 0, right: 0, height: thick, background: grad('180deg') });
  if (dir === 'DOWN') Object.assign(flash.style, { bottom: 0, left: 0, right: 0, height: thick, background: grad('0deg') });
  if (dir === 'LEFT') Object.assign(flash.style, { left: 0, top: 0, bottom: 0, width: thick, background: grad('90deg') });
  if (dir === 'RIGHT') Object.assign(flash.style, { right: 0, top: 0, bottom: 0, width: thick, background: grad('270deg') });
  flash.classList.remove('fire');
  void flash.offsetWidth;
  flash.classList.add('fire');
  clearTimeout(app.wallFlashTimer);
  app.wallFlashTimer = setTimeout(() => {
    flash.classList.remove('fire');
    flash.style.cssText = '';
    flash.style.pointerEvents = 'none';
  }, 700);
}

/* ------------------------------------------------------------------ *
 * Result + replay movie
 * ------------------------------------------------------------------ */

function showResult() {
  if (!app.game) return;
  let reveal;
  try {
    reveal = app.game.getReveal();
  } catch {
    return; // the game was abandoned before the reveal arrived
  }
  app.reveal = reveal;
  showScreen('screen-result');

  const seat = reveal.winner;
  const line = $('#winner-line');
  if (seat === null || seat === undefined) {
    // The last castles fell together. Nobody is left to take the throne.
    line.style.setProperty('--seat', 'var(--muted)');
    $('#winner-avatar').innerHTML = ART.crater();
    $('#winner-text').textContent = 'No castle stands. A draw.';
  } else {
    const winnerSeat = reveal.players[seat];
    line.style.setProperty('--seat', SEAT_COLORS[seat]);
    $('#winner-avatar').innerHTML = winnerSeat.controlMode === CONTROL_MODE.HUMAN ? ART.human : ART.bot;
    $('#winner-text').textContent =
      seat === app.seat
        ? 'Your queen has arrived. You win!'
        : (reveal.eliminatedSeats || []).includes(app.seat)
        ? 'Their castle outlasted yours.'
        : 'Claims the throne!';
  }

  // Stats live in the bottom message strip, not in a panel of their own.
  const claimed = reveal.bonusLedger.filter((b) => b.outcome === 'COLLECTED').length;
  const craters = (reveal.craters || []).length;
  $('#result-status').innerHTML =
    `<span class="stat"><b>${reveal.roundsPlayed}</b> rounds</span>` +
    `<span class="stat"><b>${reveal.completeQueenPath.length - 1}</b> cells travelled</span>` +
    `<span class="stat"><b>${claimed}</b> treasure claimed</span>` +
    (craters ? `<span class="stat"><b>${craters}</b> cannonball${craters === 1 ? '' : 's'} landed</span>` : '');

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
function drawReplayFrame(n, partialSteps = null) {
  const reveal = app.reveal;
  if (!reveal) return;
  const overlay = $('#replay-overlay');
  overlay.innerHTML = '';

  const log = reveal.roundLog;
  const upto = Math.max(0, Math.min(n, log.length));

  // Cannon fire up to this point: craters, and the castles they brought down.
  const struck = [];
  for (let i = 0; i < upto; i++) for (const x of log[i].explosions || []) struck.push(x.position);
  for (const p of struck) {
    const crater = el('div', 'marker crater-mark', ART.crater());
    placeMarker(crater, p);
    overlay.appendChild(crater);
  }

  // Castles — all of them, permanently; rubble once they have fallen.
  for (const p of reveal.players) {
    const fell = struck.some((q) => sameRC(q, p.castlePosition));
    const mark = fell
      ? el('div', 'marker ruin-mark', ART.ruin(SEAT_COLORS[p.seat]))
      : el('div', 'marker castle-mark', ART.castle(SEAT_COLORS[p.seat]));
    mark.style.color = SEAT_COLORS[p.seat];
    placeMarker(mark, p.castlePosition);
    if (!fell && p.seat === reveal.winner && upto === log.length) mark.classList.add('mine', 'win');
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
    mark.innerHTML = `<div class="bonus-ring"></div><div class="bonus-pile">${ART.treasure()}<span class="value num">${b.reward}</span></div>`;
    placeMarker(mark, b.position);
    overlay.appendChild(mark);
  }

  // Trail up to this point, optionally part-way through the current round.
  const pts = [reveal.completeQueenPath[0]];
  for (let i = 0; i < upto; i++) pts.push(...log[i].path);
  if (partialSteps !== null && log[upto]) pts.push(...log[upto].path.slice(0, partialSteps));
  drawTrail(pts, reveal.board);

  const queen = el('div', 'marker queen solid');
  queen.id = 'replay-queen';
  queen.innerHTML = `<div class="queen-glow"></div><div class="queen-plinth"></div>${ART.queen()}`;
  placeMarker(queen, pts[pts.length - 1] || reveal.completeQueenPath[0]);
  overlay.appendChild(queen);

  $('#replay-label').textContent = `${upto} / ${log.length}`;
  if (partialSteps === null) $('#replay-slider').value = String(upto);
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

/**
 * Play the game back as a film. Each round is one beat, but the queen glides
 * cell by cell within it rather than teleporting, so the trail draws smoothly.
 */
function runReplay() {
  stopReplay();
  const log = app.reveal.roundLog;
  let round = 0;
  let stepInRound = 0;
  drawReplayFrame(0);

  app.replayTimer = setInterval(() => {
    if (round >= log.length) return stopReplay();
    const steps = log[round].path.length;
    if (stepInRound < steps) {
      stepInRound++;
      drawReplayFrame(round, stepInRound);
    } else {
      round++;
      stepInRound = 0;
      drawReplayFrame(round);
    }
  }, UI_TIMING.replayStepMs);
}

function stopReplay() {
  if (app.replayTimer) clearInterval(app.replayTimer);
  app.replayTimer = null;
}

/**
 * Paint the finished board onto a canvas so the result can be shared as a
 * picture, not just a line of text.
 */
function renderResultImage() {
  const r = app.reveal;
  const S = 900;
  const pad = 60;
  const footer = 120;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S + footer;
  const ctx = canvas.getContext('2d');
  const cols = r.board.width;
  const rows = r.board.height;
  const cw = (S - pad * 2) / cols;
  const ch = (S - pad * 2) / rows;
  const px = (c) => pad + c * cw;
  const py = (rr) => pad + rr * ch;
  const cx = (c) => px(c) + cw / 2;
  const cy = (rr) => py(rr) + ch / 2;

  ctx.fillStyle = '#0b1018';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // frame
  ctx.strokeStyle = '#d9a441';
  ctx.lineWidth = 3;
  ctx.strokeRect(pad - 12, pad - 12, S - pad * 2 + 24, S - pad * 2 + 24);

  // grid
  ctx.strokeStyle = 'rgba(150,178,220,.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= cols; i++) {
    ctx.beginPath();
    ctx.moveTo(px(i), py(0));
    ctx.lineTo(px(i), py(rows));
    ctx.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    ctx.beginPath();
    ctx.moveTo(px(0), py(i));
    ctx.lineTo(px(cols), py(i));
    ctx.stroke();
  }

  // trail
  const path = r.completeQueenPath;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,225,150,.3)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  path.forEach((p, i) => (i ? ctx.lineTo(cx(p.c), cy(p.r)) : ctx.moveTo(cx(p.c), cy(p.r))));
  ctx.stroke();
  ctx.strokeStyle = '#ffeebe';
  ctx.lineWidth = 4;
  ctx.stroke();

  // craters
  for (const p of r.craters || []) {
    ctx.fillStyle = 'rgba(58, 42, 26, .9)';
    ctx.beginPath();
    ctx.arc(cx(p.c), cy(p.r), Math.min(cw, ch) * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#050608';
    ctx.beginPath();
    ctx.arc(cx(p.c), cy(p.r), Math.min(cw, ch) * 0.24, 0, Math.PI * 2);
    ctx.fill();
  }

  // castles
  for (const p of r.players) {
    ctx.fillStyle = SEAT_COLORS[p.seat];
    const x = cx(p.castlePosition.c);
    const y = cy(p.castlePosition.r);
    const s2 = Math.min(cw, ch) * 0.62;
    const fell = (r.eliminatedSeats || []).includes(p.seat);
    ctx.globalAlpha = fell ? 0.45 : 1;
    ctx.fillRect(x - s2 / 2, y - s2 / 2, s2, s2);
    ctx.globalAlpha = 1;
    if (fell) {
      ctx.strokeStyle = '#0b0d12';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x - s2 / 2, y - s2 / 2);
      ctx.lineTo(x + s2 / 2, y + s2 / 2);
      ctx.moveTo(x + s2 / 2, y - s2 / 2);
      ctx.lineTo(x - s2 / 2, y + s2 / 2);
      ctx.stroke();
    }
    if (p.seat === r.winner) {
      ctx.strokeStyle = '#ffeebe';
      ctx.lineWidth = 3.5;
      ctx.strokeRect(x - s2 / 2 - 5, y - s2 / 2 - 5, s2 + 10, s2 + 10);
    }
  }

  // start marker
  const st = path[0];
  ctx.strokeStyle = '#ffeebe';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx(st.c), cy(st.r), Math.min(cw, ch) * 0.3, 0, Math.PI * 2);
  ctx.stroke();

  // footer
  ctx.fillStyle = '#f7dda0';
  ctx.font = '700 40px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.fillText("QUEEN'S TUG", S / 2, S + 46);
  ctx.fillStyle = '#98a5ba';
  ctx.font = '26px Georgia, serif';
  const claimed = r.bonusLedger.filter((b) => b.outcome === 'COLLECTED').length;
  ctx.fillText(
    `${r.gameId}  ·  ${r.roundsPlayed} rounds  ·  ${path.length - 1} cells  ·  ${claimed} treasure`,
    S / 2,
    S + 88
  );

  return canvas;
}

async function shareResult() {
  const r = app.reveal;
  const won = r.winner === app.seat;
  const outcome = r.winner === null ? 'every castle fell' : won ? 'I won' : 'the winner took it';
  const text = `Queen's Tug ${r.gameId} — ${outcome} in ${r.roundsPlayed} rounds.\nPlay the same board: ${inviteUrl(r.gameId)}`;

  let file = null;
  try {
    const canvas = renderResultImage();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (blob) file = new File([blob], `queens-tug-${r.gameId}.png`, { type: 'image/png' });
  } catch {
    file = null;
  }

  try {
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ title: "Queen's Tug", text, files: [file] });
      return;
    }
    if (navigator.share) {
      await navigator.share({ title: "Queen's Tug", text });
      return;
    }
  } catch {
    return; // the person dismissed the sheet
  }

  // No share sheet: copy the text and offer the picture as a download.
  try {
    await navigator.clipboard.writeText(text);
    toast('Result copied.', 'gold');
  } catch {
    /* ignore */
  }
  if (file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
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
  trackBoardWidth();
  const params = new URLSearchParams(location.search);
  if (params.has('turbo')) {
    const f = Number(params.get('turbo'));
    setPacing(Number.isFinite(f) && f > 0 ? f : 0.05);
  }

  $('#btn-help').innerHTML = ART.help;
  $('#btn-exit').innerHTML = ART.exit;
  $('#coin-icon').innerHTML = ART.coin();
  $('#btn-rules').innerHTML = ART.help;
  $('#btn-leave-room').innerHTML = ART.exit;
  sound.restorePreference();
  refreshSoundIcon();

  /**
   * Browsers only start audio after a real gesture, and which gesture counts
   * differs between engines — Safari in particular is fussier than Chrome and
   * does not always honour `pointerdown` alone. Listen on every plausible
   * first interaction, and keep listening rather than unbinding after one:
   * a context can be interrupted later and needs waking again.
   *
   * `sound.unlock()` is what permits the AudioContext to be constructed at
   * all, so it must run inside these handlers and nowhere else.
   */
  for (const evt of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'click', 'keydown']) {
    document.addEventListener(
      evt,
      () => {
        sound.unlock();
        if (!$('#screen-title').hidden) sound.startTheme();
      },
      { passive: true, capture: true }
    );
  }

  /** Coming back from a background tab, a phone call or a locked screen. */
  for (const evt of ['visibilitychange', 'focus', 'pageshow']) {
    window.addEventListener(evt, () => {
      if (document.visibilityState === 'hidden') return;
      sound.resumeIfInterrupted();
      if (!$('#screen-title').hidden && !sound.isMuted()) sound.startTheme();
    });
  }

  // ---- start screen ----
  $('#btn-room-start').onclick = startTheGame;
  $('#btn-room-copy').onclick = () => copyLink(app.code);
  $('#btn-room-invite').onclick = () => inviteOthers(app.code);
  $('#chk-humans-only').onchange = (e) => {
    app.humansOnly = e.target.checked;
    // The server decides what happens when somebody drops, and it owns the
    // setting for everyone at the table, so it has to be told.
    app.game?.setHumansOnly?.(app.humansOnly);
    refreshLobbyState();
  };
  $('#btn-room-newboard').onclick = () => {
    sound.play('press');
    prepareHostLobby();
  };
  $('#btn-leave-room').onclick = () => {
    sound.play('press');
    leaveRoom();
    prepareHostLobby();
  };
  $('#room-code').onclick = () => copyCode(app.code);
  $('#btn-join').onclick = () => {
    sound.play('press');
    openModal('modal-join');
    setTimeout(() => $('#join-input').focus(), 60);
  };
  for (const id of ['#btn-rules', '#btn-help']) $(id).onclick = () => openModal('modal-rules');
  for (const id of ['#btn-sound', '#btn-sound-title']) {
    $(id).onclick = () => {
      sound.toggle();
      refreshSoundIcon();
      if (!sound.isMuted()) {
        sound.play('press');
        if (!$('#screen-title').hidden) sound.startTheme();
      }
    };
  }

  // ---- join modal ----
  $('#btn-join-go').onclick = () => {
    const code = normaliseCode($('#join-input').value);
    if (!code) return;
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      sound.play('deny');
      toast('A game code is six letters and numbers.', 'bad');
      return;
    }
    closeModals();
    prepareJoinLobby(code);
  };
  $('#join-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join-go').click();
  });

  // ---- board ----
  $('#board-cells').addEventListener('click', onBoardClick);
  wireCoinRemoval($('#board-cells'));

  // ---- cannon fire ----
  $('#ammo').addEventListener('pointerdown', (e) => beginAimDrag(e, 'rack'));
  $('#board-overlay').addEventListener('pointerdown', (e) => {
    if (e.target.closest('.shot-mark.live')) beginAimDrag(e, 'shot');
  });
  // Tapping anywhere but the board or the rack puts the cannonball away.
  document.addEventListener('pointerdown', (e) => {
    if (app.aiming && !e.target.closest('#ammo, #board')) endAiming();
  });
  // The rules say how many cannonballs a player gets; so does config.js.
  for (const n of $$('.cannon-count')) n.textContent = numberWord(DEFAULT_CONFIG.cannonballsPerPlayer);
  $('#board-overlay').addEventListener('click', (e) => {
    const queen = e.target.closest('.queen.armed');
    if (!queen) return;
    // Belt and braces: ignore anything that landed outside her own square.
    const box = queen.getBoundingClientRect();
    if (box.width && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom)) {
      return;
    }
    lockIn();
  });
  $('#btn-exit').onclick = leaveToTitle;

  // ---- result ----
  $('#btn-replay').onclick = () => {
    sound.play('press');
    runReplay();
  };
  $('#btn-again').onclick = leaveToTitle;
  $('#btn-share').onclick = shareResult;

  // ---- modals ----
  $$('[data-close]').forEach((b) => (b.onclick = closeModals));
  $$('.modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m) closeModals();
    })
  );

  // ---- keyboard ----
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      endAiming();
      return closeModals();
    }
    if (!$('#screen-title').hidden && e.key === 'Enter' && !$('#btn-room-start').hidden) {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      e.preventDefault();
      return startTheGame();
    }
    if ($('#screen-game').hidden) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const map = { ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT' };
    if (map[e.key]) {
      e.preventDefault();
      stake(map[e.key]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      lockIn();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      undoCoin();
    }
  });

  showScreen('screen-title');
  const joinCode = params.get('game');
  if (joinCode) prepareJoinLobby(normaliseCode(joinCode));
  else prepareHostLobby();
}

/** Share a ready-made invitation rather than a bare URL. */
async function inviteOthers(code) {
  /**
   * The code is written into the message as well as into the link. Link
   * previews fail for all sorts of reasons outside our control — a stripped
   * URL, a chat app that does not unfurl, a forwarded screenshot — and when
   * they do, a visible code still lets somebody in through "Join with a code".
   */
  const text =
    `Join my game of Queen's Tug — four hidden castles, one wandering queen.\n` +
    `Tap to take a seat, or enter code ${code}:`;
  const url = inviteUrl(code);
  try {
    if (navigator.share) {
      await navigator.share({ title: "Queen's Tug", text, url });
      return;
    }
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('Invite copied. Send it to your crew.', 'gold');
  } catch {
    /* the person dismissed the sheet */
  }
}

async function copyCode(code) {
  const btn = $('#room-code');
  try {
    await navigator.clipboard.writeText(code);
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1400);
    sound.play('press');
    toast('Code copied.', 'gold');
  } catch {
    toast(code);
  }
}

async function copyLink(code) {
  try {
    await navigator.clipboard.writeText(inviteUrl(code));
    toast('Link copied. Send it to your crew.', 'gold');
  } catch {
    toast(inviteUrl(code));
  }
}

function leaveRoom() {
  if (app.joinTimer) clearTimeout(app.joinTimer);
  app.joinTimer = null;
  if (app.joinWatch) clearInterval(app.joinWatch);
  app.joinWatch = null;
  // Only tear down a lobby connection here. A mounted game owns its own
  // connection and is disposed by leaveToTitle.
  if (app.online && app.game?.isRemote && !app.started) {
    app.game.sayGoodbye?.();
    app.game.dispose?.();
    app.game = null;
  }
  app.online = false;
}

function leaveToTitle() {
  app.epoch++;
  app.animating = false;
  app.linkDown = false;
  stopReplay();
  // A deliberate exit should not make the table wait out a nine-second
  // liveness timeout before the round can resolve.
  app.game?.sayGoodbye?.();
  app.unsub?.();
  app.game?.dispose?.();
  app.game = null;
  app.host?.dispose?.();
  app.host = null;
  app.started = false;
  app.online = false;
  showScreen('screen-title');
  prepareHostLobby();
}

function refreshSoundIcon() {
  const icon = sound.isMuted() ? ART.soundOff : ART.soundOn;
  for (const id of ['#btn-sound', '#btn-sound-title']) {
    const node = $(id);
    if (node) node.innerHTML = icon;
  }
}

boot();

// Exposed for the automated UI tests so every sound recipe can be exercised.
if (typeof window !== 'undefined') window.__qtSound = sound;
