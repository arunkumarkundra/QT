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
  app.lastBalance = null;
  app.placements = [];
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
  renderSeatChips();
  // While the queen is walking, the board belongs to the animation. Redrawing
  // markers here was making the NEXT round's treasure appear before the queen
  // had finished moving.
  if (!app.animating) {
    renderMarkers(view);
    renderTargets(view);
  }
  renderPurse(view);
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
    chip.appendChild(el('span', 'avatar', seat.controlMode === CONTROL_MODE.HUMAN ? ART.human : ART.bot));
    chip.appendChild(el('span', 'lock-badge', ART.lockClosed));
    // Identity is carried entirely by colour and icon; the title is for
    // screen readers and hover only.
    chip.title = seat.retired
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
    mark.innerHTML = `<div class="bonus-pile"><div class="glow"></div>${ART.treasure()}<span class="value num">${b.reward}</span></div>`;
    placeMarker(mark, b.position);
    mark.title = 'Your treasure — land exactly here to claim it';
    overlay.appendChild(mark);
  }

  const queen = ensureQueen(overlay);
  if (!app.animating) placeMarker(queen, view.queenPosition);

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
  status.innerHTML =
    view.you.currentBidTotal > 0
      ? 'Tap the queen to lock your bid.'
      : 'Tap the direction to stake the coins to lure the queen.';
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
  render();
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

  // Clear the staked coins from the board now that they are spent.
  renderTargets({ ...view, you: { ...view.you, currentBid: { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 } } });
  renderPurse(view);
  renderSeatChips();

  if (res.tie) {
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
  const winnerSeat = reveal.players[seat];
  const line = $('#winner-line');
  line.style.setProperty('--seat', SEAT_COLORS[seat]);
  $('#winner-avatar').innerHTML = winnerSeat.controlMode === CONTROL_MODE.HUMAN ? ART.human : ART.bot;
  $('#winner-text').textContent =
    seat === app.seat ? 'Your queen has arrived. You win!' : 'Claims the throne!';

  // Stats live in the bottom message strip, not in a panel of their own.
  const claimed = reveal.bonusLedger.filter((b) => b.outcome === 'COLLECTED').length;
  $('#result-status').innerHTML =
    `<span class="stat"><b>${reveal.roundsPlayed}</b> rounds</span>` +
    `<span class="stat"><b>${reveal.completeQueenPath.length - 1}</b> cells travelled</span>` +
    `<span class="stat"><b>${claimed}</b> treasure claimed</span>`;

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

  // castles
  for (const p of r.players) {
    ctx.fillStyle = SEAT_COLORS[p.seat];
    const x = cx(p.castlePosition.c);
    const y = cy(p.castlePosition.r);
    const s2 = Math.min(cw, ch) * 0.62;
    ctx.fillRect(x - s2 / 2, y - s2 / 2, s2, s2);
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
  const text = `Queen's Tug ${r.gameId} — ${won ? 'I won' : 'the winner took it'} in ${r.roundsPlayed} rounds.\nPlay the same board: ${inviteUrl(r.gameId)}`;

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
    if (e.key === 'Escape') return closeModals();
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
