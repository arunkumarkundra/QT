# QUEEN'S TUG

**Four hidden castles. One wandering queen. Every move is a secret battle.**

An implementation of the authoritative game specification. Four players, a 12×12
board, secret simultaneous coin bidding, and a queen nobody controls alone.

---

## Run it

**Fastest way:** open `dist/queens-tug.html` in any browser. It is one file with
no dependencies, no build step and no server — the stylesheet, all seven modules
and the key art are inlined.

**Development / GitHub Pages:**

```bash
npm run serve          # http://localhost:8080
```

`index.html` loads `src/*.js` as ES modules, so it needs to be served over HTTP
rather than opened from the filesystem. Push the repository root to a GitHub
Pages branch and it works as-is; no build step is required for Pages, because
`index.html` is already the deployable artifact.

**Tests and tooling:**

```bash
npm install            # jsdom, for the UI tests only
npm test               # all three suites — 112 assertions
npm run test:rules     # the §23 rule suite alone, zero dependencies
npm run simulate 200   # headless AI games, reports the §27 metrics
npm run build          # regenerate dist/queens-tug.html from src/
```

---

## Playing

You are one of four players. Only you can see your castle. Each round, tap the
glowing cells beside the queen to drop coins on them. Everyone does this in
secret at the same time.

Opposite directions cancel. The strongest survivor drags the queen that many
cells, stopping at the wall. Win by making her **finish** a move on your castle.

**The board is the controller.** There is no bidding panel. Tapping a cell adds
one coin; tapping the *opposite* cell takes one back off the pile — pulling the
other way is the natural undo, and it means you can never waste coins paying in
two opposite directions at once. Arrow keys do the same thing; Enter locks in.

**Tuning lives in `src/config.js`**, not in a settings screen: `startingCoins`,
`replenishCoins`, `bonusStartReward`, `decisionTimerMs`, `boardWidth/Height`.

**URL parameters.** `?game=QT-XXXXXX` loads a specific board. `?turbo=0.3`
speeds up animation and AI pacing for fast playtesting — presentation only, it
cannot change an outcome.

**Sound** is synthesised with WebAudio at runtime, so there are no audio files
to ship. The speaker button mutes it and the choice is remembered.

## Architecture

```
AuthoritativeGameState        (host.js — inside a closure, unreachable)
        │
        │  createPlayerView(seat)     ← the only exit
        ▼
   PlayerView(seat)
        │
   ┌────┴────┐
   ▼         ▼
Human UI    AI
```

| File | Responsibility |
| --- | --- |
| `src/config.js` | Every tunable constant. Nothing else hard-codes a rule value. |
| `src/rng.js` | Seeded RNG whose cursor lives *inside* game state, so games replay exactly. |
| `src/engine.js` | Pure rules. No DOM, no network, no timers, no I/O. |
| `src/playerView.js` | The information boundary. Builds up permitted fields; never deletes from a copy. |
| `src/ai.js` | Computer player. Its only game input is a PlayerView. |
| `src/sound.js` | WebAudio synthesis. No audio files. |
| `src/host.js` | The authoritative "server". Owns state, runs the clock, accepts intent only. |
| `src/ui.js` | Renders views, collects input. Contains no rules. |

The UI never holds another player's data, because it is never sent one. Grep
`src/ui.js` for `castles`, `activeBonuses` or `currentRoundBids` — there are no
hits. The browser cannot display what it does not have.

**The client submits intent, never outcome.** There is deliberately no
`host.moveQueen()`, no `setQueenPosition()`, no `declareWinner()`. A tampered
client can send a malformed bid and get it rejected; it cannot send `"move Right
8"`, because no such message exists.

---

## Tests

112 assertions across three suites. The rule suite has zero dependencies and
covers every bullet in §23, each tagged with its spec section.

| Suite | Covers |
| --- | --- |
| `tests/engine.test.js` | 77 rule tests — placement, bidding, cancellation, boundary stopping, castles, bonus decay/collection/replacement, coin economy, the information boundary, determinism, the reveal. |
| `tests/host.test.js` | 13 tests that the host behaves like a server: filtered reads, rejected outcomes, refused reveals, takeover reporting. |
| `tests/ui.test.js` | 21 tests booting the built file in jsdom and playing a full game through the real DOM. |

The UI tests check the *built* file, so a broken bundle fails the suite rather
than shipping.

---

## Two findings worth your attention

### 1. The specification permits a permanent stalemate

§11 replenishes coins only when **all four** players are exhausted. §26 forbids
a game time limit. Together these allow a deadlock that no rule in the document
can break: if three players are at zero and the fourth simply declines to bid,
nothing can ever change again. Headless simulation hit this in **20% of games**
before it was addressed.

Two responses, both deliberate:

- **The AI no longer causes it.** A seat holding coins while the table spends
  nothing has *uncontested* moves available, which is a winning position, not a
  reason to stall. The AI now reads the public aggregate totals (§5.1 makes them
  public, so this is legitimate inference) and presses the advantage. Completion
  went from 80% to **100% of 200 games**.
- **The rule is unchanged by default.** `config.stalemateReplenishRounds` is
  `null` — spec-exact. Set it to `3` to replenish everyone after three
  consecutive rounds in which nobody spends. It is exposed in the lobby as an
  explicitly-labelled deviation, off by default, and `tests/engine.test.js`
  contains a test that *asserts the deadlock exists* under default settings so
  the gap cannot regress silently.

Four human players can still reach this state. It is worth a rules decision
before public playtesting.

### 2. The AI was overbidding, and it broke the feel of the game

Early builds sent the queen skidding wall to wall: **6.9 cells per round and a
boundary slam in 45% of rounds**. Three compounding causes:

- Same-direction bids **stack**. Four seats capped at 20 coins each could put 40+
  behind one direction. The AI modelled rivals only as opposition, never as
  accidental allies overshooting its target.
- Nothing punished hitting the wall, so wasted steps were free.
- Expecting heavy opposition was self-fulfilling: everyone bid big because
  everyone expected big bids.

Fixed by capping a single seat's stake to a few coins, widening the "ally" tail
of the interference model, and penalising leaving the queen on the boundary
(no castle can sit there anyway). Now **4.7 cells per round and 8% wall slams**,
with 60% of moves in the 0–3 cell range where the tug-of-war is readable.

This also revived the treasure system. Stacks decay by distance travelled, so at
seven cells a round they died before anyone could reach one. Collections per game
roughly doubled, and moving to a single 50-coin starting value (rather than a
10/20/30 band) gives every stack a life worth chasing.

---

## Playtest baseline

200 AI-vs-AI games, 12×12, 50 coins:

| Metric | Value |
| --- | --- |
| Games completed | 200 / 200 |
| Rounds, mean / median | 24.0 / 21 |
| Cells moved per round | 4.7 |
| Wall slams per round | 8.0% |
| Coins per bid | 2.0 |
| No-movement rounds | 12.6% |
| Split-bid decisions | 11.6% |
| Bonuses collected per game | 0.8 |

Reproduce with `npm run simulate 200`. Vary with `--coins=50`, `--board=10`.
These are computer players, not humans — treat them as a floor for how the
system behaves, not a prediction of how it feels. §27's remaining questions
(whether decisions are fun, whether players understand *why* the queen moved)
need real people.

---

## What is not built

**Real online multiplayer.** §14 is explicit that GitHub Pages alone cannot
provide it, and that a shared authoritative state mechanism must be identified
first. The architecture is ready for it — `host.js` is already a server that
happens to run locally, and every read is already filtered — but the transport
does not exist yet. See `TRANSPORT.md` for what remains and why the current code
does not have to change to get there.

Everything through step 21 of §25's development sequence is complete. Steps
17–18 (multiplayer sync, disconnect handling) are implemented at the state-model
level — takeover, `PlayerView` parity, safe-boundary reconnection and their
tests are all present — but not over a network.
