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
npm test               # all four suites — 116 assertions
npm run test:rules     # the §23 rule suite alone, zero dependencies
npm run simulate 200   # headless AI games, reports the §27 metrics
npm run build          # regenerate dist/queens-tug.html from src/
```

---

## Playing

You are one of four players. Only you know where your castle is. Each round you
place coins on the four cells around the queen, then lock. Every player does the
same in secret.

Opposite directions cancel. The strongest survivor wins and moves the queen that
many cells — stopping dead at the wall, with the excess discarded. Two equal
survivors mean the queen does not move, and every coin is still spent.

You win by making the queen **finish** a move on your castle. Sailing over it
does nothing.

**Controls.** Click a highlighted cell or an arrow pad to stake. Shift-click or
right-click removes. Arrow keys stake, Enter locks, Backspace clears, and keys
1/2/3 switch between staking 1, 5 and 10 at a time.

**Modes.** One human against three computer players, or up to four humans
sharing a device. With multiple humans a handoff curtain covers the screen
between turns, so nobody sees anyone else's castle or bonus.

**URL parameters.** `?game=QT-XXXXXX` seeds a specific board. `?turbo=0.3`
speeds up animation and AI pacing for fast playtest sessions — presentation
only, it cannot change an outcome.

---

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

116 assertions across four suites. The rule suite has zero dependencies and
covers every bullet in §23, each tagged with its spec section.

| Suite | Covers |
| --- | --- |
| `tests/engine.test.js` | 77 rule tests — placement, bidding, cancellation, boundary stopping, castles, bonus decay/collection/replacement, coin economy, the information boundary, determinism, the reveal. |
| `tests/host.test.js` | 13 tests that the host behaves like a server: filtered reads, rejected outcomes, refused reveals, takeover reporting. |
| `tests/ui.test.js` | 18 tests booting the built file in jsdom and playing a full game through the real DOM. |
| `tests/passplay.test.js` | 8 tests that the handoff curtain never puts two players' castles on screen at once. |

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

### 2. Bonuses are currently near-inert

Across 200 AI games, **0.4 bonuses were collected per game**. The cause is
structural rather than a tuning error: a bonus must be landed on *exactly*, it
decays by the queen's full travel distance every round, and four players pulling
in different directions make precise landings rare. A 30-coin bonus typically
dies in five or six rounds without anyone getting near it.

This is a live question for §27 — "how often players pursue private bonuses
instead of castles" currently answers "almost never." Candidate levers, all
configuration rather than rule changes: raise the reward band, slow the decay
rate, or reduce it to a fraction of distance moved. No change has been made,
since the spec is explicit about the values.

---

## Playtest baseline

200 AI-vs-AI games, 12×12, 75 coins, spec defaults:

| Metric | Value |
| --- | --- |
| Games completed | 200 / 200 |
| Rounds, mean / median | 27.9 / 22 |
| Rounds, min / max | 7 / 93 |
| No-movement rounds | 8.0% |
| Split-bid decisions | 6.2% |
| Bonuses collected per game | 0.4 |
| Coin allocations used | 1.3 |

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
