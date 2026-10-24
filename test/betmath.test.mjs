import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../public/betmath.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('conversiones de cuotas', () => {
  assert.equal(m.decimalToAmerican(2.5), 150);
  assert.equal(m.decimalToAmerican(1.5), -200);
  near(m.americanToDecimal(150), 2.5);
  near(m.americanToDecimal(-200), 1.5);
});

test('EV y parlay', () => {
  near(m.expectedValue(0.5, 2.1), 0.05);
  near(m.parlayOdds([2, 1.5, 3]), 9);
});

test('hitRate, streak y summarize', () => {
  assert.deepEqual(m.hitRate([30, 25, 27.5, 31, null], 27.5, 'Over'), { hits: 2, pushes: 1, n: 4, pct: 2 / 3 });
  assert.deepEqual(m.hitRate([20, 21], 25.5, 'Under'), { hits: 2, pushes: 0, n: 2, pct: 1 });
  assert.equal(m.hitRate([], 1.5).pct, null);
  assert.equal(m.streak([30, 29, 20, 35], 27.5), 2);
  assert.equal(m.streak([30, 29, 20, 35], 27.5, 'Under'), 0);
  assert.equal(m.streak([3, 2, 4], 2), 1); // el push corta
  assert.deepEqual(m.summarize([3, 1, 2, 10]), { n: 4, avg: 4, median: 2.5, min: 1, max: 10 });
  assert.equal(m.summarize([5, null, 7, 9]).median, 7);
  assert.deepEqual(m.summarize([]), { n: 0, avg: null, median: null, min: null, max: null });
});

// 12 partidos, del más reciente al más antiguo, uno cada 2 días salvo un back-to-back.
const day = (i) => new Date(Date.UTC(2026, 3, 30) - i * 2 * 864e5 + (i >= 1 ? 864e5 : 0)).toISOString();
const GAMES = Array.from({ length: 12 }, (_, i) => ({
  eventId: `ev${i}`, date: day(i), season: i < 8 ? 2026 : 2025, opp: { id: i % 3 === 0 ? '13' : '5', abbr: i % 3 === 0 ? 'LAL' : 'MIA' },
  home: i % 2 === 0, result: i % 4 === 3 ? 'L' : 'W', margin: i % 4 === 3 ? -4 : 5 + i, teamScore: 110, oppScore: 100,
  minutes: 30 + i, stats: { pts: 20 + i },
}));

test('splitGames: ventanas, local/visita, rival, minutos, descanso, compañeros, resultado y margen', () => {
  assert.equal(m.splitGames(GAMES, { window: 'l5' }).length, 5);
  assert.deepEqual(m.splitGames(GAMES, { window: 'l3', location: 'home' }).map((g) => g.eventId), ['ev0', 'ev2', 'ev4']);
  assert.ok(m.splitGames(GAMES, { location: 'away' }).every((g) => !g.home));
  assert.deepEqual(m.splitGames(GAMES, { window: 'h2h', oppId: 13 }).map((g) => g.eventId), ['ev0', 'ev3', 'ev6', 'ev9']);
  assert.deepEqual(m.splitGames(GAMES, { window: 'h2h' }), []);
  assert.equal(m.splitGames(GAMES, { window: 'season' }).length, 8);
  assert.equal(m.splitGames(GAMES, { window: 'prev' }).length, 4);
  assert.equal(m.splitGames(GAMES, { window: '2025' }).length, 4);
  assert.equal(m.splitGames(GAMES, { minMinutes: 35, maxMinutes: 38 }).length, 4);
  assert.deepEqual(m.splitGames(GAMES, { daysRest: 0 }).map((g) => g.eventId), ['ev0']); // back-to-back
  assert.equal(m.splitGames(GAMES, { daysRest: 1 }).length, 10); // el más antiguo no tiene dato
  assert.equal(m.splitGames(GAMES, { daysRest: '1+' }).length, 10);
  assert.deepEqual(m.splitGames(GAMES, { withAthlete: { games: [{ eventId: 'ev1' }, { eventId: 'ev2' }] } }).map((g) => g.eventId), ['ev1', 'ev2']);
  assert.equal(m.splitGames(GAMES, { withoutAthlete: new Set(['ev1', 'ev2']) }).length, 10);
  assert.ok(m.splitGames(GAMES, { result: 'L' }).every((g) => g.result === 'L'));
  assert.ok(m.splitGames(GAMES, { maxMargin: 6 }).every((g) => Math.abs(g.margin) <= 6));
  assert.equal(m.splitGames(GAMES, { window: 'l10', result: 'W' }).length, 9); // solo hay 9 victorias en 12
  assert.equal(m.splitGames(GAMES, { window: 'l5', result: 'W' }).at(-1).eventId, 'ev5'); // filtra (salta ev3) y luego corta
  assert.deepEqual(m.splitGames(null), []);
});

const gamelogOf = (pts) => ({ athlete: { name: 'Jayson Tatum' }, games: pts.map((v, i) => ({ ...GAMES[i], stats: { pts: v } })) });
const PTS = { key: 'pts', name: 'Puntos' };

test('insightsFor: racha seguida, k de n, local/visita y textos en español', () => {
  const streakIns = m.insightsFor({ athlete: { name: 'Jayson Tatum' }, gamelog: gamelogOf([30, 31, 29, 33, 28, 35, 20, 30, 31, 32]), prop: { line: 27.5, stat: 'pts' }, statDef: PTS });
  const top = streakIns[0];
  assert.equal(top.type, 'streak');
  assert.equal(top.text, 'Jayson Tatum superó 27.5 puntos en 6 partidos seguidos (promedio 31)');
  assert.deepEqual([top.side, top.line, top.k, top.n, top.pct, top.location], ['Over', 27.5, 6, 6, 1, 'all']);

  const ins = m.insightsFor({ gamelog: gamelogOf([20, 40, 22, 21, 23, 24, 25, 26, 27, 28]), prop: { line: 29.5, stat: 'pts', player: 'X' }, statDef: PTS });
  const texts = ins.map((i) => i.text);
  assert.ok(texts.includes('Jayson Tatum quedó por debajo de 29.5 puntos en 9 de sus últimos 10 partidos (promedio 25.6)'));
  assert.ok(texts.includes('Jayson Tatum quedó por debajo de 29.5 puntos en 5 partidos seguidos de local (promedio 23.4)'));
  assert.ok(texts.includes('Jayson Tatum quedó por debajo de 29.5 puntos en 4 de sus últimos 5 partidos de visitante (promedio 27.8)'));
  const kofn = ins.find((i) => i.type === 'kofn' && i.location === 'all');
  assert.deepEqual([kofn.k, kofn.n, kofn.pct, kofn.side], [9, 10, 0.9, 'Under']);
});

test('insightsFor: promedio lejos de la línea, statDef.from y casos vacíos', () => {
  const ins = m.insightsFor({ gamelog: gamelogOf(Array(10).fill(40)), prop: { line: 25.5 }, statDef: { key: 'pts', name: 'Puntos', from: (s) => s.pts } });
  const avg = ins.find((i) => i.type === 'avg');
  assert.equal(avg.text, 'Jayson Tatum promedia 40 puntos en sus últimos 10 partidos, por encima de la línea de 25.5');
  assert.equal(avg.side, 'Over');
  assert.deepEqual(m.insightsFor({ gamelog: gamelogOf([10]), prop: {} }), []);
  assert.deepEqual(m.insightsFor({}), []);
});

test('teamInsights: ATS, favorito/no favorito, over/under y forma en los últimos 5', () => {
  const g = (result, ats, ou) => ({ date: '2026-04-01', opp: 'MIA', home: true, score: '110-100', result, ats, ou });
  const gd = {
    home: { id: '2', abbr: 'BOS', name: 'Boston Celtics' },
    away: { id: '13', abbr: 'LAL', name: 'Los Angeles Lakers' },
    ats: {
      home: [{ key: 'home', label: 'Local ATS', summary: '8-2-0' }, { key: 'overall', label: 'ATS', summary: '12-8' }],
      away: [{ key: 'underdog', label: 'Underdog ATS', summary: '5-1' }, { key: 'vsconf', label: 'Conferencia', summary: '3-3' }],
    },
    records: { home: [{ key: 'home', label: 'Local', summary: '30-11' }], away: [{ key: 'underdog', label: 'No favorito', summary: '7-3' }] },
    lastFive: { home: [g('W', 'W', 'O'), g('W', 'W', 'O'), g('W', 'W', 'O'), g('W', 'W', 'O'), g('L', 'L', 'U')], away: [g('W', 'P', 'U'), g('L', 'L', 'U'), g('W', 'W', 'O')] },
  };
  const ins = m.teamInsights(gd);
  const texts = ins.map((i) => i.text);
  for (const t of [
    'Boston Celtics va 8-2 (80%) contra el hándicap de local',
    'Boston Celtics va 12-8 (60%) contra el hándicap en la temporada',
    'Los Angeles Lakers va 5-1 (83%) contra el hándicap como no favorito',
    'Los Angeles Lakers va 7-3 (70%) como no favorito esta temporada',
    'Boston Celtics va 4-1 contra el hándicap en sus últimos 5 partidos',
    'Los partidos de Boston Celtics terminaron por encima del total en 4 de los últimos 5',
    'Boston Celtics ganó 4 de sus últimos 5 partidos',
    'Los Angeles Lakers va 1-1-1 contra el hándicap en sus últimos 3 partidos',
    'Los partidos de Los Angeles Lakers terminaron por debajo del total en 2 de los últimos 3',
  ]) assert.ok(texts.includes(t), t);
  assert.ok(!texts.some((t) => /Conferencia|30-11/.test(t)));
  const ou = ins.find((i) => i.type === 'ou' && i.team === 'home');
  assert.deepEqual([ou.side, ou.market, ou.k, ou.n, ou.teamId], ['Over', 'total', 4, 5, '2']);
  assert.deepEqual(m.teamInsights(null), []);
  assert.deepEqual(m.teamInsights({ home: { name: 'A' }, away: { name: 'B' } }), []);
});

test('normCdf y poissonPmf: precisión y valores extremos', () => {
  near(m.normCdf(0), 0.5, 1e-15);
  near(m.normCdf(1), 0.841344746068543, 1e-12);
  near(m.normCdf(-3), 0.00134989803163, 1e-12);
  near(m.normCdf(1.96) + m.normCdf(-1.96), 1, 1e-14);
  assert.equal(m.normCdf(Infinity), 1);
  assert.equal(m.normCdf(-Infinity), 0);
  near(m.poissonPmf(0, 2.5), Math.exp(-2.5), 1e-15);
  assert.equal(m.poissonPmf(0, 0), 1);
  assert.equal(m.poissonPmf(2, 0), 0);
  const big = m.poissonPmf(200, 200); // 200! desborda como número, en logaritmos no
  assert.ok(big > 0.02 && big < 0.03);
  assert.ok(Number.isFinite(m.poissonPmf(1000, 200)));
});
