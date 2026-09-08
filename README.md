# Tetris Duel

Two-player competitive Tetris over Cloudflare Workers + Durable Objects, built
from `two-player-tetris-spec.md`.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:8787` in two browser tabs (or send the invite link
from the first tab to a second browser/device on the same network). Click
**Create Room** in one tab, then **Copy Link** and open it in the other.

## Deploy

```bash
npx wrangler login   # first time only
npm run deploy
```

## How it works

- **`worker/index.ts`** — Worker entry: serves `/public` as static assets,
  mints room codes (`POST /api/create-room`), and routes `/room/:id`
  WebSocket upgrades to that room's Durable Object.
- **`worker/room.ts`** — the `Room` Durable Object: one instance per game
  room, holding both players' sockets/scores, the shared RNG seed, and the
  room lifecycle (`waiting → countdown → playing → finished`). It relays
  `state_update` / `garbage` / `game_over` messages between the two players
  and never runs game logic itself.
- **`public/game.js`** — the Tetris engine: 10×20 board, seeded 7-bag
  randomizer, SRS rotation with wall kicks, gravity/lock delay, scoring,
  garbage lines, and canvas rendering. Runs independently on each client for
  zero-lag input.
- **`public/net.js`** — thin WebSocket client wrapper around the message
  protocol.
- **`public/app.js`** — UI glue: lobby (create/join), countdown, the render
  loop, keyboard input, and the game-over/rematch flow.

## Controls

`← →` move · `↓` soft drop · `↑` / `X` rotate CW · `Z` rotate CCW ·
`Space` hard drop · `C` hold

## Scope notes vs. the spec's stretch goals

Implemented: shared-seed 7-bag fairness, garbage lines (double→1, triple→2,
tetris→4), rematch flow, opponent-disconnect banner. Not implemented (listed
as stretch goals in the spec): spectator mode, a persistent leaderboard, and
reconnect-into-an-in-progress-game.
