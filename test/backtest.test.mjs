// Backtest: predicciones sin fuga, métricas (Brier y log-loss), referencia, mitades y calibración del modelo normal. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { predict, score, baseline, halves, fitNormal, adjust, cutOf, LAG, SIGMAS, politeFetch } from '../scripts/backtest.mjs';
import { ratingsFromResults, expected, MU_SHRINK, SIGMA } from '../lib/ratings.mjs';

const R = (id, date, homeId, awayId, homeScore, awayScore) => ({ id, date, homeId, awayId, homeScore, awayScore, neutral: false });
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const day = (d, h = 0) => new Date(Date.UTC(2026, 0, d, h)).toISOString();

// Liga de 4 equipos: '1' es mucho mejor. prev = temporada anterior, test = la evaluada.
const prev = [R('p1', day(1), '1', '2', 110, 90), R('p2', day(2), '3', '4', 100, 100), R('p3', day(3), '2', '1', 95, 105), R('p4', day(4), '4', '3', 99, 101)];
const season = [R('t1', day(10, 20), '1', '3', 112, 100), R('t2', day(10, 23), '2', '4', 98, 101), R('t3', day(12), '3', '1', 90, 115), R('t4', day(13), '4', '2', 100, 100)];

test('backtest: corte 6 h antes del inicio, alineado al día UTC', () => {
  assert.equal(cutOf(day(10, 20)), Date.parse(day(10)));
  assert.equal(cutOf(day(11, 3)), Date.parse(day(10))); // 03:00Z del 11 − 6 h = 21:00Z del 10
  for (const r of season) assert.ok(cutOf(r.date) <= Date.parse(r.date) - LAG);
});

test('backtest: cada partido se predice con prev + partidos ya terminados de la temporada', () => {
  const preds = predict('basketball', prev, season);
  assert.deepEqual(preds.map((p) => p.id), ['t1', 't2', 't3']); // t4 empató: deporte binario, fuera
  assert.deepEqual(preds.map((p) => p.outcome), ['H', 'A', 'A']);
  assert.deepEqual(preds.map((p) => [p.margin, p.points]), [[12, 212], [-3, 199], [-25, 205]]);
  const all = [...prev, ...season];
  for (const p of preds) {
    const g = season.find((r) => r.id === p.id);
    const want = expected('basketball', ratingsFromResults(all, { sport: 'basketball', asOf: cutOf(g.date) }), g.homeId, g.awayId);
    assert.deepEqual(p.model, want);
  }
});

test('backtest: sin fuga, cambiar un resultado no cambia su propia predicción ni las del mismo corte', () => {
  const before = predict('basketball', prev, season);
  const changed = season.map((r) => (r.id === 't1' ? { ...r, homeScore: 60 } : r));
  const after = predict('basketball', prev, changed);
  assert.deepEqual(after[0].model, before[0].model);
  assert.deepEqual(after[1].model, before[1].model); // t2 empieza 3 h después de t1: mismo corte
  assert.notDeepEqual(after[2].model, before[2].model); // t3 ya ve el resultado de t1
});

test('backtest: fútbol es de 3 resultados y conserva los empates', () => {
  const goals = (rs, scores) => rs.map((r, i) => ({ ...r, homeScore: scores[i][0], awayScore: scores[i][1] }));
  const preds = predict('soccer', goals(prev, [[2, 0], [1, 1], [0, 1], [1, 2]]), goals(season, [[3, 1], [0, 2], [1, 1], [2, 0]]));
  assert.deepEqual(preds.map((p) => p.outcome), ['H', 'A', 'D', 'H']);
  for (const p of preds) assert.equal(p.model.kind, 'poisson');
});

test('backtest: Brier y log-loss binarios a mano', () => {
  const preds = [{ outcome: 'H', model: { kind: 'normal', mu: 0, sigma: 12 } }, { outcome: 'A', model: { kind: 'normal', mu: 0, sigma: 12 } }];
  const m = score('basketball', preds);
  assert.equal(m.n, 2);
  close(m.brier, 0.25);
  close(m.logloss, Math.log(2));
});

test('backtest: Brier de 3 resultados en fútbol suma las tres clases', () => {
  const m = score('soccer', [{ outcome: 'D', model: { kind: 'poisson', lh: 0, la: 0 } }]); // 0-0 seguro
  close(m.brier, 0);
  close(m.logloss, 0);
  const b = baseline('soccer', [R('a', day(1), '1', '2', 1, 0), R('b', day(2), '1', '2', 0, 0), R('c', day(3), '1', '2', 0, 2), R('d', day(4), '1', '2', 3, 1)],
    [{ outcome: 'H' }]);
  close(b.brier, (0.5 - 1) ** 2 + 0.25 ** 2 + 0.25 ** 2);
  close(b.logloss, Math.log(2));
});

test('backtest: la referencia binaria usa la tasa local de la temporada anterior, sin empates', () => {
  const b = baseline('basketball', prev, [{ outcome: 'H' }, { outcome: 'A' }]);
  // prev: local gana p1, p4; visita gana p3; p2 empate fuera → 2/3.
  close(b.brier, ((2 / 3 - 1) ** 2 + (2 / 3) ** 2) / 2);
  assert.throws(() => baseline('basketball', [], [{ outcome: 'H' }]), /temporada anterior/);
});

test('backtest: mitades cronológicas, la primera para calibrar y la segunda de prueba', () => {
  const [cal, hold] = halves([1, 2, 3, 4, 5]);
  assert.deepEqual(cal, [1, 2]);
  assert.deepEqual(hold, [3, 4, 5]);
});

test('backtest: grilla de σ de 8 a 24 cada 0.5', () => {
  assert.equal(SIGMAS.length, 33);
  assert.equal(SIGMAS[0], 8);
  assert.equal(SIGMAS.at(-1), 24);
  for (let i = 1; i < SIGMAS.length; i++) assert.equal(SIGMAS[i] - SIGMAS[i - 1], 0.5);
});

const N = (mu, margin, total = 200, points = 200) => ({ outcome: margin > 0 ? 'H' : 'A', margin, points, model: { kind: 'normal', mu, sigma: 12, total, sigmaT: 13 } });

test('backtest: fitNormal saca k por mínimos cuadrados sin intercepto, el desvío de residuos y σ_T', () => {
  // margen = mu / 2 exacto: k relativo 0.5 y residuos nulos; totales errados por ±3 y ±4.
  const ps = [N(8, 4, 200, 203), N(-8, -4, 200, 197), N(4, 2, 210, 214), N(-4, -2, 210, 206)];
  const f = fitNormal('basketball', ps);
  close(f.kRel, 0.5);
  close(f.k, MU_SHRINK.basketball * 0.5);
  close(f.residualSd, 0);
  close(f.sigmaT, Math.sqrt((9 + 9 + 16 + 16) / 4));
  const a = adjust(ps, f);
  close(a[0].model.mu, 4);
  assert.equal(a[0].model.sigma, f.sigma);
  assert.equal(a[0].model.sigmaT, f.sigmaT);
  assert.equal(ps[0].model.mu, 8); // no muta la entrada
});

test('backtest: σ de basketball = menor log-loss de la grilla tras aplicar k; fútbol americano conserva su σ', () => {
  // mu 10 y márgenes 12, 8, 15, −5: k relativo 0.75 → mu 7.5; gana 3 de 4, así que el ml del local debe dar ≈ 0.75.
  const ps = [N(10, 12), N(10, 8), N(10, 15), N(10, -5)];
  const f = fitNormal('basketball', ps);
  close(f.kRel, 0.75);
  assert.ok(f.sigma > SIGMAS[0] && f.sigma < SIGMAS.at(-1), `σ ${f.sigma} en el borde`);
  close(f.residualSd, Math.sqrt((4.5 ** 2 + 0.5 ** 2 + 7.5 ** 2 + 12.5 ** 2) / 4));
  const ll = (s) => score('basketball', adjust(ps, { ...f, sigma: s })).logloss;
  for (const s of SIGMAS) assert.ok(ll(f.sigma) <= ll(s));
  assert.equal(fitNormal('football', ps).sigma, SIGMA.football);
  assert.equal(fitNormal('basketball', [N(0, 3), N(0, -3)]).kRel, 1); // sin mu no hay pendiente que estimar
});

// ---------- politeFetch: caché en disco, ≤ 2 en vuelo y reintentos ante 403/429 (Ruling 18) ----------
const tmpDir = () => mkdtemp(join(tmpdir(), 'coflas-cache-'));
const noSleep = () => Promise.resolve();
const resp = (status, body = { ok: status }) => new Response(JSON.stringify(body), { status });

test('politeFetch: guarda en disco lo que responde bien y otra corrida lo lee sin red', async () => {
  const dir = await tmpDir();
  try {
    const calls = [];
    const inner = async (url) => (calls.push(url), resp(200, { url }));
    const a = politeFetch(inner, { dir, sleep: noSleep });
    assert.deepEqual(await (await a('https://x/1')).json(), { url: 'https://x/1' });
    const b = politeFetch(async () => assert.fail('no debía pedir a la red'), { dir, sleep: noSleep }); // corrida nueva: reanuda
    assert.deepEqual(await (await b('https://x/1')).json(), { url: 'https://x/1' });
    assert.equal(calls.length, 1);
    assert.equal((await readdir(dir)).length, 1); // sin temporales sueltos
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('politeFetch: nunca más de 2 peticiones en vuelo', async () => {
  const dir = await tmpDir();
  try {
    let active = 0;
    let max = 0;
    const inner = async (url) => {
      max = Math.max(max, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return resp(200, { url });
    };
    const f = politeFetch(inner, { dir, sleep: noSleep });
    const got = await Promise.all([1, 2, 3, 4, 5, 6].map(async (i) => (await f(`https://x/${i}`)).json()));
    assert.deepEqual(got.map((g) => g.url), [1, 2, 3, 4, 5, 6].map((i) => `https://x/${i}`));
    assert.equal(max, 2);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('politeFetch: 403/429 reintenta con espera exponencial; tras 4 intentos se detiene sin volver a pedir', async () => {
  const dir = await tmpDir();
  try {
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const seq = [429, 403, 200];
    const ok = politeFetch(async () => resp(seq.shift()), { dir, sleep, delayMs: 1, backoffMs: 100 });
    assert.equal((await ok('https://x/a')).status, 200);
    assert.deepEqual(waits.filter((w) => w !== 1), [100, 200]);

    let calls = 0;
    const blocked = politeFetch(async () => (calls++, resp(403)), { dir, sleep: noSleep });
    assert.equal((await blocked('https://x/b')).status, 403);
    assert.equal(calls, 4);
    assert.equal(blocked.blocked, 403);
    assert.equal((await blocked('https://x/c')).status, 403); // bloqueado: ya no pide
    assert.equal(calls, 4);
    assert.equal((await blocked('https://x/a')).status, 200); // lo que ya está en disco sigue sirviendo
    assert.ok(!(await readdir(dir)).some((f) => f.endsWith('.tmp')));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('politeFetch: otros errores no se reintentan ni se guardan', async () => {
  const dir = await tmpDir();
  try {
    let calls = 0;
    const f = politeFetch(async () => (calls++, resp(404)), { dir, sleep: noSleep });
    assert.equal((await f('https://x/404')).status, 404);
    assert.equal((await f('https://x/404')).status, 404);
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true });
  }
});
