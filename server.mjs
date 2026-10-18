// Servidor de Coflas Bet: sirve public/ y hace de proxy a ESPN (partidos, game logs, lesiones, plantillas; sin clave)
// y a The Odds API (cuotas y props; la clave nunca llega al navegador). Caché en memoria por URL en lib/espn.mjs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAGUES, leagueById } from './public/leagues.js';
import * as espn from './lib/espn.mjs';
import { getProps } from './lib/props.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const KEY = process.env.COFLAS_ODDS_API_KEY;
const REGIONS = process.env.COFLAS_REGIONS || 'eu,us';
const PROP_REGIONS = process.env.COFLAS_PROP_REGIONS || 'us,us2,eu';
const PROP_EVENTS = Math.min(20, Math.max(1, Number(process.env.COFLAS_PROPS_MAX_EVENTS) || 4));
const PORT = Number(process.env.PORT || 5173);
const demo = JSON.parse(await readFile(path.join(ROOT, 'demo-odds.json'), 'utf8'));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

// Cada consulta de cuotas gasta créditos del plan: caché de 5 min (TTL.board).
async function oddsApi(route, params = {}) {
  const url = new URL(`https://api.the-odds-api.com/v4${route}`);
  url.search = new URLSearchParams({ ...params, apiKey: KEY });
  const { body, headers } = await espn.fetchJson(url.href, espn.TTL.board, { label: 'The Odds API', meta: true });
  return { source: 'live', remaining: headers.get('x-requests-remaining'), data: body };
}

// ---------- validación de parámetros ----------
const RX = {
  date: /^\d{8}$/,
  id: /^\d{1,12}$/,
  season: /^(19|20)\d\d$/,
  q: /^[\p{L}\p{M}0-9 .'’-]{2,40}$/u,
  sport: /^[a-z0-9_]{1,60}$/,
};
const bad = (msg) => espn.httpError(400, msg);
function param(url, name, rx, required = false) {
  const v = url.searchParams.get(name);
  if (v == null || v === '') {
    if (required) throw bad(`Falta el parámetro ${name}`);
    return null;
  }
  if (!rx.test(v)) throw bad(`Parámetro inválido: ${name}`);
  return v;
}
function leagueParam(url) {
  const lg = leagueById(url.searchParams.get('league') ?? '');
  if (!lg) throw bad(`Liga inválida. Opciones: ${LEAGUES.map((l) => l.id).join(', ')}`);
  return lg.id;
}

const ROUTES = {
  '/api/leagues': async () => ({ source: 'espn', data: LEAGUES }),
  '/api/sports': async () => {
    if (!KEY) return { source: 'demo', data: demo.sports };
    const r = await oddsApi('/sports');
    return { ...r, data: r.data.filter((s) => s.active && !s.has_outrights).map(({ key, title, group }) => ({ key, title, group })) };
  },
  '/api/odds': async (url) => {
    const sport = param(url, 'sport', RX.sport) || 'upcoming';
    if (!KEY) return { source: 'demo', data: sport === 'upcoming' ? demo.events : demo.events.filter((e) => e.sport_key === sport) };
    return oddsApi(`/sports/${sport}/odds`, { regions: REGIONS, markets: 'h2h,spreads,totals', oddsFormat: 'decimal' });
  },
  '/api/games': async (url) => ({ source: 'espn', data: await espn.getGames(leagueParam(url), param(url, 'date', RX.date)) }),
  '/api/game': async (url) => ({ source: 'espn', data: await espn.getGame(leagueParam(url), param(url, 'id', RX.id, true)) }),
  '/api/gamelog': async (url) => ({
    source: 'espn',
    data: await espn.getGamelog(leagueParam(url), param(url, 'athlete', RX.id, true), param(url, 'season', RX.season)),
  }),
  '/api/roster': async (url) => ({ source: 'espn', data: await espn.getRoster(leagueParam(url), param(url, 'team', RX.id, true)) }),
  '/api/injuries': async (url) => ({ source: 'espn', data: await espn.getInjuries(leagueParam(url)) }),
  '/api/search': async (url) => ({ source: 'espn', data: await espn.searchAthletes(leagueParam(url), param(url, 'q', RX.q, true).trim()) }),
  '/api/props': async (url) => getProps(leagueParam(url), param(url, 'game', RX.id), { key: KEY, regions: PROP_REGIONS, maxEvents: PROP_EVENTS }),
};

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));

export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw espn.httpError(405, 'Método no permitido');
      const route = ROUTES[url.pathname];
      if (!route) throw espn.httpError(404, 'No encontrado');
      json(res, 200, await route(url));
      return;
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) throw Object.assign(new Error('Prohibido'), { status: 403 });
    const content = await readFile(file).catch(() => {
      throw Object.assign(new Error('No encontrado'), { status: 404 });
    });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(content);
  } catch (err) {
    const status = err.status || (err instanceof URIError ? 400 : 502);
    json(res, status, { error: err.status ? err.message : status === 400 ? 'Ruta inválida' : 'Error al consultar los datos' });
    if (status === 502 && !err.status) console.error(err);
  }
}

// En Vercel solo se importa el handler (api/[...path].mjs); en local se levanta el servidor.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) http.createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`Coflas Bet en http://localhost:${PORT} — partidos y estadísticas: ESPN · cuotas y props: ${KEY ? `The Odds API (regiones ${REGIONS}; props ${PROP_REGIONS}, ${PROP_EVENTS} partidos)` : 'DEMO (falta COFLAS_ODDS_API_KEY en .env)'}`);
});
