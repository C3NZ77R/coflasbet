// Props con línea y cuotas propias (modelo Oddsy) sobre game logs de ESPN. Sin red: fixtures y fetch simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { propLine, playerProps, getProps } from '../lib/props.mjs';
import { normGamelog, buildGameLog } from '../lib/espn.mjs';
import { normalOver } from '../lib/pricing.mjs';
import { propOver } from '../public/betmath.js';

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

test('playerProps: Over y Under a la línea propia con cuota Oddsy < justa', () => {
  const props = playerProps(nbaLog(), 'basketball', ctx);
  assert.ok(props.length >= 2);
  for (const p of props) {
    assert.equal(p.books.length, 1);
    assert.equal(p.books[0].key, 'oddsy');
    assert.ok(p.books[0].price < p.fair, `${p.id}: ${p.books[0].price} >= ${p.fair}`);
    assert.ok(Math.abs(p.fair - 1 / p.p) <= 0.005 + 1e-9); // redondeada a 2 decimales
    assert.equal(p.n, 12);
    assert.deepEqual([p.gameId, p.eventId, p.team, p.opp, p.athleteId, p.player], ['401871339', '401871339', 'BOS', 'DET', '4433188', 'Devin Carter']);
    const twin = props.find((q) => q.stat === p.stat && q.line === p.line && q.side !== p.side);
    assert.ok(Math.abs(p.p + twin.p - 1) < 1e-12);
    // El navegador cotiza otras líneas con kind, mean y variance: en la línea Oddsy da la misma p.
    const over = propOver(p.kind, p.mean, p.variance, p.line);
    assert.ok(Math.abs((p.side === 'Over' ? over : 1 - over) - p.p) < 1e-12, `${p.id}`);
  }
  assert.equal(new Set(props.map((p) => p.id)).size, props.length);
  assert.deepEqual(playerProps(nbaLog([fx('gamelog-nba.json')]), 'basketball', ctx), []); // 6 partidos: sin props
});

test('getProps(liga, partido) con fetch simulado: plantillas + game logs → props Oddsy', async (t) => {
  const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/summary')) return reply(fx('summary-nba-post.json'));
    if (u.pathname.endsWith('/roster')) return reply(fx('roster-nba.json'));
    if (u.pathname.endsWith('/gamelog')) return reply(u.searchParams.get('season') ? rekey(fx('gamelog-nba.json'), 'p') : fx('gamelog-nba.json'));
    return new Response('{}', { status: 404 });
  });
  const res = await getProps('nba', '401871339');
  assert.equal(res.source, 'oddsy');
  assert.ok(res.data.length > 0);
  assert.ok(res.data.every((p) => p.books[0].key === 'oddsy' && p.gameId === '401871339' && ['DET', 'CLE'].includes(p.team)));
  assert.ok(res.data.some((p) => p.player === 'Mike Conley'), 'el nombre sale de la plantilla si el perfil falla');
  await assert.rejects(getProps('xx'), { status: 400 });
});

test('propOver: líneas personalizadas; en una línea entera el push se descuenta', () => {
  const pois = [0, 1, 2].map((k) => Math.exp(-2) * 2 ** k / [1, 1, 2][k]); // Poisson(2): varianza = media
  const over2 = 1 - pois[0] - pois[1] - pois[2];
  assert.ok(Math.abs(propOver('count', 2, 2, 2.5) - over2) < 1e-12);
  assert.ok(Math.abs(propOver('count', 2, 2, 2) - over2 / (over2 + pois[0] + pois[1])) < 1e-12); // X = 2 se devuelve
  assert.ok(Math.abs(propOver('normal', 10, 16, 10.5) - normalOver(10, 4, 10.5)) < 1e-12);
  assert.ok(Math.abs(propOver('normal', 10, 16, 10) - 0.5) < 1e-12); // simétrica alrededor de la media
  assert.equal(propOver('count', 1, 1, 30), 0.01);
  assert.equal(propOver('normal', 30, 4, 0.5), 0.99);
});

test('getProps(liga) sin partido: a lo sumo 4 pedidos a ESPN en vuelo y sin pedir perfiles', async (t) => {
  const reply = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const board = fx('scoreboard-nba.json');
  const [ev] = board.events;
  board.events = [['8', '2'], ['10', '11'], ['12', '13']].map(([h, a], i) => ({ ...ev, id: `90${i}`,
    competitions: [{ ...ev.competitions[0], competitors: ev.competitions[0].competitors.map((c) => ({ ...c, team: { ...c.team, id: c.homeAway === 'home' ? h : a } })) }] }));
  const roster = fx('roster-nba.json');
  const urls = [];
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 2));
    active--;
    const u = new URL(url);
    const team = /teams\/(\d+)\/roster$/.exec(u.pathname)?.[1];
    if (u.pathname.endsWith('/scoreboard')) return reply(board);
    if (team) return reply({ ...roster, team: { ...roster.team, id: team }, athletes: roster.athletes.map((a) => ({ ...a, id: `${team}0${a.id}` })) });
    if (u.pathname.endsWith('/gamelog')) return reply(u.searchParams.get('season') ? rekey(fx('gamelog-nba.json'), 'p') : fx('gamelog-nba.json'));
    return new Response('{}', { status: 404 });
  });
  const res = await getProps('wnba');
  assert.deepEqual(new Set(res.data.map((p) => p.gameId)), new Set(['900', '901', '902']));
  assert.equal(urls.filter((u) => u.includes('/gamelog')).length, 6 * 3 * 2); // 6 plantillas × 3 jugadores × 2 temporadas
  assert.ok(!urls.some((u) => /\/athletes\/\d+$/.test(new URL(u).pathname)), 'el perfil sale de la plantilla');
  assert.ok(peak > 1 && peak <= 4, `pico ${peak}`);
});
