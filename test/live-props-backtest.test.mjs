// Backtest de PRIOR.player: acumulados por cuarto desde las jugadas, filas sin fuga, P(Más) igual que la vista y comparación pareada. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cumulative, propRows, overAt, paired, shares, crossFit } from '../scripts/live-props-backtest.mjs';
import { propLine } from '../lib/props.mjs';
import { propSignals } from '../public/live.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const play = (q, type, ids, extra = {}) => ({ period: { number: q }, type: { text: type }, participants: ids.map((id) => ({ athlete: { id } })), ...extra });

test('cumulative: puntos, asistencias y rebotes al final de cada cuarto y con prórroga', () => {
  const c = cumulative([
    play(1, 'Jump Shot', ['a', 'b'], { scoringPlay: true, scoreValue: 2, text: 'A makes jumper (B assists)' }),
    play(1, 'Free Throw - 1 of 1', ['a'], { scoringPlay: true, scoreValue: 1, text: 'A makes free throw 1 of 1' }),
    play(1, 'Jump Shot', ['a'], { scoringPlay: false, scoreValue: 0, text: 'A misses jumper' }),
    play(2, 'Defensive Rebound', ['b']),
    play(2, 'Defensive Rebound', []), // de equipo
    play(3, 'Jump Shot', ['b'], { scoringPlay: true, scoreValue: 3, text: 'B makes three point jumper' }),
    play(5, 'Layup Shot', ['a'], { scoringPlay: true, scoreValue: 2, text: 'A makes layup' }), // prórroga
  ]);
  assert.deepEqual(c.get('a'), { pts: [3, 3, 3, 5], reb: [0, 0, 0, 0], ast: [0, 0, 0, 0] });
  assert.deepEqual(c.get('b'), { pts: [0, 0, 3, 3], reb: [0, 1, 1, 1], ast: [1, 1, 1, 1] });
});

test('propRows: los 8 con más minutos, línea con el game log previo al partido, sin los que no jugaron', () => {
  const day = (d) => `2026-01-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  const log = (pts, min, from = 1) => pts.map((v, i) => ({ eventId: `e${from + i}`, date: day(from + i), minutes: min, stats: { pts: v, reb: v % 7, ast: v % 5 } }));
  const ten = [10, 14, 11, 18, 12, 16, 13, 19, 15, 17];
  const logs = new Map([
    ['a', [...log(ten, 30), ...log([99, 99, 99], 30, 20)]], // del día 20 (el partido) en adelante: no cuenta
    ['b', log(ten.slice(0, 7), 40)], // 7 previos: sin línea
    ['c', log(ten, 35)], // no jugó
    ...[1, 2, 3, 4, 5, 6].map((k) => [`f${k}`, log(ten, 25)]),
    ['z', log(ten, 5)], // noveno en minutos
  ]);
  const box = [...logs.keys()].map((id) => ({ id, teamId: 'h', stats: id === 'a' ? { min: 30, pts: 22, reb: 4, ast: 2 } : { min: id === 'c' ? 0 : 20, pts: id === 'f1' ? 10 : 0, reb: 0, ast: 0 } }));
  const cum = new Map([['a', { pts: [5, 10, 15, 22], reb: [1, 2, 3, 4], ast: [0, 1, 1, 2] }]]); // f1: las jugadas no traen sus 10 puntos
  const { rows, mismatch } = propRows({ id: 'g', date: day(20) }, box, cum, logs);
  assert.deepEqual([...new Set(rows.map((r) => r.player))].sort(), ['a', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  assert.equal(mismatch, 1);
  assert.ok(!rows.some((r) => r.player === 'f1' && r.stat === 'pts'));
  const pts = rows.filter((r) => r.player === 'a' && r.stat === 'pts');
  const line = propLine([...ten].reverse(), 'normal');
  assert.deepEqual(pts.map((r) => [r.f, r.current, r.line, r.mean, r.won]), [0.25, 0.5, 0.75].map((f, i) => [f, [5, 10, 15][i], line.line, line.mean, 22 > line.line]));
});

test('overAt: la misma P(Más) que muestra propSignals con PRIOR.player', () => {
  const live = { progress: 0.5, home: { id: 'h', abbr: 'H', score: 50 }, away: { id: 'v', abbr: 'V', score: 50 }, players: [{ id: 'a', teamId: 'h', stats: { pts: 20, pf: 0 } }] };
  const [s] = propSignals([{ id: 'x', side: 'Over', athleteId: 'a', player: 'A', stat: 'pts', kind: 'normal', mean: 20, variance: 40, line: 29.5 }], live, 'basketball');
  near(overAt({ kind: 'normal', current: 20, f: 0.5, mean: 20, variance: 40, line: 29.5 }, 5), s.pOver); // 5 = PRIOR.player de public/live.js
});

test('paired: diferencia de log-loss promedio por partido con el error entre partidos', () => {
  const rows = [['a', 2, 5, true], ['a', 4, 5, false], ['b', 1, 4, true], ['b', 3, 4, true], ['b', 0, 4, false]]
    .map(([game, current, mean, won]) => ({ game, kind: 'count', f: 0.5, current, mean, variance: mean * 1.5, line: 4.5, won }));
  const loss = (r, prior) => -Math.log(r.won ? overAt(r, prior) : 1 - overAt(r, prior));
  const d = ['a', 'b'].map((g) => rows.filter((r) => r.game === g)).map((rs) => rs.reduce((s, r) => s + loss(r, 1) - loss(r, 5), 0) / rs.length);
  const m = (d[0] + d[1]) / 2;
  const p = paired(rows, 1, 5);
  near(p.diff, m);
  near(p.se, Math.sqrt(((d[0] - m) ** 2 + (d[1] - m) ** 2) / 2));
  near(paired(rows, 5, 1).diff, -m);
});

test('shares y crossFit: parte del final por cuarto; cada mitad de la temporada lleva la curva de la otra', () => {
  const row = (game, f, current, final) => ({ game, f, current, final });
  const rows = [['g1', 4, 10], ['g2', 2, 10], ['g3', 3, 6], ['g4', 1, 6]].flatMap(([g, q1, fin]) => [row(g, 0.25, q1, fin), row(g, 0.5, fin / 2, fin), row(g, 0.75, fin * 0.8, fin)]);
  near(shares(rows)[0], 10 / 32);
  const { fit, rows: cv } = crossFit(rows);
  near(fit[0][0], 6 / 20);
  near(fit[1][0], 4 / 12);
  assert.equal(cv.length, rows.length);
  near(cv.find((r) => r.game === 'g1' && r.f === 0.25).w, 4 / 12); // g1 y g2: primera mitad → curva de g3 y g4
  near(cv.find((r) => r.game === 'g4' && r.f === 0.75).w, 0.8);
  const lin = (r) => overAt({ ...r, kind: 'count', mean: 5, variance: 7, line: 4.5, won: true, w: r.f }, 5);
  near(paired(cv.map((r) => ({ ...r, won: true })), lin, lin).diff, 0); // paired también acepta funciones fila → P(Más)
});
