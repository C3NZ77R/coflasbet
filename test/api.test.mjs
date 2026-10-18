// Cliente del API: los game logs pedidos en el mismo tick salen en una sola petición a /api/gamelogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../public/api.js';

test('api: game logs del mismo tick van juntos y un jugador sin log rechaza solo su promesa', async () => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify({ source: 'espn', data: { 1: { games: [1] }, 2: { games: [2] }, 3: null } }));
  };
  try {
    const [a, b, a2, c] = await Promise.allSettled([api.gamelog('nba', 1), api.gamelog('nba', 2), api.gamelog('nba', '1'), api.gamelog('nba', 3)]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], '/api/gamelogs?league=nba&ids=1%2C2%2C3');
    assert.deepEqual(a.value, { source: 'espn', data: { games: [1] } });
    assert.deepEqual(b.value.data, { games: [2] });
    assert.equal(a2.value, a.value);
    assert.equal(c.status, 'rejected');
  } finally { globalThis.fetch = real; }
});
