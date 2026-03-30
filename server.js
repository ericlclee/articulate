const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

let gameState = {
  room: null,
  phase: 'lobby', // 'lobby' | 'active' | 'done'
  teams: [],      // { name, score, pos, connected }
  settings: { timer: 60, spaces: 49 },
  gs: { turn: 0, phase: 'waiting', turnScore: 0 }, // gs.phase: 'waiting' | 'playing'
  currentCard: null,
  timestamp: null,
  deckSize: 0
};

const CATS = ['Object','Action','World','Person','Nature','Random'];

let cards = [];
let deck = [];
let catDecks = {}; // per-category shuffle pools
let turnHistory = []; // [{ turn, teams: [{score,pos},...] }]
const sseClients = new Set();

function getCat(pos) {
  return CATS[((pos - 1) % CATS.length + CATS.length) % CATS.length];
}

function drawCardForPos(pos) {
  const cat = getCat(pos);
  const catCards = cards.filter(c => c.cat === cat);
  if (!catCards.length) return drawCard(); // fallback if category has no cards
  if (!catDecks[cat] || !catDecks[cat].length) catDecks[cat] = shuffle(catCards);
  return catDecks[cat].pop();
}

function resetCatDecks() {
  catDecks = {};
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

function pushState() {
  gameState.deckSize = deck.length;
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
      gs: { turn: 0, phase: 'waiting', turnScore: 0 },
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
      gameState.teams.push({ name: trimmed, pos: 1, connected: true });
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
    gameState.gs = { turn: 0, phase: 'waiting', turnScore: 0 };
    gameState.currentCard = null;
    gameState.timestamp = null;
    deck = shuffle(cards);
    resetCatDecks();
    turnHistory = [];
    pushState();
    return json(res, { ok: true });
  }

  // Team: draw a card (starts their turn timer)
  if (p === '/api/new-card' && req.method === 'POST') {
    if (gameState.phase !== 'active') return json(res, { error: 'Game not active' }, 400);
    if (gameState.gs.phase !== 'waiting') return json(res, { error: 'Card already active' }, 400);
    const t = gameState.gs.turn;
    const card = drawCardForPos(gameState.teams[t].pos);
    if (!card) return json(res, { error: 'No cards' }, 400);
    gameState.currentCard = card;
    gameState.gs.phase = 'playing';
    gameState.timestamp = Date.now();
    pushState();
    return json(res, { ok: true });
  }

  // Team: correct answer — accumulate turn score, auto-draw next card from same category
  if (p === '/api/correct' && req.method === 'POST') {
    if (gameState.phase !== 'active') return json(res, { error: 'Game not active' }, 400);
    const t = gameState.gs.turn;
    gameState.gs.turnScore++;
    const card = drawCardForPos(gameState.teams[t].pos); // same pos = same category
    if (card) {
      gameState.currentCard = card;
      // Keep timestamp — timer continues from when turn started
    } else {
      gameState.currentCard = null;
      gameState.gs.phase = 'waiting';
    }
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
      gameState.timestamp = null;
      pushState();
      return json(res, { ok: true, winner: gameState.teams[t].name });
    }
    gameState.gs.turn = (gameState.gs.turn + 1) % gameState.teams.length;
    gameState.gs.phase = 'waiting';
    gameState.gs.turnScore = 0;
    gameState.currentCard = null;
    gameState.timestamp = null;
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
  if (p === '/api/cards' && req.method === 'GET') return json(res, cards);
  if (p === '/api/cards' && req.method === 'POST') {
    const body = await readBody(req);
    if (Array.isArray(body)) { cards = body; }
    else if (body.word) { cards.push({ word: body.word, cat: body.cat || 'Object', hint: body.hint || '' }); }
    deck = shuffle(cards);
    resetCatDecks();
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
    pushState();
    return json(res, { ok: true });
  }

  // Reset game (keep teams, reset scores)
  if (p === '/api/reset' && req.method === 'POST') {
    gameState.teams.forEach(t => { t.pos = 1; });
    gameState.gs = { turn: 0, phase: 'waiting', turnScore: 0 };
    gameState.currentCard = null;
    gameState.timestamp = null;
    gameState.phase = 'active';
    deck = shuffle(cards);
    resetCatDecks();
    turnHistory = [];
    pushState();
    return json(res, { ok: true });
  }

  // Static
  if (p === '/' || p === '/host') return serveFile(res, path.join(__dirname, 'public', 'host.html'), 'text/html');
  if (p === '/team') return serveFile(res, path.join(__dirname, 'public', 'team.html'), 'text/html');

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Articulate server on port ${PORT}`));
