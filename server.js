const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

let gameState = {
  room: null,
  phase: 'lobby', // 'lobby' | 'active' | 'done'
  teams: [],      // { name, pos, connected, activeEffect }
  settings: { timer: 60, spaces: 49, skips: 1, effectInterval: 0, eventFrequency: 0, eventHidden: true },
  gs: { turn: 0, phase: 'waiting', turnScore: 0, skipsLeft: 1 }, // gs.phase: 'waiting' | 'playing' | 'between-turns'
  currentCard: null,
  timestamp: null,
  deckSize: 0,
  activeEvent: null,         // { text } — currently displayed event announcement
  eventTiles: [],            // randomly generated event tile positions
  eventTilesUsed: []         // positions where events have already been triggered
};

// Colours assigned to categories in order of first appearance
const PALETTE = ['#4a9eff','#ff6b6b','#52c97a','#f5a623','#26c6da','#c57aff','#ff9f43','#a29bfe','#fd79a8','#55efc4'];

function getCategories() {
  const seen = new Map();
  for (const c of cards) {
    if (c.cat && !seen.has(c.cat)) seen.set(c.cat, PALETTE[seen.size % PALETTE.length]);
  }
  return Array.from(seen.entries()).map(([name, color]) => ({ name, color }));
}


let cards = [];
let deck = [];
let catDecks = {};   // per-category shuffle pools (unseen cards only)
let seenCards = {};  // per-category set of seen card words
let turnHistory = []; // [{ turn, teams: [{score,pos},...] }]
let effectCards = [];
let effectDeck = [];
let seenEffects = new Set();
let eventCards = [];
let eventDeck = [];
let seenEvents = new Set();
let eventTilesUsed = new Set(); // track consumed event tile positions
const sseClients = new Set();

function getCat(pos) {
  const cats = getCategories().map(c => c.name);
  if (!cats.length) return null;
  return cats[((pos - 1) % cats.length + cats.length) % cats.length];
}

function drawCardForPos(pos) {
  const cat = getCat(pos);
  const catCards = cards.filter(c => c.cat === cat);
  if (!catCards.length) return drawCard(); // fallback if category has no cards
  if (!seenCards[cat]) seenCards[cat] = new Set();
  // Refill from unseen cards; if all seen, reset and use full set
  if (!catDecks[cat] || !catDecks[cat].length) {
    const unseen = catCards.filter(c => !seenCards[cat].has(c.word));
    if (!unseen.length) return null; // all cards in this category exhausted
    catDecks[cat] = shuffle(unseen);
  }
  const card = catDecks[cat].pop();
  seenCards[cat].add(card.word);
  return card;
}

function resetCatDecks() {
  catDecks = {};
  seenCards = {};
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

// Recompute team.status for all teams based on current game state.
// status: 'idle' | 'pre-turn' | 'guessing' | 'post-turn'
// 'post-turn' only occurs within gs.phase === 'between-turns'
function setTeamStatuses() {
  const { teams, gs, phase } = gameState;
  teams.forEach((team, i) => {
    if (phase !== 'active') { team.status = 'idle'; return; }
    if (i !== gs.turn) { team.status = 'idle'; return; }
    if (gs.phase === 'between-turns') {
      team.status = team.pendingEffect ? 'post-turn' : 'idle';
      return;
    }
    if (gs.phase === 'playing') { team.status = 'guessing'; return; }
    team.status = 'pre-turn';
  });
}

// Generate random event tile positions based on frequency (1-10).
// Higher frequency = more tiles. Each eligible tile has a (frequency * 5)% chance.
function generateEventTiles() {
  const freq = parseInt(gameState.settings.eventFrequency) || 0;
  if (freq <= 0) { gameState.eventTiles = []; return; }
  const spaces = parseInt(gameState.settings.spaces);
  const effectInterval = parseInt(gameState.settings.effectInterval) || 0;
  const chance = freq * 0.05; // freq 1 = 5%, freq 5 = 25%, freq 10 = 50%
  const tiles = [];
  for (let pos = 2; pos < spaces; pos++) {
    // Skip effect tiles
    if (effectInterval > 0 && pos % effectInterval === 0) continue;
    if (Math.random() < chance) tiles.push(pos);
  }
  gameState.eventTiles = tiles;
}

function isEventTile(pos) {
  if (!gameState.eventTiles.includes(pos)) return false;
  if (eventTilesUsed.has(pos)) return false;
  return true;
}

// Try to trigger an event at the given position. Returns true if event was triggered.
function tryTriggerEvent(pos) {
  if (!isEventTile(pos)) return false;
  const event = drawEvent();
  if (!event) return false;
  eventTilesUsed.add(pos);
  gameState.eventTilesUsed = Array.from(eventTilesUsed);
  gameState.activeEvent = { text: event.text, pos };
  return true;
}

function pushState() {
  setTeamStatuses();
  gameState.deckSize = deck.length;
  gameState.eventTilesUsed = Array.from(eventTilesUsed);
  broadcast({ type: 'state', payload: gameState });
}

function genCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function drawCard() {
  if (!deck.length) deck = shuffle(cards);
  if (!deck.length) return null;
  return deck.pop();
}

function drawEffect() {
  if (!effectDeck.length) {
    // Recycle — reshuffle all cards and reset seen tracking
    seenEffects.clear();
    effectDeck = shuffle(effectCards);
  }
  if (!effectDeck.length) return null;
  const card = effectDeck.pop();
  seenEffects.add(card.text);
  return card;
}

function drawEvent() {
  if (!eventDeck.length) {
    // Recycle — reshuffle all cards and reset seen tracking
    seenEvents.clear();
    eventDeck = shuffle(eventCards);
  }
  if (!eventDeck.length) return null;
  const card = eventDeck.pop();
  seenEvents.add(card.text);
  return card;
}

function snapshotTeams() {
  return gameState.teams.map(t => ({ pos: t.pos }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const p = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // SSE
  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'state', payload: { ...gameState, deckSize: deck.length } })}\n\n`);
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ka); sseClients.delete(res); } }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    return json(res, { ...gameState, deckSize: deck.length });
  }

  // Create room — resets lobby, keeps cards & settings
  if (p === '/api/create-room' && req.method === 'POST') {
    gameState = {
      room: genCode(),
      phase: 'lobby',
      teams: [],
      settings: { ...gameState.settings },
      gs: { turn: 0, phase: 'waiting', turnScore: 0, skipsLeft: gameState.settings.skips || 1 },
      currentCard: null,
      timestamp: null,
      deckSize: deck.length
    };
    turnHistory = [];
    pushState();
    return json(res, { room: gameState.room });
  }

  // Join or create team
  if (p === '/api/join-team' && req.method === 'POST') {
    const { name } = await readBody(req);
    if (!name || !name.trim()) return json(res, { error: 'Name required' }, 400);
    if (!gameState.room) return json(res, { error: 'No room open' }, 400);

    const trimmed = name.trim();

    if (gameState.phase === 'lobby') {
      if (gameState.teams.length >= 6) return json(res, { error: 'Max 6 teams' }, 400);
      // Prevent duplicate names
      if (gameState.teams.some(t => t.name.toLowerCase() === trimmed.toLowerCase())) {
        return json(res, { error: 'Team name taken' }, 400);
      }
      const idx = gameState.teams.length;
      gameState.teams.push({ name: trimmed, pos: 1, connected: true, status: 'idle', activeEffect: null, pendingEffect: false });
      pushState();
      return json(res, { ok: true, teamIdx: idx, teamName: trimmed });
    }

    if (gameState.phase === 'active' || gameState.phase === 'done') {
      const idx = gameState.teams.findIndex(t => t.name.toLowerCase() === trimmed.toLowerCase());
      if (idx < 0) return json(res, { error: 'Team not found — game already started' }, 404);
      gameState.teams[idx].connected = true;
      pushState();
      return json(res, { ok: true, teamIdx: idx, teamName: gameState.teams[idx].name });
    }

    return json(res, { error: 'Cannot join' }, 400);
  }

  // Host: start game
  if (p === '/api/start-game' && req.method === 'POST') {
    if (gameState.phase !== 'lobby') return json(res, { error: 'Not in lobby' }, 400);
    if (gameState.teams.length < 2) return json(res, { error: 'Need at least 2 teams' }, 400);
    gameState.phase = 'active';
    gameState.gs = { turn: 0, phase: 'waiting', turnScore: 0, skipsLeft: gameState.settings.skips || 1 };
    gameState.currentCard = null;
    gameState.timestamp = null;
    gameState.activeEvent = null;
    deck = shuffle(cards);
    resetCatDecks();
    effectDeck = shuffle(effectCards); seenEffects.clear();
    eventDeck = shuffle(eventCards); seenEvents.clear();
    eventTilesUsed = new Set();
    generateEventTiles();
    turnHistory = [];
    pushState();
    return json(res, { ok: true });
  }

  // Team: draw a card (starts their turn timer)
  if (p === '/api/new-card' && req.method === 'POST') {
    if (gameState.phase !== 'active') return json(res, { error: 'Game not active' }, 400);
    if (gameState.gs.phase !== 'waiting') return json(res, { error: gameState.gs.phase === 'between-turns' ? 'Turn is between rounds' : 'Card already active' }, 400);
    const t = gameState.gs.turn;
    const card = drawCardForPos(gameState.teams[t].pos);
    if (!card) return json(res, { error: 'All cards in this category have been seen' }, 400);
    gameState.currentCard = card;
    gameState.gs.phase = 'playing';
    gameState.timestamp = Date.now();
    pushState();
    return json(res, { ok: true });
  }

  // Team: skip card — draw next card from same category, costs one skip
  if (p === '/api/skip-card' && req.method === 'POST') {
    if (gameState.phase !== 'active') return json(res, { error: 'Game not active' }, 400);
    if (gameState.gs.phase !== 'playing') return json(res, { error: 'No active card' }, 400);
    if (gameState.gs.skipsLeft <= 0) return json(res, { error: 'No skips left' }, 400);
    const t = gameState.gs.turn;
    gameState.gs.skipsLeft--;
    const card = drawCardForPos(gameState.teams[t].pos);
    gameState.currentCard = card || null;
    // Keep phase as 'playing' so timer and turn continue even if cards exhausted
    pushState();
    return json(res, { ok: true });
  }

  // Team: correct answer — accumulate turn score, auto-draw next card from same category
  if (p === '/api/correct' && req.method === 'POST') {
    if (gameState.phase !== 'active') return json(res, { error: 'Game not active' }, 400);
    const t = gameState.gs.turn;
    gameState.gs.turnScore++;
    const card = drawCardForPos(gameState.teams[t].pos); // same pos = same category
    gameState.currentCard = card || null;
    // Keep phase as 'playing' so timer and turn continue even if cards exhausted
    pushState();
    return json(res, { ok: true });
  }

  // Team or host: end turn — apply accumulated turnScore to position
  if (p === '/api/end-turn' && req.method === 'POST') {
    const t = gameState.gs.turn;
    turnHistory.push({ turn: t, teams: snapshotTeams() });
    if (turnHistory.length > 20) turnHistory.shift();
    const spaces = parseInt(gameState.settings.spaces);
    gameState.teams[t].pos = Math.min(gameState.teams[t].pos + gameState.gs.turnScore, spaces);
    if (gameState.teams[t].pos >= spaces) {
      gameState.phase = 'done';
      gameState.currentCard = null;
      gameState.gs.phase = 'waiting';
      gameState.gs.turnScore = 0;
      gameState.gs.skipsLeft = gameState.settings.skips || 1;
      gameState.timestamp = null;
      pushState();
      return json(res, { ok: true, winner: gameState.teams[t].name });
    }
    // Enter between-turns — game takes control for checks before advancing
    gameState.gs.phase = 'between-turns';
    gameState.gs.turnScore = 0;
    gameState.gs.skipsLeft = gameState.settings.skips || 1;
    gameState.currentCard = null;
    gameState.timestamp = null;

    // Check: did team land on an effect tile?
    const effectInterval = parseInt(gameState.settings.effectInterval) || 0;
    if (effectInterval > 0 && gameState.teams[t].pos % effectInterval === 0) {
      gameState.teams[t].activeEffect = null; // clear any existing effect before assigning new one
      gameState.teams[t].pendingEffect = true;
      pushState();
      return json(res, { ok: true, pendingEffect: true });
    }

    // No effect — check for event tile
    gameState.teams[t].activeEffect = null;
    gameState.teams[t].pendingEffect = false;
    if (tryTriggerEvent(gameState.teams[t].pos)) {
      pushState();
      return json(res, { ok: true, activeEvent: true });
    }

    // No checks triggered — auto-advance to next team
    gameState.gs.turn = (gameState.gs.turn + 1) % gameState.teams.length;
    gameState.gs.phase = 'waiting';
    pushState();
    return json(res, { ok: true });
  }

  // Host: directly set a team's position (drag-and-drop)
  if (p === '/api/set-position' && req.method === 'POST') {
    const { teamIdx, pos } = await readBody(req);
    if (gameState.phase !== 'active') return json(res, { error: 'Game not active' }, 400);
    if (teamIdx < 0 || teamIdx >= gameState.teams.length) return json(res, { error: 'Invalid team' }, 400);
    const spaces = parseInt(gameState.settings.spaces);
    gameState.teams[teamIdx].pos = Math.min(Math.max(1, parseInt(pos)), spaces);
    pushState();
    return json(res, { ok: true });
  }

  // Host debug: skip current team's turn (no scoring)
  if (p === '/api/skip-turn' && req.method === 'POST') {
    turnHistory.push({ turn: gameState.gs.turn, teams: snapshotTeams() });
    if (turnHistory.length > 20) turnHistory.shift();
    gameState.gs.turn = (gameState.gs.turn + 1) % gameState.teams.length;
    gameState.gs.phase = 'waiting';
    gameState.gs.turnScore = 0;
    gameState.gs.skipsLeft = gameState.settings.skips || 1;
    gameState.currentCard = null;
    gameState.timestamp = null;
    pushState();
    return json(res, { ok: true });
  }

  // Host debug: undo last turn (restore scores + go back)
  if (p === '/api/undo-turn' && req.method === 'POST') {
    if (!turnHistory.length) return json(res, { error: 'Nothing to undo' }, 400);
    const last = turnHistory.pop();
    gameState.gs.turn = last.turn;
    gameState.gs.phase = 'waiting';
    gameState.currentCard = null;
    gameState.timestamp = null;
    last.teams.forEach((snap, i) => {
      if (gameState.teams[i]) { gameState.teams[i].pos = snap.pos; }
    });
    if (gameState.phase === 'done') gameState.phase = 'active';
    pushState();
    return json(res, { ok: true });
  }

  // Cards
  if (p === '/api/categories' && req.method === 'GET') return json(res, getCategories());
  if (p === '/api/cards' && req.method === 'GET') return json(res, cards);
  if (p === '/api/cards' && req.method === 'POST') {
    const body = await readBody(req);
    const newCards = Array.isArray(body) ? body : body.word ? [{ word: body.word, cat: body.cat || 'Object' }] : [];
    // Add new cards to the master list, then merge only unseen ones into category decks
    cards = Array.isArray(body) ? body : [...cards, ...newCards];
    for (const c of newCards) {
      if (!c.cat || !c.word) continue;
      if (!seenCards[c.cat]) seenCards[c.cat] = new Set();
      if (seenCards[c.cat].has(c.word)) continue; // already seen this game
      if (!catDecks[c.cat]) catDecks[c.cat] = [];
      catDecks[c.cat].push(c);
    }
    // Reshuffle each affected category deck so new cards are mixed in
    for (const cat of new Set(newCards.map(c => c.cat))) {
      if (catDecks[cat]) catDecks[cat] = shuffle(catDecks[cat]);
    }
    pushState();
    return json(res, { ok: true, count: cards.length });
  }
  if (p === '/api/cards/clear' && req.method === 'POST') {
    cards = []; deck = []; resetCatDecks();
    pushState();
    return json(res, { ok: true });
  }

  // Settings
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.timer) gameState.settings.timer = parseInt(body.timer);
    if (body.spaces) gameState.settings.spaces = parseInt(body.spaces);
    if (body.skips !== undefined) gameState.settings.skips = parseInt(body.skips);
    if (body.effectInterval !== undefined) gameState.settings.effectInterval = parseInt(body.effectInterval);
    if (body.eventFrequency !== undefined) gameState.settings.eventFrequency = Math.max(0, Math.min(10, parseInt(body.eventFrequency) || 0));
    if (body.eventHidden !== undefined) gameState.settings.eventHidden = body.eventHidden === true || body.eventHidden === 'true';
    if (body.eventFrequency !== undefined || body.spaces !== undefined) {
      eventTilesUsed = new Set();
      generateEventTiles();
    }
    pushState();
    return json(res, { ok: true });
  }

  // Team: draw effect card — reveals the effect, turn advances separately via /api/advance-turn
  if (p === '/api/draw-effect' && req.method === 'POST') {
    const t = gameState.gs.turn;
    if (!gameState.teams[t] || !gameState.teams[t].pendingEffect) return json(res, { error: 'No pending effect' }, 400);
    const effect = drawEffect();
    gameState.teams[t].pendingEffect = false;
    if (effect) gameState.teams[t].activeEffect = effect;
    pushState();
    return json(res, { ok: true, effect });
  }

  // Advance turn — moves from between-turns to the next team's pre-turn
  if (p === '/api/advance-turn' && req.method === 'POST') {
    if (gameState.gs.phase !== 'between-turns') return json(res, { error: 'Not in between-turns phase' }, 400);
    const t = gameState.gs.turn;
    gameState.teams[t].pendingEffect = false; // ensure clean state on outgoing team

    // After effect, check for event tile before advancing
    if (!gameState.activeEvent && tryTriggerEvent(gameState.teams[t].pos)) {
      pushState();
      return json(res, { ok: true, activeEvent: true });
    }

    gameState.gs.turn = (gameState.gs.turn + 1) % gameState.teams.length;
    gameState.gs.phase = 'waiting';
    pushState();
    return json(res, { ok: true });
  }

  // Host: dismiss active event — clears event, advances turn
  if (p === '/api/dismiss-event' && req.method === 'POST') {
    if (!gameState.activeEvent) return json(res, { error: 'No active event' }, 400);
    gameState.activeEvent = null;
    // Advance to next team
    const t = gameState.gs.turn;
    gameState.teams[t].pendingEffect = false;
    gameState.gs.turn = (gameState.gs.turn + 1) % gameState.teams.length;
    gameState.gs.phase = 'waiting';
    pushState();
    return json(res, { ok: true });
  }

  // Effect cards
  if (p === '/api/effect-cards' && req.method === 'GET') return json(res, effectCards);
  if (p === '/api/effect-cards' && req.method === 'POST') {
    const body = await readBody(req);
    const newCards = Array.isArray(body) ? body : body.text ? [{ text: body.text }] : [];
    effectCards = Array.isArray(body) ? body : [...effectCards, ...newCards];
    for (const c of newCards) {
      if (!c.text || seenEffects.has(c.text)) continue;
      effectDeck.push(c);
    }
    effectDeck = shuffle(effectDeck);
    return json(res, { ok: true, count: effectCards.length });
  }
  if (p === '/api/effect-cards/clear' && req.method === 'POST') {
    effectCards = []; effectDeck = []; seenEffects.clear();
    return json(res, { ok: true });
  }

  // Event cards
  if (p === '/api/event-cards' && req.method === 'GET') return json(res, eventCards);
  if (p === '/api/event-cards' && req.method === 'POST') {
    const body = await readBody(req);
    const newCards = Array.isArray(body) ? body : body.text ? [{ text: body.text }] : [];
    eventCards = Array.isArray(body) ? body : [...eventCards, ...newCards];
    for (const c of newCards) {
      if (!c.text || seenEvents.has(c.text)) continue;
      eventDeck.push(c);
    }
    eventDeck = shuffle(eventDeck);
    return json(res, { ok: true, count: eventCards.length });
  }
  if (p === '/api/event-cards/clear' && req.method === 'POST') {
    eventCards = []; eventDeck = []; seenEvents.clear();
    return json(res, { ok: true });
  }

  // Reset game (keep teams, reset scores)
  if (p === '/api/reset' && req.method === 'POST') {
    gameState.teams.forEach(t => { t.pos = 1; t.activeEffect = null; t.pendingEffect = false; });
    gameState.gs = { turn: 0, phase: 'waiting', turnScore: 0, skipsLeft: gameState.settings.skips || 1 };
    gameState.currentCard = null;
    gameState.timestamp = null;
    gameState.activeEvent = null;
    gameState.phase = 'active';
    deck = shuffle(cards);
    resetCatDecks();
    effectDeck = shuffle(effectCards); seenEffects.clear();
    eventDeck = shuffle(eventCards); seenEvents.clear();
    eventTilesUsed = new Set();
    generateEventTiles();
    turnHistory = [];
    pushState();
    return json(res, { ok: true });
  }

  // Static
  if (p === '/' || p === '/host') return serveFile(res, path.join(__dirname, 'public', 'host.html'), 'text/html');
  if (p === '/team') return serveFile(res, path.join(__dirname, 'public', 'team.html'), 'text/html');
  if (p === '/debug') return serveFile(res, path.join(__dirname, 'public', 'debug.html'), 'text/html');

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Articulate server on port ${PORT}`));
