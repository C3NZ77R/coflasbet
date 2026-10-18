// Props de jugador con línea y cuotas propias: el game log de ESPN de cada jugador da su distribución por estadística.
// Conteos: binomial negativa (Poisson si no hay sobredispersión). Volúmenes altos (puntos, yardas): normal.
import { leagueById } from '../public/leagues.js';
import { STATS, statOf } from '../public/stats.js';
import { getGame, getGames, getGamelog, getRoster, httpError, mapLimit } from './espn.mjs';
import { price, halfLine } from './pricing.mjs';
import { propOver } from '../public/betmath.js';

const MIN_GAMES = 8;
const PER_TEAM = 8; // jugadores por equipo con más minutos (o más partidos)
const NEXT_GAMES = 3; // sin partido: los próximos de la liga (cada partido son ~2 plantillas + 30 game logs)
const IN_FLIGHT = 4; // peticiones a ESPN a la vez (Ruling 12): una ráfaga de cientos acaba en 403
const NORMAL = new Set(['pts', 'pra', 'pr', 'pa', 'pass_yds', 'rush_yds', 'rec_yds', 'rush_rec_yds', 'pass_rush_yds']);
const POS = { football: new Set(['QB', 'RB', 'WR', 'TE']) }; // NFL: 53 por plantilla; solo los que tienen props

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// values: del más reciente al más viejo. null con menos de MIN_GAMES partidos.
export function propLine(values, kind = 'count') {
  if (values.length < MIN_GAMES) return null;
  const m = 0.5 * mean(values.slice(0, 10)) + 0.3 * mean(values) + 0.2 * mean(values.slice(0, 5));
  const line = halfLine(median(values.slice(0, 20)));
  const variance = values.reduce((s, x) => s + (x - mean(values)) ** 2, 0) / (values.length - 1);
  return { line, mean: m, variance, pOver: propOver(kind, m, variance, line) };
}

// Props de un jugador a partir de su game log normalizado (lib/espn.mjs → buildGameLog).
export function playerProps(log, sport, ctx) {
  const out = [];
  for (const d of STATS[sport] ?? []) {
    if (!d.market) continue;
    const values = log.games.map((g) => statOf(sport, d.key, g.stats)).filter((v) => v != null);
    if (!values.some((v) => v > 0)) continue;
    const kind = NORMAL.has(d.key) ? 'normal' : 'count';
    const r = propLine(values, kind);
    if (!r || r.pOver < 0.03 || r.pOver > 0.97) continue; // casi seguro (p. ej. Under 0.5 tapones): cuota 1.01, no aporta
    for (const [side, p] of [['Over', r.pOver], ['Under', 1 - r.pOver]]) {
      const pr = price(p);
      out.push({
        id: `${ctx.gameId}|${d.market}|${log.athlete.id}|${r.line}|${side}`, league: ctx.league, gameId: ctx.gameId, eventId: ctx.gameId,
        start: ctx.start, player: log.athlete.name ?? ctx.name, athleteId: log.athlete.id, team: ctx.team, opp: ctx.opp,
        market: d.market, stat: d.key, line: r.line, side, p, fair: pr.fair, mean: r.mean, variance: r.variance, kind, n: values.length,
        books: [{ key: 'oddsy', title: 'Oddsy', price: pr.oddsy }],
      });
    }
  }
  return out;
}

const activity = (log) => {
  const mins = log.games.map((g) => g.minutes).filter(Number.isFinite);
  return mins.length ? mean(mins.slice(0, 10)) : log.games.length;
};

export async function getProps(league, gameId = null) {
  const lg = leagueById(league);
  if (!lg) throw httpError(400, 'Liga inválida');
  if (lg.props === false) return { source: 'oddsy', data: [] }; // Betano.co solo ofrece goleador en esta liga
  // shortcut: sin partido solo se cubren los próximos NEXT_GAMES de hoy; para más, pedir por partido.
  const games = gameId ? [await getGame(lg.id, gameId)] : (await getGames(lg.id)).filter((g) => g.status?.state === 'pre').slice(0, NEXT_GAMES);
  // Plantillas y después una lista plana de game logs, siempre con a lo sumo IN_FLIGHT pedidos a ESPN.
  const sides = games.flatMap((g) => [[g, g.home, g.away], [g, g.away, g.home]]);
  const rosters = await mapLimit(sides, IN_FLIGHT, ([, t]) => getRoster(lg.id, t.id).catch(() => []));
  const jobs = sides.flatMap((_, i) => rosters[i].filter((a) => !POS[lg.sport] || POS[lg.sport].has(a.pos)).map((a) => [i, a]));
  const logs = await mapLimit(jobs, IN_FLIGHT, ([, a]) => getGamelog(lg.id, a.id, null, { athlete: a }).catch(() => null));
  const bySide = sides.map(() => []);
  jobs.forEach(([i], k) => { if (logs[k]?.games.length >= MIN_GAMES) bySide[i].push(logs[k]); });
  const data = bySide.flatMap((ls, i) => {
    const [g, t, o] = sides[i];
    return ls.sort((a, b) => activity(b) - activity(a)).slice(0, PER_TEAM)
      .flatMap((l) => playerProps(l, lg.sport, { league: lg.id, gameId: g.id, start: g.start, team: t.abbr, opp: o.abbr }));
  });
  return { source: 'oddsy', data };
}
