// Calibración previa de propLine (lib/props.mjs) en la NBA 2025-26, sin cortes en vivo: la misma muestra que
// scripts/live-props-backtest.mjs (los 8 de cada equipo con más minutos, game log previo al partido, sin fuga) y su P(Más)
// contra el total final de puntos, rebotes y asistencias. Separa las tres hipótesis del sesgo hacia el Más: la mezcla de la
// media, la varianza (y la forma, normal o binomial negativa) y la línea (mediana de los últimos 20 con halfLine). Compara
// cada modelo media|varianza|forma con el de hoy en la misma línea, con log-loss pareado por partido.
// Uso: node scripts/props-backtest.mjs [partidos=300]. Sin red: solo .cache/espn/. Escribe docs/accuracy.json → props.nba.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { propOver } from '../public/betmath.js';
import { getGamelog } from '../lib/espn.mjs';
import { halfLine } from '../lib/pricing.mjs';
import { propLine } from '../lib/props.mjs';
import { calibration, CUTS } from './live-backtest.mjs';
import { sampleRows } from './live-props-backtest.mjs';

const OUT = new URL('../docs/accuracy.json', import.meta.url);
const EPS = 1e-12;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const avg = (xs) => sum(xs) / xs.length;
const vari = (xs) => {
  const m = avg(xs);
  return sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1);
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const loss = (p, won) => -Math.log(Math.max(won ? p : 1 - p, EPS));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// values: del más reciente al más viejo, como propLine.
export const MEANS = {
  blend: (v) => 0.5 * avg(v.slice(0, 10)) + 0.3 * avg(v) + 0.2 * avg(v.slice(0, 5)), // propLine hoy
  all: avg,
  last20: (v) => avg(v.slice(0, 20)),
  last10: (v) => avg(v.slice(0, 10)),
};
export const VARS = { all: vari, last20: (v) => vari(v.slice(0, 20)), 'all*1.2': (v) => 1.2 * vari(v) }; // all: propLine hoy
export const KINDS = ['normal', 'count'];
export const LINES = {
  median20: (v) => halfLine(median(v.slice(0, 20))), // propLine hoy: con mediana entera, medio punto por encima
  median20Down: (v) => Math.ceil(median(v.slice(0, 20))) - 0.5, // con mediana entera, medio punto por debajo
  mean20: (v) => halfLine(avg(v.slice(0, 20))),
};
export const MODELS = Object.keys(MEANS).flatMap((m) => Object.keys(VARS).flatMap((v) => KINDS.map((k) => `${m}|${v}|${k}`)));
export const pOver = (model, values, line) => {
  const [m, v, k] = model.split('|');
  return propOver(k, MEANS[m](values), VARS[v](values), line);
};

// Log-loss de a menos b (P(Más) por fila), promedio por partido, con el error estándar entre partidos. Negativo: a es mejor.
export function paired(rows, a, b) {
  const by = new Map();
  rows.forEach((r, i) => {
    const g = by.get(r.game) ?? by.set(r.game, { s: 0, n: 0 }).get(r.game);
    g.s += loss(a[i], r.won) - loss(b[i], r.won);
    g.n++;
  });
  const d = [...by.values()].map((g) => g.s / g.n), m = avg(d);
  return { diff: m, se: Math.sqrt(sum(d.map((x) => (x - m) ** 2)) / (d.length - 1) / d.length) };
}

// Filas de una estadística (r.values, r.line de propLine, r.final, r.won, r.game en orden de fecha). Cada modelo contra el
// de hoy en toda la muestra y en cada mitad de la temporada; guarda los que cambian un solo factor y el mejor de la grilla.
// La línea, con el modelo de hoy y el mejor.
export function statEntry(rows) {
  const cur = `blend|all|${rows[0].kind}`;
  const ps = Object.fromEntries(MODELS.map((k) => [k, rows.map((r) => pOver(k, r.values, r.line))]));
  const games = [...new Set(rows.map((r) => r.game))], early = new Set(games.slice(0, games.length >> 1));
  const half = (k, h) => {
    const keep = (_, i) => early.has(rows[i].game) === h;
    return paired(rows.filter(keep), ps[k].filter(keep), ps[cur].filter(keep)).diff;
  };
  const cal = (k) => calibration(rows.map((r, i) => ({ p: ps[k][i], won: r.won })));
  const ll = Object.fromEntries(MODELS.map((k) => [k, cal(k).logloss]));
  const best = MODELS.reduce((a, b) => (ll[b] < ll[a] ? b : a));
  const oneOff = (k) => k.split('|').filter((x, i) => x !== cur.split('|')[i]).length <= 1;
  const models = Object.fromEntries(MODELS.filter((k) => k === best || oneOff(k)).map((k) => [k,
    { logloss: ll[k], said: avg(ps[k]), ...(k !== cur && { vsCurrent: paired(rows, ps[k], ps[cur]), halves: [half(k, true), half(k, false)] }) }]));
  const lines = Object.fromEntries(Object.entries(LINES).map(([name, f]) => {
    const ls = rows.map((r) => f(r.values));
    return [name, { over: avg(rows.map((r, i) => r.final > ls[i])), said: Object.fromEntries([...new Set([cur, best])].map((k) => [k, avg(rows.map((r, i) => pOver(k, r.values, ls[i])))])) }];
  }));
  return { n: rows.length, over: avg(rows.map((r) => r.won)), current: cur, best, bins: Object.fromEntries([...new Set([cur, best])].map((k) => [k, cal(k).bins])), models, lines };
}

// Confirmación fuera de la muestra: cada partido de la temporada en el game log de esos mismos jugadores, salvo los de la
// muestra, con su game log previo (las dos temporadas, como getGamelog). logs: Map id → { cur, all } (all del más reciente).
// shortcut: sin el boxscore del partido, "los 8 de cada equipo con más minutos" se aproxima con ≥ 20 min en los últimos 10.
export function logRows(logs, kinds, skip) {
  const rows = [];
  for (const { cur, all } of logs.values()) {
    for (const g of cur) {
      if (skip.has(g.eventId) || !(g.minutes > 0)) continue;
      const before = all.filter((x) => x.date < g.date);
      if (avg(before.slice(0, 10).map((x) => x.minutes ?? 0)) < 20) continue;
      for (const [stat, kind] of Object.entries(kinds)) {
        const values = before.map((x) => x.stats[stat]).filter((v) => v != null), final = g.stats[stat];
        const r = final != null && values.some((v) => v > 0) && propLine(values, kind);
        if (r && r.pOver >= 0.03 && r.pOver <= 0.97) rows.push({ game: g.eventId, date: g.date, stat, kind, values, line: r.line, final, won: final > r.line });
      }
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

const byStat = (rows) => Object.fromEntries([...new Set(rows.map((r) => r.stat))].map((s) => [s, statEntry(rows.filter((r) => r.stat === s))]));
const round = (x) => JSON.parse(JSON.stringify(x, (k, v) => (typeof v === 'number' ? r4(v) : v)));

function report(label, x) {
  console.log(`${label}: ${x.n} líneas, Más en el ${x.over}`);
  for (const [s, e] of Object.entries(x.stats)) {
    const cur = e.models[e.current];
    console.log(`${s} (${e.n}, Más ${e.over}): hoy ${e.current} log-loss ${cur.logloss}, dijo ${cur.said}; mejor ${e.best}`);
    const top = Object.entries(e.models).filter(([k]) => k !== e.current).sort((a, b) => a[1].logloss - b[1].logloss);
    for (const [k, m] of top) console.log(`  ${k}: ${m.logloss} (${m.vsCurrent.diff} ± ${m.vsCurrent.se}; mitades ${m.halves.join(' / ')}), dijo ${m.said}`);
    for (const [name, l] of Object.entries(e.lines)) console.log(`  línea ${name}: Más ${l.over}, dijo ${Object.entries(l.said).map(([k, p]) => `${k} ${p}`).join(', ')}`);
    for (const [k, bins] of Object.entries(e.bins)) console.log(`  ${k}: ${bins.map((b) => `${b.from}% ${b.said}→${b.hit}`).join(', ')}`);
  }
}

async function main([n = '300']) {
  let misses = 0; // sin red: lo que no está en .cache/espn/ responde 504 y ese partido o ese game log no entra
  globalThis.fetch = async () => (misses++, new Response('{}', { status: 504 }));
  const got = await sampleRows(Number(n));
  if (!got) return;
  const rows = got.rows.filter((r) => r.f === CUTS[0] / 4); // una fila por jugador × estadística: lo previo no depende del corte
  // Qué parte del total final lleva el jugador en cada corte: el ritmo lineal de public/live.js supone f.
  const share = Object.fromEntries([...new Set(rows.map((r) => r.stat))].map((s) => [s, CUTS.map((k) => {
    const rs = got.rows.filter((r) => r.stat === s && r.f === k / 4);
    return { f: k / 4, share: sum(rs.map((r) => r.current)) / sum(rs.map((r) => r.final)) };
  })]));
  const logs = new Map();
  for (const pid of new Set(rows.map((r) => r.player))) {
    const [cur, prev] = await Promise.all([got.season, got.season - 1].map((s) => getGamelog('nba', pid, s, { athlete: { id: pid } }).then((l) => l.games, () => [])));
    logs.set(pid, { cur, all: [...new Map([...cur, ...prev].map((g) => [g.eventId, g])).values()].sort((a, b) => b.date.localeCompare(a.date)) });
  }
  const kinds = Object.fromEntries(rows.map((r) => [r.stat, r.kind]));
  const out = logRows(logs, kinds, new Set(rows.map((r) => r.game)));
  const e = round({ season: got.season, games: got.games, skipped: { ...got.skipped, cacheMiss: misses }, share,
    sample: { n: rows.length, over: avg(rows.map((r) => r.won)), stats: byStat(rows) },
    outOfSample: { games: new Set(out.map((r) => r.game)).size, n: out.length, over: avg(out.map((r) => r.won)), stats: byStat(out) } });
  console.log(`nba ${e.season}: ${e.games} partidos de la muestra; fuera de la caché ${misses}. Parte del total por corte: `
    + Object.entries(share).map(([s, cs]) => `${s} ${cs.map((c) => r4(c.share)).join('/')}`).join(', '));
  report('muestra', e.sample);
  report(`fuera de la muestra (${e.outOfSample.games} partidos)`, e.outOfSample);
  const old = JSON.parse(await readFile(OUT, 'utf8')); // releer justo antes: otros scripts escriben el mismo archivo
  await writeFile(OUT, `${JSON.stringify({ ...old, props: { ...old.props, nba: e } }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
