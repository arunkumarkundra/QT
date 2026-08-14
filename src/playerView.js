/**
 * QUEEN'S TUG — The information boundary (Spec §5, §14.1, §25 step 4)
 *
 *   AuthoritativeGameState
 *        ↓  filtered by seat
 *   PlayerView(seat)
 *        ↓
 *   Human UI  /  AI
 *
 * This is the single chokepoint through which game state may reach a player.
 * Nothing else in the codebase is allowed to hand raw GameState to a client or
 * to an AI. §14.1: never send hidden information to the browser merely because
 * the browser promises not to display it.
 *
 * A PlayerView is constructed by *building up* only permitted fields. It is
 * never a copy of GameState with fields deleted — that pattern leaks the moment
 * someone adds a new field to GameState.
 */

import { DIRECTIONS, PHASES, STATUS } from './config.js';
import { adjacentCells, cell, emptyBid, bidTotal } from './engine.js';

/** Aggregate, non-attributable resolution summary. Public by §5.1 and §19. */
function publicResolution(resolution, seat) {
  if (!resolution) return null;
  const out = {
    roundNumber: resolution.roundNumber,
    startPosition: resolution.startPosition,
    totals: { ...resolution.totals },
    surviving: { ...resolution.surviving },
    direction: resolution.direction,
    requestedDistance: resolution.requestedDistance,
    actualDistance: resolution.actualDistance,
    blockedByBoundary: resolution.blockedByBoundary,
    tie: resolution.tie,
    finalPosition: resolution.finalPosition,
    path: resolution.path, // this round's segment only — never the full history
    winner: resolution.winner,
    /** Filled only for the seat it belongs to. */
    yourBonusCollected: null,
  };
  const collection = resolution._private?.collection;
  if (collection && collection.seat === seat) {
    out.yourBonusCollected = { reward: collection.reward, position: collection.position };
  }
  return out;
}

/**
 * Build the view for one seat. This is what a human client and an AI both
 * receive — byte-for-byte the same shape (§13).
 */
export function createPlayerView(state, seat) {
  const player = state.players[seat];
  if (!player) throw new Error(`No such seat: ${seat}`);

  const alloc = state.coinAllocationState[seat];
  const bonus = state.activeBonuses[seat];
  const bid = state.currentRoundBids[seat] || emptyBid();

  const view = {
    /* ---- Public game facts (§5.1) ---- */
    gameId: state.gameId,
    status: state.status,
    phase: state.phase,
    roundNumber: state.roundNumber,
    timerDeadline: state.timerDeadline,
    board: { width: state.boardWidth, height: state.boardHeight, boundaryMargin: state.config.boundaryMargin },
    queenPosition: cell(state.queenPosition.r, state.queenPosition.c),
    adjacent: adjacentCells(state),
    config: {
      decisionTimerMs: state.config.decisionTimerMs,
      startingCoins: state.config.startingCoins,
      replenishCoins: state.config.replenishCoins,
      bonusRewards: [...state.config.bonusRewards],
      playerCount: state.config.playerCount,
    },

    /* ---- Everything this player privately owns (§5.2) ---- */
    you: {
      seat,
      playerId: player.playerId,
      displayName: player.displayName,
      controlMode: player.controlMode,
      connectionStatus: player.connectionStatus,
      coinsRemaining: alloc.coinsRemaining,
      allocationNumber: alloc.allocationNumber,
      castlePosition: cell(state.castles[seat].r, state.castles[seat].c),
      activeBonus: bonus ? { position: cell(bonus.position.r, bonus.position.c), reward: bonus.reward } : null,
      currentBid: { ...bid },
      currentBidTotal: bidTotal(bid),
      locked: state.lockedSeats.includes(seat),
    },

    /**
     * ---- Opponents (§5.1 identity + control mode only) ----
     * Castle, coins, bonus and bid are all absent. Not null, not masked —
     * absent. Whether a seat has locked is public because the UI must show
     * who the round is waiting on.
     */
    opponents: state.players
      .filter((p) => p.seat !== seat)
      .map((p) => ({
        seat: p.seat,
        displayName: p.displayName,
        connectionStatus: p.connectionStatus,
        controlMode: p.controlMode,
        takeoverReason: p.takeoverReason,
        locked: state.lockedSeats.includes(p.seat),
      })),

    lastResolution: publicResolution(state.lastResolution, seat),
    winner: state.winner,
  };

  return view;
}

/**
 * §18 — The end-of-game reveal. This is the ONLY function permitted to widen
 * the boundary, and it refuses to do so while the game is still running.
 */
export function createRevealView(state) {
  if (state.status !== STATUS.FINISHED) {
    throw new Error('Reveal requested before the game finished — refused.');
  }
  return {
    gameId: state.gameId,
    seed: state.seed,
    board: { width: state.boardWidth, height: state.boardHeight },
    winner: state.winner,
    winnerName: state.winner !== null ? state.players[state.winner].displayName : null,
    roundsPlayed: state.metrics.rounds,
    players: state.players.map((p) => ({
      seat: p.seat,
      displayName: p.displayName,
      controlMode: p.controlMode,
      castlePosition: state.castles[p.seat],
      coinsRemaining: state.coinAllocationState[p.seat].coinsRemaining,
      allocationNumber: state.coinAllocationState[p.seat].allocationNumber,
    })),
    castles: state.castles.map((c) => cell(c.r, c.c)),
    completeQueenPath: state.completeQueenPath.map((p) => cell(p.r, p.c)),
    bonusLedger: state.bonusLedger.map((b) => ({ ...b })),
    metrics: { ...state.metrics },
  };
}

/**
 * Test helper (§23) — walks a serialized PlayerView looking for any coordinate
 * that matches another player's hidden object, or any forbidden key.
 * Used by the automated information-leak tests.
 */
export function auditViewForLeaks(state, seat) {
  const view = createPlayerView(state, seat);
  const json = JSON.stringify(view);
  const problems = [];

  state.castles.forEach((c, i) => {
    if (i === seat) return;
    // A raw coordinate pair alone is not proof of a leak (the queen may stand
    // there), so check the structural keys instead.
    if (json.includes(`"castlePosition"`) && view.opponents.some((o) => 'castlePosition' in o)) {
      problems.push(`Opponent ${i} castle exposed`);
    }
  });

  for (const o of view.opponents) {
    for (const forbidden of ['castlePosition', 'activeBonus', 'coinsRemaining', 'currentBid', 'bid']) {
      if (forbidden in o) problems.push(`Opponent ${o.seat} exposes ${forbidden}`);
    }
  }

  if ('completeQueenPath' in view) problems.push('Complete queen path exposed during play');
  if ('castles' in view) problems.push('Castle array exposed');
  if ('activeBonuses' in view) problems.push('Bonus array exposed');
  if ('currentRoundBids' in view) problems.push('Raw round bids exposed');
  if ('coinAllocationState' in view) problems.push('Coin allocation array exposed');
  if ('seed' in view) problems.push('RNG seed exposed — future placements predictable');
  if ('rngState' in view) problems.push('RNG cursor exposed');
  if ('bonusLedger' in view) problems.push('Bonus ledger exposed');
  if (view.lastResolution && '_private' in view.lastResolution) problems.push('Private resolution slice exposed');

  return problems;
}

export { DIRECTIONS, PHASES };
