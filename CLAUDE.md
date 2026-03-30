# Articulate Game — CLAUDE.md

## Project Overview

A real-time multiplayer party game (inspired by the board game "Articulate!"). Players describe words while teammates guess them. A host controls the game via browser; teams join on their phones.

## Tech Stack

- **Backend:** Pure Node.js (`http` module only — zero npm dependencies)
- **Frontend:** Vanilla HTML/CSS/JavaScript (no frameworks, no build step)
- **Real-time:** Server-Sent Events (SSE) for state push, REST APIs for actions
- **State:** In-memory only — resets on server restart

## Running the Project

```bash
npm start          # runs node server.js on port 3000
PORT=8000 npm start  # custom port
```

- Host interface: `http://localhost:3000/` or `/host`
- Team interface: `http://localhost:3000/team`

No build step, no compilation, no tooling required beyond Node.js >= 18.

## Project Structure

```
articulate/
├── server.js          # HTTP server, game logic, REST API, SSE broadcast
└── public/
    ├── host.html      # Host interface (game leader, 4 tabs: game/cards/setup/room)
    └── team.html      # Team interface (join screen + live game view)
```

## Architecture

### Backend (`server.js`)

All game state lives in a single `gameState` object:

```js
{
  room, teams[{ name, score, pos }], settings: { timer, spaces, skips, move },
  gs: { turn, phase, skipsLeft }, currentCard: { word, cat, hint },
  timestamp, deckSize
}
```

Key patterns:
- `pushState()` — updates `timestamp` and broadcasts full state to all SSE clients
- `broadcast(data)` — sends SSE message to all connected clients
- `/events` — SSE endpoint; clients subscribe and receive all state updates
- All action routes are `POST`; only `/api/state` is `GET`

### Frontend

- **Host** (`host.html`): Tabs navigate via `showPg()`. All state comes from SSE; `applyState()` re-renders on every update. Circular CSS timer extrapolates from `timestamp` to avoid clock skew.
- **Teams** (`team.html`): Join screen → game screen. Card display only shown to the team whose turn it is.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Fetch full game state |
| POST | `/api/create-room` | Generate 4-letter room code |
| POST | `/api/setup` | Initialize teams & settings, shuffle deck |
| GET/POST | `/api/cards` | List / add cards |
| POST | `/api/cards/clear` | Clear all cards |
| POST | `/api/new-card` | Draw next card |
| POST | `/api/correct` | Mark correct, advance score/position |
| POST | `/api/skip` | Skip card |
| POST | `/api/end-turn` | Advance to next team |
| POST | `/api/reshuffle` | Shuffle remaining deck |
| POST | `/api/reset` | Reset scores, reshuffle |
| GET | `/events` | SSE subscription |

## Key Constraints

- No database — state is in memory, lost on restart
- No test suite — test manually via the browser interfaces
- No linter, formatter, or type checking
- No external npm packages — keep it that way
- CORS is enabled globally on all responses
