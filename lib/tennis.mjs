// Tenis ATP (singles masculino): normalizadores puros del scoreboard y rankings de ESPN, envoltorios de fetch,
// Elo por superficie y cadena de Markov punto → game → set → partido. Lo que llega de ESPN es dato no confiable:
// solo se copian campos conocidos, como texto o número.
import { readFileSync } from 'node:fs';
import { fetchJson, TTL } from './espn.mjs';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp';
const DAY = 24 * 3_600_000;
const str = (v) => (v == null ? null : String(v));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

// ---------- superficie ----------
// shortcut: ESPN no trae la superficie; se deduce del nombre del torneo. Cambiar si aparece una fuente.
const CLAY = /roland garros|french|monte|madrid|rome|italia|barcelona|hamburg|munich|geneva|lyon|estoril|buenos aires|rio|santiago|bastad|båstad|gstaad|kitzb|umag|houston|marrakech|bucharest/i;
const GRASS = /wimbledon|halle|queen|hertogenbosch|stuttgart|mallorca|eastbourne|newport/i;
export const SURFACE = (name = '') => (CLAY.test(name) ? 'clay' : GRASS.test(name) ? 'grass' : 'hard');

// ---------- normalizadores ----------
const player = (a = {}) => ({
  id: str(a.id),
  name: str(a.displayName),
  short: str(a.shortName ?? a.shortname),
  country: str(a.flag?.alt ?? a.flagAltText ?? a.citizenshipCountry),
  flag: str(typeof a.flag === 'string' ? a.flag : a.flag?.href),
});

const RET = /\bret\b|w\/o|walkover/i;

function normMatch(ev, c) {
  const [ca, cb] = [...(c.competitors ?? [])].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  if (!ca?.id || !cb?.id || !ca.athlete || !cb.athlete) return null; // cuadro con rival por definir
  const state = str(c.status?.type?.state);
  const slam = ev.major === true;
  const bestOf = slam && !/qualif/i.test(c.round?.displayName ?? '') ? 5 : 3;
  const la = ca.linescores ?? [];
  const lb = cb.linescores ?? [];
  const sets = [];
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    const s = [num(la[i].value), num(lb[i].value)];
    if (s.some((v) => v == null)) break;
    if (la[i].tiebreak != null && lb[i].tiebreak != null) s.push(num(la[i].tiebreak), num(lb[i].tiebreak));
    sets.push(s);
  }
  const winner = state === 'post' ? (ca.winner ? 'a' : cb.winner ? 'b' : null) : null;
  const need = Math.ceil(bestOf / 2);
  const won = sets.filter(([x, y]) => (winner === 'a' ? x > y : y > x)).length;
  const retired =
    /RETIRED|WALKOVER/.test(c.status?.type?.name ?? '') ||
    (c.notes ?? []).some((n) => RET.test(n?.text ?? '')) ||
    (winner != null && won < need);
  return {
    id: str(c.id),
    date: str(c.date),
    tournament: str(ev.name),
    surface: SURFACE(ev.name),
    round: str(c.round?.displayName),
    bestOf,
    slam,
    state,
    a: player({ ...ca.athlete, id: ca.id }), // en el scoreboard el id del jugador está en el competidor
    b: player({ ...cb.athlete, id: cb.id }),
    winner,
    sets,
    retired,
  };
}

export function normScoreboard(body) {
  const out = [];
  for (const ev of body?.events ?? [])
    for (const g of ev.groupings ?? [])
      if (g.grouping?.slug === 'mens-singles')
        for (const c of g.competitions ?? []) {
          const m = normMatch(ev, c);
          if (m?.id) out.push(m);
        }
  return out;
}

export function normRankings(body) {
  return (body?.rankings?.[0]?.ranks ?? [])
    .map((r) => ({ rank: num(r.current), prev: num(r.previous), points: num(r.points), player: player(r.athlete) }))
    .filter((r) => r.rank != null && r.player.id)
    .sort((x, y) => x.rank - y.rank)
    .slice(0, 150); // ESPN publica hasta el 150
}

// ---------- fetch ----------
const ym = (d) => d.toISOString().slice(0, 7).replace('-', '');
const months = new Map(); // yyyymm -> { at, ttl, promise } con la versión normalizada (un mes crudo pesa ~4 MB)

export function getMonth(yyyymm) {
  const y = Number(yyyymm.slice(0, 4));
  const m = Number(yyyymm.slice(4, 6));
  const ttl = yyyymm === ym(new Date()) ? TTL.board : DAY;
  const hit = months.get(yyyymm);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const promise = fetchJson(`${BASE}/scoreboard?dates=${yyyymm}01-${yyyymm}${last}`, 0).then(normScoreboard);
  months.set(yyyymm, { at: Date.now(), ttl, promise });
  promise.catch(() => months.delete(yyyymm));
  return promise;
}

// Snapshot de meses pasados (scripts/tennis-snapshot.mjs); si falta, solo se usan los dos meses en vivo.
let snapshot;
const loadSnapshot = () => {
  if (snapshot) return snapshot;
  try {
    snapshot = JSON.parse(readFileSync(new URL('../data/atp-history.json', import.meta.url), 'utf8')).matches ?? [];
  } catch {
    snapshot = [];
  }
  return snapshot;
};

export const uniqueById = (ms) => [...new Map(ms.map((m) => [m.id, m])).values()];
export const finished = (ms) => ms.filter((m) => m.state === 'post' && m.winner).sort((x, y) => Date.parse(x.date) - Date.parse(y.date));

export async function getHistory(n = 24, now = new Date()) {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const live = (await Promise.all([getMonth(ym(prev)), getMonth(ym(now))])).flat();
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n + 1, 1);
  return finished(uniqueById([...loadSnapshot(), ...live])).filter((m) => Date.parse(m.date) >= from);
}

export async function getRankings() {
  return normRankings(await fetchJson(`${BASE}/rankings`, TTL.sched));
}

const bogota = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

// date = 'YYYY-MM-DD' en hora de Colombia. ESPN devuelve el torneo completo: se filtra al día pedido.
export async function getToday(date = bogota(Date.now())) {
  const body = await fetchJson(`${BASE}/scoreboard?dates=${date.replaceAll('-', '')}`, TTL.board);
  return normScoreboard(body).filter((m) => m.date && bogota(m.date) === date);
}

export async function getPlayer(id) {
  const [history, rankings] = await Promise.all([getHistory(), getRankings()]);
  const matches = history.filter((m) => m.a.id === id || m.b.id === id).reverse();
  const r = rankings.find((x) => x.player.id === id);
  const p = r?.player ?? (matches[0] ? (matches[0].a.id === id ? matches[0].a : matches[0].b) : null);
  return { player: p, rank: r?.rank ?? null, matches };
}

// ---------- Elo por superficie ----------
const START = 1500;
const K = (n) => 250 / (n + 5) ** 0.4;
const pElo = (ra, rb) => 1 / (1 + 10 ** ((rb - ra) / 400));
const fresh = () => ({ all: START, hard: START, clay: START, grass: START, n: 0, ns: { hard: 0, clay: 0, grass: 0 } });

export function eloFrom(matches, { asOf = Infinity } = {}) {
  const elo = new Map();
  const get = (id) => elo.get(id) ?? elo.set(id, fresh()).get(id);
  for (const m of [...matches].sort((x, y) => Date.parse(x.date) - Date.parse(y.date))) {
    if (!(Date.parse(m.date) < asOf)) continue;
    if (m.retired || !m.winner) continue;
    const [w, l] = m.winner === 'a' ? [get(m.a.id), get(m.b.id)] : [get(m.b.id), get(m.a.id)];
    const e = pElo(w.all, l.all);
    [w.all, l.all] = [w.all + K(w.n) * (1 - e), l.all - K(l.n) * (1 - e)];
    const s = m.surface;
    const es = pElo(w[s], l[s]);
    [w[s], l[s]] = [w[s] + K(w.ns[s]) * (1 - es), l[s] - K(l.ns[s]) * (1 - es)];
    w.n++, l.n++, w.ns[s]++, l.ns[s]++;
  }
  return elo;
}

export const ratingOf = (elo, id) => elo.get(id) ?? fresh();
const blend = (r, surface) => 0.5 * r.all + 0.5 * (r[surface] ?? r.all);
export const matchProb = (elo, aId, bId, surface = 'hard') => pElo(blend(ratingOf(elo, aId), surface), blend(ratingOf(elo, bId), surface));

// ---------- Markov ----------
// P(gana el game quien saca), con deuce cerrado.
const holdP = (p) => {
  const q = 1 - p;
  return p ** 4 * (1 + 4 * q + 10 * q * q) + (20 * p ** 3 * q ** 3 * p * p) / (1 - 2 * p * q);
};

// P(A gana el tiebreak a `to` puntos) con A sacando el primer punto; luego saques de a dos (B, B, A, A, …).
function tiebreakP(sa, sb, to) {
  const aServes = (k) => Math.floor((k + 1) / 2) % 2 === 0;
  let grid = new Map([['0,0', 1]]);
  let win = 0;
  for (let k = 0; grid.size; k++) {
    const next = new Map();
    const pa = aServes(k) ? sa : 1 - sb;
    for (const [key, pr] of grid) {
      const [i, j] = key.split(',').map(Number);
      if (i === to - 1 && j === to - 1) {
        // empate: cada par de puntos tiene un saque de cada uno
        const x = sa * (1 - sb);
        win += (pr * x) / (x + (1 - sa) * sb);
        continue;
      }
      for (const [ni, nj, pp] of [[i + 1, j, pa], [i, j + 1, 1 - pa]]) {
        if (ni === to && nj <= to - 2) win += pr * pp;
        else if (nj === to && ni <= to - 2) continue;
        else next.set(`${ni},${nj}`, (next.get(`${ni},${nj}`) ?? 0) + pr * pp);
      }
    }
    grid = next;
  }
  return win;
}

// Marcadores finales de un set: [[ga, gb, p, aSacaElSiguiente]]. `aFirst`: A saca el primer game.
function setDist(sa, sb, aFirst, tbTo) {
  const ha = holdP(sa);
  const hb = holdP(sb);
  const tbA = aFirst ? tiebreakP(sa, sb, tbTo) : 1 - tiebreakP(sb, sa, tbTo);
  const out = [];
  let grid = new Map([['0,0', 1]]);
  while (grid.size) {
    const next = new Map();
    for (const [key, pr] of grid) {
      const [i, j] = key.split(',').map(Number);
      const n = i + j;
      if (i === 6 && j === 6) {
        // el tiebreak cuenta como game 13: el siguiente set lo empieza el otro
        out.push([7, 6, pr * tbA, !aFirst], [6, 7, pr * (1 - tbA), !aFirst]);
        continue;
      }
      const aServing = aFirst === (n % 2 === 0);
      const pa = aServing ? ha : 1 - hb;
      for (const [ni, nj, pp] of [[i + 1, j, pa], [i, j + 1, 1 - pa]]) {
        const done = (Math.max(ni, nj) === 6 && Math.abs(ni - nj) >= 2) || Math.max(ni, nj) === 7;
        if (done) out.push([ni, nj, pr * pp, aFirst === ((ni + nj) % 2 === 0)]);
        else next.set(`${ni},${nj}`, (next.get(`${ni},${nj}`) ?? 0) + pr * pp);
      }
    }
    grid = next;
  }
  return out;
}

// sa, sb: P(ganar el punto con el propio saque). Promedia sobre quién saca primero.
// slam: el set decisivo se define con tiebreak a 10 en 6-6 (regla de Grand Slam desde 2022).
export function matchDist(sa, sb, bestOf = 3, { slam = bestOf === 5 } = {}) {
  const need = Math.ceil(bestOf / 2);
  const cache = new Map();
  const sets = (aFirst, decisive) => {
    const k = `${aFirst}${decisive}`;
    if (!cache.has(k)) cache.set(k, setDist(sa, sb, aFirst, decisive && slam ? 10 : 7));
    return cache.get(k);
  };
  const res = { pA: 0, firstSet: 0, sets: {}, games: [], margin: {} };
  for (let a = need; a >= 0; a--) for (let b = 0; b <= need; b++) if ((a === need) !== (b === need) && a + b >= need) res.sets[`${a}-${b}`] = 0;
  for (const aFirst of [true, false]) {
    res.firstSet += 0.5 * sets(aFirst, false).reduce((s, [x, y, p]) => (x > y ? s + p : s), 0);
    // estado: "setsA,setsB,aSaca,games,margen" → probabilidad
    let states = new Map([[`0,0,${aFirst},0,0`, 0.5]]);
    while (states.size) {
      const next = new Map();
      for (const [key, pr] of states) {
        const [a, b, f, g, mg] = key.split(',');
        const [na, nb] = [Number(a), Number(b)];
        for (const [x, y, p, nf] of sets(f === 'true', na === need - 1 && nb === need - 1)) {
          const sA = na + (x > y), sB = nb + (y > x), G = Number(g) + x + y, D = Number(mg) + x - y, q = pr * p;
          if (sA === need || sB === need) {
            if (sA === need) res.pA += q;
            res.sets[`${sA}-${sB}`] += q;
            res.games[G] = (res.games[G] ?? 0) + q;
            res.margin[D] = (res.margin[D] ?? 0) + q;
          } else {
            const k = `${sA},${sB},${nf},${G},${D}`;
            next.set(k, (next.get(k) ?? 0) + q);
          }
        }
      }
      states = next;
    }
  }
  res.games = Array.from(res.games, (p) => p ?? 0);
  return res;
}

// Saques sa = 0.64 + d, sb = 0.64 − d que reproducen la probabilidad de partido p (bisección; pA crece con d).
export function serveFromMatchProb(p, bestOf = 3, opts) {
  let lo = -0.3, hi = 0.3;
  for (let i = 0; i < 20; i++) { // 0.6 / 2^20 ≈ 6e-7 en d: sobra para 4 decimales de pA; 50 pasos costaban hasta 0.5 s
    const d = (lo + hi) / 2;
    if (matchDist(0.64 + d, 0.64 - d, bestOf, opts).pA < p) lo = d;
    else hi = d;
  }
  const d = (lo + hi) / 2;
  return { sa: 0.64 + d, sb: 0.64 - d };
}
