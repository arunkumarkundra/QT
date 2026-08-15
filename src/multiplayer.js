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
 */

const TRYSTERO_URLS = [
  'https://esm.sh/trystero@0.21.5/nostr',
  'https://cdn.jsdelivr.net/npm/trystero@0.21.5/+esm',
];

const APP_ID = 'queens-tug-v1';

/** Loaded lazily so solo play never pays for the network code. */
let trysteroPromise = null;
function loadTrystero() {
  if (trysteroPromise) return trysteroPromise;
  trysteroPromise = (async () => {
    let lastError = null;
    for (const url of TRYSTERO_URLS) {
      try {
        const mod = await import(/* @vite-ignore */ url);
        if (mod?.joinRoom) return mod;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('Could not load the networking library.');
  })();
  return trysteroPromise;
}

export const NET_STATE = {
  IDLE: 'IDLE',
  CONNECTING: 'CONNECTING',
  WAITING: 'WAITING',
  READY: 'READY',
  PLAYING: 'PLAYING',
  ERROR: 'ERROR',
};

/**
 * Open a room. Both creator and joiner call this; `isHost` decides which side
 * of the protocol they speak.
 */
export async function openRoom({ code, isHost, onEvent }) {
  const { joinRoom } = await loadTrystero();
  const room = joinRoom({ appId: APP_ID }, code);

  // Trystero actions are capped at 12 bytes.
  const [sendState, onState] = room.makeAction('state');
  const [sendIntent, onIntent] = room.makeAction('intent');
  const [sendLobby, onLobby] = room.makeAction('lobby');

  const api = {
    room,
    isHost,
    code,
    peers: new Map(), // peerId -> seat
    sendState,
    sendIntent,
    sendLobby,
    onState,
    onIntent,
    onLobby,
    leave() {
      try {
        room.leave();
      } catch {
        /* already gone */
      }
    },
  };

  room.onPeerJoin((peerId) => onEvent({ type: 'peer-join', peerId }));
  room.onPeerLeave((peerId) => onEvent({ type: 'peer-leave', peerId }));

  return api;
}

/* ------------------------------------------------------------------ *
 * HOST SIDE
 * ------------------------------------------------------------------ */

/**
 * Wrap a local authoritative host so that remote seats are fed filtered views
 * and their intents are validated exactly like local ones.
 */
export function attachHostToRoom({ net, host, onLobbyChange }) {
  /** seat -> peerId for remote humans. Seat 0 is always the creator. */
  const seatOwners = new Map();

  function seatOfPeer(peerId) {
    for (const [seat, id] of seatOwners) if (id === peerId) return seat;
    return null;
  }

  function nextFreeSeat() {
    for (let seat = 1; seat < 4; seat++) if (!seatOwners.has(seat)) return seat;
    return null;
  }

  function lobbySnapshot() {
    return {
      code: net.code,
      seats: [0, 1, 2, 3].map((seat) => ({
        seat,
        kind: seat === 0 || seatOwners.has(seat) ? 'human' : 'bot',
      })),
    };
  }

  function broadcastLobby() {
    net.sendLobby(lobbySnapshot());
    onLobbyChange?.(lobbySnapshot());
  }

  /**
   * Push each remote seat its own private view. Never broadcast a view.
   * Nothing is sent until the host actually starts, so a joiner stays on the
   * lobby screen instead of being dropped onto a board that is not live.
   */
  function pushViews() {
    const summary = host.getPublicSummary();
    if (summary.status !== 'PLAYING' && summary.status !== 'FINISHED') return;
    const presenting = host.isPresenting();
    const lastResolution = host.getLastResolution();
    let reveal = null;
    try {
      reveal = host.getReveal();
    } catch {
      reveal = null; // still running — the boundary refuses, as it should
    }
    for (const [seat, peerId] of seatOwners) {
      net.sendState(
        {
          view: host.getView(seat),
          summary,
          presenting,
          lastResolution,
          reveal,
        },
        peerId
      );
    }
  }

  net.onIntent((msg, peerId) => {
    const seat = seatOfPeer(peerId);
    if (seat === null) return; // not seated; ignore
    if (msg?.t === 'bid') host.stageBid(seat, msg.bid);
    else if (msg?.t === 'lock') host.lock(seat);
    pushViews();
  });

  const unsubscribe = host.subscribe(() => pushViews());

  return {
    lobbySnapshot,
    pushViews,
    broadcastLobby,

    /** A browser appeared. Give it a seat if one is free. */
    admit(peerId) {
      if (seatOfPeer(peerId) !== null) return seatOfPeer(peerId);
      const seat = nextFreeSeat();
      if (seat === null) return null;
      seatOwners.set(seat, peerId);
      host.setControl(seat, 'HUMAN', { connectionStatus: 'CONNECTED' });
      broadcastLobby();
      pushViews();
      return seat;
    },

    /**
     * A browser vanished. The computer covers the seat immediately so the
     * round can still resolve — the takeover rule, applied across a network.
     */
    release(peerId) {
      const seat = seatOfPeer(peerId);
      if (seat === null) return null;
      seatOwners.delete(seat);
      host.setControl(seat, 'AI', { reason: 'disconnected', connectionStatus: 'DISCONNECTED' });
      broadcastLobby();
      pushViews();
      return seat;
    },

    seatOfPeer,
    dispose() {
      unsubscribe();
    },
  };
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
export function createRemoteGame({ net, onEvent }) {
  let view = null;
  let summary = null;
  let presenting = false;
  let lastResolution = null;
  let reveal = null;
  let lastRound = 0;
  const listeners = new Set();

  const emit = (type, payload = {}) => {
    for (const fn of listeners) {
      try {
        fn({ type, ...payload });
      } catch (err) {
        console.error(err);
      }
    }
  };

  net.onState((msg) => {
    if (!msg?.view) return;
    const previous = view;
    view = msg.view;
    summary = msg.summary;
    presenting = msg.presenting;
    reveal = msg.reveal;

    const incoming = msg.lastResolution;
    const isNewResolution = incoming && incoming.roundNumber !== lastRound;
    lastResolution = incoming;

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

  const game = {
    isRemote: true,

    getView() {
      return view;
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

    /* writes are intents sent upstream; the host decides */
    stageBid(_seat, bid) {
      net.sendIntent({ t: 'bid', bid });
      return { ok: true };
    },
    lock() {
      net.sendIntent({ t: 'lock' });
      return { ok: true };
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    dispose() {
      listeners.clear();
    },
  };

  return game;
}

/** Is peer-to-peer play even possible in this browser? */
export function multiplayerSupported() {
  return typeof RTCPeerConnection !== 'undefined' && typeof window !== 'undefined';
}
