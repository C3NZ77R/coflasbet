// Backtest del total de games del 1er set (ATP): cada partido de la temporada con el primer set terminado se predice con
// setLengthFrom reajustado cada día con lo jugado antes y el Elo de ese momento (sin fuga; en producción se reajusta una
// vez por día). Referencias: el histograma de primeros sets por superficie de los 365 días previos y la cadena con saque
// fijo 0.64 (el modelo de antes). Escribe atp.set1 y _bins.tennis.ou_set1 en docs/accuracy.json.
// Uso: node scripts/tennis-set1-backtest.mjs (lee data/atp-history.json; tarda unos minutos).
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { finished, matchProb, eloStep, setLengthFrom, firstSetGames, setGames, serveFromMatchProb, setDone, shortSets } from '../lib/tennis.mjs';
import { countOver } from '../lib/pricing.mjs';

const SEASON = 2026;
export const LINES = [8.5, 9.5, 10.5, 12.5];
const DAY = 86_400_000;
const OUT = new URL('../docs/accuracy.json', import.meta.url);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// Filas { s, g, P: { model, hist, fixed } }: g = games del primer set, P = distribución de cada predictor.
export function predictSet1(matches, season, { fixed = true } = {}) {
  const ms = finished(matches).filter((m) => !shortSets(m));
  const elo = new Map();
  const rows = [];
  let day = null, fit, hist;
  for (const m of ms) {
    const t = Date.parse(m.date);
    const p = matchProb(elo, m.a.id, m.b.id, m.surface);
    if (new Date(t).getUTCFullYear() === season && m.sets.length && setDone(m.sets[0])) {
      const d = Math.floor(t / DAY) * DAY;
      if (d !== day) {
        day = d;
        fit = setLengthFrom(ms, { asOf: d });
        hist = { hard: Array(14).fill(0.5), clay: Array(14).fill(0.5), grass: Array(14).fill(0.5) }; // Laplace
        for (const x of ms) {
          const tx = Date.parse(x.date);
          if (tx >= d) break;
          if (tx >= d - 365 * DAY && x.sets.length && setDone(x.sets[0])) hist[x.surface][x.sets[0][0] + x.sets[0][1]]++;
        }
      }
      const h = hist[m.surface], z = h.reduce((a, b) => a + b, 0);
      const P = { model: firstSetGames(fit, m, p), hist: h.map((v) => v / z) };
      if (fixed) {
        const { sa, sb } = serveFromMatchProb(p, m.bestOf, { slam: m.slam });
        P.fixed = setGames(sa, sb);
      }
      rows.push({ s: m.surface, g: m.sets[0][0] + m.sets[0][1], P });
    }
    eloStep(elo, m);
  }
  return rows;
}

// Log-loss del total exacto, RPS ordinal (0..13), Brier de "Más" en cada línea y media predicha contra la real.
export function scoreSet1(rows, key) {
  const n = rows.length;
  const avg = (f) => rows.reduce((s, r) => s + f(r.P[key], r.g), 0) / n;
  const rps = (P, g) => {
    let s = 0, c = 0;
    for (let k = 0; k < 13; k++) s += ((c += P[k]) - (g <= k ? 1 : 0)) ** 2;
    return s / 13;
  };
  return {
    n,
    logloss: r4(avg((P, g) => -Math.log(Math.max(P[g], 1e-12)))),
    rps: r4(avg(rps)),
    brier: Object.fromEntries(LINES.map((t) => [t, r4(avg((P, g) => (countOver(P, t) - (g > t ? 1 : 0)) ** 2))])),
    mean: r4(avg((P) => P.reduce((s, p, k) => s + p * k, 0))),
    actual: r4(avg((P, g) => g)),
  };
}

// Aciertos por tramo de p (forma de hitBins en scripts/backtest.mjs): las dos opciones de cada línea.
export function set1Bins(rows, key = 'model') {
  const bins = {};
  for (const r of rows) for (const t of LINES) {
    const o = countOver(r.P[key], t);
    for (const [p, won] of [[o, r.g > t], [1 - o, r.g < t]]) {
      const b = (bins[Math.min(9, Math.floor(p * 10))] ??= { n: 0, said: 0, hit: 0 });
      b.n++;
      b.said += p;
      b.hit += won;
    }
  }
  return Object.entries(bins).map(([i, b]) => ({ from: Number(i) * 10, n: b.n, said: r4(b.said / b.n), hit: r4(b.hit / b.n) }));
}

async function main() {
  const rows = predictSet1(JSON.parse(await readFile(new URL('../data/atp-history.json', import.meta.url), 'utf8')).matches, SEASON);
  const [model, hist, fixed] = ['model', 'hist', 'fixed'].map((k) => scoreSet1(rows, k));
  for (const [name, m] of [['modelo', model], ['histograma', hist], ['saque fijo 0.64', fixed]]) {
    console.log(`${name}: n ${m.n}, log-loss ${m.logloss}, RPS ${m.rps}, Brier ${LINES.map((t) => `${t}: ${m.brier[t]}`).join(' ')}, media ${m.mean} (real ${m.actual})`);
  }
  const bins = set1Bins(rows);
  for (const b of bins) console.log(`  ${b.from}%: n ${b.n}, dijo ${(b.said * 100).toFixed(1)}%, pasó ${(b.hit * 100).toFixed(1)}%`);
  const old = JSON.parse(await readFile(OUT, 'utf8'));
  const set1 = { season: SEASON, ...model, baseline: { hist, fixed }, publish: model.logloss < hist.logloss };
  await writeFile(OUT, `${JSON.stringify({ ...old, atp: { ...old.atp, set1 }, _bins: { ...old._bins, tennis: { ...old._bins?.tennis, ou_set1: bins } } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
