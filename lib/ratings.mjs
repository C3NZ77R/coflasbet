// Fuerza de equipos a partir de resultados: ataque (gf) y defensa (ga) por partido ajustados por rival y por
// localía, con shrink a la media de liga. Deportes 'normal': modelo aditivo, E[pf] = gf + ga_rival − m ± HFA/2.
// Deportes 'poisson': multiplicativo, E[pf] = media_sede · (gf/m) · (ga_rival/m). m = media por equipo y partido.
export const SPORT_MODEL = { soccer: 'poisson', hockey: 'poisson', baseball: 'poisson', basketball: 'normal', football: 'normal' };
// Modelo normal, calibrado en la primera mitad de la última temporada con scripts/backtest.mjs (football: σ fijo de la
// literatura). MU_SHRINK: regresión a la media de mu, que sin ella sale sobreconfiado; SIGMA_T: desvío de los totales.
export const SIGMA = { football: 13.5, basketball: 14 };
export const MU_SHRINK = { football: 0.8, basketball: 0.72 };
export const SIGMA_T = { football: 13.2, basketball: 19.4 };

// Medias de respaldo [local, visita] cuando la liga aún no tiene partidos (ni de la temporada anterior).
const DEFAULT_AVG = { soccer: [1.5, 1.2], hockey: [3.1, 2.9], baseball: [4.6, 4.4], basketball: [114, 111], football: [24, 21] };
const TOL = 1e-9;
const MAX_ITERS = 500;

const modelOf = (sport) => {
  const m = SPORT_MODEL[sport];
  if (!m) throw new TypeError(`Deporte sin modelo: ${sport}`);
  return m;
};
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const regulation = (r) => ({ ...r, homeScore: r.homeScore - (r.homeScore > r.awayScore), awayScore: r.awayScore - (r.awayScore > r.homeScore) });

export function ratingsFromResults(results, { sport, asOf = Infinity, prior = 5 } = {}) {
  const mult = modelOf(sport) === 'poisson';
  const cut = typeof asOf === 'string' ? Date.parse(asOf) : Number(asOf);
  if (Number.isNaN(cut)) throw new TypeError('asOf inválido');
  // NHL: el final de un partido con ot trae +1 del ganador (gol de prórroga o shootout); el modelo es de tiempo regular.
  const rs = results.filter((r) => Date.parse(r.date) < cut).map((r) => (sport === 'hockey' && r.ot ? regulation(r) : r));
  // La ventaja local sale solo de partidos con sede; los neutrales cuentan para la fuerza de cada equipo.
  const venue = rs.filter((r) => !r.neutral);
  const all = sum(rs, (r) => r.homeScore + r.awayScore) / (2 * rs.length || 1);
  const avgHome = venue.length ? sum(venue, (r) => r.homeScore) / venue.length : all;
  const avgAway = venue.length ? sum(venue, (r) => r.awayScore) / venue.length : all;
  const avg = (avgHome + avgAway) / 2;
  const teams = new Map();
  if (!(avg > 0)) return { teams, avgHome, avgAway };

  // Cada partido visto desde cada equipo: rival, a favor, en contra y efecto de sede propio (v) y del rival (vo).
  const [vH, vA, v0] = mult ? [avgHome / avg, avgAway / avg, 1] : [avgHome - avg, avgAway - avg, 0];
  const sides = new Map();
  const add = (id, g) => (sides.get(id) ?? sides.set(id, []).get(id)).push(g);
  for (const r of rs) {
    const [vh, va] = r.neutral ? [v0, v0] : [vH, vA];
    add(r.homeId, { opp: r.awayId, pf: r.homeScore, pa: r.awayScore, v: vh, vo: va });
    add(r.awayId, { opp: r.homeId, pf: r.awayScore, pa: r.homeScore, v: va, vo: vh });
  }

  // Punto fijo: cada rating es la media (con prior partidos en la media de liga) de lo que el equipo habría hecho
  // contra un rival medio en campo neutral. Jacobi amortiguado: sin amortiguar, el nivel total oscila.
  let t = new Map([...sides.keys()].map((id) => [id, { gf: avg, ga: avg }]));
  for (let k = 0, delta = Infinity; k < MAX_ITERS && delta > TOL; k++) {
    const next = new Map();
    delta = 0;
    for (const [id, gs] of sides) {
      const opp = (g) => t.get(g.opp);
      const [f, a] = mult
        ? [(sum(gs, (g) => g.pf) + prior * avg) / (sum(gs, (g) => (g.v * opp(g).ga) / avg) + prior),
          (sum(gs, (g) => g.pa) + prior * avg) / (sum(gs, (g) => (g.vo * opp(g).gf) / avg) + prior)]
        : [(sum(gs, (g) => g.pf - opp(g).ga + avg - g.v) + prior * avg) / (gs.length + prior),
          (sum(gs, (g) => g.pa - opp(g).gf + avg - g.vo) + prior * avg) / (gs.length + prior)];
      const o = t.get(id);
      const n = { gf: (o.gf + f) / 2, ga: (o.ga + a) / 2 };
      delta = Math.max(delta, Math.abs(n.gf - o.gf), Math.abs(n.ga - o.ga));
      next.set(id, n);
    }
    t = next;
  }
  for (const [id, gs] of sides) teams.set(id, { ...t.get(id), gp: gs.length });
  return { teams, avgHome, avgAway };
}

// Espera de goles (poisson) o de margen y total (normal). Equipo desconocido = media de liga.
// neutral: sin ventaja local (ambos lados con la media de liga).
export function expected(sport, ratings, homeId, awayId, { neutral = false } = {}) {
  const model = modelOf(sport);
  const d = DEFAULT_AVG[sport];
  const ok = ratings.avgHome > 0 && ratings.avgAway > 0;
  const avg = ok ? (ratings.avgHome + ratings.avgAway) / 2 : (d[0] + d[1]) / 2;
  const [avgHome, avgAway] = neutral ? [avg, avg] : ok ? [ratings.avgHome, ratings.avgAway] : d;
  const T = (id) => ratings.teams.get(id) ?? { gf: avg, ga: avg, gp: 0 };
  const [h, a] = [T(homeId), T(awayId)];
  if (model === 'normal') {
    return {
      kind: 'normal',
      mu: MU_SHRINK[sport] * (h.gf - h.ga - (a.gf - a.ga) + (avgHome - avgAway)),
      sigma: SIGMA[sport],
      total: h.gf + a.ga + a.gf + h.ga - 2 * avg,
      sigmaT: SIGMA_T[sport],
    };
  }
  return { kind: 'poisson', lh: avgHome * (h.gf / avg) * (a.ga / avg), la: avgAway * (a.gf / avg) * (h.ga / avg) };
}
