/**
 * QUEEN'S TUG — Game server (Cloudflare Worker + Durable Object)
 *
 * The authoritative game moved off the players' devices and into here.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * The previous build made one player's browser the authority and connected the
 * others to it directly over WebRTC. That works on a single Wi-Fi network and
 * fails on mobile data: carriers hide every phone behind a shared address that
 * refuses unsolicited inbound connections, so the direct route never forms and
 * neither side ever sees the other. The usual patch is a TURN relay, which
 * means credentials in a public repository and bandwidth that scales with every
 * minute of every game.
 *
 * A server removes the problem rather than working around it. Browsers connect
 * OUTWARD over a WebSocket, which every network on earth permits. There is no
 * NAT to traverse, no relay to pay for and no secret to leak. The game also
 * stops dying when the creator's phone sleeps, because the game is no longer
 * *in* the creator's phone.
 *
 * ── Topology ──────────────────────────────────────────────────────────────
 *
 * One Durable Object per game code. `QT-4UCCQT` resolves to exactly one object,
 * single-threaded, holding one GameState — which is precisely the concurrency
 * model src/host.js already assumes, and why almost no game logic changed.
 *
 *     browser ──┐
 *     browser ──┼──WebSocket──►  GameRoom (Durable Object)
 *     browser ──┘                 └── createHost()  ← the real engine
 *
 * Every player, the creator included, is now just a client holding one
 * PlayerView. That strengthens the §14.1 boundary rather than weakening it:
 * hidden state never leaves Cloudflare's edge, so no player's device holds
 * another player's castle, coins or bid even in memory.
 *
 * Clients send INTENT ('stake two coins left', 'lock'). No message exists that
 * moves the queen, so a tampered client has nothing to forge.
 *
 * ── Cost shape ────────────────────────────────────────────────────────────
 *
 * Durable Objects bill per request and per second of residency. Two decisions
 * keep both small:
 *
 *   1. No polling clock. src/host.js can run without its 10 Hz ticker
 *      (`autoTicker: false`); the deadline is driven by a single alarm instead.
 *      A 10 Hz interval would keep the object resident and billable for the
 *      entire game while doing nothing but reading the clock.
 *   2. No per-tick traffic. Clients render their own countdown from the
 *      absolute `timerDeadline` the server already sent, so a thinking player
 *      costs zero messages.
 *
 * A whole game is a few hundred messages. WebSocket messages bill at 20:1.
 */

import { createHost } from '../src/host.js';
import { CONTROL_MODE, CONNECTION, STATUS } from '../src/config.js';

/**
 * Game codes are the room key, so they are validated before routing. The old
 * `QT-` prefix is accepted and stripped so links shared before it was dropped
 * still resolve to the right room.
 */
const CODE_RE = /^[A-Z0-9]{6}$/;
const normaliseCode = (raw) => (raw || '').toUpperCase().replace(/^QT-/, '').trim();

/**
 * Browsers send an Origin header on the WebSocket handshake, so a page on
 * somebody else's domain cannot quietly point its users at this server and
 * spend the quota. It is not a security boundary against a determined attacker
 * — a non-browser client can send any header it likes — but there is nothing
 * here worth stealing: the server holds no accounts, no payment details and no
 * personal data, and a forged connection can do no more than play a game.
 *
 * ADD YOUR OWN ORIGINS HERE if you ever move the site.
 */
const ALLOWED_ORIGINS = [
  'https://arunkumarkundra.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

/** A frame larger than this is not a bid; it is someone probing. */
const MAX_FRAME_BYTES = 4096;

/** Per socket. Generous for real play — a busy round is a handful of frames. */
const RATE_WINDOW_MS = 10000;
const RATE_MAX_FRAMES = 240;

/** Bursts of host events (stage, lock, resolve) collapse into one push. */
const PUSH_COALESCE_MS = 80;

/**
 * A socket that has not spoken for this long is treated as gone. Clients ping
 * every 10s, so this is three missed pings — long enough to survive a tunnel,
 * short enough that a round is not held up by a phone that left.
 */
const CLIENT_TIMEOUT_MS = 35000;

/** Liveness sweep. Also the safety net if an alarm is ever missed. */
const SWEEP_MS = 10000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: "queen's-tug" });
    }

    if (url.pathname === '/ws') {
      const origin = request.headers.get('Origin');
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        return new Response('This game server only serves its own site.', { status: 403 });
      }
      const code = normaliseCode(url.searchParams.get('code'));
      if (!CODE_RE.test(code)) {
        return new Response('Malformed game code.', { status: 400 });
      }
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('This endpoint expects a WebSocket upgrade.', { status: 426 });
      }
      // idFromName is deterministic: the same code always reaches the same
      // object, from any device, in any region.
      const id = env.GAME_ROOM.idFromName(code);
      return env.GAME_ROOM.get(id).fetch(request);
    }

    return new Response("Queen's Tug game server.", {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * One game. Holds the roster while people gather, the authoritative host once
 * play starts, and nothing at all once everybody has left.
 */
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    this.code = null;
    /** The real engine. Null until the game starts. */
    this.host = null;
    this.unsubscribe = null;

    /**
     * clientId -> { seat, ws, admin, present, lastSeen, ackSeq }
     *
     * Keyed by the browser's durable clientId rather than by socket, so a
     * player who drops and returns is recognised and gets their own seat,
     * castle and coins back.
     */
    this.clients = new Map();

    this.humansOnly = false;
    this.started = false;
    this.finished = false;
    /** Set when a game ended for a reason that is not a win. */
    this.endedReason = null;

    this.pushTimer = null;
    this.lastPushAt = 0;
    this.sweeping = false;
  }

  /* ------------------------------------------------------------------ *
   * Connection
   * ------------------------------------------------------------------ */

  async fetch(request) {
    const url = new URL(request.url);
    this.code = normaliseCode(url.searchParams.get('code'));

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // The socket is anonymous until it says hello. Nothing is allocated for it
    // before then — that is what stops a bare connection from claiming a seat,
    // which in the WebRTC build produced a phantom extra player.
    let clientId = null;
    let windowStart = Date.now();
    let framesThisWindow = 0;

    server.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : '';

      // A frame this large is not a bid. Drop the connection rather than
      // spend time parsing it.
      if (data.length > MAX_FRAME_BYTES) {
        try {
          server.close(1009, 'Frame too large.');
        } catch {
          /* already closing */
        }
        return;
      }

      // Rate limit per socket. Real play is a handful of frames per round, so
      // anything near this ceiling is a script rather than a player.
      const now = Date.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        windowStart = now;
        framesThisWindow = 0;
      }
      if (++framesThisWindow > RATE_MAX_FRAMES) {
        try {
          server.close(1008, 'Too many messages.');
        } catch {
          /* already closing */
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return; // unparseable frames are simply ignored
      }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'hello') {
        // One identity per socket, fixed at the first hello. Without this a
        // single connection could introduce itself repeatedly under different
        // ids and quietly occupy every seat at the table.
        if (clientId) return;
        const id = typeof msg.id === 'string' && /^[\w-]{4,64}$/.test(msg.id) ? msg.id : null;
        if (!id) {
          send(server, { t: 'error', message: 'A player id is required.' });
          return;
        }
        clientId = id;
        this.onHello(clientId, server);
        return;
      }

      if (!clientId) return; // must identify before anything else
      this.onMessage(clientId, msg, server);
    });

    const bye = () => {
      if (clientId) this.onDisconnect(clientId);
    };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);

    this.ensureSweep();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ------------------------------------------------------------------ *
   * Seating
   * ------------------------------------------------------------------ */

  seatLimit() {
    return this.host ? this.host.getPublicSummary().seats.length : 4;
  }

  nextFreeSeat() {
    const taken = new Set([...this.clients.values()].filter((c) => c.present).map((c) => c.seat));
    for (let seat = 0; seat < 4; seat++) if (!taken.has(seat)) return seat;
    return null;
  }

  presentClients() {
    return [...this.clients.entries()]
      .filter(([, c]) => c.present)
      .sort((a, b) => a[1].seat - b[1].seat);
  }

  /**
   * A browser identified itself.
   *
   * Three cases: a returning player takes their own seat back; a new arrival in
   * the lobby gets the next free seat; a new arrival at a game already running
   * is told so plainly rather than left waiting.
   */
  onHello(clientId, ws) {
    const existing = this.clients.get(clientId);

    if (existing) {
      // Replace the socket. A reconnect from a new tab or after a tunnel keeps
      // the same seat because identity is durable, not per-connection.
      if (existing.ws && existing.ws !== ws) {
        try {
          existing.ws.close(1000, 'Replaced by a newer connection.');
        } catch {
          /* already gone */
        }
      }
      const returning = !existing.present;
      existing.ws = ws;
      existing.present = true;
      existing.lastSeen = Date.now();

      if (returning && this.host && !this.finished) {
        // §21 — control comes back to the person, and their castle, coins and
        // treasure are exactly where they left them because the authoritative
        // state never moved.
        this.host.setControl(existing.seat, CONTROL_MODE.HUMAN, {
          connectionStatus: CONNECTION.CONNECTED,
        });
      }
      this.sendWelcome(clientId);
      this.broadcastLobby();
      this.pushViews({ force: true });
      return;
    }

    if (this.started) {
      send(ws, {
        t: 'lobby',
        code: this.code,
        started: true,
        inProgress: true,
        humansOnly: this.humansOnly,
        yourSeat: null,
        admin: false,
        seats: this.lobbySeats(),
      });
      return;
    }

    const seat = this.nextFreeSeat();
    if (seat === null) {
      send(ws, { t: 'error', message: 'This game is full.' });
      // Nothing further can happen on this connection, so do not hold it open.
      try {
        ws.close(1000, 'Game full.');
      } catch {
        /* already closing */
      }
      return;
    }

    // The first player to arrive owns the game: they can start it and choose
    // humans-only. There is no separate notion of a host any more.
    const admin = this.presentClients().length === 0;

    this.clients.set(clientId, {
      seat,
      ws,
      admin,
      present: true,
      lastSeen: Date.now(),
      ackSeq: 0,
    });

    this.sendWelcome(clientId);
    this.broadcastLobby();
  }

  /** Promote someone if the owner leaves before the game starts. */
  ensureAdmin() {
    const present = this.presentClients();
    if (!present.length) return;
    if (present.some(([, c]) => c.admin)) return;
    present[0][1].admin = true;
  }

  /* ------------------------------------------------------------------ *
   * Inbound intents
   * ------------------------------------------------------------------ */

  onMessage(clientId, msg, ws) {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.lastSeen = Date.now();

    switch (msg.t) {
      case 'ping':
        send(ws, { t: 'pong', now: Date.now() });
        return;

      case 'config':
        if (!client.admin || this.started) return;
        this.humansOnly = !!msg.humansOnly;
        this.broadcastLobby();
        return;

      case 'start':
        if (!client.admin) return;
        this.startGame(ws);
        return;

      case 'bid':
      case 'lock': {
        if (!this.host || this.finished) return;
        const seq = Number(msg.seq) || 0;
        /**
         * Intents are re-sent until acknowledged, so applying one twice must be
         * harmless. That is why a bid travels as an absolute placement
         * ('UP:2, LEFT:1') rather than a delta — deltas plus retries would
         * double-charge a player.
         */
        if (seq && seq <= client.ackSeq) {
          send(ws, { t: 'ack', seq: client.ackSeq });
          return;
        }
        if (msg.t === 'bid') this.host.stageBid(client.seat, msg.bid);
        else this.host.lock(client.seat);

        if (seq) client.ackSeq = seq;
        send(ws, { t: 'ack', seq: client.ackSeq });
        this.pushViews();
        return;
      }

      case 'bye':
        this.onDisconnect(clientId, { voluntary: true });
        try {
          ws.close(1000, 'Goodbye.');
        } catch {
          /* already closing */
        }
        return;

      default:
        return;
    }
  }

  /* ------------------------------------------------------------------ *
   * Starting
   * ------------------------------------------------------------------ */

  startGame(ws) {
    if (this.started) return;
    const present = this.presentClients();

    if (this.humansOnly) {
      if (present.length < 2) {
        send(ws, { t: 'error', message: 'A humans-only game needs at least two players.' });
        return;
      }
      /**
       * The table has to be exactly the people who are here, and seats must
       * have no holes: if the player who took seat 2 left, seat 1 is empty and
       * a three-player game would be dealt around a gap. Compact first.
       */
      present.forEach(([, c], i) => {
        c.seat = i;
      });
    }

    const playerCount = this.humansOnly ? present.length : 4;
    const humanSeats = new Set(present.map(([, c]) => c.seat));

    const seats = [];
    for (let seat = 0; seat < playerCount; seat++) {
      seats.push({
        playerId: `seat-${seat}`,
        displayName: `Player ${seat + 1}`,
        controlMode: humanSeats.has(seat) ? CONTROL_MODE.HUMAN : CONTROL_MODE.AI,
      });
    }

    this.host = createHost({
      // The code seeds the board, so a given code is always the same game.
      seed: this.code,
      config: { playerCount },
      seats,
      // No 10 Hz interval on the server. The deadline runs on an alarm, and
      // clients render their own countdown from the absolute deadline.
      autoTicker: false,
    });

    this.unsubscribe = this.host.subscribe((evt) => this.onHostEvent(evt));
    this.started = true;
    this.host.start();

    this.broadcastLobby();
    this.pushViews({ force: true });
    this.scheduleDeadline();
  }

  /**
   * Only events that change what a player sees are worth sending. `tick` is
   * emitted for local UIs and carries nothing a client cannot compute from
   * `timerDeadline`, so it never crosses the wire.
   */
  onHostEvent(evt) {
    if (evt?.type === 'tick') return;

    if (evt?.type === 'finished' || evt?.type === 'abandoned') {
      this.finished = true;
      if (evt.type === 'abandoned') this.endedReason = evt.reason || null;
    }

    const force =
      evt?.type === 'resolution' ||
      evt?.type === 'finished' ||
      evt?.type === 'abandoned' ||
      evt?.type === 'round-open' ||
      evt?.type === 'started';

    this.pushViews({ force });
    if (!this.finished) this.scheduleDeadline();
  }

  /* ------------------------------------------------------------------ *
   * Outbound
   * ------------------------------------------------------------------ */

  lobbySeats() {
    const total = this.host ? this.host.getPublicSummary().seats.length : 4;
    const filled = new Set([...this.clients.values()].filter((c) => c.present).map((c) => c.seat));
    return Array.from({ length: total }, (_, seat) => ({
      seat,
      kind: filled.has(seat) ? 'human' : 'bot',
    }));
  }

  sendWelcome(clientId) {
    const client = this.clients.get(clientId);
    if (!client?.ws) return;
    send(client.ws, {
      t: 'lobby',
      code: this.code,
      humansOnly: this.humansOnly,
      started: this.started,
      yourSeat: client.seat,
      admin: client.admin,
      seats: this.lobbySeats(),
    });
  }

  /**
   * The lobby goes out per client, not as one broadcast, because each player
   * needs one thing nobody else does: their own seat number, and whether they
   * are the one who can press Start.
   */
  broadcastLobby() {
    const seats = this.lobbySeats();
    for (const client of this.clients.values()) {
      if (!client.present || !client.ws) continue;
      send(client.ws, {
        t: 'lobby',
        code: this.code,
        humansOnly: this.humansOnly,
        started: this.started,
        yourSeat: client.seat,
        admin: client.admin,
        seats,
      });
    }
  }

  /**
   * Push each seat its own private view. Never broadcast a view.
   *
   * Coalesced: host events arrive in bursts and only the final state matters.
   */
  pushViews({ force = false } = {}) {
    if (!this.host) return;

    const wait = Math.max(0, PUSH_COALESCE_MS - (Date.now() - this.lastPushAt));
    if (!force && wait > 0) {
      if (!this.pushTimer) {
        this.pushTimer = setTimeout(() => {
          this.pushTimer = null;
          this.pushViews({ force: true });
        }, wait);
      }
      return;
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.lastPushAt = Date.now();

    const summary = this.host.getPublicSummary();
    if (summary.status !== STATUS.PLAYING && summary.status !== STATUS.FINISHED) return;

    const presenting = this.host.isPresenting();
    const lastResolution = this.host.getLastResolution();

    /**
     * The reveal is large — every castle, the full queen path and the round log
     * — and meaningful exactly once. It goes only with a finished game.
     */
    let reveal = null;
    if (summary.status === STATUS.FINISHED) {
      try {
        reveal = this.host.getReveal();
      } catch {
        reveal = null; // the boundary refuses while play continues, as it should
      }
    }

    for (const client of this.clients.values()) {
      if (!client.present || !client.ws) continue;
      send(client.ws, {
        t: 'state',
        view: this.host.getView(client.seat),
        summary,
        presenting,
        lastResolution,
        reveal,
        endedReason: this.endedReason,
        /** Server wall-clock, so a client can correct for clock skew. */
        hostNow: Date.now(),
        ackSeq: client.ackSeq,
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Leaving
   * ------------------------------------------------------------------ */

  onDisconnect(clientId, { voluntary = false } = {}) {
    const client = this.clients.get(clientId);
    if (!client || !client.present) return;

    client.present = false;
    client.ws = null;
    const seat = client.seat;

    if (!this.started) {
      // Left before kick-off: free the seat entirely so the next arrival can
      // have it, and hand ownership on if the owner is the one who left.
      this.clients.delete(clientId);
      this.ensureAdmin();
      this.broadcastLobby();
      this.teardownIfEmpty();
      return;
    }

    if (this.host && !this.finished) {
      if (this.humansOnly) {
        /**
         * No bot ever plays for a person in this mode, so the seat is retired:
         * it bids nothing and can no longer win, and the round resolves as soon
         * as everyone still here has locked. Below two players there is no game
         * left to play.
         */
        this.host.setControl(seat, CONTROL_MODE.HUMAN, {
          connectionStatus: CONNECTION.DISCONNECTED,
        });
        this.host.retire(seat);
        if (this.host.getLiveHumanCount() < 2) {
          this.host.abandon('Not enough players remain to continue.');
        }
      } else {
        // §13 takeover — the computer covers the seat immediately so the round
        // can still resolve.
        this.host.setControl(seat, CONTROL_MODE.AI, {
          reason: 'disconnected',
          connectionStatus: CONNECTION.DISCONNECTED,
        });
      }
    }

    this.broadcastLobby();
    this.pushViews({ force: true });
    this.teardownIfEmpty();
  }

  /**
   * A game does not outlive its players. When the last person leaves, the
   * engine is disposed and the room forgets everything — no orphaned games
   * holding memory, no stale board waiting for somebody who is not coming back.
   */
  teardownIfEmpty() {
    if (this.presentClients().length > 0) return;

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.host?.dispose();
    this.host = null;
    this.clients.clear();
    this.started = false;
    this.finished = false;
    this.endedReason = null;
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.ctx.storage.deleteAlarm().catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * Clock
   * ------------------------------------------------------------------ */

  /**
   * One alarm at the round deadline, instead of polling ten times a second.
   * §12 expiry locks whatever is currently placed, so the deadline is the only
   * moment the server needs to wake up on its own.
   */
  scheduleDeadline() {
    if (!this.host || this.finished) return;
    const deadline = this.host.getTimerDeadline?.();
    if (!deadline) return;
    // A small margin absorbs clock jitter so we never wake a hair too early.
    this.ctx.storage.setAlarm(deadline + 50).catch(() => {});
  }

  /** Liveness sweep, and the safety net if an alarm were ever missed. */
  ensureSweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    this.ctx.storage.setAlarm(Date.now() + SWEEP_MS).catch(() => {});
  }

  async alarm() {
    const now = Date.now();

    // A phone that loses signal often produces no close event at all, so
    // silence is treated as absence after a grace period.
    for (const [clientId, client] of [...this.clients]) {
      if (!client.present) continue;
      if (now - client.lastSeen > CLIENT_TIMEOUT_MS) this.onDisconnect(clientId);
    }

    if (this.host && !this.finished) {
      // §12 — drive the clock forward. Locks whatever is placed if the deadline
      // has passed, and resolves the round if that completes the table.
      this.host.advanceClock?.();
    }

    if (this.presentClients().length === 0) {
      this.teardownIfEmpty();
      this.sweeping = false;
      return;
    }

    // Re-arm: whichever comes first, the next deadline or the next sweep.
    const deadline = this.host && !this.finished ? this.host.getTimerDeadline?.() : null;
    const next = deadline ? Math.min(deadline + 50, now + SWEEP_MS) : now + SWEEP_MS;
    await this.ctx.storage.setAlarm(next);
  }
}

function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* the socket closed between the check and the send */
  }
}
