import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poissonPmf } from '../public/betmath.js';
import { price, halfLine, negBinPmf, scoreGrid, normalOver, countOver } from '../lib/pricing.mjs';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('price: cuota justa y con margen, acotadas', () => {
  const r = price(0.5);
  assert.equal(r.fair, 2);
  assert.equal(r.coflas, 1.9);
  assert.equal(price(0.999).fair, 1.01);
  assert.equal(price(0.001).fair, 101);
});

test('halfLine', () => {
  assert.equal(halfLine(7.2), 7.5);
  assert.equal(halfLine(6.9), 6.5);
  assert.equal(halfLine(7), 7.5);
});

test('scoreGrid suma 1 y aplica Dixon-Coles', () => {
  const g = scoreGrid(1.4, 1.1);
  near(sum(g.flat()), 1, 1e-9);
  const g0 = scoreGrid(1.4, 1.1, { rho: 0 });
  near(g0[0][0], poissonPmf(0, 1.4) * poissonPmf(0, 1.1), 1e-4);
  assert.ok(g[0][0] > g0[0][0]);
});

test('normalOver y countOver', () => {
  near(normalOver(7, 13.5, 0), 0.685, 0.002); // línea entera: P(X >= 0.5)
  near(normalOver(7, 13.5, 0.5), 0.685, 0.002);
  near(countOver([0.2, 0.3, 0.5], 0.5), 0.8);
  near(countOver([0.2, 0.3, 0.5], 1), 0.5);
});

test('negBinPmf suma 1; sin sobredispersión usa Poisson', () => {
  near(sum(Array.from({ length: 61 }, (_, k) => negBinPmf(k, 5, 9))), 1, 1e-6);
  near(negBinPmf(2, 5, 4), poissonPmf(2, 5), 1e-12);
});
