/**
 * QUEEN'S TUG — Headless simulation harness (Spec §27)
 *
 * Runs full AI-vs-AI games and reports the exact metrics the playtesting plan
 * asks for: average game length, share of no-movement rounds, how often players
 * split bids, and how often they chase bonuses instead of castles.
 *
 *   node tools/simulate.js [games] [--coins=75] [--board=12] [--quiet]
 */

import { createGame, startGame, lockBid, resolveRound } from '../src/engine.js';
import { createPlayerView } from '../src/playerView.js';
import { decideBid } from '../src/ai.js';

const args = process.argv.slice(2);
const games = Number(args.find((a) => /^\d+$/.test(a)) || 200);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const quiet = args.includes('--quiet');

const config = {
  startingCoins: flag('coins', 75),
  replenishCoins: flag('replenish', flag('coins', 75)),
  boardWidth: flag('board', 12),
  boardHeight: flag('board', 12),
};

const MAX_ROUNDS = 500;
const results = [];

for (let g = 0; g < games; g++) {
  let s = startGame(createGame({ seed: `sim-${g}`, config }), { now: 0 });
  let rounds = 0;
  while (s.status === 'PLAYING' && rounds < MAX_ROUNDS) {
    for (let seat = 0; seat < 4; seat++) {
      const bid = decideBid(createPlayerView(s, seat), { rngSeed: `sim-${g}` });
      const r = lockBid(s, seat, bid);
      if (!r.ok) throw new Error(`Illegal AI bid: ${r.error}`);
      s = r.state;
    }
    s = resolveRound(s, { now: 0 }).state;
    rounds++;
  }
  results.push({
    finished: s.status === 'FINISHED',
    rounds,
    metrics: s.metrics,
    allocations: Math.max(...s.coinAllocationState.map((a) => a.allocationNumber)),
  });
}

const finished = results.filter((r) => r.finished);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};
const roundsList = finished.map((r) => r.rounds);
const noMove = avg(results.map((r) => r.metrics.noMoveRounds / Math.max(1, r.metrics.rounds)));
const split = avg(results.map((r) => r.metrics.splitBidDecisions / Math.max(1, r.metrics.bidDecisions)));
const bonuses = avg(results.map((r) => r.metrics.bonusesCollected));
const cellsPerRound = avg(results.map((r) => r.metrics.cellsTravelled / Math.max(1, r.metrics.rounds)));
const wallRate = avg(results.map((r) => r.metrics.wallBlocks / Math.max(1, r.metrics.rounds)));
const coinsPerBid = avg(results.map((r) => r.metrics.coinsSpent / Math.max(1, r.metrics.bidDecisions)));
const allocs = avg(results.map((r) => r.allocations));

const pct = (x) => `${(x * 100).toFixed(1)}%`;
if (!quiet) {
  console.log(`\nQueen's Tug — ${games} simulated games`);
  console.log(`board ${config.boardWidth}×${config.boardHeight}, ${config.startingCoins} starting coins\n`);
}
console.log(`  games completed        ${finished.length}/${games}  (${pct(finished.length / games)})`);
console.log(`  rounds (mean / median) ${avg(roundsList).toFixed(1)} / ${median(roundsList)}`);
console.log(`  rounds (min / max)     ${Math.min(...roundsList)} / ${Math.max(...roundsList)}`);
console.log(`  cells moved / round    ${cellsPerRound.toFixed(2)}`);
console.log(`  wall slams / round     ${pct(wallRate)}`);
console.log(`  coins per bid          ${coinsPerBid.toFixed(2)}`);
console.log(`  no-movement rounds     ${pct(noMove)}`);
console.log(`  split-bid decisions    ${pct(split)}`);
console.log(`  bonuses collected/game ${bonuses.toFixed(1)}`);
console.log(`  coin allocations used  ${allocs.toFixed(1)}`);
