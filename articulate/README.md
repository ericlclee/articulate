# Articulate! — Multiplayer Game

## Deploy to Railway (free, ~2 minutes)

### Step 1 — Create a GitHub repo
1. Go to https://github.com/new
2. Name it `articulate-game`, set to **Public** or Private
3. Click **Create repository**

### Step 2 — Upload these files
Drag and drop the files into GitHub (or use git):
```
articulate-game/
├── server.js
├── package.json
└── public/
    ├── host.html
    └── team.html
```

### Step 3 — Deploy on Railway
1. Go to https://railway.app and sign up (GitHub login is easiest)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `articulate-game` repo
4. Railway auto-detects Node.js and deploys it
5. Click **Generate Domain** to get a public URL like `articulate-game.up.railway.app`

That's it! No config needed.

---

## How to play

### Host (you, on your laptop)
- Open `https://your-app.railway.app/host` (or just `/`)
- Go to **Room** tab → click **Create new room** → share the 4-letter code
- Go to **Cards** tab → add your cards
- Go to **Setup** → name your teams → **Save & new game**
- Run the game from the **Game** tab

### Teams (everyone else, on their phones)
- Open `https://your-app.railway.app/team`
- Enter the room code + pick their team → **Join game**
- They see: their card (only on their turn), the timer, and all scores

---

## Architecture
- **server.js** — Node.js HTTP server, no dependencies
- **Server-Sent Events (SSE)** — real-time push from server to all clients
- **REST API** — host sends actions (new card, correct, skip, etc.)
- State lives in memory on the server (resets on redeploy)
