/**
 * QUEEN'S TUG — Authoritative host (Spec §14, §24)
 *
 * This object plays the role the specification assigns to the server. It owns
 * the one true GameState inside a closure. Clients — the browser UI and the AI
 * alike — hold a reference to the host but cannot reach the state: the only way
 * out is `getView(seat)`, which runs everything through createPlayerView.
 *
 * Clients submit INTENT ("stake 6 coins Right"), never OUTCOME ("move Right 6").
 * The host validates every submission against the authoritative balance, board
 * and phase, and rejects anything stale, over-budget or out of turn.
 *
 * Running this in the browser makes the local device the trusted environment,
 * which is fine for solo and pass-and-play. For real online multiplayer the
 * SAME module must run in the shared authoritative environment instead, with
 * `getView` results serialized over the wire. See TRANSPORT.md.
 */

import {
  createGame,
  startGame,
  stageBid,
  lockBid,
  lockExpiredSeats,
  allSeatsLocked,
  resolveRound,
  setControlMode,
  retireSeat,
  emptyBid,
} from './engine.js';
import { createPlayerView, createRevealView } from './playerView.js';
import { decideBid } from './ai.js';
import { CONTROL_MODE, CONNECTION, STATUS, PHASES, UI_TIMING } from './config.js';

export const TURN_MODE = {
  /** Spec §7: all four players plan at once behind a shared timer. */
  SIMULTANEOUS: 'SIMULTANEOUS',
  /**
   * Local adaptation for several humans on ONE device. Planning is sequential
   * because it has to be, but no player ever sees another's placement, so the
   * information rules of §5 are preserved exactly. Presentation only.
   */
  SEQUENTIAL: 'SEQUENTIAL',
};

export function createHost({
  seed,
  config = {},
  seats = [],
  turnMode = TURN_MODE.SIMULTANEOUS,
  autoResolve = true,
  /**
   * A browser wants a polling clock: the countdown on screen is redrawn from
   * the `tick` event ten times a second. A server does not, and must not — an
   * interval that never idles keeps a Durable Object resident and billable for
   * the whole game while doing nothing but reading the clock. With this off,
   * nothing changes about the rules; the owner simply becomes responsible for
   * calling `advanceClock()` when `getTimerDeadline()` has passed, which the
   * server does from a single alarm.
   */
  autoTicker = true,
} = {}) {
  /** The authoritative state. Nothing outside this closure may touch it. */
  let state = createGame({ seed, config, players: seats });
  let listeners = new Set();
  let ticker = null;
  let aiTimers = [];
  let presentingUntil = 0;
  let activeSeat = null;
  let lastResolution = null;

  const humanSeats = () =>
    state.players.filter((p) => p.controlMode === CONTROL_MODE.HUMAN).map((p) => p.seat);

  function emit(type, payload = {}) {
    for (const fn of listeners) {
      try {
        fn({ type, ...payload });
      } catch (err) {
        console.error('Host listener failed', err);
      }
    }
  }

  function clearAiTimers() {
    aiTimers.forEach(clearTimeout);
    aiTimers = [];
  }

  /* ---------------- AI scheduling ---------------- */

  function scheduleAi() {
    clearAiTimers();
    if (state.status !== STATUS.PLAYING) return;

    for (const player of state.players) {
      if (player.controlMode !== CONTROL_MODE.AI) continue;
      if (state.lockedSeats.includes(player.seat)) continue;

      const spread = UI_TIMING.aiThinkMaxMs - UI_TIMING.aiThinkMinMs;
      const delay =
        turnMode === TURN_MODE.SEQUENTIAL
          ? UI_TIMING.aiSequentialMs
          : UI_TIMING.aiThinkMinMs + Math.random() * spread;

      aiTimers.push(
        setTimeout(() => {
          if (state.status !== STATUS.PLAYING) return;
          if (state.lockedSeats.includes(player.seat)) return;
          // The AI is handed a PlayerView — the identical object a human client
          // receives. It has no other route to game information (§13).
          const view = createPlayerView(state, player.seat);
          const bid = decideBid(view, { rngSeed: state.seed });
          const r = lockBid(state, player.seat, bid);
          if (r.ok) {
            state = r.state;
            emit('seat-locked', { seat: player.seat });
            afterLock();
          }
        }, delay)
      );
    }
  }

  /* ---------------- Round flow ---------------- */

  function afterLock() {
    if (allSeatsLocked(state) && autoResolve) {
      doResolve();
    } else {
      if (turnMode === TURN_MODE.SEQUENTIAL) advanceActiveSeat();
      emit('state');
    }
  }

  function advanceActiveSeat() {
    const pending = humanSeats().filter((s) => !state.lockedSeats.includes(s));
    activeSeat = pending.length ? pending[0] : null;
    /**
     * The decision timer measures a player's thinking time, not the time it
     * takes to physically hand over a device. It stays paused (null deadline)
     * until that seat calls beginTurn().
     */
    state = { ...state, timerDeadline: null };
    emit('active-seat', { seat: activeSeat });
  }

  function doResolve() {
    clearAiTimers();
    const presentMs =
      UI_TIMING.resolutionHoldMs + UI_TIMING.cancelAnimMs + UI_TIMING.travelMinMs;
    // Push the next round's deadline out by the presentation window so players
    // are not planning while the queen is still sliding.
    const r = resolveRound(state, { now: Date.now() + presentMs });
    if (r.error) return;
    state = r.state;
    lastResolution = r.resolution;
    presentingUntil = Date.now() + presentMs;

    emit('resolution', { roundNumber: r.resolution.roundNumber });

    if (state.status === STATUS.FINISHED) {
      stopTicker();
      emit('finished', { winner: state.winner });
      return;
    }
    if (turnMode === TURN_MODE.SEQUENTIAL) {
      setTimeout(() => {
        activeSeat = humanSeats()[0] ?? null;
        state = { ...state, timerDeadline: null }; // paused until beginTurn()
        emit('round-open', { roundNumber: state.roundNumber });
        scheduleAi();
      }, presentMs);
    } else {
      setTimeout(() => {
        emit('round-open', { roundNumber: state.roundNumber });
        scheduleAi();
      }, presentMs);
    }
  }

  /* ---------------- Timer ---------------- */

  function tick() {
    if (state.status !== STATUS.PLAYING) return;
    if (Date.now() < presentingUntil) return;
    if (!state.timerDeadline) return;

    if (Date.now() >= state.timerDeadline) {
      // §12 — expiry locks whatever is currently placed.
      if (turnMode === TURN_MODE.SEQUENTIAL && activeSeat !== null) {
        const r = lockBid(state, activeSeat, state.currentRoundBids[activeSeat] || emptyBid());
        state = r.ok ? r.state : lockBid(state, activeSeat, emptyBid()).state;
        emit('seat-locked', { seat: activeSeat, byTimer: true });
        afterLock();
      } else {
        state = lockExpiredSeats(state);
        emit('timer-expired');
        afterLock();
      }
    }
    emit('tick');
  }

  function startTicker() {
    stopTicker();
    if (!autoTicker) return;
    ticker = setInterval(tick, 100);
  }
  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  /* ---------------- Public surface ---------------- */

  const host = {
    /* ---- reads: every one of these is filtered ---- */

    /** The ONLY way game information leaves this object. */
    getView(seat) {
      return createPlayerView(state, seat);
    },

    /** §18 — throws unless the game has actually finished. */
    getReveal() {
      return createRevealView(state);
    },

    getPublicSummary() {
      return {
        gameId: state.gameId,
        status: state.status,
        started: state.status !== 'LOBBY',
        phase: state.phase,
        roundNumber: state.roundNumber,
        seats: state.players.map((p) => ({
          seat: p.seat,
          displayName: p.displayName,
          controlMode: p.controlMode,
          connectionStatus: p.connectionStatus,
          locked: state.lockedSeats.includes(p.seat),
          retired: (state.retiredSeats || []).includes(p.seat),
        })),
      };
    },

    /** Aggregate resolution for the animation layer. Contains no per-seat bids. */
    getLastResolution() {
      if (!lastResolution) return null;
      const { _private, ...publicPart } = lastResolution;
      return publicPart;
    },

    isPresenting: () => Date.now() < presentingUntil,
    presentingUntil: () => presentingUntil,

    /**
     * The absolute moment this round's timer expires, or null while the clock
     * is paused. An owner running without `autoTicker` schedules its single
     * wake-up from this rather than polling.
     */
    getTimerDeadline: () => state.timerDeadline,

    /**
     * Step the clock by hand. Identical to what the internal ticker does, and
     * safe to call at any time: it returns immediately unless the game is
     * playing, the presentation window has closed, and a deadline has actually
     * passed. Idempotent, so an early or duplicated wake-up costs nothing.
     */
    advanceClock() {
      tick();
      return host;
    },
    getActiveSeat: () => activeSeat,
    getTurnMode: () => turnMode,
    getConfig: () => ({ ...state.config }),
    getSeed: () => state.seed,
    getMetrics: () => ({ ...state.metrics }),

    /* ---- writes: intent only ---- */

    start() {
      state = startGame(state, { now: Date.now() });
      if (turnMode === TURN_MODE.SEQUENTIAL) {
        activeSeat = humanSeats()[0] ?? null;
        state = { ...state, timerDeadline: null }; // paused until beginTurn()
      }
      startTicker();
      scheduleAi();
      emit('started');
      return host;
    },

    /** Uncommitted placement (§12). Rejected if it breaks any rule. */
    stageBid(seat, bid) {
      if (turnMode === TURN_MODE.SEQUENTIAL && activeSeat !== null && seat !== activeSeat) {
        return { ok: false, error: 'It is not your turn to plan.' };
      }
      const r = stageBid(state, seat, bid);
      if (r.ok) {
        state = r.state;
        emit('state');
      }
      return { ok: r.ok, error: r.error };
    },

    /**
     * Sequential mode only: the seat has taken the device and is looking at the
     * board, so start their decision timer now. Idempotent, and it refuses for
     * any seat that is not the active one.
     */
    beginTurn(seat) {
      if (turnMode !== TURN_MODE.SEQUENTIAL) return { ok: true };
      if (seat !== activeSeat) return { ok: false, error: 'It is not your turn.' };
      if (state.timerDeadline) return { ok: true }; // already running
      state = { ...state, timerDeadline: Date.now() + state.config.decisionTimerMs };
      emit('state');
      return { ok: true };
    },

    /** §7 LOCK. */
    lock(seat) {
      const r = lockBid(state, seat);
      if (!r.ok) return { ok: false, error: r.error };
      state = r.state;
      emit('seat-locked', { seat });
      afterLock();
      return { ok: true };
    },

    /** §13 — hand a seat to the computer, or give it back. */
    setControl(seat, mode, opts) {
      state = setControlMode(state, seat, mode, opts);
      emit('state');
      if (mode === CONTROL_MODE.AI) scheduleAi();
      return host;
    },

    /**
     * Humans-only games have no computer players, so a seat that empties is
     * not covered — it is retired. The player stops bidding and can no longer
     * win, and the round resolves as soon as everyone still present has
     * locked. §13's takeover rule deliberately does not apply here, because
     * the whole point of the mode is that a bot never plays for a person.
     */
    retire(seat) {
      state = retireSeat(state, seat);
      emit('state');
      afterLock();
      return host;
    },

    /** Seats still playing. */
    getActiveSeats() {
      const retired = state.retiredSeats || [];
      return state.players.filter((p) => !retired.includes(p.seat)).map((p) => p.seat);
    },

    /** Connected humans still in the game — the humans-only quorum check. */
    getLiveHumanCount() {
      const retired = state.retiredSeats || [];
      return state.players.filter(
        (p) =>
          !retired.includes(p.seat) &&
          p.controlMode === CONTROL_MODE.HUMAN &&
          p.connectionStatus === CONNECTION.CONNECTED
      ).length;
    },

    /**
     * End a game that can no longer be played — a humans-only table that has
     * dropped below two people. Distinct from a win: there is no winner.
     */
    abandon(reason = 'Not enough players remain.') {
      stopTicker();
      clearAiTimers();
      state = { ...state, status: STATUS.FINISHED, phase: PHASES.FINISHED, timerDeadline: null, winner: null };
      emit('abandoned', { reason });
      return host;
    },

    /** Simulate a dropped connection for testing §13 and §21. */
    simulateDisconnect(seat) {
      return host.setControl(seat, CONTROL_MODE.AI, {
        reason: 'disconnected',
        connectionStatus: CONNECTION.DISCONNECTED,
      });
    },

    /** §21 — control returns at the next safe boundary, never mid-round. */
    simulateReconnect(seat) {
      state = setControlMode(state, seat, CONTROL_MODE.HUMAN, {
        connectionStatus: CONNECTION.CONNECTED,
      });
      emit('state');
      return host;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    dispose() {
      stopTicker();
      clearAiTimers();
      listeners.clear();
    },

    /**
     * Development-only escape hatch for the four-up debug view (§25 step 15).
     * Deliberately ugly to name so it can never be mistaken for a normal read,
     * and it refuses to work unless debug mode was requested at construction.
     */
    __authoritativeStateForDebugOnly() {
      if (!config.debug) throw new Error('Debug state requested without debug mode.');
      return state;
    },
  };

  return host;
}

export { CONTROL_MODE, STATUS, PHASES };
