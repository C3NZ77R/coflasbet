// Props con línea y cuotas propias (modelo Coflas) sobre game logs de ESPN. Sin red: fixtures y fetch simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { propLine, playerProps, getProps } from '../lib/props.mjs';
import { normGamelog, buildGameLog } from '../lib/espn.mjs';
import { normalOver } from '../lib/pricing.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
// Copia del game log con otros eventId y un año antes: hace de temporada anterior (el fixture trae solo 6 partidos).
const rekey = (j, s) => ({
  ...j,
  seasonTypes: j.seasonTypes.map((st) => ({ ...st, categories: st.categories.map((c) => ({ ...c, events: (c.events ?? []).map((e) => ({ ...e, eventId: e.eventId + s })) })) })),
  events: Object.fromEntries(Object.entries(j.events).map(([k, v]) => [k + s, { ...v, id: k + s, gameDate: v.gameDate.replace('2026', '2025') }])),
});
const nbaLog = (lists = [fx('gamelog-nba.json'), rekey(fx('gamelog-nba.json'), 'p')]) =>
  buildGameLog({ id: '4433188', name: 'Devin Carter' }, 'basketball', lists.map((j) => normGamelog(j, 'basketball')));
const ctx = { league: 'nba', gameId: '401871339', start: '2026-05-18T00:00:00.000Z', team: 'BOS', opp: 'DET' };

test('propLine: mínimo de 8 partidos, línea = mediana redondeada a .5', () => {
  assert.equal(propLine([1, 2, 3, 4, 5, 6, 7]), null);
  const r = propLine(Array(20).fill(10));
  assert.equal(r.line, 10.5);
  assert.ok(r.pOver < 0.5, `pOver ${r.pOver}`);
});

test('pts usa la normal; los conteos, la binomial negativa', () => {
  const log = nbaLog();
  const vals = log.games.map((g) => g.stats.pts);
  const r = propLine(vals, 'normal');
  const m = 0.5 * avg(vals.slice(0, 10)) + 0.3 * avg(vals) + 0.2 * avg(vals.slice(0, 5));
  const sd = Math.sqrt(vals.reduce((s, x) => s + (x - avg(vals)) ** 2, 0) / (vals.length - 1));
  assert.equal(r.pOver, Math.min(0.99, Math.max(0.01, normalOver(m, Math.max(sd, 1), r.line))));
  const over = playerProps(log, 'basketball', ctx).find((p) => p.stat === 'pts' && p.side === 'Over');
  assert.equal(over.p, r.pOver);
  assert.notEqual(over.p, propLine(vals, 'count').pOver);
});
const avg = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

test('playerProps: Over y Under a la línea propia con cuota Coflas < justa', () => {
  const props = playerProps(nbaLog(), 'basketball', ctx);
  assert.ok(props.length >= 2);
  for (const p of props) {
    assert.equal(p.books.length, 1);
    assert.equal(p.books[0].key, 'coflas');
    assert.ok(p.books[0].price < p.fair, `${p.id}: ${p.books[0].price} >= ${p.fair}`);
    assert.ok(Math.abs(p.fair - 1 / p.p) <= 0.005 + 1e-9); // redondeada a 2 decimales
    assert.equal(p.n, 12);
    assert.deepEqual([p.gameId, p.eventId, p.team, p.opp, p.athleteId, p.player], ['401871339', '401871339', 'BOS', 'DET', '4433188', 'Devin Carter']);
    const twin = props.find((q) => q.stat === p.stat && q.line === p.line && q.side !== p.side);
    assert.ok(Math.abs(p.p + twin.p - 1) < 1e-12);
  }
  assert.equal(new Set(props.map((p) => p.id)).size, props.length);
  assert.deepEqual(playerProps(nbaLog([fx('gamelog-nba.json')]), 'basketball', ctx), []); // 6 partidos: sin props
});

test('getProps(liga, partido) con fetch simulado: plantillas + game logs → props Coflas', async (t) => {
  const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/summary')) return reply(fx('summary-nba-post.json'));
    if (u.pathname.endsWith('/roster')) return reply(fx('roster-nba.json'));
    if (u.pathname.endsWith('/gamelog')) return reply(u.searchParams.get('season') ? rekey(fx('gamelog-nba.json'), 'p') : fx('gamelog-nba.json'));
    return new Response('{}', { status: 404 });
  });
  const res = await getProps('nba', '401871339');
  assert.equal(res.source, 'coflas');
  assert.ok(res.data.length > 0);
  assert.ok(res.data.every((p) => p.books[0].key === 'coflas' && p.gameId === '401871339' && ['DET', 'CLE'].includes(p.team)));
  assert.ok(res.data.some((p) => p.player === 'Mike Conley'), 'el nombre sale de la plantilla si el perfil falla');
  await assert.rejects(getProps('xx'), { status: 400 });
});
