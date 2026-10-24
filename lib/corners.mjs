// Córners y tarjetas de fútbol: estadísticas por partido desde el summary de ESPN, tasas por equipo (a favor y en
// contra, relativas a la media de liga por localía, con shrink) y mercados con binomial negativa.
// Las tarjetas cuentan amarillas + rojas, una cada una.
import { readFileSync } from 'node:fs';
import { fetchJson, getTeamSchedule, mapLimit } from './espn.mjs';
import { leagueById } from '../public/leagues.js';
import { price, halfLine, negBinPmf, countOver, MAX_P, publishable } from './pricing.mjs';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const str = (v) => (v == null ? null : String(v));
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------- normalizador ----------
// summary → { id, date, homeId, awayId, corners: [h, a], cards: [h, a] }; null si no terminó o faltan datos.
export function normMatchStats(json) {
  const comp = json?.header?.competitions?.[0];
  if (comp?.status?.type?.completed !== true) return null;
  const teams = json?.boxscore?.teams ?? [];
  const side = (ha) => teams.find((t) => t.homeAway === ha);
  const stat = (t, name) => num(t?.statistics?.find((s) => s.name === name)?.displayValue);
  const [h, a] = [side('home'), side('away')];
  const corners = [stat(h, 'wonCorners'), stat(a, 'wonCorners')];
  const yellow = [stat(h, 'yellowCards'), stat(a, 'yellowCards')];
  const red = [stat(h, 'redCards'), stat(a, 'redCards')];
  if ([...corners, ...yellow, ...red].some((v) => v == null)) return null;
  const id = str(json?.header?.id ?? comp.id);
  const [homeId, awayId] = [str(h?.team?.id), str(a?.team?.id)];
  const date = str(comp.date);
  if (!id || !homeId || !awayId || !date) return null;
  return { id, date, homeId, awayId, corners, cards: [yellow[0] + red[0], yellow[1] + red[1]] };
}

// ---------- datos ----------
const base = (league) => {
  const lg = leagueById(league);
  if (!lg || lg.sport !== 'soccer') throw Object.assign(new Error('Liga de fútbol no encontrada'), { status: 404 });
  return `${SITE}/soccer/${lg.espn}`;
};

export const getMatchStats = async (league, id) => normMatchStats(await fetchJson(`${base(league)}/summary?event=${id}`, 0));

// Partidos terminados de la temporada (o season=N) según los calendarios de todos los equipos.
export async function leagueMatchIds(league, query = '') {
  const teams = (await fetchJson(`${base(league)}/teams`))?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  const lists = await Promise.all(teams.map((t) => getTeamSchedule(league, t?.team?.id, query).catch(() => [])));
  return [...new Map(lists.flat().map((r) => [r.id, r.date])).entries()].map(([id, date]) => ({ id, date }));
}

// Pide summaries con concurrencia acotada; los que fallan se saltan.
export async function pullStats(league, ids, concurrency = 8) {
  const rows = await mapLimit(ids, concurrency, (id) => getMatchStats(league, id).catch(() => null));
  return rows.filter(Boolean).sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
}

const snapshots = new Map();
const loadSnapshot = (league) => {
  if (!snapshots.has(league)) {
    let rows = [];
    try {
      rows = JSON.parse(readFileSync(new URL(`../data/stats-${league}.json`, import.meta.url), 'utf8')).rows ?? [];
    } catch {}
    snapshots.set(league, rows);
  }
  return snapshots.get(league);
};

const LIVE_MAX = 40; // shortcut: si el snapshot tiene más de ~40 partidos de atraso, regenerarlo con scripts/stats-snapshot.mjs
const memo = new Map(); // league -> { at, promise }

// Snapshot (scripts/stats-snapshot.mjs) + los partidos terminados que le falten, pedidos en vivo.
export function getStatsHistory(league) {
  const hit = memo.get(league);
  if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.promise;
  const promise = (async () => {
    const snap = loadSnapshot(league);
    const have = new Set(snap.map((r) => r.id));
    const missing = (await leagueMatchIds(league)).filter((m) => !have.has(m.id)).sort((x, y) => y.date.localeCompare(x.date));
    const live = await pullStats(league, missing.slice(0, LIVE_MAX).map((m) => m.id));
    return [...snap, ...live].sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
  })();
  memo.set(league, { at: Date.now(), promise });
  promise.catch(() => memo.delete(league));
  return promise;
}

// ---------- modelo ----------
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
const variance = (xs) => {
  const m = mean(xs);
  return xs.length > 1 ? xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1) : m;
};

// stat: 'corners' | 'cards'. Fuerzas multiplicativas: for = cuánto genera el equipo, against = cuánto le generan.
// prior: partidos ficticios en la media de liga (shrink para equipos con poca muestra o recién ascendidos).
// Backtest Liga BetPlay 2026 (334 partidos; medido a mano, sin script): con prior 48 las tarjetas le ganan a la media
// de liga (log-loss 2.3005 contra 2.3071) y los córners quedan casi en la media (Brier en 9.5: 0.2419 contra 0.2409).
// Con menos shrink los córners empeoran: la fuerza del equipo casi no los predice.
export function statRates(rows, stat, { asOf = Infinity, prior = 48 } = {}) {
  const rs = rows.filter((r) => Date.parse(r.date) < asOf);
  const home = rs.map((r) => r[stat][0]);
  const away = rs.map((r) => r[stat][1]);
  const lg = { home: mean(home) || 1, away: mean(away) || 1, dispHome: Math.max(1, variance(home) / (mean(home) || 1)), dispAway: Math.max(1, variance(away) / (mean(away) || 1)), n: rs.length };
  const acc = new Map();
  const add = (id, key, ratio) => {
    const t = acc.get(id) ?? acc.set(id, { for: 0, against: 0, n: 0 }).get(id);
    t[key] += ratio;
  };
  for (const r of rs) {
    const [h, a] = r[stat];
    add(r.homeId, 'for', h / lg.home), add(r.homeId, 'against', a / lg.away);
    add(r.awayId, 'for', a / lg.away), add(r.awayId, 'against', h / lg.home);
    acc.get(r.homeId).n++, acc.get(r.awayId).n++;
  }
  const teams = new Map([...acc].map(([id, t]) => [id, { for: (t.for + prior) / (t.n + prior), against: (t.against + prior) / (t.n + prior), n: t.n }]));
  return { league: lg, teams };
}

const AVG = { for: 1, against: 1, n: 0 };
// Medias esperadas del partido (local, visita) y dispersión por lado.
export function expectedStat(rates, homeId, awayId) {
  const h = rates.teams.get(homeId) ?? AVG;
  const a = rates.teams.get(awayId) ?? AVG;
  const { league: lg } = rates;
  return { home: lg.home * h.for * a.against, away: lg.away * a.for * h.against, dispHome: lg.dispHome, dispAway: lg.dispAway };
}

// pmf truncada en max y renormalizada.
const pmf = (m, disp, max) => {
  const ps = Array.from({ length: max + 1 }, (_, k) => negBinPmf(k, m, m * disp));
  const s = ps.reduce((x, y) => x + y, 0);
  return ps.map((p) => p / s);
};
const conv = (a, b) => {
  const out = new Array(a.length + b.length - 1).fill(0);
  a.forEach((pa, i) => b.forEach((pb, j) => (out[i + j] += pa * pb)));
  return out;
};
const sel = (name, p, line) => ({ name, ...(line != null && { line }), ...price(p) });
// Cada línea es un mercado de dos lados: si uno pasa de MAX_P, cae la línea entera.
const ouSelections = (ps, lines) => lines.map((l) => [sel('Más', countOver(ps, l), l), sel('Menos', 1 - countOver(ps, l), l)])
  .filter((pair) => pair.every((s) => s.p <= MAX_P)).flat();
const linesAround = (m, w = 1) => [...new Set(Array.from({ length: 2 * w + 1 }, (_, k) => halfLine(m) + k - w))].filter((l) => l > 0);

// Distribuciones del partido: total y por equipo (independientes).
export function statDist(exp, max) {
  const h = pmf(exp.home, exp.dispHome, max);
  const a = pmf(exp.away, exp.dispAway, max);
  return { home: h, away: a, total: conv(h, a) };
}

function marketsOf(prefix, label, exp, max) {
  const d = statDist(exp, max);
  let pH = 0, pD = 0;
  d.home.forEach((ph, i) => d.away.forEach((pa, j) => (i > j ? (pH += ph * pa) : i === j ? (pD += ph * pa) : 0)));
  return publishable([
    { key: `${prefix}_ou`, label: `${label}: total`, selections: ouSelections(d.total, linesAround(exp.home + exp.away)) },
    { key: `${prefix}_home_ou`, label: `${label}: local`, selections: ouSelections(d.home, linesAround(exp.home)) },
    { key: `${prefix}_away_ou`, label: `${label}: visita`, selections: ouSelections(d.away, linesAround(exp.away)) },
    { key: `${prefix}_1x2`, label: `Más ${label.toLowerCase()}`, selections: [sel('Local', pH), sel('Empate', pD), sel('Visita', 1 - pH - pD)] },
  ]);
}

export const cardsMarkets = (exp) => marketsOf('cards', 'Tarjetas', exp, 15);
