# Multiplayer transport — what remains

Spec §14 requires that a shared authoritative state mechanism be **identified
before** real online multiplayer is enabled, and warns against assuming GitHub
Pages can provide it. This document is that identification step.

## Why almost nothing has to change

`src/host.js` is already a server. It owns `GameState` inside a closure, runs
its own clock, validates every submission against the authoritative balance and
board, and exposes exactly two kinds of operation:

```
reads   getView(seat) → PlayerView      already filtered
        getPublicSummary()              already public-only
        getReveal()                     refuses until the game ends

writes  stageBid(seat, bid)             intent
        lock(seat)                      intent
        setControl(seat, mode)          intent
```

That surface is already a network protocol. It takes JSON in and returns JSON
out. Moving it off the device means running the same module somewhere trusted
and putting a wire between the two halves — not rewriting the game.

Critically, the filtering already happens **before** data would hit the wire.
§14.1 says never send hidden information to the browser merely because the
browser promises not to display it; because `getView` builds a PlayerView from
scratch rather than deleting fields from a copy, serializing its output is safe
by construction.

## What has to be built

### 1. A trusted execution environment

The resolver must run where no single player can alter its inputs (§14, §24).
Free-tier options that fit a round-based game:

| Option | Shape | Notes |
| --- | --- | --- |
| Cloudflare Workers + Durable Objects | One Durable Object per game | Best fit. A single-threaded object per game is exactly the concurrency model the engine assumes. WebSocket support included. |
| Supabase (Postgres + Realtime) | State in a row, resolution in an Edge Function | Generous free tier. Needs row-level security so a client can only read its own view. |
| Firebase Realtime DB + Cloud Functions | State in the tree, resolution in a function | Workable, but the default security-rules model makes per-seat filtering fiddly. |

### 2. Per-seat serialization

Broadcast is the wrong primitive here. Each connected client gets its own
message built from its own `getView(seat)`. Nothing is ever sent to all four
sockets except `getPublicSummary()`.

```js
for (const [seat, socket] of connections) {
  socket.send(JSON.stringify({ type: 'view', view: host.getView(seat) }));
}
```

### 3. Session identity

`?game=QT-XXXXXX` currently seeds a board. For real multiplayer it must also
resolve to a server-side session, and a separate per-player token must
authenticate seat ownership — otherwise any player could submit as any seat.
§20 requires that hidden state never travel in the URL; the seat token must
therefore be issued on join, not derived from the game code.

### 4. Authoritative time

§24 requires server timestamps for deadlines. `timerDeadline` is already in
game state and already produced by the host, so clients should render a
countdown against a server-provided deadline and never lock a round themselves.
The host already ignores late submissions — `validateBid` rejects anything
outside `PLAN`.

### 5. Reconnection

The state model is done: `setControl`, `simulateDisconnect`, `simulateReconnect`
and the safe-boundary rule from §21 are implemented and tested. What is missing
is only the socket lifecycle that calls them — a disconnect handler that flips a
seat to AI, and a rejoin handler that flips it back at the next round boundary
without disturbing a locked bid.

## What must not change

- The client must never gain a way to submit an outcome. Keep the write surface
  to `stageBid` / `lock`.
- `createPlayerView` stays the only exit from authoritative state. If a new
  field is needed on the client, add it to the view builder explicitly — never
  widen by copying state and deleting keys.
- The seed must not reach clients. `tests/engine.test.js` asserts this; a leaked
  seed makes every future castle and bonus placement predictable.
- Randomness stays authoritative (§17). Clients must never roll for anything.

## Suggested order

1. Stand up one Durable Object per game wrapping the existing `createHost`.
2. Replace the UI's direct `app.host` reference with a transport shim exposing
   the same method names. Nothing in `ui.js` needs to know the difference.
3. Add join tokens and seat authentication.
4. Move the clock server-side; make the client render, not enforce, deadlines.
5. Wire disconnect/reconnect to the existing control-mode functions.
6. Re-run `tests/engine.test.js` and `tests/host.test.js` against the remote
   host, plus a new test asserting that a socket for seat 0 never receives bytes
   containing seat 1's castle.
