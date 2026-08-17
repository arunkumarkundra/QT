/**
 * QUEEN'S TUG — Peer-to-peer multiplayer
 *
 * GitHub Pages cannot run a server, but WebRTC only needs a *signalling*
 * channel to introduce two browsers. Trystero provides that over public relays,
 * after which players are connected directly to each other. No backend, no
 * accounts, no hosting bill.
 *
 * Topology: HOST-AUTHORITATIVE.
 *
 *     Creator's browser                    Joiner's browser
 *     ┌────────────────────┐               ┌──────────────────┐
 *     │ createHost()       │  view(seat)   │ remote proxy     │
 *     │ authoritative state├──────────────►│ latestView only  │
 *     │                    │◄──────────────┤                  │
 *     └────────────────────┘  bid intent   └──────────────────┘
 *
 * The creator runs the real engine. Every other player holds nothing but the
 * PlayerView the host chose to send them — the same object the local UI uses.
 * This is the §14.1 boundary enforced across a network: a joiner's machine
 * never receives another player's castle, treasure, balance or bid, so a
 * tampered client has nothing to reveal.
 *
 * Peers submit INTENT ("stake one coin left"). There is no message that moves
 * the queen, so a hostile peer cannot fabricate an outcome.
 *
 * ── Why the previous build was unstable ───────────────────────────────────
 *
 * It pushed a full state blob to every peer on EVERY host event, and the host
 * emits `tick` ten times a second. Each joiner was therefore sent a complete
 * serialized PlayerView 10×/s for the whole game — plus a lobby broadcast
 * every two seconds, plus (once finished) the entire reveal, which carries the
 * complete queen path and round log and grows all game.
 *
 * A WebRTC data channel saturated like that backs up, and once it backs up the
 * intent messages travelling the other way queue behind it. That is one cause
 * producing both reported symptoms: a link that "breaks in between", and coin
 * staking that misbehaves on a guest's screen.
 *
 * Five changes address it:
 *
 *   1. Pushes are event-filtered and coalesced. `tick` never crosses the wire;
 *      guests run their own countdown against the host's absolute deadline.
 *   2. Payloads are trimmed — the reveal is sent once, at the end.
 *   3. Intents are sequenced and re-sent until acknowledged, so a dropped
 *      message no longer means a lost coin.
 *   4. Guests echo their own staking optimistically and reconcile against the
 *      host's authoritative answer, so the board responds to a tap instantly.
 *   5. Players are identified by a durable clientId rather than by peerId, so
 *      a browser that reconnects gets its own seat back.
 */

/**
 * Signalling relays, tried in order. Different networks block different
 * things, so this spans two CDNs and two relay strategies rather than betting
 * on one. The first module that exposes `joinRoom` wins.
 */
const TRYSTERO_URLS = [
  'https://esm.sh/trystero@0.21/nostr',
  'https://cdn.jsdelivr.net/npm/trystero@0.21/nostr/+esm',
  'https://esm.sh/trystero@0.21/mqtt',
  'https://cdn.jsdelivr.net/npm/trystero@0.21/mqtt/+esm',
  'https://esm.sh/trystero/nostr',
  'https://esm.sh/trystero/mqtt',
];

const APP_ID = 'queens-tug-v1';

/** Wire tuning. Presentation-neutral: none of these can change an outcome. */
export const NET_TUNING = {
  /** Never send two state pushes closer together than this. */
  pushCoalesceMs: 90,
  /** Even with nothing happening, refresh each peer at this rate. */
  keepAliveMs: 1500,
  /** Re-send an unacknowledged intent this often until the host confirms it. */
  intentRetryMs: 350,
  /** Give up on an intent after this long and tell the player. */
  intentTimeoutMs: 6000,
  /** Host → peer liveness probe. */
  pingMs: 2000,
  /** No traffic from a peer for this long: treat them as gone. */
  peerTimeoutMs: 9000,
  /** Guest: no traffic from the host for this long: show "reconnecting". */
  hostSilenceMs: 6000,
  /** Lobby re-broadcast while waiting in the start screen. */
  lobbyBroadcastMs: 2000,
};

/** Loaded lazily so solo play never pays for the network code. */
let trysteroPromise = null;
function loadTrystero() {
  if (trysteroPromise) return trysteroPromise;
  trysteroPromise = (async () => {
    let lastError = null;
    for (const url of TRYSTERO_URLS) {
      try {
        const mod = await withTimeout(import(/* @vite-ignore */ url), 8000);
        if (mod?.joinRoom) return mod;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Could not load the networking library.');
  })();
  return trysteroPromise;
}

/** Never let a hung request leave the lobby spinning forever. */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

export const NET_STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  WAITING: 'WAITING',
  READY: 'READY',
  PLAYING: 'PLAYING',
  ERROR: 'ERROR',
};

const CLIENT_ID_KEY = 'qt-client-id';
let fallbackClientId = null;

/**
 * A durable identity for this browser, independent of the WebRTC peerId, which
 * is regenerated on every reconnection. This is what lets a player who drops
 * out and comes back get their own seat, castle and coins returned rather than
 * being handed a new seat or none at all.
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
 * Open a room. Both creator and joiner call this; `isHost` decides which side
 * of the protocol they speak.
 */
export async function openRoom({ code, isHost, onEvent }) {
  const { joinRoom } = await loadTrystero();
  const room = joinRoom({ appId: APP_ID }, code);

  // Trystero action names are capped at 12 bytes.
  const [sendState, onState] = room.makeAction('state');
  const [sendIntent, onIntent] = room.makeAction('intent');
  const [sendLobby, onLobby] = room.makeAction('lobby');
  // An explicit greeting removes any dependence on peer-join event ordering,
  // which is the classic way a lobby ends up silently waiting forever.
  const [sendHello, onHello] = room.makeAction('hello');
  // Acknowledgement of a received intent, carrying the sequence number the
  // host has applied. Without this a dropped bid is simply lost.
  const [sendAck, onAck] = room.makeAction('ack');
  // Liveness + clock offset. Cheap, and it keeps the data channel warm, which
  // some NATs need in order not to reap an idle mapping.
  const [sendPing, onPing] = room.makeAction('ping');
  const [sendPong, onPong] = room.makeAction('pong');

  const api = {
    room,
    isHost,
    code,
    id: clientId(),
    sendState,
    sendIntent,
    sendLobby,
    sendHello,
    sendAck,
    sendPing,
    sendPong,
    onState,
    onIntent,
    onLobby,
    onHello,
    onAck,
    onPing,
    onPong,
    getPeers: () => Object.keys(room.getPeers?.() || {}),
    leave() {
      try {
        room.leave();
      } catch {
        /* already gone */
      }
    },
  };

  room.onPeerJoin((peerId) => onEvent?.({ type: 'peer-join', peerId }));
  room.onPeerLeave((peerId) => onEvent?.({ type: 'peer-leave', peerId }));

  // Answer every ping so the other side can measure liveness and clock skew.
  onPing((msg, peerId) => {
    try {
      sendPong({ t: msg?.t, now: Date.now() }, peerId);
    } catch {
      /* peer vanished mid-flight */
    }
  });

  /**
   * Announce ourselves repeatedly for a short while. Whichever side comes up
   * second still gets seen. The greeting carries our durable clientId so the
   * host can restore a seat we already held.
   */
  if (!isHost) {
    
    let tries = 0;
    const knock = () => {
      /**
       * Knock forever, not forty times. The old cap gave up after roughly a
       * minute, so a guest who opened the link before the host opened their
       * screen could never be seated no matter how long they waited. An
       * unanswered hello costs nothing, and this doubles as reconnection.
       */
      try {
        sendHello({ t: 'hello', id: api.id });
      } catch {
        /* not connected yet */
      }
      api._knockTimer = setTimeout(knock, tries++ < 10 ? 700 : 3000);
    };
    knock();
    const stopLeaving = api.leave;
    api.leave = () => {
      clearTimeout(api._knockTimer);
      stopLeaving();
    };
  }

  return api;
}

/* ------------------------------------------------------------------ *
 * HOST SIDE
 * ------------------------------------------------------------------ */

/**
 * Wrap a local authoritative host so that remote seats are fed filtered views
 * and their intents are validated exactly like local ones.
 *
 * `humansOnly` changes what happens when somebody leaves: instead of a
 * computer covering the seat, the seat is retired and the table plays on,
 * provided at least two people remain.
 */
export function attachHostToRoom({ net, host, onLobbyChange, onEvent, humansOnly = false }) {
  /**
   * The seating book. Keyed by durable clientId, not by peerId, so a browser
   * that reconnects is recognised as the same player.
   *
   *   clientId -> { seat, peerId, lastSeen, present }
   */
  const roster = new Map();
  /** Highest intent sequence applied per seat; anything older is a duplicate. */
  const appliedSeq = new Map();
  let currentHost = host;
  let unsubscribe = null;
  let started = false;
  let disposed = false;
  let onlyHumans = humansOnly;

  let pushTimer = null;
  let lastPushAt = 0;

  const entryOfPeer = (peerId) => {
    for (const entry of roster.values()) if (entry.peerId === peerId) return entry;
    return null;
  };
  const seatOfPeer = (peerId) => entryOfPeer(peerId)?.seat ?? null;

  function seatCount() {
    return currentHost.getPublicSummary().seats.length;
  }

  function nextFreeSeat() {
    const total = seatCount();
    const taken = new Set([0, ...[...roster.values()].map((e) => e.seat)]);
    for (let seat = 1; seat < total; seat++) if (!taken.has(seat)) return seat;
    return null;
  }

  /** Humans present right now: the creator plus every connected joiner. */
  function humanRoster() {
    return [
      { seat: 0, clientId: net.id, peerId: null, isHost: true },
      ...[...roster.entries()]
        .filter(([, e]) => e.present)
        .sort((a, b) => a[1].seat - b[1].seat)
        .map(([id, e]) => ({ seat: e.seat, clientId: id, peerId: e.peerId, isHost: false })),
    ];
  }

  function lobbySnapshot() {
    const total = seatCount();
    const filled = new Set([0, ...[...roster.values()].filter((e) => e.present).map((e) => e.seat)]);
    return {
      code: net.code,
      humansOnly: onlyHumans,
      started,
      seats: Array.from({ length: total }, (_, seat) => ({
        seat,
        kind: filled.has(seat) ? 'human' : 'bot',
      })),
    };
  }


  function broadcastLobby() {
    if (disposed) return;
    const base = lobbySnapshot();

    /**
     * Sent per peer, not broadcast, because each guest needs one thing nobody
     * else does: its own seat number. Without it a joiner cannot highlight its
     * chair, and could not know its seat at all until the game had started.
     */
    const seatedPeers = new Set();
    for (const entry of roster.values()) {
      if (!entry.peerId) continue;
      seatedPeers.add(entry.peerId);
      try {
        net.sendLobby({ ...base, yourSeat: entry.seat }, entry.peerId);
      } catch {
        /* the peer went away between the check and the send */
      }
    }

    // A peer that has connected but is not seated yet still deserves to see the
    // table, so its screen can say "found the game" rather than "not found".
    for (const peerId of net.getPeers()) {
      if (seatedPeers.has(peerId)) continue;
      try {
        net.sendLobby({ ...base, yourSeat: null }, peerId);
      } catch {
        /* gone */
      }
    }

    onLobbyChange?.(base);
  }

  /**
   * Push each remote seat its own private view. Never broadcast a view.
   *
   * Coalesced: many host events arrive in a burst (stage, lock, resolve) and
   * only the final state matters. Sending each one separately is what floods
   * the channel.
   */
  function pushViews({ force = false } = {}) {
    if (disposed) return;
    const wait = Math.max(0, NET_TUNING.pushCoalesceMs - (Date.now() - lastPushAt));
    if (!force && wait > 0) {
      if (!pushTimer) {
        pushTimer = setTimeout(() => {
          pushTimer = null;
          pushViews({ force: true });
        }, wait);
      }
      return;
    }
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    lastPushAt = Date.now();

    const summary = currentHost.getPublicSummary();
    if (summary.status !== 'PLAYING' && summary.status !== 'FINISHED') return;
    const presenting = currentHost.isPresenting();
    const lastResolution = currentHost.getLastResolution();

    /**
     * The reveal is large — every castle, the complete queen path and the full
     * round log — and it is only meaningful once. Sending it on every push was
     * a growing redundant payload for the whole of a finished game.
     */
    let reveal = null;
    if (summary.status === 'FINISHED') {
      try {
        reveal = currentHost.getReveal();
      } catch {
        reveal = null; // still running — the boundary refuses, as it should
      }
    }

    for (const entry of roster.values()) {
      if (!entry.peerId) continue;
      try {
        net.sendState(
          {
            view: currentHost.getView(entry.seat),
            summary,
            presenting,
            lastResolution,
            reveal,
            /** Host wall-clock, so the guest can correct for clock skew. */
            hostNow: Date.now(),
            ackSeq: appliedSeq.get(entry.seat) ?? 0,
          },
          entry.peerId
        );
      } catch {
        /* the peer went away between the check and the send */
      }
    }
  }

  /* ---------------- inbound ---------------- */

  net.onHello((msg, peerId) => {
    const id = typeof msg?.id === 'string' ? msg.id : null;
    api.admit(peerId, id);
  });

  net.onIntent((msg, peerId) => {
    const entry = entryOfPeer(peerId);
    if (!entry) return; // not seated; ignore
    entry.lastSeen = Date.now();
    const seat = entry.seat;

    const seq = Number(msg?.seq) || 0;
    const applied = appliedSeq.get(seat) ?? 0;

    /**
     * Re-sent messages are expected — that is how a dropped intent recovers.
     * Applying one twice must therefore be harmless, which is why a bid is
     * sent as an absolute placement ("UP:2, LEFT:1") rather than as a delta
     * ("+1 coin left"). Deltas plus retries would double-charge a player.
     */
    if (seq && seq <= applied) {
      try {
        net.sendAck({ seq: applied }, peerId);
      } catch {
        /* gone */
      }
      return;
    }

    if (msg?.t === 'bid') currentHost.stageBid(seat, msg.bid);
    else if (msg?.t === 'lock') currentHost.lock(seat);
    else if (msg?.t === 'bye') {
      api.release(peerId, { voluntary: true });
      return;
    }

    if (seq) appliedSeq.set(seat, seq);
    try {
      net.sendAck({ seq: appliedSeq.get(seat) ?? 0 }, peerId);
    } catch {
      /* gone */
    }
    pushViews();
  });

  net.onPong((_msg, peerId) => {
    const entry = entryOfPeer(peerId);
    if (entry) entry.lastSeen = Date.now();
  });

  /* ---------------- timers ---------------- */

  /** Lobby re-broadcast, but only while we are still in the lobby. */
  const lobbyBeat = setInterval(() => {
    if (!started) broadcastLobby();
  }, NET_TUNING.lobbyBroadcastMs);

  /**
   * Liveness. `onPeerLeave` is not reliable on flaky mobile networks — a phone
   * that loses signal often produces no event at all — so silence is treated
   * as absence after a grace period, and a keep-alive push stops an idle NAT
   * mapping from being reaped underneath a thinking player.
   */
  const healthBeat = setInterval(() => {
    if (disposed) return;
    const now = Date.now();
    for (const entry of roster.values()) {
      if (!entry.peerId || !entry.present) continue;
      try {
        net.sendPing({ t: now }, entry.peerId);
      } catch {
        /* gone */
      }
      /**
       * Mid-game a silent player must be noticed quickly so the round can
       * resolve. In the lobby there is nothing to resolve and everyone is
       * waiting on everyone else, so be far more patient — dropping a seat
       * here just made players appear to change chairs while they waited.
       */
      const silenceLimit = started ? NET_TUNING.peerTimeoutMs : 30000;
      if (now - entry.lastSeen > silenceLimit) api.release(entry.peerId);
      
    }
    if (started) pushViews({ force: true });
  }, Math.min(NET_TUNING.pingMs, NET_TUNING.keepAliveMs));

  const api = {
    lobbySnapshot,
    humanRoster,
    pushViews,
    broadcastLobby,
    seatOfPeer,
    setHumansOnly(value) {
      onlyHumans = !!value;
      broadcastLobby();
    },

    /** Point the bridge at a freshly-built host, e.g. after seat compaction. */
    rebind(nextHost) {
      unsubscribe?.();
      currentHost = nextHost;
      appliedSeq.clear();
      unsubscribe = currentHost.subscribe(onHostEvent);
      return api;
    },

    /**
     * Re-seat everyone into contiguous seats 0..n-1. Called just before a
     * humans-only game starts, because the engine's playerCount has to match
     * the number of people at the table and seats must have no holes: if the
     * player who took seat 2 leaves the lobby, seat 1 is empty and a
     * three-player game would be built around a gap.
     *
     * Returns the clientIds in seat order.
     */
    compactSeats() {
      const present = [...roster.entries()]
        .filter(([, e]) => e.present)
        .sort((a, b) => a[1].seat - b[1].seat);
      present.forEach(([, e], i) => {
        e.seat = i + 1; // seat 0 is always the creator
      });
      appliedSeq.clear();
      return [net.id, ...present.map(([id]) => id)];
    },

    markStarted() {
      started = true;
      broadcastLobby();
      pushViews({ force: true });
    },

    /**
     * A browser appeared. Give it the seat it already held if we know it,
     * otherwise the next free one.
     */

    admit(peerId, id) {
      if (disposed) return null;
      /**
       * Seating requires the durable player id carried by the "hello" message.
       * Falling back to a temporary connection id filed the entry under a key
       * the hello could never match, so the same browser was handed a second
       * seat a moment later. That is the phantom player.
       */
      if (!id) return null;

      // One connection may hold exactly one seat. Anything else is stale.
      for (const [staleKey, stale] of roster) {
        if (stale.peerId === peerId && staleKey !== id) {
          if (started) {
            stale.peerId = null;
            stale.present = false;
          } else {
            roster.delete(staleKey);
          }
        }
      }

      const existing = roster.get(id);
    

      if (existing) {
        const returning = !existing.present || existing.peerId !== peerId;
        existing.peerId = peerId;
        existing.present = true;
        existing.lastSeen = Date.now();
        if (returning) {
          /**
           * §21 — a returning player takes their own seat back. Their castle,
           * coins and treasure are exactly where they left them, because the
           * authoritative state never moved.
           */
          currentHost.setControl(existing.seat, 'HUMAN', { connectionStatus: 'CONNECTED' });
          onEvent?.({ type: 'peer-returned', seat: existing.seat });
          broadcastLobby();
          pushViews({ force: true });
        }
        return existing.seat;
      }

      // A game already running has no free seats to hand out.
      if (started) return null;

      const seat = nextFreeSeat();
      if (seat === null) return null;
      roster.set(id, { seat, peerId, lastSeen: Date.now(), present: true });
      currentHost.setControl(seat, 'HUMAN', { connectionStatus: 'CONNECTED' });
      onEvent?.({ type: 'peer-seated', seat });
      broadcastLobby();
      pushViews({ force: true });
      return seat;
    },

    /**
     * A browser vanished.
     *
     * In a normal game the computer covers the seat immediately so the round
     * can still resolve — the takeover rule, applied across a network. In a
     * humans-only game no bot ever plays for a person, so the seat is retired
     * instead, and if that leaves fewer than two players the game ends.
     */
    release(peerId, { voluntary = false } = {}) {
      const entry = entryOfPeer(peerId);
      if (!entry || !entry.present) return null;
      const seat = entry.seat;
      entry.present = false;
      entry.peerId = null;

      if (!started) {
        // Left the lobby before kick-off: free the seat entirely so the next
        // arrival can have it.
        for (const [key, e] of roster) if (e === entry) roster.delete(key);
        broadcastLobby();
        return seat;
      }

      if (onlyHumans) {
        currentHost.setControl(seat, 'HUMAN', { connectionStatus: 'DISCONNECTED' });
        currentHost.retire(seat);
        onEvent?.({ type: 'peer-retired', seat, voluntary });
        if (currentHost.getLiveHumanCount() < 2) {
          currentHost.abandon('Not enough players remain to continue.');
          onEvent?.({ type: 'abandoned' });
        }
      } else {
        currentHost.setControl(seat, 'AI', {
          reason: 'disconnected',
          connectionStatus: 'DISCONNECTED',
        });
        onEvent?.({ type: 'peer-covered', seat });
      }

      broadcastLobby();
      pushViews({ force: true });
      return seat;
    },

    dispose() {
      disposed = true;
      clearInterval(lobbyBeat);
      clearInterval(healthBeat);
      if (pushTimer) clearTimeout(pushTimer);
      unsubscribe?.();
    },
  };

  /**
   * Only events that change what a guest sees are worth a push. `tick` is
   * emitted ten times a second and carries nothing a guest cannot compute from
   * `view.timerDeadline`, so it is dropped here rather than flooding the wire.
   */
  function onHostEvent(evt) {
    if (evt?.type === 'tick') return;
    pushViews({ force: evt?.type === 'resolution' || evt?.type === 'finished' });
  }

  unsubscribe = currentHost.subscribe(onHostEvent);

  return api;
}

/* ------------------------------------------------------------------ *
 * CLIENT SIDE
 * ------------------------------------------------------------------ */

/**
 * A stand-in for the authoritative host, for a player who is not running it.
 * It exposes the SAME read/write surface as `createHost`, so the UI cannot
 * tell the difference and needs no branching. It holds only what arrived over
 * the wire: one PlayerView.
 */
export function createRemoteGame({ net, onEvent, onLobby }) {
  let view = null;
  let summary = null;
  let presenting = false;
  let lastResolution = null;
  let reveal = null;
  let lastRound = 0;
  let lastMessageAt = 0;
  let clockOffset = 0; // hostNow - ourNow
  let healthy = false;
  const listeners = new Set();

  /**
   * Outstanding intents, newest last. Each is re-sent until the host
   * acknowledges its sequence number. Because a bid is an absolute placement
   * rather than a delta, re-sending is always safe.
   */
  let seq = 0;
  let ackedSeq = 0;
  const outbox = new Map(); // seq -> { msg, sentAt, firstSentAt }

  /**
   * What we believe our bid to be, ahead of the host confirming it. The board
   * has to respond to a tap immediately or the game feels broken; this is the
   * optimistic half, and every host message reconciles it.
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

  /** Merge the optimistic bid over the last authoritative view. */
  function effectiveView() {
    if (!view) return null;
    if (!pendingBid && !pendingLock) return view;
    const total = pendingBid
      ? Object.values(pendingBid).reduce((s, n) => s + (n || 0), 0)
      : view.you.currentBidTotal;
    return {
      ...view,
      you: {
        ...view.you,
        currentBid: pendingBid ? { ...pendingBid } : view.you.currentBid,
        currentBidTotal: total,
        locked: pendingLock || view.you.locked,
      },
    };
  }

  function send(msg) {
    seq += 1;
    outbox.set(seq, { msg: { ...msg, seq }, sentAt: 0, firstSentAt: Date.now() });
    flushOutbox();
    return seq;
  }

  function flushOutbox() {
    const now = Date.now();
    for (const [n, rec] of outbox) {
      if (n <= ackedSeq) {
        outbox.delete(n);
        continue;
      }
      if (now - rec.firstSentAt > NET_TUNING.intentTimeoutMs) {
        outbox.delete(n);
        emit('intent-lost', { seq: n });
        continue;
      }
      if (now - rec.sentAt < NET_TUNING.intentRetryMs) continue;
      rec.sentAt = now;
      try {
        net.sendIntent(rec.msg);
      } catch {
        /* not connected this instant; the next sweep tries again */
      }
    }
  }

  function absorbAck(n) {
    if (!(n > ackedSeq)) return;
    ackedSeq = n;
    for (const key of [...outbox.keys()]) if (key <= ackedSeq) outbox.delete(key);
  }

  net.onAck((msg) => {
    lastMessageAt = Date.now();
    absorbAck(Number(msg?.seq) || 0);
  });

  net.onState((msg) => {
    if (!msg?.view) return;
    lastMessageAt = Date.now();
    if (typeof msg.hostNow === 'number') clockOffset = msg.hostNow - Date.now();
    if (typeof msg.ackSeq === 'number') absorbAck(msg.ackSeq);

    const previous = view;
    view = msg.view;
    summary = msg.summary;
    presenting = msg.presenting;
    if (msg.reveal) reveal = msg.reveal;

    /**
     * Reconcile the optimistic bid. Once every intent we sent has been
     * acknowledged, the host's copy is by definition complete and ours is
     * redundant — dropping it here is what stops a rejected bid (over budget,
     * aimed off the board, locked too late) from sticking on screen.
     */
    if (!outbox.size) {
      pendingBid = null;
      pendingLock = false;
    }
    if (view.you.locked) pendingLock = false;
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

    if (isNewResolution) {
      lastRound = incoming.roundNumber;
      emit('resolution', { roundNumber: incoming.roundNumber });
    } else if (previous && previous.roundNumber !== view.roundNumber) {
      emit('round-open', { roundNumber: view.roundNumber });
    } else {
      emit('state');
    }
    onEvent?.({ type: 'sync' });
  });

  if (onLobby) net.onLobby((lobby) => onLobby(lobby));

  /**
   * The guest runs its own clock. The host sends an absolute `timerDeadline`,
   * so the countdown can be rendered locally at 10 Hz without a single packet
   * crossing the network — which is precisely the traffic that used to break
   * the link. The same sweep retries unacknowledged intents and notices a
   * silent host, rather than leaving the player staring at a frozen board.
   */
  const heartbeat = setInterval(() => {
    flushOutbox();
    if (view) emit('tick');
    if (healthy && lastMessageAt && Date.now() - lastMessageAt > NET_TUNING.hostSilenceMs) {
      healthy = false;
      emit('link-down');
    }
  }, 100);

  const game = {
    isRemote: true,

    getView() {
      return effectiveView();
    },
    getPublicSummary() {
      return summary;
    },
    getLastResolution() {
      return lastResolution;
    },
    getReveal() {
      if (!reveal) throw new Error('Reveal not available yet.');
      return reveal;
    },
    isPresenting: () => presenting,
    getSeat: () => view?.you?.seat ?? null,
    /** Host clock minus ours, so deadlines line up across devices. */
    getClockOffset: () => clockOffset,
    isHealthy: () => healthy,

    /* writes are intents sent upstream; the host decides */
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
    /** Tell the host we are leaving on purpose, so it need not wait us out. */
    sayGoodbye() {
      try {
        seq += 1;
        net.sendIntent({ t: 'bye', seq });
      } catch {
        /* nothing to do */
      }
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      clearInterval(heartbeat);
      outbox.clear();
      listeners.clear();
    },
  };

  return game;
}

/** Is peer-to-peer play even possible in this browser? */
export function multiplayerSupported() {
  return typeof RTCPeerConnection !== 'undefined' && typeof window !== 'undefined';
}
