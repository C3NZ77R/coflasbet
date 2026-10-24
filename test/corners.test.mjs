// Córners y tarjetas: normalizador del summary (fixture real de col.1), tasas por equipo y mercados. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normMatchStats, statRates, expectedStat, statDist, cardsMarkets } from '../lib/corners.mjs';
import { MAX_P } from '../lib/pricing.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const R = (id, d, homeId, awayId, corners, cards = [2, 2]) => ({ id, date: `2026-01-${String(d).padStart(2, '0')}T20:00Z`, homeId, awayId, corners, cards });

test('córners: el summary de ESPN se normaliza a córners y tarjetas por lado', () => {
  const r = normMatchStats(fx('summary-col-stats.json'));
  assert.deepEqual(r, { id: '401843153', date: r.date, homeId: '4928', awayId: '9761', corners: [2, 2], cards: [1, 1] });
  assert.ok(Date.parse(r.date));
});

test('córners: partido sin terminar o sin estadísticas devuelve null', () => {
  const j = fx('summary-col-stats.json');
  j.header.competitions[0].status.type.completed = false;
  assert.equal(normMatchStats(j), null);
  const k = fx('summary-col-stats.json');
  k.boxscore.teams[0].statistics = k.boxscore.teams[0].statistics.filter((s) => s.name !== 'wonCorners');
  assert.equal(normMatchStats(k), null);
  assert.equal(normMatchStats(null), null);
});

test('córners: el equipo que más genera tiene fuerza > 1 y el desconocido es la media', () => {
  // A saca 8 por partido, el resto 4
  const rows = [R('1', 1, 'A', 'B', [8, 4]), R('2', 2, 'C', 'A', [4, 8]), R('3', 3, 'B', 'C', [4, 4]), R('4', 4, 'A', 'C', [8, 4])];
  const rates = statRates(rows, 'corners', { prior: 2 });
  assert.ok(rates.teams.get('A').for > 1 && rates.teams.get('B').for < 1);
  assert.equal(rates.teams.get('A').n, 3);
  const e = expectedStat(rates, 'X', 'Y');
  close(e.home, rates.league.home);
  close(e.away, rates.league.away);
  assert.ok(expectedStat(rates, 'A', 'B').home > e.home);
  // asOf deja fuera lo posterior
  assert.equal(statRates(rows, 'corners', { asOf: Date.parse('2026-01-02T00:00Z') }).league.n, 1);
});

test('córners: las distribuciones suman 1 y el total es la suma de lados', () => {
  const d = statDist({ home: 5.4, away: 4.1, dispHome: 1.3, dispAway: 1.2 }, 25);
  close(sum(d.home), 1);
  close(sum(d.total), 1);
  close(sum(d.total.map((p, k) => p * k)), sum(d.home.map((p, k) => p * k)) + sum(d.away.map((p, k) => p * k)));
});

test('tarjetas: mercados con forma Market y probabilidades coherentes', () => {
  const ms = cardsMarkets({ home: 2.3, away: 2.6, dispHome: 1.1, dispAway: 1.1 });
  assert.ok(ms.length === 4);
  for (const m of ms) {
    assert.ok(m.key && m.label && m.selections.length);
    for (const s of m.selections) assert.ok(s.p > 0 && s.p < 1 && s.oddsy < s.fair, `${m.key} ${s.name}`);
  }
  const x12 = ms.find((m) => m.key.endsWith('_1x2'));
  close(sum(x12.selections.map((s) => s.p)), 1);
  const ou = ms.find((m) => m.key.endsWith('_ou'));
  for (let i = 0; i < ou.selections.length; i += 2) close(ou.selections[i].p + ou.selections[i + 1].p, 1);
  assert.ok(x12.selections[0].p < x12.selections[2].p); // la visita saca más
});

test('tarjetas: nada por encima de MAX_P; en un total cae la línea entera (Más y Menos)', () => {
  const ms = cardsMarkets({ home: 0.3, away: 4, dispHome: 1.1, dispAway: 1.1 });
  for (const m of ms) for (const s of m.selections) assert.ok(s.p <= MAX_P, `${m.key} ${s.name} ${s.line}`);
  const home = ms.find((m) => m.key === 'cards_home_ou'); // Menos 1.5 con media 0.3 sale al 96%
  assert.deepEqual(home.selections.map((s) => [s.name, s.line]), [['Más', 0.5], ['Menos', 0.5]]);
});
