// Matemática de apuestas compartida por el navegador y los tests. Todas las cuotas en formato decimal.
// Convención: los datos inválidos (cuota <= 1, NaN, faltan lados) devuelven null en vez de lanzar;
// solo un método de devig desconocido (error de programación) lanza RangeError.

const ok = (d) => Number.isFinite(d) && d > 1;
const okAll = (prices) => Array.isArray(prices) && prices.length >= 2 && prices.every(ok);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const round2 = (x) => Math.round(x * 100) / 100;
const isHalfStep = (x) => Number.isFinite(x) && Number.isInteger(x * 2);

// Bisección: f(lo) y f(hi) deben tener signos opuestos (o cero).
function bisect(f, lo, hi) {
  let flo = f(lo);
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (fm === 0) return mid;
    if (fm > 0 === flo > 0) [lo, flo] = [mid, fm];
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------- Cuotas ----------

export const implied = (odds) => 1 / odds;

export const decimalToAmerican = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

export const americanToDecimal = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);

const amOf = (d) => (ok(d) && d < Infinity ? decimalToAmerican(d) : null);
const fairAm = (p) => (p > 0 ? amOf(1 / p) : null);

export function decimalToFractional(d, maxDen = 100) {
  const target = d - 1;
  let best = [Math.round(target), 1];
  for (let den = 2; den <= maxDen; den++) {
    const num = Math.round(target * den);
    if (Math.abs(num / den - target) < Math.abs(best[0] / best[1] - target) - 1e-12) best = [num, den];
  }
  return `${best[0]}/${best[1]}`;
}

// "3/2" → 2.5. Solo positivos con barra; inválido → null.
export function fractionalToDecimal(frac) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(String(frac ?? ''));
  return m && +m[1] > 0 && +m[2] > 0 ? 1 + m[1] / m[2] : null;
}

export const expectedValue = (prob, odds) => prob * odds - 1;

export const kelly = (prob, odds, fraction = 1) => Math.max(0, (prob * odds - 1) / (odds - 1)) * fraction;

export const parlayOdds = (oddsList) => oddsList.reduce((p, o) => p * o, 1);

// ---------- Devig ----------

const DEVIG = {
  multiplicative: (q, S) => q.map((x) => x / S),
  // Resta el mismo margen a cada lado; si un lado queda negativo se recorta a 0 y se renormaliza.
  additive: (q, S) => q.map((x) => Math.max(0, x - (S - 1) / q.length)),
  // p_i = q_i^k con k tal que Σ q_i^k = 1 (f decrece en k porque q_i < 1).
  power(q) {
    const f = (k) => sum(q.map((x) => x ** k)) - 1;
    let hi = 1;
    while (f(hi) > 0) hi *= 2;
    const k = bisect(f, 0, hi);
    return q.map((x) => x ** k);
  },
  // Shin (1993): z = proporción de dinero informado. Sin margen (S <= 1) el modelo no aplica: multiplicativo.
  shin(q, S) {
    if (S <= 1) return q.map((x) => x / S);
    const p = (z) => q.map((x) => (Math.sqrt(z * z + (4 * (1 - z) * x * x) / S) - z) / (2 * (1 - z)));
    return p(bisect((z) => sum(p(z)) - 1, 0, 1 - 1e-12));
  },
  // Desplaza todos los lados la misma cantidad en el espacio de cuantiles normales.
  probit(q) {
    const zs = q.map(normInv);
    const p = (c) => zs.map((z) => normCdf(z - c));
    return p(bisect((c) => sum(p(c)) - 1, -40, 40));
  },
};

const normalize = (p) => {
  const t = sum(p);
  return p.map((x) => x / t);
};

// Probabilidades justas. method: multiplicative | additive | power | shin | probit | worst
// ('worst' = la menor probabilidad por lado entre todos los métodos: la más conservadora; no suma 1).
export function devig(prices, method = 'multiplicative') {
  if (method !== 'worst' && !DEVIG[method]) throw new RangeError(`Método de devig desconocido: ${method}`);
  if (!okAll(prices)) return null;
  const q = prices.map((d) => 1 / d), S = sum(q);
  if (method !== 'worst') return normalize(DEVIG[method](q, S));
  const all = Object.values(DEVIG).map((fn) => normalize(fn(q, S)));
  return q.map((_, i) => Math.min(...all.map((p) => p[i])));
}

export const noVig = (prices) => devig(prices);

// Margen del mercado: Σ 1/d − 1.
export const vig = (prices) => (okAll(prices) ? sum(prices.map((d) => 1 / d)) - 1 : null);

// Centavos de un precio americano respecto a la par: −110 → 10, +130 → −30.
const parCents = (d) => {
  const a = decimalToAmerican(d);
  return a < 0 ? -a - 100 : 100 - a;
};
// Ancho del mercado en centavos (−110/−110 → 20, −150/+130 → 20). Negativo = mercado sin margen (arbitraje).
export const width = (a, b) => (ok(a) && ok(b) ? parCents(a) + parCents(b) : null);

// ---------- Acierto, splits e insights ----------

const fin = (values) => (values ?? []).filter(Number.isFinite);
const isUnder = (side) => String(side).toLowerCase() === 'under';
const beats = (v, line, side) => (isUnder(side) ? v < line : v > line);

// pct excluye los push; null si no hay partidos decididos.
export function hitRate(values, line, side = 'Over') {
  const xs = fin(values);
  const hits = xs.filter((v) => beats(v, line, side)).length, pushes = xs.filter((v) => v === line).length;
  return { hits, pushes, n: xs.length, pct: xs.length > pushes ? hits / (xs.length - pushes) : null };
}

// Aciertos seguidos desde el más reciente (values[0]); un push corta la racha.
export function streak(values, line, side = 'Over') {
  let n = 0;
  for (const v of fin(values)) {
    if (!beats(v, line, side)) break;
    n++;
  }
  return n;
}

export function summarize(values) {
  const xs = fin(values).sort((a, b) => a - b), n = xs.length;
  if (!n) return { n, avg: null, median: null, min: null, max: null };
  return { n, avg: sum(xs) / n, median: n % 2 ? xs[(n - 1) / 2] : (xs[n / 2 - 1] + xs[n / 2]) / 2, min: xs[0], max: xs[n - 1] };
}

const DAY = 864e5;

// games: GameLog.games (del más reciente al más antiguo). Primero filtra y luego aplica la ventana,
// así "L10 de local" = los últimos 10 partidos de local. window: l5 | l10 | l20 | lN | h2h (con oppId) |
// season | prev | YYYY | all. daysRest: número exacto o '3+'. withAthlete/withoutAthlete: GameLog del
// compañero, o lista/Set de eventId en los que jugó.
export function splitGames(games, { window = 'all', oppId, location = 'all', minMinutes, maxMinutes, daysRest, withAthlete, withoutAthlete, result = 'all', maxMargin } = {}) {
  const list = games ?? [];
  const ids = (x) => x && new Set([...(x.games ?? x)].map((g) => String(typeof g === 'object' ? g.eventId : g)));
  const withSet = ids(withAthlete), withoutSet = ids(withoutAthlete);
  const rest = new Map(list.map((g, i) => [g, list[i + 1] ? Math.round((Date.parse(g.date) - Date.parse(list[i + 1].date)) / DAY) - 1 : null]));
  const restOk = (r) => daysRest == null || daysRest === '' || (Number.isFinite(r) && (String(daysRest).endsWith('+') ? r >= parseInt(daysRest, 10) : r === Number(daysRest)));
  const out = list.filter((g) =>
    (location === 'all' || g.home === (location === 'home')) &&
    (minMinutes == null || (g.minutes != null && g.minutes >= minMinutes)) &&
    (maxMinutes == null || (g.minutes != null && g.minutes <= maxMinutes)) &&
    restOk(rest.get(g)) &&
    (!withSet || withSet.has(String(g.eventId))) &&
    (!withoutSet || !withoutSet.has(String(g.eventId))) &&
    (result === 'all' || g.result === result) &&
    (maxMargin == null || (g.margin != null && Math.abs(g.margin) <= maxMargin)));
  const w = String(window).toLowerCase();
  const season = Math.max(...list.map((g) => g.season).filter(Number.isFinite));
  const lastN = /^l(\d+)$/.exec(w);
  if (lastN) return out.slice(0, +lastN[1]);
  if (w === 'h2h') return oppId == null ? [] : out.filter((g) => String(g.opp?.id) === String(oppId));
  if (w === 'season') return out.filter((g) => g.season === season);
  if (w === 'prev') return out.filter((g) => g.season === season - 1);
  if (/^\d{4}$/.test(w)) return out.filter((g) => g.season === +w);
  return out;
}

const num = (x) => String(Math.round(x * 10) / 10);
const LOC = { all: '', home: ' de local', away: ' de visitante' };

// Insights de un jugador para la línea del prop, en ambos lados: racha seguida, k de los últimos n
// (total, local, visita) y promedio vs. línea. statDef: { key, name, from? } de stats.js.
export function insightsFor({ athlete, gamelog, prop, statDef } = {}) {
  const line = Number(prop?.line);
  const games = gamelog?.games ?? [];
  if (prop?.line == null || !Number.isFinite(line) || !games.length) return [];
  const key = statDef?.key ?? prop?.stat;
  const valueOf = (g) => {
    try {
      return statDef?.from ? statDef.from(g.stats ?? {}) : g.stats?.[key];
    } catch {
      return null;
    }
  };
  const who = athlete?.name ?? gamelog?.athlete?.name ?? prop?.player ?? 'El jugador';
  const stat = String(statDef?.name ?? statDef?.label ?? key ?? '').toLowerCase();
  const out = [];
  for (const location of ['all', 'home', 'away']) {
    const vals = fin(splitGames(games, { location }).map(valueOf));
    for (const side of ['Over', 'Under']) {
      const verb = side === 'Over' ? 'superó' : 'quedó por debajo de';
      const base = { side, line, location, stat: key };
      const s = streak(vals, line, side);
      if (s >= 4) {
        const avg = summarize(vals.slice(0, s)).avg;
        out.push({ ...base, type: 'streak', k: s, n: s, pct: 1, avg, text: `${who} ${verb} ${num(line)} ${stat} en ${s} partidos seguidos${LOC[location]} (promedio ${num(avg)})` });
        continue;
      }
      const top = [10, 20, 5]
        .filter((n) => vals.length >= n)
        .map((n) => ({ n, ...hitRate(vals.slice(0, n), line, side) }))
        .filter((r) => r.pct >= 0.7)
        .sort((a, b) => b.pct - a.pct || b.n - a.n)[0];
      if (top) {
        const avg = summarize(vals.slice(0, top.n)).avg;
        out.push({ ...base, type: 'kofn', k: top.hits, n: top.n, pct: top.pct, avg, text: `${who} ${verb} ${num(line)} ${stat} en ${top.hits} de sus últimos ${top.n} partidos${LOC[location]} (promedio ${num(avg)})` });
      }
    }
    // Promedio de los últimos 10 al menos un 20% lejos de la línea.
    const l10 = vals.slice(0, 10), avg = summarize(l10).avg;
    if (location === 'all' && l10.length >= 5 && line > 0 && Math.abs(avg - line) / line >= 0.2) {
      const side = avg > line ? 'Over' : 'Under', hr = hitRate(l10, line, side);
      out.push({ side, line, location, stat: key, type: 'avg', k: hr.hits, n: l10.length, pct: hr.pct, avg, text: `${who} promedia ${num(avg)} ${stat} en sus últimos ${l10.length} partidos, ${avg > line ? 'por encima' : 'por debajo'} de la línea de ${num(line)}` });
    }
  }
  const rank = { streak: 2, kofn: 1, avg: 0 };
  return out.sort((a, b) => rank[b.type] - rank[a.type] || b.pct - a.pct || b.n - a.n);
}

const parseRec = (s) => {
  const m = /^(\d+)-(\d+)(?:-(\d+))?/.exec(String(s ?? '').trim());
  return m && { w: +m[1], l: +m[2], t: +(m[3] ?? 0) };
};
const recText = ({ w, l, t }) => `${w}-${l}${t ? `-${t}` : ''}`;
const recContext = (rec) => {
  const s = `${rec.key ?? ''} ${rec.label ?? ''}`.toLowerCase();
  if (/underdog|\bdog|no fav/.test(s)) return 'como no favorito';
  if (/fav/.test(s)) return 'como favorito';
  if (/home|local|casa/.test(s)) return 'de local';
  if (/road|away|visit/.test(s)) return 'de visitante';
  return /overall|total|general|^ats\b/.test(s) ? 'en la temporada' : null;
};

// Insights de equipo desde GameDetail: ATS de la temporada (total, local, visita, favorito, no favorito),
// récord como favorito/no favorito, ATS, over/under y ganados/perdidos en los últimos 5.
export function teamInsights(game) {
  const out = [];
  for (const team of ['home', 'away']) {
    const t = game?.[team];
    if (!t) continue;
    const name = t.name ?? t.abbr ?? (team === 'home' ? 'El local' : 'El visitante');
    const base = { team, teamId: t.id ?? null };
    for (const rec of game.ats?.[team] ?? []) {
      const ctx = recContext(rec), r = parseRec(rec.summary);
      if (!ctx || !r || r.w + r.l < 3) continue;
      const pct = r.w / (r.w + r.l);
      out.push({ ...base, type: 'ats', market: 'spread', k: r.w, n: r.w + r.l, pct, text: `${name} va ${recText(r)} (${Math.round(pct * 100)}%) contra el hándicap ${ctx}` });
    }
    for (const rec of game.records?.[team] ?? []) {
      const ctx = recContext(rec), r = parseRec(rec.summary);
      if ((ctx !== 'como favorito' && ctx !== 'como no favorito') || !r || r.w + r.l < 3) continue;
      const pct = r.w / (r.w + r.l);
      out.push({ ...base, type: ctx === 'como favorito' ? 'favorite' : 'underdog', market: 'moneyline', k: r.w, n: r.w + r.l, pct, text: `${name} va ${recText(r)} (${Math.round(pct * 100)}%) ${ctx} esta temporada` });
    }
    const last = game.lastFive?.[team] ?? [];
    const count = (xs, f, v) => xs.filter((g) => g[f] === v).length;
    const ats = last.filter((g) => ['W', 'L', 'P'].includes(g.ats));
    if (ats.length >= 3) {
      const r = { w: count(ats, 'ats', 'W'), l: count(ats, 'ats', 'L'), t: count(ats, 'ats', 'P') };
      if (r.w + r.l) out.push({ ...base, type: 'ats-last', market: 'spread', k: r.w, n: r.w + r.l, pct: r.w / (r.w + r.l), text: `${name} va ${recText(r)} contra el hándicap en sus últimos ${ats.length} partidos` });
    }
    const ou = last.filter((g) => ['O', 'U', 'P'].includes(g.ou));
    if (ou.length >= 3) {
      const o = count(ou, 'ou', 'O'), u = count(ou, 'ou', 'U');
      const [k, side] = o >= u ? [o, 'Over'] : [u, 'Under'];
      if (k / ou.length >= 0.6) out.push({ ...base, type: 'ou', market: 'total', side, k, n: ou.length, pct: k / ou.length, text: `El ${side.toLowerCase()} se dio en ${k} de los últimos ${ou.length} partidos de ${name}` });
    }
    const su = last.filter((g) => g.result === 'W' || g.result === 'L');
    const w = count(su, 'result', 'W'), l = su.length - w;
    if (su.length >= 3 && Math.max(w, l) / su.length >= 0.8) {
      out.push({ ...base, type: 'form', market: 'moneyline', k: w, n: su.length, pct: w / su.length, text: `${name} ${w >= l ? `ganó ${w}` : `perdió ${l}`} de sus últimos ${su.length} partidos` });
    }
  }
  return out;
}

// ---------- Distribuciones ----------

// Φ(x) con el algoritmo de Hart (West 2005), error ~1e-15.
export function normCdf(x) {
  const ax = Math.abs(x);
  let c = 0;
  if (ax <= 37) {
    const e = Math.exp(-ax * ax / 2);
    if (ax < 7.07106781186547) {
      let n = 3.52624965998911e-2 * ax + 0.700383064443688;
      n = n * ax + 6.37396220353165; n = n * ax + 33.912866078383; n = n * ax + 112.079291497871;
      n = n * ax + 221.213596169931; n = n * ax + 220.206867912376;
      let d = 8.83883476483184e-2 * ax + 1.75566716318264;
      d = d * ax + 16.064177579207; d = d * ax + 86.7807322029461; d = d * ax + 296.564248779674;
      d = d * ax + 637.333633378831; d = d * ax + 793.826512519948; d = d * ax + 440.413735824752;
      c = (e * n) / d;
    } else {
      c = e / (ax + 1 / (ax + 2 / (ax + 3 / (ax + 4 / (ax + 0.65))))) / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

// Φ⁻¹(p): Acklam + un paso de Halley con normCdf.
export function normInv(p) {
  if (!(p > 0)) return p === 0 ? -Infinity : NaN;
  if (!(p < 1)) return p === 1 ? Infinity : NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  let x;
  if (p < 0.02425) x = tail(Math.sqrt(-2 * Math.log(p)));
  else if (p > 1 - 0.02425) x = -tail(Math.sqrt(-2 * Math.log(1 - p)));
  else {
    const q = p - 0.5, r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const u = (normCdf(x) - p) * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

// En espacio logarítmico: sin desbordes por factoriales grandes.
const lnFactorial = (n) => {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
};

export function poissonPmf(k, lambda) {
  if (!Number.isInteger(k) || k < 0 || !(lambda >= 0)) return 0;
  if (lambda === 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - lnFactorial(k));
}

export function poissonCdf(k, lambda) {
  if (!(k >= 0) || !(lambda >= 0)) return 0;
  if (k === Infinity || lambda === 0) return 1;
  const ll = Math.log(lambda);
  let s = 0, lf = 0;
  for (let i = 0; i <= Math.floor(k); i++) {
    if (i > 1) lf += Math.log(i);
    const term = Math.exp(-lambda + i * ll - lf);
    s += term;
    if (i > lambda && term < 1e-17 * s) break;
  }
  return Math.min(1, s);
}

// ---------- Calculadoras (docs/spec-calculators.json) ----------

const binom = (n, k) => {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

function combinations(n, r) {
  const out = [];
  const walk = (start, acc) => {
    if (acc.length === r) return void out.push(acc.slice());
    for (let i = start; i < n; i++) {
      acc.push(i);
      walk(i + 1, acc);
      acc.pop();
    }
  };
  walk(0, []);
  return out;
}

// legs: [{ price, result: 'win'|'loss'|'push'|'pending' }] (o solo cuotas), parlays de tamaño exacto size.
export function roundRobin(legs, size, stake = 1) {
  const L = (legs ?? []).map((x) => (typeof x === 'number' ? { price: x } : x));
  const n = L.length;
  if (n < 2 || n > 15 || !Number.isInteger(size) || size < 2 || size > n || !(stake > 0) || !L.every((l) => ok(l.price))) return null;
  const rows = combinations(n, size).map((idx) => {
    const rs = idx.map((i) => L[i].result ?? 'pending');
    const result = rs.includes('loss') ? 'loss' : rs.includes('pending') ? 'pending' : rs.every((r) => r === 'push') ? 'push' : 'win';
    const payout = result === 'loss' ? 0 : result === 'pending' ? null : stake * idx.reduce((p, i) => p * (L[i].result === 'push' ? 1 : L[i].price), 1);
    return { legs: idx, odds: idx.reduce((p, i) => p * L[i].price, 1), result, payout };
  });
  const totalStake = rows.length * stake, maxPayout = sum(rows.map((r) => stake * r.odds));
  const pending = rows.filter((r) => r.result === 'pending').length, payout = sum(rows.map((r) => r.payout ?? 0));
  return { combos: rows.length, totalStake, maxPayout, maxProfit: maxPayout - totalStake, payout, profit: pending ? null : payout - totalStake, pending, rows };
}

// probs: probabilidad de cada pick; payouts[k] = multiplicador bruto con k aciertos (Power 2 picks: [0, 0, 3]).
export function prizepicksEv({ probs, payouts, stake = 1, bankroll = 0, kellyShare = 1 } = {}) {
  const n = probs?.length;
  if (!n || !probs.every((p) => p >= 0 && p <= 1) || !Array.isArray(payouts) || !(stake > 0)) return null;
  const mult = Array.from({ length: n + 1 }, (_, k) => Math.max(0, Number(payouts[k]) || 0));
  let dist = [1]; // Poisson-binomial por programación dinámica
  for (const p of probs) {
    const next = Array(dist.length + 1).fill(0);
    dist.forEach((x, k) => {
      next[k] += x * (1 - p);
      next[k + 1] += x * p;
    });
    dist = next;
  }
  const outcomes = dist.map((prob, k) => ({ k, prob, mult: mult[k], ret: stake * mult[k], net: stake * (mult[k] - 1) }));
  const roi = sum(outcomes.map((o) => o.prob * (o.mult - 1)));
  // Kelly multi-resultado: maximiza E[ln(1 + f(m − 1))]; su derivada decrece en f.
  const dlog = (f) => sum(outcomes.map((o) => (o.prob * (o.mult - 1)) / (1 + f * (o.mult - 1))));
  const f = roi <= 0 ? 0 : dlog(1 - 1e-9) >= 0 ? 1 : bisect(dlog, 0, 1 - 1e-9);
  const be = (p) => sum(mult.map((m, k) => binom(n, k) * p ** k * (1 - p) ** (n - k) * m)) - 1;
  return {
    n, dist, outcomes, roi, expectedProfit: stake * roi, expectedReturn: stake * (1 + roi),
    pProfit: sum(outcomes.filter((o) => o.mult > 1).map((o) => o.prob)),
    pLoss: sum(outcomes.filter((o) => o.mult === 0).map((o) => o.prob)),
    breakEvenP: be(0) >= 0 ? 0 : be(1) < 0 ? null : bisect(be, 0, 1),
    kelly: f, kellyStake: bankroll * f * kellyShare,
  };
}

export function bonusBetConversion({ amount, odds, hedgeOdds, stakeReturned = false } = {}) {
  if (!(amount > 0) || !ok(odds) || !ok(hedgeOdds)) return null;
  const bonusPayout = amount * (stakeReturned ? odds : odds - 1);
  const hedgeStake = round2(bonusPayout / hedgeOdds);
  const ifBonus = round2(bonusPayout - hedgeStake), ifHedge = round2(hedgeStake * (hedgeOdds - 1));
  const profit = Math.min(ifBonus, ifHedge);
  return { bonusPayout, hedge: hedgeStake, ifBonus, ifHedge, profit, rate: profit / amount };
}

// Dos resultados. { budget }: reparte un total; { stake }: ya hay stake en el lado 1 y se cubre el 2.
export function hedge(prices, { budget, stake } = {}) {
  if (prices?.length !== 2 || !okAll(prices)) return null;
  const [d1, d2] = prices;
  let s1, s2;
  if (budget > 0) {
    s1 = round2((budget * d2) / (d1 + d2));
    s2 = round2(budget - s1);
  } else if (stake > 0) [s1, s2] = [round2(stake), round2((stake * d1) / d2)];
  else return null;
  const total = round2(s1 + s2), profits = [round2(s1 * d1 - total), round2(s2 * d2 - total)];
  const minProfit = Math.min(...profits);
  return { stakes: [s1, s2], total, payouts: [s1 * d1, s2 * d2], profits, minProfit, roi: minProfit / total, isArb: 1 / d1 + 1 / d2 < 1 };
}

export function hold(prices) {
  if (!okAll(prices)) return null;
  const q = prices.map((d) => 1 / d), S = sum(q);
  return { total: S, overround: S - 1, hold: (S - 1) / S, rows: q.map((x) => ({ implied: x, fair: x / S, fairOdds: S / x, fairAmerican: fairAm(x / S), margin: x - x / S })) };
}

// Costo del vig ($) de apostar stake al resultado index; negativo = precio favorable.
export function vigCost(prices, index = 0, stake = 100) {
  const h = hold(prices), row = h?.rows[index];
  if (!row || !(stake > 0)) return null;
  return { ...h, cost: stake * (1 - row.fair * prices[index]), fair: row.fair, fairOdds: row.fairOdds, fairAmerican: row.fairAmerican };
}

// Contrato de mercado de predicción: precio en centavos (o cuota decimal), N contratos, comisión por contrato en centavos.
export function predictionMarket({ cents, odds, contracts = 1, fee = 0 } = {}) {
  const c = cents ?? (ok(odds) ? 100 / odds : NaN);
  if (!(c > 0 && c < 100) || !(contracts > 0) || !(fee >= 0)) return null;
  const decimal = 100 / c, cost = (contracts * (c + fee)) / 100;
  return {
    cents: c, decimal, american: decimalToAmerican(decimal), fractional: decimalToFractional(decimal), prob: c / 100, complement: 100 - c,
    cost, fees: (contracts * fee) / 100, payout: contracts, profit: contracts - cost, breakEven: (c + fee) / 100,
  };
}

// Valor de medio punto. side: 'spread' | 'over' | 'under'; prices: [lado elegido, contrario].
// Línea entera: push = probabilidad de caer justo en ella. Línea .5: pushLower / pushHigher =
// probabilidad de caer justo en la línea entera de abajo / de arriba. rows: [línea − 0.5, base, línea + 0.5].
export function halfPoint({ prices, line, side = 'spread', push = 0, pushLower = 0, pushHigher = 0 } = {}) {
  if (prices?.length !== 2 || !okAll(prices) || !isHalfStep(line) || !['spread', 'over', 'under'].includes(side)) return null;
  const [p] = devig(prices);
  const towardHigher = side !== 'over'; // el hándicap y el under mejoran con una línea más alta
  const row = (l, win, pu) => {
    const loss = 1 - win - pu, fair = win > 0 ? (1 - pu) / win : null, oppFair = loss > 0 ? (1 - pu) / loss : null;
    return { line: l, win, push: pu, loss, fair, fairAmerican: amOf(fair), oppFair, oppFairAmerican: amOf(oppFair) };
  };
  let toward, against, base;
  if (Number.isInteger(line)) {
    if (!(push >= 0 && push < 1)) return null;
    base = row(line, p * (1 - push), push);
    toward = row(0, p * (1 - push) + push, 0); // el número del push pasa a ganar
    against = row(0, p * (1 - push), 0); // el número del push pasa a perder
  } else {
    if (!(pushLower >= 0 && pushHigher >= 0 && pushLower < 1 && pushHigher < 1)) return null;
    const [mT, mA] = towardHigher ? [pushHigher, pushLower] : [pushLower, pushHigher];
    base = row(line, p, 0);
    toward = row(0, p, mT); // el número perdedor vecino pasa a push
    against = row(0, p - mA, mA); // el número ganador vecino pasa a push
  }
  const [lower, higher] = towardHigher ? [against, toward] : [toward, against];
  lower.line = line - 0.5;
  higher.line = line + 0.5;
  return { p, rows: [lower, base, higher] };
}

// Hándicap → moneyline justo con margen ~ Normal(−spread, sigma).
export function spreadToMoneyline(spread, sigma = 13.5) {
  if (!Number.isFinite(spread) || !(sigma > 0)) return null;
  const prob = normCdf(-spread / sigma);
  return { prob, decimal: 1 / prob, american: fairAm(prob), oppProb: 1 - prob, oppDecimal: 1 / (1 - prob), oppAmerican: fairAm(1 - prob) };
}

// Poisson: { k } → exactamente / al menos / como máximo k; { line } → over/under con push en líneas enteras.
export function poisson(lambda, { k, line } = {}) {
  if (!(lambda >= 0) || !Number.isFinite(lambda)) return null;
  if (line != null) {
    if (!isHalfStep(line) || line < 0) return null;
    const push = Number.isInteger(line) ? poissonPmf(line, lambda) : 0;
    const under = poissonCdf(Math.ceil(line) - 1, lambda), over = Math.max(0, 1 - under - push);
    const side = (win, loss) => {
      const fair = win > 0 ? (1 - push) / win : null;
      return { win, loss, push, fair, american: amOf(fair) };
    };
    return { line, over: side(over, under), under: side(under, over) };
  }
  if (!Number.isInteger(k) || k < 0) return null;
  const exact = poissonPmf(k, lambda), atMost = poissonCdf(k, lambda), atLeast = 1 - poissonCdf(k - 1, lambda);
  return { k, exact, atLeast, atMost, american: { exact: fairAm(exact), atLeast: fairAm(atLeast), atMost: fairAm(atMost) } };
}
