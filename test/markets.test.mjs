// Mercados por deporte desde el modelo de expected(): sumas, identidades entre mercados y casos límite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketsFor } from '../lib/markets.mjs';
import { scoreGrid, normalOver, halfLine } from '../lib/pricing.mjs';
import { matchDist } from '../lib/tennis.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const sumP = (m) => m.selections.reduce((s, x) => s + x.p, 0);
const pick = (ms, key, line) => ms.find((m) => m.key === key && (line === undefined || m.selections[0].line === line));
const sel = (m, name) => m.selections.find((s) => s.name === name);

const SOCCER = { kind: 'poisson', lh: 1.4, la: 1.1 };
const HOCKEY = { kind: 'poisson', lh: 1.3, la: 1.2 };
const BASEBALL = { kind: 'poisson', lh: 4.6, la: 4.1 };
const NBA = { kind: 'normal', mu: 5.2, sigma: 12, total: 226.3, sigmaT: 13.2 };
const BO3 = { kind: 'tennis', dist: matchDist(0.67, 0.62, 3) };
const BO5 = { kind: 'tennis', dist: matchDist(0.67, 0.62, 5, { slam: true }) };
const CASES = [['soccer', SOCCER], ['hockey', HOCKEY], ['baseball', BASEBALL], ['basketball', NBA], ['football', { ...NBA, sigma: 13.5 }], ['tennis', BO3], ['tennis', BO5]];

test('markets: 1x2 suma 1', () => {
  close(sumP(pick(marketsFor('soccer', SOCCER), '1x2')), 1);
});

test('markets: cada mercado suma 1 (doble oportunidad suma 2: cada selección cubre dos resultados)', () => {
  for (const [sport, model] of CASES) {
    for (const m of marketsFor(sport, model)) close(sumP(m), m.key === 'dc' ? 2 : 1);
  }
});

test('markets: cada selección trae p, fair y oddsy, con oddsy < fair', () => {
  for (const [sport, model] of CASES) {
    for (const m of marketsFor(sport, model)) {
      assert.ok(m.key && m.label && m.selections.length >= 2, `${sport} ${m.key}`);
      for (const s of m.selections) {
        assert.ok(s.name && s.p >= 0 && s.p <= 1, `${sport} ${m.key} ${s.name}`);
        assert.ok(s.oddsy < s.fair, `${sport} ${m.key} ${s.name}: ${s.oddsy} ≥ ${s.fair}`);
      }
    }
  }
});

test('markets: fútbol trae todos los mercados y líneas del brief', () => {
  const ms = marketsFor('soccer', SOCCER);
  assert.deepEqual([...new Set(ms.map((m) => m.key))], ['1x2', 'dc', 'dnb', 'ou', 'ou_home', 'ou_away', 'btts', 'ah', 'cs']);
  assert.deepEqual(ms.filter((m) => m.key === 'ou').map((m) => m.selections[0].line), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]);
  assert.deepEqual(ms.filter((m) => m.key === 'ah').map((m) => m.selections[0].line), [-1, -0.5, 0.5, 1]); // líneas de Betano.co
});

test('markets: btts.Sí con lh = la = 0 es 0 y nada sale NaN', () => {
  const ms = marketsFor('soccer', { kind: 'poisson', lh: 0, la: 0 });
  assert.equal(sel(pick(ms, 'btts'), 'Sí').p, 0);
  for (const m of ms) for (const s of m.selections) assert.ok(Number.isFinite(s.p) && Number.isFinite(s.fair) && Number.isFinite(s.oddsy), `${m.key} ${s.name}`);
  assert.equal(sel(pick(ms, 'dnb'), 'Local').p, 0.5); // sin goles no hay ganador: reparto parejo
});

test('markets: identidades entre mercados de fútbol', () => {
  const ms = marketsFor('soccer', SOCCER);
  const x = pick(ms, '1x2');
  const [H, D, A] = ['Local', 'Empate', 'Visitante'].map((n) => sel(x, n).p);
  close(sel(pick(ms, 'ah', -0.5), 'Local').p, H); // −0.5 = ganar
  close(sel(pick(ms, 'ah', 0.5), 'Local').p, H + D); // +0.5 = no perder
  close(sel(pick(ms, 'dc'), 'Local o empate').p, H + D);
  close(sel(pick(ms, 'dnb'), 'Local').p, H / (H + A));
  assert.equal(sel(pick(ms, 'ah', -1), 'Visitante').line, 1);
  const g1 = scoreGrid(SOCCER.lh, SOCCER.la), by = (f) => g1.reduce((s, row, i) => s + row.reduce((t, v, j) => (f(i - j) ? t + v : t), 0), 0);
  close(sel(pick(ms, 'ah', -1), 'Local').p, by((d) => d > 1) / (1 - by((d) => d === 1))); // ganar por 1 devuelve
  close(sel(pick(ms, 'ou_home', 0.5), 'Menos').p, g1[0].reduce((s, v) => s + v, 0));
  const g = scoreGrid(SOCCER.lh, SOCCER.la);
  close(sel(pick(ms, 'ou', 2.5), 'Menos').p, g[0][0] + g[0][1] + g[1][0] + g[1][1] + g[0][2] + g[2][0]);
  close(sel(pick(ms, 'btts'), 'No').p, g.reduce((s, row, i) => s + row.reduce((t, v, j) => (i && j ? t : t + v), 0), 0));
});

test('markets: marcador exacto = los 10 más probables en orden, más "Otro"', () => {
  const cs = pick(marketsFor('soccer', SOCCER), 'cs');
  assert.equal(cs.selections.length, 11);
  assert.equal(cs.selections.at(-1).name, 'Otro');
  const top = cs.selections.slice(0, 10).map((s) => s.p);
  assert.deepEqual(top, [...top].sort((a, b) => b - a));
  const g = scoreGrid(SOCCER.lh, SOCCER.la);
  assert.equal(cs.selections[0].name, '1-1');
  close(cs.selections[0].p, g[1][1]);
  close(top.at(-1), g.flat().sort((a, b) => b - a)[9]);
});

test('markets: hockey sin empate; el empate se reparte según lh/(lh+la)', () => {
  const ms = marketsFor('hockey', HOCKEY);
  assert.deepEqual([...new Set(ms.map((m) => m.key))], ['ml', 'rl', 'ou']);
  const ml = pick(ms, 'ml');
  assert.deepEqual(ml.selections.map((s) => s.name), ['Local', 'Visitante']);
  assert.ok(!ml.selections.some((s) => s.name === 'Empate'));
  const g = scoreGrid(HOCKEY.lh, HOCKEY.la, { rho: 0, max: 20 });
  const P = (f) => g.reduce((s, row, i) => s + row.reduce((t, v, j) => (f(i, j) ? t + v : t), 0), 0);
  close(sel(ml, 'Local').p, P((i, j) => i > j) + P((i, j) => i === j) * (1.3 / 2.5));
  // El favorito (local) lleva −1.5: gana por 2 o más en tiempo regular (la prórroga solo da victorias por 1).
  const rl = pick(ms, 'rl');
  assert.equal(sel(rl, 'Local').line, -1.5);
  close(sel(rl, 'Local').p, P((i, j) => i - j >= 2));
  // Total sobre el marcador final: un empate en tiempo regular suma el gol de prórroga o shootout.
  const ou = pick(ms, 'ou');
  assert.equal(ou.selections[0].line, halfLine(2.5));
  close(sel(ou, 'Más').p, P((i, j) => i + j + (i === j) > 2.5));
  assert.ok(sel(ou, 'Más').p > P((i, j) => i + j > 2.5));
});

test('markets: run line con visitante favorito y total de carreras sin gol extra', () => {
  const ms = marketsFor('baseball', { kind: 'poisson', lh: 3.9, la: 4.8 });
  assert.equal(pick(ms, 'rl').label, 'Run line');
  assert.equal(sel(pick(ms, 'rl'), 'Visitante').line, -1.5);
  assert.equal(sel(pick(ms, 'rl'), 'Local').line, 1.5);
  const g = scoreGrid(3.9, 4.8, { rho: 0, max: 20 });
  close(sel(pick(ms, 'ou'), 'Más').p, g.reduce((s, row, i) => s + row.reduce((t, v, j) => (i + j > 8.5 ? t + v : t), 0), 0));
});

test('markets: normal con mu = 0 y línea 0 da ml 0.5', () => {
  const ml = pick(marketsFor('basketball', { ...NBA, mu: 0 }), 'ml');
  close(sel(ml, 'Local').p, 0.5);
  close(sel(ml, 'Visitante').p, 0.5);
});

test('markets: spread en halfLine(-mu) para el local y total en halfLine(total)', () => {
  const ms = marketsFor('basketball', NBA);
  assert.deepEqual([...new Set(ms.map((m) => m.key))], ['ml', 'spread', 'ou']);
  const sp = pick(ms, 'spread');
  assert.equal(sel(sp, 'Local').line, -5.5);
  assert.equal(sel(sp, 'Visitante').line, 5.5);
  close(sel(sp, 'Local').p, normalOver(5.2, 12, 5.5));
  const ou = pick(ms, 'ou');
  assert.equal(ou.selections[0].line, 226.5);
  close(sel(ou, 'Más').p, normalOver(226.3, 13.2, 226.5));
  // ml sin push: empate excluido y renormalizado.
  const [over, under] = [normalOver(5.2, 12, 0), normalOver(-5.2, 12, 0)];
  close(sel(pick(ms, 'ml'), 'Local').p, over / (over + under));
});

test('markets: deporte o modelo desconocido es un error', () => {
  assert.throws(() => marketsFor('curling', SOCCER), TypeError);
  assert.throws(() => marketsFor('soccer', NBA), TypeError);
  assert.throws(() => marketsFor('basketball', SOCCER), TypeError);
});

test('markets: tenis trae ml, sets, totales, hándicap de games, gana un set y primer set', () => {
  const ms = marketsFor('tennis', BO3);
  assert.deepEqual(ms.map((m) => m.key), ['ml', 'sets', 'ou_sets', 'ou_games', 'games_hcp', 'win_set', 'win_set', 'first_set']);
  const d = BO3.dist;
  close(sel(pick(ms, 'ml'), 'A').p, d.pA);
  assert.deepEqual(pick(ms, 'sets').selections.map((s) => [s.name, s.p]), Object.entries(d.sets));
  const ous = pick(ms, 'ou_sets');
  assert.equal(ous.selections[0].line, 2.5);
  close(sel(ous, 'Más').p, d.sets['2-1'] + d.sets['1-2']);
  const [a, b] = ms.filter((m) => m.key === 'win_set');
  close(sel(a, 'Sí').p, 1 - d.sets['0-2']);
  close(sel(b, 'Sí').p, 1 - d.sets['2-0']);
  close(sel(pick(ms, 'first_set'), 'A').p, d.firstSet);
});

test('markets: tenis a 5 sets ofrece totales de sets 3.5 y 4.5', () => {
  const ms = marketsFor('tennis', BO5);
  const d = BO5.dist;
  assert.deepEqual(ms.filter((m) => m.key === 'ou_sets').map((m) => m.selections[0].line), [3.5, 4.5]);
  close(sel(pick(ms, 'ou_sets', 4.5), 'Más').p, d.sets['3-2'] + d.sets['2-3']);
  close(sel(pick(ms, 'ou_sets', 3.5), 'Menos').p, d.sets['3-0'] + d.sets['0-3']);
});

test('markets: total de games en halfLine(media) y hándicap en halfLine(−margen medio)', () => {
  const ms = marketsFor('tennis', BO3);
  const d = BO3.dist;
  const mean = d.games.reduce((s, p, k) => s + p * k, 0);
  const ou = pick(ms, 'ou_games');
  assert.equal(ou.selections[0].line, halfLine(mean));
  close(sel(ou, 'Más').p, d.games.reduce((s, p, k) => (k > halfLine(mean) ? s + p : s), 0));
  const D = Object.entries(d.margin).map(([k, p]) => [Number(k), p]);
  const l = halfLine(-D.reduce((s, [k, p]) => s + k * p, 0));
  const hcp = pick(ms, 'games_hcp');
  assert.ok(l < 0, 'A es favorito: da games');
  assert.equal(sel(hcp, 'A').line, l);
  assert.equal(sel(hcp, 'B').line, -l);
  close(sel(hcp, 'A').p, D.reduce((s, [k, p]) => (k + l > 0 ? s + p : s), 0));
});

test('markets: tenis exige un modelo de tenis', () => {
  assert.throws(() => marketsFor('tennis', SOCCER), TypeError);
  assert.throws(() => marketsFor('soccer', BO3), TypeError);
});
