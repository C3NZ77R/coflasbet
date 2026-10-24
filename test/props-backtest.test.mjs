// Calibración previa de propLine: el modelo de hoy reproduce propLine, filas fuera de la muestra sin fuga y comparación pareada. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pOver, logRows, paired, statEntry, MODELS } from '../scripts/props-backtest.mjs';
import { propLine } from '../lib/props.mjs';

const ten = [10, 14, 11, 18, 12, 16, 13, 19, 15, 17, 9, 20];

test('pOver: blend|all|kind es la P(Más) de propLine', () => {
  for (const kind of ['normal', 'count']) {
    const r = propLine(ten, kind);
    assert.equal(pOver(`blend|all|${kind}`, ten, r.line), r.pOver);
  }
  assert.equal(MODELS.length, 4 * 3 * 2);
});

test('logRows: solo partidos previos, sin los de la muestra ni los de pocos minutos, en orden de fecha', () => {
  const day = (d) => `2026-01-${String(d).padStart(2, '0')}T00:00:00.000Z`;
  const games = ten.map((v, i) => ({ eventId: `e${i + 1}`, date: day(i + 1), minutes: i === 10 ? 0 : 30, stats: { pts: v, reb: v % 7 } }));
  const all = [...games].reverse(); // del más reciente al más viejo, como getGamelog
  const bench = all.map((g) => ({ ...g, minutes: 10 }));
  const rows = logRows(new Map([['a', { cur: games, all }], ['b', { cur: bench, all: bench }]]), { pts: 'normal', reb: 'count' }, new Set(['e10']));
  // e1..e8 tienen menos de 8 previos, e10 está en la muestra, e11 no jugó; b promedia 10 min.
  assert.deepEqual([...new Set(rows.map((r) => r.game))], ['e9', 'e12']);
  const r = rows.find((x) => x.game === 'e12' && x.stat === 'pts');
  const before = all.filter((g) => g.date < day(12)).map((g) => g.stats.pts);
  assert.deepEqual(r.values, before);
  assert.equal(r.line, propLine(before, 'normal').line);
  assert.equal(r.won, 20 > r.line);
});

test('paired y statEntry: diferencia de log-loss por partido; el modelo de hoy contra sí mismo no tiene vsCurrent', () => {
  const rows = [['a', true], ['a', false], ['b', true]].map(([game, won]) => ({ game, won }));
  const loss = (p, w) => -Math.log(w ? p : 1 - p);
  const d = [(loss(0.6, true) - loss(0.5, true) + loss(0.6, false) - loss(0.5, false)) / 2, loss(0.6, true) - loss(0.5, true)];
  const p = paired(rows, [0.6, 0.6, 0.6], [0.5, 0.5, 0.5]);
  assert.ok(Math.abs(p.diff - (d[0] + d[1]) / 2) < 1e-12);
  assert.ok(Math.abs(p.se - Math.abs(d[0] - d[1]) / 2) < 1e-12);
  const values = [...ten].reverse();
  const line = propLine(values, 'count').line;
  const e = statEntry([20, 9, 16, 7].map((final, i) => ({ game: `g${i >> 1}`, kind: 'count', values, line, final, won: final > line })));
  assert.equal(e.current, 'blend|all|count');
  assert.equal(e.models[e.current].vsCurrent, undefined);
  // Guarda el de hoy, los 6 que cambian un solo factor (media, varianza o forma) y el mejor de la grilla.
  const off = (k) => k.split('|').filter((x, i) => x !== e.current.split('|')[i]).length;
  const kept = Object.keys(e.models).filter((k) => k !== e.best || off(k) <= 1);
  assert.equal(kept.length, 7);
  assert.ok(kept.every((k) => off(k) <= 1 && (k === e.current || e.models[k].vsCurrent)));
  assert.equal(e.lines.median20.over, 0.5);
});
