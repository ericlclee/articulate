# Articulate Game — CLAUDE.md

## Project Overview

A real-time multiplayer party game (inspired by the board game "Articulate!"). One device per team — teams join a lobby, the host starts the game, and team devices control their own turn flow. The host monitors a physical-style board and has debug controls.

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
├── sample-cards.json  # 60 sample cards (10 per category) for import
└── public/
    ├── host.html      # Host interface (lobby, board, debug, cards, settings)
    └── team.html      # Team interface (join/lobby/game)
```

## Game Flow

### Phase: `lobby`
1. Host creates a room (4-letter code) via **New room**
2. Teams navigate to `/team`, enter the code and a team name → creates their team slot
3. Host sees teams appear in the lobby list in real time
4. Host clicks **Start game** (requires ≥2 teams) → moves to `active`

### Phase: `active`
- One device per team controls that team's turn
- When it's your turn: press **Get card** → starts the timer
- Cards are drawn from the **active category** only (determined by the team's current position)
- **Correct** → `turnScore+1`, auto-draws next card from same category (timer keeps running, position does NOT change mid-turn)
- **End turn** (or timer expiring) → applies `turnScore` to position, passes to next team, checks for winner
- Teams rejoining during an active game must enter their exact team name

### Phase: `done`
- First team whose position reaches `settings.spaces` after an end-turn wins
- Host can reset positions to play again

## Architecture

### Game State

```js
{
  room,              // 4-letter code or null
  phase,             // 'lobby' | 'active' | 'done'
  teams: [{
    name, pos, connected
  }],
  settings: { timer: 60, spaces: 49 },
  gs: {
    turn,            // index of active team
    phase,           // 'waiting' | 'playing'
    turnScore        // correct answers this turn (applied to pos on end-turn)
  },
  currentCard: { word, cat, hint } | null,
  timestamp,         // Date.now() when current card was drawn (for timer sync)
  deckSize
}
```

Key patterns:
- `pushState()` — broadcasts full state to all SSE clients
- `turnHistory` (server-only) — array of `{ turn, teams: [{pos}] }` snapshots for undo (last 20)
- Timer sync: clients compute `elapsed = Date.now() - timestamp` to extrapolate countdown
- `catDecks` (server-only) — per-category shuffle pools; each category cycles independently

### Board

Tiles 1 (start) through `settings.spaces` (win), default 49 (7×7). Categories cycle `['Object','Action','World','Person','Nature','Random']` by position (`pos=1` → Object, `pos=2` → Action, etc.). Rendered as a snake (alternating row direction, `ceil(√spaces)` tiles per row) in the host view. Tile size scales dynamically to fill the board card container via `ResizeObserver`.

### Category colours

```js
{ Object:'#4a9eff', Action:'#ff6b6b', World:'#52c97a', Person:'#f5a623', Nature:'#26c6da', Random:'#c57aff' }
```

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/state` | Fetch full game state |
| POST | `/api/create-room` | Reset lobby, generate new room code |
| POST | `/api/join-team` | Lobby: create team. Active: rejoin by name |
| POST | `/api/start-game` | Host: move from lobby → active |
| POST | `/api/new-card` | Team: draw card from active category, start timer |
| POST | `/api/correct` | Team: increment turnScore, auto-draw next card (same category) |
| POST | `/api/end-turn` | Team/host: apply turnScore to pos, check winner, advance turn |
| POST | `/api/skip-turn` | Host debug: skip current turn (no position change) |
| POST | `/api/undo-turn` | Host debug: restore previous turn's positions |
| POST | `/api/reset` | Reset all positions, reshuffle, phase → active |
| GET/POST | `/api/cards` | List / add cards |
| POST | `/api/cards/clear` | Clear all cards |
| POST | `/api/settings` | Update timer and spaces |
| GET | `/events` | SSE subscription |

## Key Constraints

- No database — state is in memory, lost on restart
- No test suite — test manually via the browser interfaces
- No linter, formatter, or type checking
- No external npm packages — keep it that way
- CORS is enabled globally on all responses
