// Tenis ATP: normalizador del scoreboard y rankings (fixtures reales de ESPN), Elo y cadena de Markov. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SURFACE, normScoreboard, normRankings, eloFrom, ratingOf, matchProb, serveFromMatchProb, matchDist } from '../lib/tennis.mjs';

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
