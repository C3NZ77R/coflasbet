// Tenis ATP: normalizador del scoreboard y rankings (fixtures reales de ESPN), Elo y cadena de Markov. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SURFACE, normScoreboard, normRankings, getHistory, eloFrom, ratingOf, matchProb, serveFromMatchProb, matchDist, winProb, setGames, gapOf, setLengthFrom, firstSetGames } from '../lib/tennis.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('tenis: el scoreboard se normaliza solo a singles masculino', () => {
  const ms = normScoreboard(fx('atp-month.json'));
  assert.equal(ms.length, 30); // 14 + 8 + 8 del fixture; singles femenino y dobles fuera
  for (const m of ms) {
    assert.ok(m.id && m.date && m.tournament && m.a.id && m.b.id && m.a.id !== m.b.id);
    assert.ok(['hard', 'clay', 'grass'].includes(m.surface));
    assert.equal(m.state, 'post');
    assert.ok(m.winner === 'a' || m.winner === 'b');
  }
  const fearnley = ms.find((m) => m.id === '184607');
  assert.equal(fearnley.a.name, 'Jacob Fearnley');
  assert.equal(fearnley.a.country, 'Great Britain');
  assert.equal(fearnley.winner, 'a');
  assert.deepEqual(fearnley.sets, [[7, 6, 7, 3], [6, 3]]);
  assert.equal(fearnley.bestOf, 3); // qualy de Grand Slam a 3 sets
  assert.equal(fearnley.retired, false);
  assert.ok(ms.some((m) => m.tournament === 'US Open' && m.bestOf === 5));
  assert.ok(ms.filter((m) => m.tournament !== 'US Open').every((m) => m.bestOf === 3));
});

test('tenis: retiros y walkovers quedan marcados', () => {
  const ms = normScoreboard(fx('atp-month.json'));
  const ret = ms.filter((m) => m.retired);
  assert.equal(ret.length, 6); // US Open: 3 retiros y 1 w/o; China Open: 2 retiros
  const wo = ms.find((m) => m.sets.length === 0);
  assert.equal(wo.retired, true);
});

test('tenis: superficie por nombre del torneo', () => {
  assert.equal(SURFACE('Mutua Madrid Open'), 'clay');
  assert.equal(SURFACE('Rolex Shanghai Masters'), 'hard');
  assert.equal(SURFACE('Wimbledon'), 'grass');
  assert.equal(SURFACE("Libema Open 's-Hertogenbosch"), 'grass');
  assert.equal(SURFACE('Internazionali BNL d\'Italia'), 'clay');
});

test('tenis: rankings recortados y ordenados', () => {
  const rk = normRankings(fx('atp-rankings.json'));
  assert.equal(rk.length, 5);
  assert.deepEqual(rk.map((r) => r.rank), [1, 2, 3, 4, 5]);
  assert.equal(rk[0].player.name, 'Jannik Sinner');
  assert.equal(rk[0].player.country, 'Italy');
  assert.ok(Number.isFinite(rk[0].points));
  const many = { rankings: [{ ranks: Array.from({ length: 200 }, (_, i) => ({ current: 200 - i, previous: 1, points: i, athlete: { id: String(i), displayName: `P${i}` } })) }] };
  const top = normRankings(many);
  assert.equal(top.length, 150);
  assert.equal(top[149].rank, 150);
});

test('tenis: getHistory pide en vivo cada mes desde el último partido del snapshot hasta hoy', async () => {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => (urls.push(String(url)), new Response(JSON.stringify({ events: [] })));
  try {
    await getHistory(24, new Date('2026-11-05T12:00:00Z'));
  } finally {
    globalThis.fetch = real;
  }
  const got = urls.map((u) => /dates=(\d{6})01-/.exec(u)[1]);
  // el snapshot de data/ termina el 2026-09-13: sin septiembre, del 14 al 30 se perderían del Elo
  const last = JSON.parse(readFileSync(new URL('../data/atp-history.json', import.meta.url), 'utf8')).matches.at(-1).date.slice(0, 7).replace('-', '');
  const from = [last, '202610'].sort()[0]; // hoy 202609; el mes anterior siempre va
  for (const ym of new Set([from, '202610', '202611'])) assert.ok(got.includes(ym), `${ym} en ${got}`);
  assert.ok(got.every((ym) => ym >= from), 'lo que ya está en el snapshot no se vuelve a pedir');
});

// ---------- modelo ----------
test('tenis: matchDist es simétrica con saques iguales y suma 1', () => {
  for (const bo of [3, 5]) {
    const d = matchDist(0.64, 0.64, bo);
    close(d.pA, 0.5);
    close(sum(d.games), 1);
    close(sum(Object.values(d.sets)), 1);
    close(sum(Object.values(d.margin)), 1);
    close(d.firstSet, 0.5);
  }
});

test('tenis: el mejor sacador gana más y el mínimo de games es 6-0 6-0', () => {
  const d = matchDist(0.7, 0.6, 3);
  assert.ok(d.pA > 0.5);
  assert.ok(d.firstSet > 0.5 && d.firstSet < d.pA);
  close(d.pA, d.sets['2-0'] + d.sets['2-1']);
  assert.equal(d.games.findIndex((p) => p > 0), 12);
  assert.equal(matchDist(0.7, 0.6, 5).games.findIndex((p) => p > 0), 18);
  assert.ok(matchDist(0.7, 0.6, 5).pA > d.pA); // a 5 sets el favorito gana más
});

test('tenis: serveFromMatchProb reproduce la probabilidad pedida', () => {
  for (const [p, bo] of [[0.75, 3], [0.3, 3], [0.9, 5]]) {
    const { sa, sb } = serveFromMatchProb(p, bo);
    close(matchDist(sa, sb, bo).pA, p, 1e-4);
  }
});

test('tenis: winProb es la pA de matchDist y serveFromMatchProb acepta otro centro', () => {
  for (const [sa, sb, bo] of [[0.7, 0.6, 3], [0.66, 0.62, 5], [0.58, 0.63, 3]]) close(winProb(sa, sb, bo), matchDist(sa, sb, bo).pA, 1e-12);
  const { sa, sb } = serveFromMatchProb(0.8, 3, undefined, 0.6);
  close((sa + sb) / 2, 0.6);
  close(matchDist(sa, sb, 3).pA, 0.8, 1e-4);
});

test('tenis: games de un set suman 1, van de 6 a 13 y crecen con el saque', () => {
  const g = setGames(0.64, 0.64);
  close(sum(g), 1);
  assert.equal(g.findIndex((p) => p > 0), 6);
  assert.equal(g[11], 0); // 6-5 no termina un set
  const mean = (P) => P.reduce((s, p, k) => s + p * k, 0);
  assert.ok(mean(setGames(0.68, 0.68)) > mean(g) && setGames(0.68, 0.68)[13] > g[13]);
  assert.ok(mean(setGames(0.7, 0.58)) < mean(g)); // con la misma media, la brecha acorta el set
});

test('tenis: gapOf aproxima la brecha de serveFromMatchProb a menos de 3%', () => {
  for (const [p, c, bo] of [[0.6, 0.62, 3], [0.8, 0.66, 3], [0.9, 0.6, 5], [0.3, 0.64, 3]]) {
    const { sa } = serveFromMatchProb(p, bo, { slam: bo === 5 }, c);
    assert.ok(Math.abs(gapOf(p, c, bo) - (sa - c)) < 0.03 * Math.abs(sa - c), `${p} ${c} ${bo}`);
  }
});

test('tenis: el largo del set separa sacadores de restadores y el 1er set suma 1', () => {
  // s1, s2 siempre van a tiebreak; r1, r2 juegan 6-2. Cruces parejos (6-4) para que no se confunda con el torneo.
  const sets = { s: [[7, 6, 7, 5], [6, 7, 4, 7], [7, 6, 7, 3]], r: [[6, 2], [6, 2]], x: [[6, 4], [6, 4]] };
  const ms = [];
  for (let i = 0; i < 40; i++) {
    const [a, b, k] = [['s1', 's2', 's'], ['r1', 'r2', 'r'], ['s1', 'r1', 'x'], ['s2', 'r2', 'x']][i % 4];
    ms.push({ id: String(i), date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), state: 'post', winner: 'a', retired: false, surface: 'hard', tournament: 'T', bestOf: 3, a: { id: a }, b: { id: b }, sets: sets[k] });
  }
  const fit = setLengthFrom(ms, { asOf: Date.UTC(2026, 3, 1) });
  assert.ok(fit.D.get('s1') > 0 && fit.D.get('s2') > 0 && fit.D.get('r1') < 0 && fit.D.get('r2') < 0);
  const m = (a, b, tournament = 'T') => ({ a: { id: a }, b: { id: b }, surface: 'hard', tournament, bestOf: 3 });
  const [big, small] = [firstSetGames(fit, m('s1', 's2'), 0.5), firstSetGames(fit, m('r1', 'r2'), 0.5)];
  close(sum(big), 1, 1e-6); // pesos de Gauss-Hermite con 9 decimales
  assert.ok(big[13] > small[13]);
  assert.equal(firstSetGames(fit, m('s1', 's2', 'Next Gen ATP Finals'), 0.5), null);
});

const M = (id, date, aId, bId, winner, extra = {}) => ({ id, date, surface: 'hard', a: { id: aId }, b: { id: bId }, winner, retired: false, ...extra });

test('tenis: Elo inicial 1500, el ganador sube y el retiro no cuenta', () => {
  const elo0 = eloFrom([]);
  assert.equal(ratingOf(elo0, 'nadie').all, 1500);
  close(matchProb(elo0, 'x', 'y', 'clay'), 0.5);

  const ms = [M('1', '2026-01-01', 'a', 'b', 'a'), M('2', '2026-01-02', 'a', 'c', 'a', { surface: 'clay' })];
  const elo = eloFrom(ms);
  assert.ok(ratingOf(elo, 'a').all > 1500 && ratingOf(elo, 'b').all < 1500);
  assert.equal(ratingOf(elo, 'a').n, 2);
  assert.ok(ratingOf(elo, 'a').clay > 1500);
  assert.ok(matchProb(elo, 'a', 'b', 'hard') > 0.5);

  const withRet = eloFrom([...ms, M('3', '2026-01-03', 'b', 'a', 'b', { retired: true })]);
  assert.deepEqual(ratingOf(withRet, 'a'), ratingOf(elo, 'a'));
  assert.deepEqual(ratingOf(eloFrom(ms, { asOf: Date.parse('2026-01-02') }), 'c'), ratingOf(elo0, 'c'));
});
