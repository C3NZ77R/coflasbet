// Props de jugador: The Odds API (con COFLAS_ODDS_API_KEY) o demo-props.json (sin clave). Se enlazan con los partidos de
// ESPN (nombres de los equipos + hora de inicio) y con los atletas de ESPN (nombre en las plantillas) cuando se puede.
// Coste en créditos de The Odds API: /events es gratis; /events/{id}/odds cuesta [mercados devueltos] x [regiones].
import { readFile } from 'node:fs/promises';
import { leagueById } from '../public/leagues.js';
import { statForMarket, propMarkets } from '../public/stats.js';
import { fetchJson, getGames, getRoster, httpError, TTL } from './espn.mjs';

const ODDS = 'https://api.the-odds-api.com/v4';
const DEMO_FILE = new URL('../demo-props.json', import.meta.url);
let demo;

// "Luka Dončić Jr." → "luka doncic"
export const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();

// Palabras de 3+ letras (descarta "LA", "NY", "FC", "de"...).
const tokens = (s) => new Set(normName(s).split(' ').filter((t) => t.length > 2 && !['club', 'the'].includes(t)));
// ¿Mismo equipo? Iguales, o todas las palabras de uno están en el otro ("LA Clippers" ~ "Los Angeles Clippers",
// "Atletico Madrid" ~ "Atlético de Madrid"), pero no "Los Angeles Lakers" ~ "Los Angeles Clippers".
export function sameTeam(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const A = tokens(a), B = tokens(b);
  const within = (P, Q) => P.size > 0 && [...P].every((t) => Q.has(t));
  return within(A, B) || within(B, A);
}

// Partido de ESPN para un evento de The Odds API: ambos equipos coinciden y empiezan con menos de 6 h de diferencia.
export function matchGame(ev, games) {
  const t = Date.parse(ev.commence_time);
  return games.find((g) => Math.abs(Date.parse(g.start) - t) < 6 * 3600e3
    && sameTeam(ev.home_team, g.home.name) && sameTeam(ev.away_team, g.away.name)) ?? null;
}

const SIDES = { Over: 'Over', Under: 'Under', Yes: 'Over', No: 'Under' };

// Respuesta de /events/{id}/odds → Prop[] (un Prop por jugador + mercado + línea + lado, con todas las casas).
// ctx = { league, sport, gameId, players: Map(normName → { athleteId, team, opp }) }
export function normEventProps(ev, { league, sport, gameId = null, players = new Map() }) {
  const byId = new Map();
  for (const bm of ev?.bookmakers ?? []) {
    for (const mk of bm.markets ?? []) {
      for (const o of mk.outcomes ?? []) {
        const side = SIDES[o.name];
        const player = typeof o.description === 'string' ? o.description.trim() : '';
        const line = Number.isFinite(o.point) ? o.point : o.name === 'Yes' || o.name === 'No' ? 0.5 : null;
        if (!side || !player || line == null || !(o.price > 1)) continue;
        const id = `${ev.id}|${mk.key}|${normName(player)}|${line}|${side}`;
        let p = byId.get(id);
        if (!p) {
          const who = players.get(normName(player));
          p = {
            id, league, gameId, eventId: ev.id, start: ev.commence_time, player, athleteId: who?.athleteId ?? null,
            team: who?.team ?? null, opp: who?.opp ?? null, market: mk.key, stat: statForMarket(sport, mk.key)?.key ?? null,
            line, side, books: [],
          };
          byId.set(id, p);
        }
        if (!p.books.some((b) => b.key === bm.key)) p.books.push({ key: bm.key, title: bm.title, price: o.price });
      }
    }
  }
  return [...byId.values()];
}

// Jugadores de las dos plantillas de ESPN para enlazar por nombre.
async function playersFor(league, game) {
  const map = new Map();
  if (!game) return map;
  const [home, away] = await Promise.all([game.home.id, game.away.id].map((t) => getRoster(league, t).catch(() => [])));
  for (const [list, team, opp] of [[home, game.home.abbr, game.away.abbr], [away, game.away.abbr, game.home.abbr]]) {
    for (const a of list) if (a.name) map.set(normName(a.name), { athleteId: a.id, team, opp });
  }
  return map;
}

// Fecha YYYYMMDD en la hora del este de EE. UU., que es como ESPN agrupa los partidos del scoreboard.
const etDate = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t).replaceAll('-', '');

// Mercados principales por deporte: cada mercado devuelto cuesta 1 crédito por región y partido.
const CORE_MARKETS = {
  basketball: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists'],
  football: ['player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_anytime_td'],
  baseball: ['batter_hits', 'batter_total_bases', 'pitcher_strikeouts'],
  hockey: ['player_points', 'player_shots_on_goal'],
  soccer: ['player_goal_scorer_anytime', 'player_shots_on_target'],
};

async function liveProps(lg, gameId, { key, regions, maxEvents }) {
  if (!lg.odds) return { source: 'live', data: [], remaining: null };
  const q = (params) => new URLSearchParams({ apiKey: key, ...params });
  const events = await fetchJson(`${ODDS}/sports/${lg.odds}/events?${q({})}`, TTL.board, { label: 'The Odds API' });
  const now = Date.now();
  const upcoming = (Array.isArray(events) ? events : []).filter((e) => Date.parse(e.commence_time) > now - 4 * 3600e3)
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  if (!upcoming.length) return { source: 'live', data: [], remaining: null };
  // ESPN no acepta rangos de fechas: un scoreboard por día (en caché). Con game se mira la próxima semana; sin él, solo los elegidos.
  const pool = gameId ? upcoming.filter((e) => Date.parse(e.commence_time) < now + 8 * 864e5) : upcoming.slice(0, maxEvents);
  const dates = [...new Set(pool.map((e) => etDate(Date.parse(e.commence_time))))];
  const games = (await Promise.all(dates.map((d) => getGames(lg.id, d).catch(() => [])))).flat();
  const linked = pool.map((ev) => ({ ev, game: matchGame(ev, games) }));
  const chosen = gameId ? linked.filter((x) => x.game?.id === gameId) : linked;
  let remaining = null;
  const markets = (CORE_MARKETS[lg.sport] ?? propMarkets(lg.sport)).join(',');
  const lists = await Promise.all(chosen.map(async ({ ev, game }) => {
    const [res, players] = await Promise.all([
      fetchJson(`${ODDS}/sports/${lg.odds}/events/${ev.id}/odds?${q({ regions, markets, oddsFormat: 'decimal' })}`, TTL.board, { label: 'The Odds API', meta: true }),
      playersFor(lg.id, game),
    ]);
    remaining = res.headers.get('x-requests-remaining') ?? remaining;
    return normEventProps(res.body, { league: lg.id, sport: lg.sport, gameId: game?.id ?? null, players });
  }));
  return { source: 'live', data: lists.flat(), remaining };
}

export async function getProps(league, gameId = null, opts = {}) {
  const lg = leagueById(league);
  if (!lg) throw httpError(400, 'Liga inválida');
  // Props en vivo solo por partido: la lista de toda la liga gastaría los créditos del plan gratis en una consulta.
  if (opts.key && gameId) return liveProps(lg, gameId, { key: opts.key, regions: opts.regions || 'us', maxEvents: opts.maxEvents || 1 });
  demo ??= JSON.parse(await readFile(DEMO_FILE, 'utf8'));
  const body = { source: 'demo', data: demo.props.filter((p) => p.league === lg.id && (!gameId || p.gameId === gameId)) };
  return opts.key ? { ...body, warning: 'Para ahorrar créditos, los props en vivo solo se cargan al abrir un partido (Partidos → Detalles → Props de jugador). Esta lista es demo.' } : body;
}
