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
