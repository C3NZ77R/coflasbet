// fetchJson y su caché en memoria por URL, con fetch simulado (sin red). Archivo propio: la caché es del módulo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJson } from '../lib/espn.mjs';

async function withFetch(reply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => (calls.push(url), reply(url, calls.length));
  try { await fn(calls); } finally { globalThis.fetch = real; }
}
const ok = (body) => new Response(JSON.stringify(body));

test('fetchJson: un pedido fallido no queda en caché', () => withFetch((_, n) => (n === 1 ? new Response('{}', { status: 500 }) : ok({ n })), async (calls) => {
  await assert.rejects(fetchJson('https://x.test/falla'), { status: 502, message: 'ESPN respondió 500' });
  assert.deepEqual(await fetchJson('https://x.test/falla'), { n: 2 });
  assert.deepEqual(await fetchJson('https://x.test/falla'), { n: 2 });
  assert.equal(calls.length, 2);
}));

test('fetchJson: una entrada recién renovada no es la próxima en salir de la caché', () => withFetch((url) => ok({ url }), async (calls) => {
  const a = 'https://x.test/a';
  await fetchJson(a, 1);
  for (let i = 0; i < 299; i++) await fetchJson(`https://x.test/viejo/${i}`); // tope de 300: a queda primera
  await new Promise((r) => setTimeout(r, 5));
  await fetchJson(a); // vencida: se pide de nuevo
  for (let i = 0; i < 299; i++) await fetchJson(`https://x.test/nuevo/${i}`);
  await fetchJson(a);
  assert.equal(calls.filter((u) => u === a).length, 2);
}));
