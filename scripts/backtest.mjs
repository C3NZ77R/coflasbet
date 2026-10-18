// Backtest del modelo en la última temporada completa de cada liga: Brier y log-loss de la p del ganador (fútbol:
// 1X2 de 3 resultados) contra la referencia de las frecuencias de la temporada anterior. La temporada se parte por
// fecha: en la primera mitad se calibra el modelo normal (k, σ y σ_T) y en la segunda se mide; n, brier, logloss y
// baseline son de esa segunda mitad y calibration trae la primera. Escribe docs/accuracy.json mezclando con lo que ya
// tenía. Uso: node --env-file-if-exists=.env scripts/backtest.mjs [liga…] (sin ligas: todas menos las universitarias;
// el k, σ y σ_T que imprime valen para copiar a lib/ratings.mjs solo si corrieron todas las ligas del deporte).
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { LEAGUES, leagueById } from '../public/leagues.js';
import { getPastSeason, isCollege } from '../lib/espn.mjs';
import { ratingsFromResults, expected, SPORT_MODEL, SIGMA, SIGMA_T, MU_SHRINK } from '../lib/ratings.mjs';
import { marketsFor } from '../lib/markets.mjs';

export const LAG = 6 * 3_600_000;
const DAY = 86_400_000;
export const SIGMAS = Array.from({ length: 33 }, (_, i) => 8 + i / 2);
const GRID = { basketball: SIGMAS }; // football conserva el σ de la literatura
const EPS = 1e-12; // log(0) sería Infinity, que JSON guarda como null
const OUT = new URL('../docs/accuracy.json', import.meta.url);

// Los ratings de un partido usan lo que empezó al menos 6 h antes (ya terminó: sin fuga del resultado), con el
// corte bajado al día UTC para calcular los ratings una vez por jornada.
export const cutOf = (date) => Math.floor((Date.parse(date) - LAG) / DAY) * DAY;
const outcomeOf = (r) => (r.homeScore > r.awayScore ? 'H' : r.homeScore < r.awayScore ? 'A' : 'D');
const binary = (sport) => sport !== 'soccer'; // en los demás deportes el ganador no tiene empate: se ignoran
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// Igual que en vivo: ratings de la temporada anterior más la evaluada hasta el corte, y expected() con la sede.
export function predict(sport, prev, games) {
  const all = [...prev, ...games];
  const out = [];
  let cut = null;
  let ratings;
  for (const g of [...games].sort((a, b) => a.date.localeCompare(b.date))) {
    const outcome = outcomeOf(g);
    if (binary(sport) && outcome === 'D') continue;
    const c = cutOf(g.date);
    if (c !== cut) [cut, ratings] = [c, ratingsFromResults(all, { sport, asOf: c })];
    out.push({ id: g.id, outcome, margin: g.homeScore - g.awayScore, points: g.homeScore + g.awayScore,
      model: expected(sport, ratings, g.homeId, g.awayId, { neutral: g.neutral }) });
  }
  return out;
}

export const halves = (xs) => [xs.slice(0, Math.floor(xs.length / 2)), xs.slice(Math.floor(xs.length / 2))];

// p de cada resultado con los mismos mercados que ve el usuario.
function probs(sport, model) {
  const ms = marketsFor(sport, model);
  const p = (key, name) => ms.find((m) => m.key === key).selections.find((s) => s.name === name).p;
  return binary(sport) ? { H: p('ml', 'Local'), D: 0, A: p('ml', 'Visitante') } : { H: p('1x2', 'Local'), D: p('1x2', 'Empate'), A: p('1x2', 'Visitante') };
}

// Brier binario (p_local − o)² o de 3 clases (suma sobre H/D/A); log-loss = −ln p del resultado.
function metrics(sport, rows) {
  if (!rows.length) throw new Error('sin partidos terminados para medir');
  const ks = binary(sport) ? ['H'] : ['H', 'D', 'A'];
  let brier = 0;
  let logloss = 0;
  for (const { p, outcome } of rows) {
    for (const k of ks) brier += (p[k] - (k === outcome)) ** 2;
    logloss -= Math.log(Math.max(p[outcome], EPS));
  }
  return { n: rows.length, brier: brier / rows.length, logloss: logloss / rows.length };
}

export const score = (sport, preds) => metrics(sport, preds.map(({ model, outcome }) => ({ outcome, p: probs(sport, model) })));

// Referencia: siempre las frecuencias de la temporada anterior (binario: tasa de victorias local sin empates).
export function baseline(sport, prev, preds) {
  const os = prev.map(outcomeOf).filter((o) => !binary(sport) || o !== 'D');
  if (!os.length) throw new Error('sin temporada anterior para la referencia');
  const f = Object.fromEntries(['H', 'D', 'A'].map((k) => [k, os.filter((o) => o === k).length / os.length]));
  const { brier, logloss } = metrics(sport, preds.map(({ outcome }) => ({ outcome, p: f })));
  return { brier, logloss };
}

// Modelo normal con la calibración aplicada; kRel es relativo al MU_SHRINK con el que se predijo.
export const adjust = (preds, { kRel, sigma, sigmaT }) => preds.map((p) => ({ ...p, model: { ...p.model, mu: p.model.mu * kRel, sigma, sigmaT } }));

// Calibración del modelo normal sobre los partidos de calibración de todas las ligas del deporte (las constantes son
// por deporte). k: mínimos cuadrados del margen sobre mu sin intercepto (mu ya trae la localía); k < 1 = mu
// sobreconfiado. σ: el de menor log-loss de la grilla con k aplicado; debe quedar cerca de residualSd, el desvío
// real de margen − k·mu. σ_T: desvío real de los totales.
export function fitNormal(sport, preds) {
  const den = sum(preds, (p) => p.model.mu ** 2);
  const kRel = den > 0 ? sum(preds, (p) => p.margin * p.model.mu) / den : 1;
  const rms = (f) => Math.sqrt(sum(preds, (p) => f(p) ** 2) / preds.length);
  const sigmaT = rms((p) => p.points - p.model.total);
  const grid = GRID[sport] ?? [SIGMA[sport]];
  const loss = grid.map((sigma) => score(sport, adjust(preds, { kRel, sigma, sigmaT })).logloss);
  const sigma = grid[loss.indexOf(Math.min(...loss))]; // empate = el menor
  return { k: MU_SHRINK[sport] * kRel, kRel, sigma, residualSd: rms((p) => p.margin - kRel * p.model.mu), sigmaT };
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r1 = (x) => Math.round(x * 10) / 10;

async function main(args) {
  const ids = args.length ? args : LEAGUES.filter((l) => !isCollege(l)).map((l) => l.id);
  const bad = ids.filter((id) => !leagueById(id) || isCollege(leagueById(id)));
  if (bad.length) {
    console.error(`Sin backtest: ${bad.join(', ')}. Ligas válidas: ${LEAGUES.filter((l) => !isCollege(l)).map((l) => l.id).join(' ')}`);
    process.exitCode = 2;
    return;
  }
  const runs = [];
  for (const id of ids) {
    try {
      const { sport } = leagueById(id);
      const [test, prev] = [await getPastSeason(id, 1), await getPastSeason(id, 2)];
      runs.push({ id, sport, season: test.season, prev: prev.results, preds: predict(sport, prev.results, test.results) });
    } catch (err) {
      console.error(`${id}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  const fits = {};
  for (const sport of new Set(runs.map((r) => r.sport).filter((s) => SPORT_MODEL[s] === 'normal'))) {
    const f = fitNormal(sport, runs.filter((r) => r.sport === sport).flatMap((r) => halves(r.preds)[0]));
    fits[sport] = f;
    console.log(`${sport}: k ${r2(f.k)}, σ ${f.sigma} (desvío real ${r2(f.residualSd)}), σ_T ${r1(f.sigmaT)}`
      + ` → lib/ratings.mjs tiene k ${MU_SHRINK[sport]}, σ ${SIGMA[sport]}, σ_T ${SIGMA_T[sport]}`);
    const grid = GRID[sport];
    if (grid && (f.sigma === grid[0] || f.sigma === grid.at(-1) || Math.abs(f.sigma - f.residualSd) > 0.15 * f.residualSd)) {
      console.warn(`${sport}: σ en el borde de la grilla o lejos del desvío real: revisar el modelo de mu antes de publicar`);
    }
  }
  const fresh = {};
  for (const { id, sport, season, prev, preds } of runs) {
    const f = fits[sport];
    const [cal, hold] = halves(f ? adjust(preds, f) : preds);
    const half = (ps) => {
      const m = score(sport, ps);
      const b = baseline(sport, prev, ps);
      return { n: m.n, brier: r4(m.brier), logloss: r4(m.logloss), baseline: { brier: r4(b.brier), logloss: r4(b.logloss) } };
    };
    const out = half(hold);
    const publish = out.brier < out.baseline.brier;
    fresh[id] = { season, ...out, publish, calibration: half(cal),
      ...(f && { k: r2(f.k), sigma: f.sigma, residualSd: r2(f.residualSd), sigmaT: r1(f.sigmaT) }) };
    console.log(`${id} ${season}: ${out.n} partidos de prueba, Brier ${out.brier} (referencia ${out.baseline.brier}), log-loss`
      + ` ${out.logloss} (referencia ${out.baseline.logloss}) → ${publish ? 'se publica' : 'NO se publica'}`);
  }
  if (!runs.length) return;
  let old = {};
  try {
    old = JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await writeFile(OUT, `${JSON.stringify({ ...old, ...fresh }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
