// Fuerza de equipos a partir de resultados: medias de goles/puntos a favor y en contra con shrink a la media de liga.
export const SPORT_MODEL = { soccer: 'poisson', hockey: 'poisson', baseball: 'poisson', basketball: 'normal', football: 'normal' };
export const SIGMA = { football: 13.5, basketball: 12 }; // basketball provisional: Task 3 lo calibra

// Medias de respaldo [local, visita] cuando aún no hay partidos (inicio de temporada).
const DEFAULT_AVG = { soccer: [1.5, 1.2], hockey: [3.1, 2.9], baseball: [4.6, 4.4], basketball: [114, 111], football: [24, 21] };

export function ratingsFromResults(results, { asOf = Infinity, prior = 5 } = {}) {
  const rs = results.filter((r) => Date.parse(r.date) < asOf);
  const n = rs.length || 1;
  const avgHome = rs.reduce((s, r) => s + r.homeScore, 0) / n;
  const avgAway = rs.reduce((s, r) => s + r.awayScore, 0) / n;
  const avg = (avgHome + avgAway) / 2;
  const raw = new Map();
  const add = (id, gf, ga) => {
    const t = raw.get(id) ?? { gf: 0, ga: 0, gp: 0 };
    t.gf += gf; t.ga += ga; t.gp += 1;
    raw.set(id, t);
  };
  for (const r of rs) { add(r.homeId, r.homeScore, r.awayScore); add(r.awayId, r.awayScore, r.homeScore); }
  const teams = new Map();
  for (const [id, t] of raw) teams.set(id, { gf: (t.gf + prior * avg) / (t.gp + prior), ga: (t.ga + prior * avg) / (t.gp + prior), gp: t.gp });
  return { teams, avgHome, avgAway };
}

// Espera de goles (poisson) o de margen y total (normal). Nunca NaN: equipo desconocido = media de liga.
export function expected(sport, ratings, homeId, awayId) {
  const d = DEFAULT_AVG[sport] ?? DEFAULT_AVG.soccer;
  const ok = ratings.avgHome > 0 && ratings.avgAway > 0;
  const avgHome = ok ? ratings.avgHome : d[0];
  const avgAway = ok ? ratings.avgAway : d[1];
  const avg = (avgHome + avgAway) / 2;
  const T = (id) => ratings.teams.get(id) ?? { gf: avg, ga: avg, gp: 0 };
  const [h, a] = [T(homeId), T(awayId)];
  if (SPORT_MODEL[sport] === 'normal') {
    const sigma = SIGMA[sport];
    return {
      kind: 'normal',
      mu: (h.gf - h.ga - (a.gf - a.ga)) / 2 + (avgHome - avgAway),
      sigma,
      total: (h.gf + h.ga + a.gf + a.ga) / 2,
      sigmaT: sigma * 1.1, // atajo: se calibra en Task 3
    };
  }
  return { kind: 'poisson', lh: avgHome * (h.gf / avg) * (a.ga / avg), la: avgAway * (a.gf / avg) * (h.ga / avg) };
}
