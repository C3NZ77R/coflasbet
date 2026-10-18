// Ratings de equipos: normalizador de calendarios (fixture real de ESPN) y modelo de fuerzas. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normSchedule } from '../lib/espn.mjs';
import { ratingsFromResults, expected, SPORT_MODEL, SIGMA } from '../lib/ratings.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const R = (id, date, homeId, awayId, homeScore, awayScore) => ({ id, date, homeId, awayId, homeScore, awayScore });

test('ratings: el calendario de ESPN se normaliza a 10 resultados numéricos', () => {
  const res = normSchedule(fx('schedule-nba.json'));
  assert.equal(res.length, 10);
  for (const r of res) {
    assert.ok(r.id && r.date && r.homeId && r.awayId && r.homeId !== r.awayId);
    assert.ok(Number.isFinite(r.homeScore) && Number.isFinite(r.awayScore));
  }
});

test('ratings: ignora partidos sin terminar o sin marcador', () => {
  const json = fx('schedule-nba.json');
  json.events[0].competitions[0].status.type = { state: 'pre', completed: false };
  json.events[1].competitions[0].competitors[0].score = undefined;
  json.events[2].competitions[0].competitors[0].score = '101'; // forma string
  const res = normSchedule(json);
  assert.equal(res.length, 8);
  assert.ok(res.some((r) => r.homeScore === 101 || r.awayScore === 101));
  assert.deepEqual(normSchedule(null), []);
});

test('ratings: equipo sin partidos = media de liga', () => {
  const rs = [R('1', '2026-01-01', 'A', 'B', 110, 100), R('2', '2026-01-02', 'B', 'A', 105, 95)];
  const ra = ratingsFromResults(rs);
  const e = expected('soccer', ra, 'X', 'Y');
  assert.ok(Math.abs(e.lh - ra.avgHome) < 1e-9 && Math.abs(e.la - ra.avgAway) < 1e-9);
});

test('ratings: sin resultados todo es finito', () => {
  const ra = ratingsFromResults([]);
  for (const sport of Object.keys(SPORT_MODEL)) {
    const e = expected(sport, ra, 'X', 'Y');
    for (const v of Object.values(e)) if (typeof v === 'number') assert.ok(Number.isFinite(v) && v >= 0, `${sport}`);
    if (e.kind === 'poisson') assert.ok(e.lh > 0 && e.la > 0);
    else assert.ok(e.total > 0 && e.sigma > 0);
  }
});

test('ratings: asOf excluye partidos futuros', () => {
  const base = [R('1', '2026-01-01T00:00Z', 'A', 'B', 2, 1)];
  const fut = [...base, R('2', '2026-03-01T00:00Z', 'A', 'B', 9, 0)];
  const asOf = Date.parse('2026-02-01T00:00Z');
  const a = ratingsFromResults(base, { asOf });
  const b = ratingsFromResults(fut, { asOf });
  assert.equal(b.teams.get('A').gp, 1);
  assert.deepEqual(b.teams.get('A'), a.teams.get('A'));
  assert.equal(b.avgHome, a.avgHome);
});

test('ratings: shrink hacia la media con prior y fuerza relativa', () => {
  const rs = Array.from({ length: 10 }, (_, i) => R(String(i), `2026-01-${10 + i}`, i % 2 ? 'A' : 'B', i % 2 ? 'B' : 'A', 3, 1));
  const ra = ratingsFromResults(rs, { prior: 5 });
  const a = ra.teams.get('A');
  assert.equal(a.gp, 10);
  const avg = (ra.avgHome + ra.avgAway) / 2;
  // 5 partidos en casa a favor 3, 5 de visitante a favor 1: gf bruto 2 = media, así que aquí gf == avg
  assert.ok(Math.abs(a.gf - avg) < 1e-9);
  const e = expected('hockey', ratingsFromResults([R('1', '2026-01-01', 'A', 'B', 6, 0)], { prior: 5 }), 'A', 'B');
  assert.ok(e.lh > e.la && Number.isFinite(e.lh));
});

test('ratings: modelo normal con sigma por deporte', () => {
  assert.equal(SPORT_MODEL.basketball, 'normal');
  assert.equal(SPORT_MODEL.soccer, 'poisson');
  const rs = [R('1', '2026-01-01', 'A', 'B', 120, 100), R('2', '2026-01-02', 'B', 'A', 100, 110)];
  const e = expected('basketball', ratingsFromResults(rs), 'A', 'B');
  assert.equal(e.kind, 'normal');
  assert.equal(e.sigma, SIGMA.basketball);
  assert.ok(Math.abs(e.sigmaT - SIGMA.basketball * 1.1) < 1e-9);
  assert.ok(e.mu > 0 && e.total > 150);
});
