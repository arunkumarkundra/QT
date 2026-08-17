/**
 * QUEEN'S TUG — Online play (WebSocket client)
 *
 * Replaces the old peer-to-peer layer. Every player, including the one who
 * created the game, is now a client of the authoritative server in
 * `worker/index.js`. Nobody's browser runs the engine for anybody else.
 *
 * ── What this fixes ───────────────────────────────────────────────────────
 *
 * The WebRTC build asked two browsers to open a direct connection. That works
 * on one Wi-Fi network and fails on mobile data, because carriers hide every
 * phone behind a shared address that refuses unsolicited inbound connections —
 * so the peers never saw each other at all. A WebSocket goes OUTWARD to a
 * server, which every network permits. No NAT traversal, no TURN relay, no
 * credentials in a public repository.
 *
 * ── What it holds ─────────────────────────────────────────────────────────
 *
 * One PlayerView: the same object the local UI uses. §14.1 is enforced on the
 * server, so another player's castle, treasure, balance or bid never reaches
 * this machine even in memory. Writes are INTENT ('stake two coins left'),
 * never outcome; no message exists that moves the queen.
 *
 * ── Why it feels instant ──────────────────────────────────────────────────
 *
 * Staking is echoed optimistically and reconciled against the server's
 * authoritative answer, so the board responds to a tap without waiting for a
 * round trip. Intents carry a sequence number and are re-sent until
 * acknowledged, so a dropped message is not a lost coin. Because a bid travels
 * as an absolute placement rather than a delta, re-sending is always safe.
 */

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  SET THIS to the address Cloudflare gives you after the first deploy.
 *  It looks like:  wss://queens-tug.<your-subdomain>.workers.dev/ws
 *  Keep the wss:// and keep the /ws at the end.
 * ─────────────────────────────────────────────────────────────────────────
 */
export const SERVER_URL = 'wss://qt.arunkumarkundra.workers.dev/ws';

const CLIENT_ID_KEY = 'qt-client-id';
let fallbackClientId = null;

export const NET_TUNING = {
  /** Keeps the socket warm and doubles as our liveness signal. */
  pingMs: 10000,
  /** Unacknowledged intents are re-sent this often. */
  retryMs: 400,
  /** An intent unacknowledged this long is reported to the player. */
  intentGiveUpMs: 6000,
  /** Silence longer than this means the link is in trouble. */
  serverSilenceMs: 12000,
  /** Reconnection backoff, in order. Repeats the last value forever. */
  reconnectMs: [500, 1000, 2000, 4000, 8000],
};

/** Online play needs nothing exotic — any browser from the last decade. */
export function multiplayerSupported() {
  return typeof WebSocket !== 'undefined';
}

/**
 * A durable identity for this browser, so a player who drops out and comes
 * back is recognised and handed their own seat, castle and coins rather than a
 * new seat or none at all.
 */
export function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode: fall back to a per-tab identity. Reconnection within the
    // same tab still works; a fresh tab is treated as a new player.
    if (!fallbackClientId) fallbackClientId = `c-${Math.random().toString(36).slice(2, 12)}`;
    return fallbackClientId;
  }
}

/**
 * Join a game and return an object with the SAME read/write surface as the
 * local host, so the UI cannot tell the difference and needs no branching.
 *
 * `onLobby` receives the pre-game roster (including this player's own seat and
 * whether they are the one who may press Start). `onEvent` receives connection
 * notices. Game events go to `subscribe()`, exactly as with a local host.
 */
export function connectRoom({ code, onLobby, onEvent }) {
  const listeners = new Set();

  let ws = null;
  let disposed = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  let view = null;
  let summary = null;
  let presenting = false;
  let lastResolution = null;
  let reveal = null;
  let endedReason = null;
  let lobby = null;

  let lastRound = 0;
  let lastLocked = [];
  let lastMessageAt = 0;
  let clockOffset = 0; // serverNow - ourNow
  let healthy = false;

  /**
   * Outstanding intents, newest last. Each is re-sent until the server
   * acknowledges its sequence number.
   */
  let seq = 0;
  let ackedSeq = 0;
  const outbox = new Map(); // seq -> { msg, firstSentAt }

  /**
   * What we believe our bid to be, ahead of the server confirming it. The
   * board has to respond to a tap immediately or the game feels broken; this
   * is the optimistic half, and every server message reconciles it.
   */
  let pendingBid = null;
  let pendingLock = false;

  const emit = (type, payload = {}) => {
    for (const fn of listeners) {
      try {
        fn({ type, ...payload });
      } catch (err) {
        console.error(err);
      }
    }
  };

  /* ---------------- socket ---------------- */

  function open() {
    if (disposed) return;
    let socket;
    try {
      socket = new WebSocket(`${SERVER_URL}?code=${encodeURIComponent(code)}`);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      if (disposed) return;
      reconnectAttempt = 0;
      // The greeting carries our durable id, which is how the server restores
      // a seat we already held.
      raw({ t: 'hello', id: clientId() });
      flushOutbox({ force: true });
      onEvent?.({ type: 'open' });
    });

    socket.addEventListener('message', (event) => {
      if (disposed) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      lastMessageAt = Date.now();
      handle(msg);
    });

    const closed = () => {
      if (disposed || ws !== socket) return;
      ws = null;
      if (healthy) {
        healthy = false;
        emit('link-down');
      }
      scheduleReconnect();
    };
    socket.addEventListener('close', closed);
    socket.addEventListener('error', closed);
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer) return;
    const steps = NET_TUNING.reconnectMs;
    const delay = steps[Math.min(reconnectAttempt, steps.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function raw(msg) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- inbound ---------------- */

  function handle(msg) {
    switch (msg.t) {
      case 'lobby':
        lobby = msg;
        onLobby?.(msg);
        return;

      case 'ack':
        ackedSeq = Math.max(ackedSeq, Number(msg.seq) || 0);
        for (const n of [...outbox.keys()]) if (n <= ackedSeq) outbox.delete(n);
        return;

      case 'pong':
        if (typeof msg.now === 'number') clockOffset = msg.now - Date.now();
        return;

      case 'error':
        onEvent?.({ type: 'error', message: msg.message });
        return;

      case 'state':
        applyState(msg);
        return;

      default:
        return;
    }
  }

  function applyState(msg) {
    const previous = view;
    view = msg.view;
    summary = msg.summary;
    presenting = !!msg.presenting;
    endedReason = msg.endedReason ?? null;
    if (msg.reveal) reveal = msg.reveal;
    if (typeof msg.hostNow === 'number') clockOffset = msg.hostNow - Date.now();
    ackedSeq = Math.max(ackedSeq, Number(msg.ackSeq) || 0);
    for (const n of [...outbox.keys()]) if (n <= ackedSeq) outbox.delete(n);

    /**
     * Once every intent we sent has been acknowledged, the server's copy is by
     * definition complete and ours is redundant. Dropping it here is what stops
     * a rejected bid — over budget, off the board, locked too late — from
     * sticking on screen.
     */
    if (!outbox.size) {
      pendingBid = null;
      pendingLock = false;
    }
    if (view?.you?.locked) pendingLock = false;
    if (previous && previous.roundNumber !== view.roundNumber) {
      pendingBid = null;
      pendingLock = false;
    }

    const incoming = msg.lastResolution;
    const isNewResolution = incoming && incoming.roundNumber !== lastRound;
    lastResolution = incoming;

    if (!healthy) {
      healthy = true;
      emit('link-up');
    }

    // A rival locking in is worth hearing. The server does not send a discrete
    // event for it, so notice the change in the public summary instead.
    const locked = (summary?.seats || []).filter((s) => s.locked).map((s) => s.seat);
    for (const s of locked) {
      if (!lastLocked.includes(s)) emit('seat-locked', { seat: s });
    }
    lastLocked = locked;

    if (summary?.status === 'FINISHED' && !summary.winner && endedReason) {
      emit('abandoned', { reason: endedReason });
      return;
    }

    if (isNewResolution) {
      lastRound = incoming.roundNumber;
      emit('resolution', { roundNumber: incoming.roundNumber });
    } else if (previous && previous.roundNumber !== view.roundNumber) {
      emit('round-open', { roundNumber: view.roundNumber });
    } else {
      emit('state');
    }
    onEvent?.({ type: 'sync' });
  }

  /* ---------------- outbound intents ---------------- */

  function send(msg) {
    seq += 1;
    outbox.set(seq, { msg: { ...msg, seq }, firstSentAt: Date.now() });
    flushOutbox({ force: true });
  }

  function flushOutbox({ force = false } = {}) {
    const now = Date.now();
    for (const [n, item] of outbox) {
      if (n <= ackedSeq) {
        outbox.delete(n);
        continue;
      }
      if (now - item.firstSentAt > NET_TUNING.intentGiveUpMs) {
        outbox.delete(n);
        emit('intent-lost', { seq: n });
        continue;
      }
      if (force || now - (item.sentAt || 0) > NET_TUNING.retryMs) {
        if (raw(item.msg)) item.sentAt = now;
      }
    }
  }

  /**
   * The client runs its own clock. The server sends an absolute
   * `timerDeadline`, so the countdown is rendered locally at 10 Hz without a
   * single packet crossing the network. The same sweep retries unacknowledged
   * intents and notices a silent server rather than leaving the player staring
   * at a frozen board.
   */
  const heartbeat = setInterval(() => {
    if (disposed) return;
    flushOutbox();
    if (view) emit('tick');
    if (healthy && lastMessageAt && Date.now() - lastMessageAt > NET_TUNING.serverSilenceMs) {
      healthy = false;
      emit('link-down');
    }
  }, 100);

  const pinger = setInterval(() => {
    if (!disposed) raw({ t: 'ping', now: Date.now() });
  }, NET_TUNING.pingMs);

  open();

  /* ---------------- public surface ---------------- */

  /** Merge the optimistic bid over the last authoritative view. */
  function effectiveView() {
    if (!view) return null;
    if (!pendingBid && !pendingLock) return view;
    return {
      ...view,
      you: {
        ...view.you,
        currentBid: pendingBid || view.you.currentBid,
        locked: pendingLock || view.you.locked,
      },
    };
  }

  const game = {
    isRemote: true,

    /* ---- reads ---- */
    getView: () => effectiveView(),
    getPublicSummary: () => summary,
    getLastResolution: () => lastResolution,
    getReveal() {
      if (!reveal) throw new Error('Reveal not available yet.');
      return reveal;
    },
    isPresenting: () => presenting,
    getSeat: () => view?.you?.seat ?? lobby?.yourSeat ?? null,
    /** Server clock minus ours, so deadlines line up across devices. */
    getClockOffset: () => clockOffset,
    isHealthy: () => healthy,
    getLobby: () => lobby,
    /** Only one player may start the game or change its settings. */
    isAdmin: () => !!lobby?.admin,

    /* ---- writes: intent only ---- */
    stageBid(_seat, bid) {
      pendingBid = { ...bid };
      send({ t: 'bid', bid });
      emit('state');
      return { ok: true };
    },
    lock() {
      pendingLock = true;
      send({ t: 'lock' });
      emit('state');
      return { ok: true };
    },

    /* ---- lobby controls (ignored by the server unless we are admin) ---- */
    setHumansOnly(value) {
      raw({ t: 'config', humansOnly: !!value });
    },
    startGame() {
      raw({ t: 'start' });
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * A deliberate exit. Telling the server means the table need not wait out a
     * liveness timeout before the round can resolve.
     */
    sayGoodbye() {
      raw({ t: 'bye' });
    },

    dispose() {
      disposed = true;
      clearInterval(heartbeat);
      clearInterval(pinger);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      listeners.clear();
      try {
        ws?.close(1000, 'Left the game.');
      } catch {
        /* already closed */
      }
      ws = null;
    },
  };

  return game;
}
