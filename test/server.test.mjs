// Rutas del servidor sin red: The Odds API ya no existe y los parámetros se validan antes de llamar a ESPN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../server.mjs';

async function call(path) {
  let status, body;
  const res = { writeHead(s) { status = s; return this; }, end(b) { body = JSON.parse(b); } };
  await handler({ url: path, method: 'GET' }, res);
  return { status, body };
}

test('server: /api/odds y /api/sports ya no existen', async () => {
  assert.equal((await call('/api/odds?sport=basketball_nba')).status, 404);
  assert.equal((await call('/api/sports')).status, 404);
});

test('server: /api/markets valida liga y partido', async () => {
  assert.equal((await call('/api/markets?league=xx')).status, 400);
  assert.equal((await call('/api/markets?league=nba&game=abc')).status, 400);
});

test('server: /api/accuracy sirve el backtest', async () => {
  const { status, body } = await call('/api/accuracy');
  assert.equal(status, 200);
  assert.equal(body.source, 'coflas');
  assert.ok(body.data.nba.brier < body.data.nba.baseline.brier);
});

// Tenis: ESPN se reemplaza por los fixtures (rankings y un mes de scoreboard); el snapshot de data/ se lee del disco.
import { readFileSync } from 'node:fs';
const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
async function withAtp(fn) {
  const real = globalThis.fetch;
  const bodies = { rankings: fixture('atp-rankings.json'), scoreboard: fixture('atp-month.json') };
  globalThis.fetch = async (url) => {
    const body = /\/tennis\/atp\/rankings/.test(url) ? bodies.rankings : /\/tennis\/atp\/scoreboard/.test(url) ? bodies.scoreboard : null;
    if (!body) throw new Error(`fetch inesperado: ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try { await fn(); } finally { globalThis.fetch = real; }
}

test('server: /api/tennis/rankings trae el top con Elo', () => withAtp(async () => {
  const { status, body } = await call('/api/tennis/rankings');
  assert.equal(status, 200);
  assert.ok(body.data.length > 0 && body.data.length <= 100);
  assert.equal(body.data[0].rank, 1);
  const zverev = body.data.find((r) => r.player.id === '2375');
  assert.ok(Number.isFinite(zverev.elo));
}));

test('server: /api/tennis/player valida el id y trae rank, puntos, Elo y partidos', () => withAtp(async () => {
  assert.equal((await call('/api/tennis/player?id=abc')).status, 400);
  assert.equal((await call('/api/tennis/player')).status, 400);
  assert.equal((await call('/api/tennis/player?id=999999999')).status, 404);
  const { status, body } = await call('/api/tennis/player?id=2375');
  assert.equal(status, 200);
  assert.equal(body.data.player.name, 'Alexander Zverev');
  assert.equal(body.data.rank, 2);
  assert.ok(body.data.points > 0);
  assert.ok(Number.isFinite(body.data.elo.all) && Number.isFinite(body.data.elo.hard));
  assert.ok(body.data.matches.length >= 5);
}));

test('server: /api/games?league=atp mapea Match a Game (home = a, bandera, rank)', () => withAtp(async () => {
  const { status, body } = await call('/api/games?league=atp&date=20260913');
  assert.equal(status, 200);
  const final = body.data.find((g) => g.id === '182677');
  assert.equal(final.home.name, 'Alexander Zverev');
  assert.equal(final.away.name, 'Ben Shelton');
  assert.match(final.home.logo, /^https:\/\/a\.espncdn\.com\//);
  assert.equal(final.home.record, '#2');
  assert.deepEqual([final.home.score, final.away.score], [3, 1]);
  assert.equal(final.status.detail, '6-3 7-6(2) 5-7 6-2');
}));

test('server: /api/markets?league=atp con Elo, Markov y nombres de jugador', () => withAtp(async () => {
  const { status, body } = await call('/api/markets?league=atp&game=182677&date=20260913');
  assert.equal(status, 200);
  assert.equal(body.source, 'coflas');
  assert.equal(body.data.game.home.name, 'Alexander Zverev');
  const ml = body.data.markets.find((m) => m.key === 'ml');
  assert.deepEqual(ml.selections.map((s) => s.name), ['A. Zverev', 'B. Shelton']);
  assert.ok(Math.abs(ml.selections[0].p + ml.selections[1].p - 1) < 1e-9);
  assert.ok(body.data.markets.some((m) => m.key === 'ou_sets' && m.label === 'Total de sets 3.5')); // final de Grand Slam: a 5 sets
  assert.ok(body.data.markets.some((m) => m.label === 'A. Zverev gana al menos un set'));
  assert.equal((await call('/api/markets?league=atp&game=999999')).status, 404);
  const day = await call('/api/markets?league=atp&date=20260913');
  assert.ok(day.body.data.some((x) => x.gameId === '182677'));
}));

test('server: tenis no tiene props ni rutas de equipo', () => withAtp(async () => {
  const props = await call('/api/props?league=atp');
  assert.equal(props.status, 200);
  assert.deepEqual(props.body.data, []);
  assert.equal((await call('/api/game?league=atp&id=1')).status, 400);
  assert.equal((await call('/api/injuries?league=atp')).status, 400);
}));
