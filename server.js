const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

let gameState = {
  room: null,
  teams: [{ name: 'Team 1', score: 0, pos: 0 }, { name: 'Team 2', score: 0, pos: 0 }],
  settings: { timer: 60, spaces: 30, skips: 3, move: 1 },
  gs: { turn: 0, phase: 'idle', skipsLeft: 3 },
  currentCard: null,
  timestamp: Date.now(),
  deckSize: 0
};

let cards = [];
let deck = [];
const sseClients = new Set();

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
  gameState.timestamp = Date.now();
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const p = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'state', payload: { ...gameState, deckSize: deck.length } })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); sseClients.delete(res); } }, 20000);
    req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    return json(res, { ...gameState, deckSize: deck.length });
  }

  if (p === '/api/create-room' && req.method === 'POST') {
    gameState.room = genCode();
    pushState();
    return json(res, { room: gameState.room });
  }

  if (p === '/api/setup' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.teams) gameState.teams = body.teams;
    if (body.settings) gameState.settings = body.settings;
    gameState.gs = { turn: 0, phase: 'idle', skipsLeft: parseInt(gameState.settings.skips) };
    gameState.currentCard = null;
    deck = shuffle(cards);
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/api/cards' && req.method === 'GET') {
    return json(res, cards);
  }

  if (p === '/api/cards' && req.method === 'POST') {
    const body = await readBody(req);
    if (Array.isArray(body)) { cards = body; }
    else if (body.word) { cards.push({ word: body.word, cat: body.cat || 'Random', hint: body.hint || '' }); }
    deck = shuffle(cards);
    pushState();
    return json(res, { ok: true, count: cards.length });
  }

  if (p === '/api/cards/clear' && req.method === 'POST') {
    cards = []; deck = [];
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/api/new-card' && req.method === 'POST') {
    if (!deck.length) deck = shuffle(cards);
    if (!deck.length) return json(res, { error: 'No cards' }, 400);
    gameState.currentCard = deck.pop();
    gameState.gs.phase = 'playing';
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/api/correct' && req.method === 'POST') {
    const t = gameState.gs.turn;
    gameState.teams[t].score++;
    gameState.teams[t].pos = Math.min(
      gameState.teams[t].pos + parseInt(gameState.settings.move),
      parseInt(gameState.settings.spaces)
    );
    gameState.currentCard = null;
    gameState.gs.phase = 'idle';
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/api/skip' && req.method === 'POST') {
    if (gameState.gs.skipsLeft <= 0) return json(res, { error: 'No skips left' }, 400);
    gameState.gs.skipsLeft--;
    gameState.currentCard = null;
    gameState.gs.phase = 'idle';
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/api/end-turn' && req.method === 'POST') {
    const n = gameState.teams.length;
    gameState.gs.turn = (gameState.gs.turn + 1) % n;
    gameState.gs.phase = 'idle';
    gameState.gs.skipsLeft = parseInt(gameState.settings.skips);
    gameState.currentCard = null;
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/api/reshuffle' && req.method === 'POST') {
    deck = shuffle(cards);
    pushState();
    return json(res, { ok: true, deckSize: deck.length });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    gameState.teams.forEach(t => { t.score = 0; t.pos = 0; });
    gameState.gs = { turn: 0, phase: 'idle', skipsLeft: parseInt(gameState.settings.skips) };
    gameState.currentCard = null;
    deck = shuffle(cards);
    pushState();
    return json(res, { ok: true });
  }

  if (p === '/' || p === '/host') {
    return serveFile(res, path.join(__dirname, 'public', 'host.html'), 'text/html');
  }
  if (p === '/team') {
    return serveFile(res, path.join(__dirname, 'public', 'team.html'), 'text/html');
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Articulate server running on port ${PORT}`);
});
