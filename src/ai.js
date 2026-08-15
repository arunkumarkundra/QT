/**
 * QUEEN'S TUG — Computer player (Spec §13, §25 step 16)
 *
 * HARD CONSTRAINT: this module's only game input is a PlayerView. It never
 * imports GameState, never sees another castle, bid, balance or bonus, and
 * never touches the engine's authoritative structures. If you find yourself
 * wanting more information here, the answer is no — §26 forbids it.
 *
 * Strategy summary
 * ----------------
 * The AI scores hypothetical queen positions, then picks the (direction, stake)
 * pair with the best expected value across a distribution of guessed opponent
 * interference. It cannot observe opponent bids, so interference is modelled,
 * not known. The one legitimate signal it uses is `lastResolution`, which the
 * spec makes public: if the queen was shoved somewhere last round, someone
 * wanted it there.
 */

import { DIRECTIONS, VECTORS, OPPOSITE } from './config.js';
import { standaloneRng } from './rng.js';

const abs = Math.abs;

/** Distinct temperaments so four AI seats don't play identically. */
const PERSONALITIES = [
  { name: 'Patient', margin: 1, thrift: 1.25, counter: 0.30, noise: 0.04 },
  { name: 'Forceful', margin: 4, thrift: 0.75, counter: 0.45, noise: 0.06 },
  { name: 'Opportunist', margin: 2, thrift: 1.0, counter: 0.35, noise: 0.10, bonusBias: 2.2 },
  { name: 'Blocker', margin: 2, thrift: 0.95, counter: 0.75, noise: 0.05 },
];

export function personalityFor(seat) {
  return PERSONALITIES[seat % PERSONALITIES.length];
}

/** Where the queen ends up if it is pushed `dist` cells in `dir`, wall-clamped. */
function project(view, dir, dist) {
  const v = VECTORS[dir];
  let { r, c } = view.queenPosition;
  for (let i = 0; i < dist; i++) {
    const nr = r + v.dr;
    const nc = c + v.dc;
    if (nr < 0 || nr >= view.board.height || nc < 0 || nc >= view.board.width) break;
    r = nr;
    c = nc;
  }
  return { r, c };
}

/**
 * How much the AI likes the queen standing on a given cell.
 * Landing on the castle is worth everything; standing on the castle's row or
 * column is worth a lot, because it puts a one-move kill on the table.
 */
function positionScore(pos, view, personality) {
  const castle = view.you.castlePosition;
  if (pos.r === castle.r && pos.c === castle.c) return 1e6;

  const dr = abs(pos.r - castle.r);
  const dc = abs(pos.c - castle.c);
  let score = -(dr + dc) * 30;

  // Being adjacent to the castle is worth a great deal: it puts a one-cell,
  // one-coin kill on the table next round.
  if (dr + dc === 1) score += 220;

  if (dr === 0) score += 95 - dc * 5;
  if (dc === 0) score += 95 - dr * 5;

  const bonus = view.you.activeBonus;
  if (bonus && bonus.reward > 0) {
    const bias = personality.bonusBias || 1;
    if (pos.r === bonus.position.r && pos.c === bonus.position.c) {
      score += bonus.reward * 70 * bias;
    } else {
      const br = abs(pos.r - bonus.position.r);
      const bc = abs(pos.c - bonus.position.c);
      score -= (br + bc) * bonus.reward * 0.55 * bias;
      if (br === 0 || bc === 0) score += bonus.reward * 3 * bias;
    }
  }

  /**
   * The wall is a bad place to leave the queen. No castle can ever sit on the
   * outer ring (§4.1), an edge costs the queen an escape route, and a corner
   * costs two. Without this the AI happily slams the queen into the boundary
   * because the wasted steps cost it nothing.
   */
  const edgeR = pos.r === 0 || pos.r === view.board.height - 1;
  const edgeC = pos.c === 0 || pos.c === view.board.width - 1;
  if (edgeR) score -= 70;
  if (edgeC) score -= 70;
  if (edgeR && edgeC) score -= 80;

  return score;
}

/**
 * Read how hard the table played last round. The aggregate totals are public
 * (§5.1), so this is legitimate inference, not a peek at hidden state.
 * Returns a 0–1 scale where 0 means nobody spent anything.
 */
function tablePressure(view) {
  const last = view.lastResolution;
  if (!last) return null;
  const spent = DIRECTIONS.reduce((s, d) => s + (last.totals[d] || 0), 0);
  return { spent, passive: spent === 0, quiet: spent <= 4 };
}

/** Guessed opposing pressure in a chosen direction: value → probability. */
function interferenceModel(view, dir, personality) {
  const pressure = tablePressure(view);

  /**
   * When the table spent nothing last round, the most likely explanation is
   * that the other seats are out of coins. §11 only replenishes once ALL FOUR
   * are dry, so a seat still holding coins in that situation owns uncontested
   * moves — the correct play is to take them, precisely, at minimum cost.
   */
  if (pressure?.passive) {
    return [
      { push: 0, p: 0.8 },
      { push: 2, p: 0.2 },
    ];
  }

  let base = pressure?.quiet
    ? [
        { push: -2, p: 0.18 },
        { push: 0, p: 0.40 },
        { push: 1, p: 0.27 },
        { push: 3, p: 0.15 },
      ]
    : [
        /**
         * Negative values are ALLIES, not opposition: bids in the same
         * direction stack, so a rival wanting the same thing overshoots our
         * target. With three rivals the ally tail has to be wide, otherwise
         * the AI bids for a 3-cell move and gets a 12-cell skid.
         */
        { push: -8, p: 0.08 },
        { push: -4, p: 0.13 },
        { push: -1, p: 0.19 },
        { push: 0, p: 0.20 },
        { push: 2, p: 0.20 },
        { push: 4, p: 0.13 },
        { push: 7, p: 0.07 },
      ];

  // Public signal (§5.1): last round's surviving forces. If the table pushed
  // hard in a direction, expect that pressure to persist.
  const last = view.lastResolution;
  if (last && last.surviving) {
    const against = last.surviving[OPPOSITE[dir]] || 0;
    const along = last.surviving[dir] || 0;
    const drift = (against - along) * 0.22;
    base = base.map((b) => ({ push: Math.round(b.push + drift), p: b.p }));
  }
  return base;
}

/**
 * Choose a bid. Returns a plain {UP,DOWN,LEFT,RIGHT} object of whole coins.
 * @param {object} view  A PlayerView — the same object a human client receives.
 * @param {object} opts  { rngSeed } for reproducible AI behaviour.
 */
export function decideBid(view, { rngSeed } = {}) {
  const empty = { UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0 };
  const balance = view.you.coinsRemaining;
  if (balance <= 0 || view.status !== 'PLAYING') return empty;

  const seat = view.you.seat;
  const personality = personalityFor(seat);
  const rng = standaloneRng(`${rngSeed ?? view.gameId}-${seat}-${view.roundNumber}`);

  const holdScore = positionScore(view.queenPosition, view, personality);
  const pressure = tablePressure(view);

  /**
   * Coins get more precious as the allocation drains — §11 only replenishes
   * once all four seats are empty, so running dry early is a real cost.
   * The exception is a passive table: if nobody else is spending, hoarding buys
   * nothing and a cheap uncontested move is close to free.
   */
  const scarcity = 1 + (1 - balance / Math.max(1, view.config.startingCoins)) * 2.2;
  const coinCost = pressure?.passive ? 2.5 : 15 * personality.thrift * scarcity;

  /**
   * Hard ceiling on a single round's stake. Earlier versions allowed up to 20,
   * which four seats turned into nets of 8–15 and sent the queen skidding
   * wall to wall. Small stakes make the tug-of-war legible.
   */
  /**
   * Hard ceiling on one round's stake. Four seats bidding the same direction
   * STACK, so a ceiling of 5 still produced 20-cell skids. Keeping each seat
   * to a few coins is what makes the tug-of-war readable — and it keeps bonus
   * stacks alive long enough to matter, since they decay by distance moved.
   */
  const maxStake = pressure?.passive
    ? Math.min(balance, 4)
    : Math.min(balance, Math.max(2, Math.floor(balance * 0.10)), 3);

  let best = { dir: null, amount: 0, ev: holdScore };

  for (const dir of DIRECTIONS) {
    if (!view.adjacent[dir]) continue; // §21 — no cell that way; bidding there is illegal
    const model = interferenceModel(view, dir, personality);

    for (let amount = 1; amount <= maxStake; amount++) {
      let ev = 0;
      for (const { push, p } of model) {
        const net = amount - push;
        const outcome = net > 0 ? positionScore(project(view, dir, net), view, personality) : holdScore;
        ev += p * outcome;
      }
      ev -= amount * coinCost;
      ev *= 1 + (rng.next() - 0.5) * personality.noise;

      if (ev > best.ev) best = { dir, amount, ev };
    }
  }

  /**
   * Anti-stall clause. If the whole table spent nothing last round and this
   * seat still holds coins, doing nothing again risks a permanent stalemate:
   * §11 will not replenish while this seat holds coins, and §26 forbids a game
   * time limit. A free move is never worse than no move, so take the best one
   * available even if the scoring said "hold".
   */
  if (!best.dir && pressure?.passive && balance > 0) {
    let fallback = { dir: null, amount: 0, score: -Infinity };
    for (const dir of DIRECTIONS) {
      if (!view.adjacent[dir]) continue;
      for (let amount = 1; amount <= Math.min(balance, 12); amount++) {
        const score = positionScore(project(view, dir, amount), view, personality) - amount * 0.5;
        if (score > fallback.score) fallback = { dir, amount, score };
      }
    }
    if (fallback.dir) best = { dir: fallback.dir, amount: fallback.amount, ev: fallback.score };
  }

  const bid = { ...empty };
  if (!best.dir) return bid;
  bid[best.dir] = best.amount;

  /**
   * Optional defensive split (§8: bids may be spread across directions).
   * If last round's momentum is dragging the queen away from our castle, stake
   * a little against it. This is what makes AI games show genuine tug-of-war.
   */
  const last = view.lastResolution;
  if (last && last.direction && rng.next() < personality.counter) {
    const threat = last.direction;
    const counter = OPPOSITE[threat];
    if (counter !== best.dir && view.adjacent[counter]) {
      const after = project(view, threat, Math.max(1, last.actualDistance));
      const worse = positionScore(after, view, personality) < holdScore - 20;
      const spare = balance - best.amount;
      if (worse && spare > 2) {
        bid[counter] = Math.min(spare, 4, Math.max(1, Math.round(last.actualDistance * 0.5)));
      }
    }
  }

  // Final safety: never exceed the balance the view reports.
  let total = DIRECTIONS.reduce((s, d) => s + bid[d], 0);
  while (total > balance) {
    const biggest = DIRECTIONS.reduce((a, b) => (bid[a] >= bid[b] ? a : b));
    bid[biggest] -= 1;
    total -= 1;
  }
  return bid;
}

/** Flavour text for the UI's takeover banner. */
export function aiLabel(seat) {
  return personalityFor(seat).name;
}
