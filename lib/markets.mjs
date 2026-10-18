// Mercados por deporte desde el modelo de expected(): cada selección con su p, cuota justa y cuota Oddsy.
import { price, scoreGrid, normalOver, halfLine, countOver } from './pricing.mjs';
import { readFileSync } from 'node:fs';
import { SPORT_MODEL, ratingsFromResults, expected } from './ratings.mjs';
import { getGame, getGames, getSeasonResults, isCollege, httpError } from './espn.mjs';
import { leagueById } from '../public/leagues.js';
import { getToday, getHistory, getRankings, eloFrom, matchProb, serveFromMatchProb, matchDist } from './tennis.mjs';
import { getStatsHistory, statRates, expectedStat, cardsMarkets } from './corners.mjs';

const sel = (name, p, line) => ({ name, ...(line !== undefined && { line }), ...price(p) });
const market = (key, label, selections) => ({ key, label, selections });
const sumGrid = (g, f) => g.reduce((s, row, i) => s + row.reduce((t, v, j) => (f(i, j) ? t + v : t), 0), 0);
const fmt = (x) => (x > 0 ? `+${x}` : `${x}`);
// Línea asiática → p equivalente (cuota justa 1/p). part(x) = [P(gana), P(devuelve)] en la línea x; las de cuarto se parten en dos.
const asian = (part, l) => {
  const ps = ((l * 4) % 2 ? [l - 0.25, l + 0.25] : [l]).map(part);
  const w = ps.reduce((s, [p]) => s + p, 0) / ps.length, q = ps.reduce((s, [, p]) => s + p, 0) / ps.length;
  return q < 1 ? w / (1 - q) : 0.5;
};

function soccer({ lh, la }) {
  const g = scoreGrid(lh, la);
  const [H, D, A] = [sumGrid(g, (i, j) => i > j), sumGrid(g, (i, j) => i === j), sumGrid(g, (i, j) => i < j)];
  const dnb = H + A > 0 ? H / (H + A) : 0.5; // sin goles no hay ganador: reparto parejo
  const btts = sumGrid(g, (i, j) => i > 0 && j > 0);
  const cells = g.flatMap((row, i) => row.map((p, j) => ({ name: `${i}-${j}`, p }))).sort((a, b) => b.p - a.p).slice(0, 10);
  return [
    market('1x2', 'Resultado (1X2)', [sel('Local', H), sel('Empate', D), sel('Visitante', A)]),
    market('dc', 'Doble oportunidad', [sel('Local o empate', H + D), sel('Local o visitante', H + A), sel('Empate o visitante', D + A)]),
    market('dnb', 'Empate no válido', [sel('Local', dnb), sel('Visitante', 1 - dnb)]),
    ...[0.5, 1.5, 2.5, 3.5, 4.5, 5.5].map((l) => {
      const over = sumGrid(g, (i, j) => i + j > l);
      return market('ou', `Total de goles ${l}`, [sel('Más', over, l), sel('Menos', 1 - over, l)]);
    }),
    ...[['home', 'Local', (i) => i], ['away', 'Visitante', (i, j) => j]].flatMap(([k, n, f]) => [0.5, 1.5, 2.5, 3.5].map((l) => {
      const over = sumGrid(g, (i, j) => f(i, j) > l);
      return market(`ou_${k}`, `Goles ${n.toLowerCase()} ${l}`, [sel('Más', over, l), sel('Menos', 1 - over, l)]);
    })),
    market('btts', 'Ambos marcan', [sel('Sí', btts), sel('No', 1 - btts)]),
    // Líneas de Betano.co. Entera: si empata con la línea devuelve. De cuarto: media apuesta en cada línea vecina.
    ...[-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1].map((l) => {
      const home = asian((x) => [sumGrid(g, (i, j) => i - j + x > 0), sumGrid(g, (i, j) => i - j + x === 0)], l);
      return market('ah', `Hándicap asiático local ${fmt(l)}`, [sel('Local', home, l), sel('Visitante', 1 - home, -l)]);
    }),
    ...[-0.5, -0.25, 0.25, 0.5].map((d) => halfLine(lh + la) + d).filter((l) => l > 0).map((l) => {
      const over = asian((x) => [sumGrid(g, (i, j) => i + j > x), sumGrid(g, (i, j) => i + j === x)], l);
      return market('aou', `Total asiático de goles ${l}`, [sel('Más', over, l), sel('Menos', 1 - over, l)]);
    }),
    market('cs', 'Marcador exacto', [...cells.map((c) => sel(c.name, c.p)), sel('Otro', Math.max(0, 1 - cells.reduce((s, c) => s + c.p, 0)))]),
  ];
}

// Hockey y béisbol: sin empate. El empate en tiempo regular se reparte según lh/(lh+la); en hockey suma un gol al final.
function noDraw(sport, { lh, la }) {
  const g = scoreGrid(lh, la, { rho: 0, max: 20 });
  const share = lh + la > 0 ? lh / (lh + la) : 0.5;
  const home = sumGrid(g, (i, j) => i > j) + sumGrid(g, (i, j) => i === j) * share;
  const homeFav = lh >= la;
  const fav = sumGrid(g, (i, j) => (homeFav ? i - j : j - i) >= 2);
  const [pHome, pAway] = homeFav ? [fav, 1 - fav] : [1 - fav, fav];
  const line = halfLine(lh + la);
  const extra = sport === 'hockey';
  const over = sumGrid(g, (i, j) => i + j + (extra && i === j) > line);
  const unit = extra ? 'goles' : 'carreras';
  return [
    market('ml', 'Ganador', [sel('Local', home), sel('Visitante', 1 - home)]),
    market('rl', extra ? 'Puck line' : 'Run line', [sel('Local', pHome, homeFav ? -1.5 : 1.5), sel('Visitante', pAway, homeFav ? 1.5 : -1.5)]),
    market('ou', `Total de ${unit} ${line}`, [sel('Más', over, line), sel('Menos', 1 - over, line)]),
  ];
}

function normal({ mu, sigma, total, sigmaT }) {
  const [over, under] = [normalOver(mu, sigma, 0), normalOver(-mu, sigma, 0)];
  const ml = over / (over + under); // sin push: el empate se excluye y se renormaliza
  const l = halfLine(-mu);
  const cover = normalOver(mu, sigma, -l);
  const t = halfLine(total);
  const ou = normalOver(total, sigmaT, t);
  return [
    market('ml', 'Ganador', [sel('Local', ml), sel('Visitante', 1 - ml)]),
    market('spread', `Spread local ${fmt(l)}`, [sel('Local', cover, l), sel('Visitante', 1 - cover, -l)]),
    market('ou', `Total de puntos ${t}`, [sel('Más', ou, t), sel('Menos', 1 - ou, t)]),
  ];
}

// Tenis: todo sale de matchDist (lib/tennis.mjs); A es el primer jugador del partido y B el segundo.
function tennis({ pA, firstSet, sets, games, margin }) {
  const won = (f) => Object.entries(sets).reduce((s, [k, p]) => (f(...k.split('-').map(Number)) ? s + p : s), 0);
  const fiveSets = '3-0' in sets;
  const g = halfLine(games.reduce((s, p, k) => s + p * k, 0));
  const overG = countOver(games, g);
  const ds = Object.entries(margin).map(([d, p]) => [Number(d), p]); // d = games de A − games de B
  const l = halfLine(-ds.reduce((s, [d, p]) => s + d * p, 0));
  const cover = ds.reduce((s, [d, p]) => (d + l > 0 ? s + p : s), 0);
  return [
    market('ml', 'Ganador', [sel('A', pA), sel('B', 1 - pA)]),
    market('sets', 'Resultado exacto en sets', Object.entries(sets).map(([k, p]) => sel(k, p))),
    ...(fiveSets ? [3.5, 4.5] : [2.5]).map((t) => {
      const over = won((a, b) => a + b > t);
      return market('ou_sets', `Total de sets ${t}`, [sel('Más', over, t), sel('Menos', 1 - over, t)]);
    }),
    market('ou_games', `Total de games ${g}`, [sel('Más', overG, g), sel('Menos', 1 - overG, g)]),
    market('games_hcp', `Hándicap de games A ${fmt(l)}`, [sel('A', cover, l), sel('B', 1 - cover, -l)]),
    ...[['A', (a) => a > 0], ['B', (a, b) => b > 0]].map(([n, f]) => {
      const p = won(f);
      return market('win_set', `${n} gana al menos un set`, [sel('Sí', p), sel('No', 1 - p)]);
    }),
    market('first_set', 'Ganador del primer set', [sel('A', firstSet), sel('B', 1 - firstSet)]),
  ];
}

export function marketsFor(sport, model) {
  const kind = sport === 'tennis' ? 'tennis' : SPORT_MODEL[sport];
  if (!kind) throw new TypeError(`Deporte sin modelo: ${sport}`);
  if (model?.kind !== kind) throw new TypeError(`Modelo ${model?.kind} no sirve para ${sport}`);
  if (kind === 'tennis') return tennis(model.dist);
  if (kind === 'normal') return normal(model);
  return sport === 'soccer' ? soccer(model) : noDraw(sport, model);
}

// ---------- servicio: mercados de partidos reales de ESPN ----------
const ACCURACY = JSON.parse(readFileSync(new URL('../docs/accuracy.json', import.meta.url), 'utf8'));
export const accuracyOf = (league) => ACCURACY[league] ?? null;
export const getAccuracy = () => ACCURACY;

const RATINGS_TTL = 30 * 60_000;
const ratingsMemo = new Map(); // clave liga (o liga + equipos en universitarias) -> { at, promise }
function ratingsFor(lg, teamIds) {
  const key = isCollege(lg) ? `${lg.id}:${[...teamIds].sort().join(',')}` : lg.id;
  const hit = ratingsMemo.get(key);
  if (hit && Date.now() - hit.at < RATINGS_TTL) return hit.promise;
  const promise = getSeasonResults(lg.id, isCollege(lg) ? { teamIds } : {}).then((rs) => ratingsFromResults(rs, { sport: lg.sport }));
  ratingsMemo.set(key, { at: Date.now(), promise });
  promise.catch(() => ratingsMemo.delete(key));
  return promise;
}

const forGame = (lg, ratings, g) => ({ gameId: g.id, markets: marketsFor(lg.sport, expected(lg.sport, ratings, g.home.id, g.away.id, { neutral: g.neutral })) });

// Con game: mercados de ese partido. Sin game: de todos los partidos de date (YYYYMMDD; por defecto hoy).
export async function getMarkets(league, { game = null, date = null } = {}) {
  const lg = leagueById(league);
  if (lg?.sport === 'tennis') return tennisMarkets(game, date);
  if (!lg || !SPORT_MODEL[lg.sport]) throw httpError(400, 'Liga sin modelo de cuotas');
  const games = game ? [await getGame(lg.id, game)] : await getGames(lg.id, date);
  const ratings = await ratingsFor(lg, games.flatMap((g) => [g.home.id, g.away.id]));
  // Tarjetas solo en Liga BetPlay (hay snapshot de estadísticas). Los córners no se publican: el backtest 2026 los deja en la media de liga.
  const cards = lg.id === 'colombia' ? await getStatsHistory(lg.id).then((rows) => statRates(rows, 'cards')).catch(() => null) : null;
  const data = games.filter((g) => g.home?.id && g.away?.id).map((g) => {
    const r = forGame(lg, ratings, g);
    if (cards) r.markets.push(...cardsMarkets(expectedStat(cards, g.home.id, g.away.id)));
    return r;
  });
  return { source: 'oddsy', accuracy: accuracyOf(lg.id), data: game ? data[0] ?? null : data };
}

// ---------- servicio: tenis ATP ----------
// Elo de los últimos 24 meses: se recalcula solo cuando cambia el historial (getHistory ya cachea los meses).
let elo = { key: null };
export async function atpElo() {
  const history = await getHistory();
  const key = `${history.length}:${history.at(-1)?.id}`;
  if (elo.key !== key) elo = { key, history, ratings: eloFrom(history) };
  return elo;
}

// El ranking solo decora la lista (#rank): si ESPN falla, los partidos salen sin él.
const atpRanks = () => getRankings().then((rs) => new Map(rs.map((r) => [r.player.id, r.rank])), () => new Map());
const isoDay = (d) => (d ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : undefined); // YYYYMMDD → YYYY-MM-DD
const setDone = ([x, y]) => (Math.max(x, y) >= 6 && Math.abs(x - y) >= 2) || Math.max(x, y) === 7;
const setTxt = (s) => `${s[0]}-${s[1]}${s.length > 2 ? `(${Math.min(s[2], s[3])})` : ''}`;

// Match → forma de Game para reusar la lista de partidos: home = a, away = b, logo = bandera, record = rank, score = sets.
export function tennisGame(m, ranks = new Map()) {
  const side = (p, i) => ({
    id: p.id,
    abbr: p.short,
    name: p.name,
    logo: p.flag ?? null,
    record: ranks.has(p.id) ? `#${ranks.get(p.id)}` : null,
    score: m.state === 'pre' ? null : m.sets.filter((s) => setDone(s) && s[i] > s[1 - i]).length,
    color: null,
  });
  const score = m.sets.map(setTxt).join(' ');
  return {
    id: m.id,
    league: 'atp',
    start: m.date,
    status: { state: m.state ?? 'pre', detail: score ? `${score}${m.retired ? ' (ret.)' : ''}` : null },
    home: side(m.a, 0),
    away: side(m.b, 1),
    tournament: m.tournament,
    round: m.round,
    surface: m.surface,
    bestOf: m.bestOf,
  };
}

export async function getTennisGames(date) {
  const [day, ranks] = await Promise.all([getToday(isoDay(date)), atpRanks()]);
  return day.map((m) => tennisGame(m, ranks));
}

// serveFromMatchProb cuesta 0.1–0.6 s por partido (bisección de 50 pasos): memo por p con 4 decimales y formato.
const dists = new Map();
function tennisDist(p, bestOf, slam) {
  const key = `${p}|${bestOf}|${slam}`;
  if (!dists.has(key)) {
    if (dists.size > 2000) dists.clear();
    const { sa, sb } = serveFromMatchProb(p, bestOf, { slam });
    dists.set(key, matchDist(sa, sb, bestOf, { slam }));
  }
  return dists.get(key);
}

// marketsFor('tennis') nombra a los jugadores A y B: se cambian por sus nombres cortos.
function named(markets, a, b) {
  const n = { A: a.short ?? a.name ?? 'A', B: b.short ?? b.name ?? 'B' };
  const sub = (s) => s.replace(/\b[AB]\b/g, (k) => n[k]);
  return markets.map((m) => ({
    ...m,
    label: m.key === 'sets' ? `${m.label} (${n.A} primero)` : sub(m.label),
    selections: m.selections.map((s) => ({ ...s, name: sub(s.name) })),
  }));
}

// Con game: ese partido (del día pedido o, si no está, del historial). Sin game: todos los del día (YYYYMMDD; hoy en Bogotá).
async function tennisMarkets(game, date) {
  const [day, { history, ratings }, ranks] = await Promise.all([getToday(isoDay(date)), atpElo(), atpRanks()]);
  const found = game && (day.find((m) => m.id === game) ?? history.find((m) => m.id === game));
  if (game && !found) throw httpError(404, 'Partido no encontrado');
  const data = (game ? [found] : day).map((m) => {
    const p = Math.round(matchProb(ratings, m.a.id, m.b.id, m.surface) * 1e4) / 1e4;
    const markets = marketsFor('tennis', { kind: 'tennis', dist: tennisDist(p, m.bestOf, m.slam) });
    return { gameId: m.id, game: tennisGame(m, ranks), markets: named(markets, m.a, m.b) };
  });
  return { source: 'oddsy', accuracy: accuracyOf('atp'), data: game ? data[0] : data };
}
