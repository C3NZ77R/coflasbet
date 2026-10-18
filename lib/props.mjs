// Props de jugador con línea y cuotas propias: el game log de ESPN de cada jugador da su distribución por estadística.
// Conteos: binomial negativa (Poisson si no hay sobredispersión). Volúmenes altos (puntos, yardas): normal.
import { leagueById } from '../public/leagues.js';
import { STATS, statOf } from '../public/stats.js';
import { getGame, getGames, getGamelog, getRoster, httpError } from './espn.mjs';
import { price, halfLine, negBinPmf, normalOver } from './pricing.mjs';

const MIN_GAMES = 8;
const PER_TEAM = 8; // jugadores por equipo con más minutos (o más partidos)
const NEXT_GAMES = 3; // sin partido: los próximos de la liga (cada partido son ~2 plantillas + 30 game logs)
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
  let pOver;
  if (kind === 'normal') pOver = normalOver(m, Math.max(Math.sqrt(variance), 1), line);
  else {
    pOver = 1 - Array.from({ length: Math.floor(line) + 1 }, (_, k) => negBinPmf(k, m, variance)).reduce((s, p) => s + p, 0);
  }
  return { line, mean: m, pOver: Math.min(0.99, Math.max(0.01, pOver)) };
}

// Props de un jugador a partir de su game log normalizado (lib/espn.mjs → buildGameLog).
export function playerProps(log, sport, ctx) {
  const out = [];
  for (const d of STATS[sport] ?? []) {
    if (!d.market) continue;
    const values = log.games.map((g) => statOf(sport, d.key, g.stats)).filter((v) => v != null);
    if (!values.some((v) => v > 0)) continue;
    const r = propLine(values, NORMAL.has(d.key) ? 'normal' : 'count');
    if (!r) continue;
    for (const [side, p] of [['Over', r.pOver], ['Under', 1 - r.pOver]]) {
      const pr = price(p);
      out.push({
        id: `${ctx.gameId}|${d.market}|${log.athlete.id}|${r.line}|${side}`, league: ctx.league, gameId: ctx.gameId, eventId: ctx.gameId,
        start: ctx.start, player: log.athlete.name ?? ctx.name, athleteId: log.athlete.id, team: ctx.team, opp: ctx.opp,
        market: d.market, stat: d.key, line: r.line, side, p, fair: pr.fair, mean: r.mean, n: values.length,
        books: [{ key: 'coflas', title: 'Coflas', price: pr.coflas }],
      });
    }
  }
  return out;
}

const activity = (log) => {
  const mins = log.games.map((g) => g.minutes).filter(Number.isFinite);
  return mins.length ? mean(mins.slice(0, 10)) : log.games.length;
};

async function gameProps(lg, game) {
  const sides = [[game.home, game.away], [game.away, game.home]];
  const lists = await Promise.all(sides.map(async ([t, o]) => {
    const roster = (await getRoster(lg.id, t.id).catch(() => [])).filter((a) => !POS[lg.sport] || POS[lg.sport].has(a.pos));
    const logs = (await Promise.all(roster.map((a) => getGamelog(lg.id, a.id).then((l) => ({ ...l, athlete: { ...l.athlete, name: l.athlete.name ?? a.name } })).catch(() => null))))
      .filter((l) => l?.games.length >= MIN_GAMES).sort((a, b) => activity(b) - activity(a)).slice(0, PER_TEAM);
    return logs.flatMap((l) => playerProps(l, lg.sport, { league: lg.id, gameId: game.id, start: game.start, team: t.abbr, opp: o.abbr }));
  }));
  return lists.flat();
}

export async function getProps(league, gameId = null) {
  const lg = leagueById(league);
  if (!lg) throw httpError(400, 'Liga inválida');
  // shortcut: sin partido solo se cubren los próximos NEXT_GAMES de hoy; para más, pedir por partido.
  const games = gameId ? [await getGame(lg.id, gameId)] : (await getGames(lg.id)).filter((g) => g.status?.state === 'pre').slice(0, NEXT_GAMES);
  const data = (await Promise.all(games.map((g) => gameProps(lg, g)))).flat();
  return { source: 'coflas', data };
}
