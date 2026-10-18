// Servidor de Coflas Bet: sirve public/ y hace de proxy a ESPN (partidos, game logs, lesiones, plantillas; sin clave).
// Las cuotas son propias (lib/markets.mjs y lib/props.mjs). Caché en memoria por URL en lib/espn.mjs.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEAGUES, leagueById } from './public/leagues.js';
import * as espn from './lib/espn.mjs';
import { getProps } from './lib/props.mjs';
import { getMarkets, getAccuracy } from './lib/markets.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---------- validación de parámetros ----------
const RX = {
  date: /^\d{8}$/,
  id: /^\d{1,12}$/,
  season: /^(19|20)\d\d$/,
  q: /^[\p{L}\p{M}0-9 .'’-]{2,40}$/u,
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
  '/api/markets': async (url) => getMarkets(leagueParam(url), { game: param(url, 'game', RX.id), date: param(url, 'date', RX.date) }),
  '/api/accuracy': async () => ({ source: 'coflas', data: getAccuracy() }),
  '/api/games': async (url) => ({ source: 'espn', data: await espn.getGames(leagueParam(url), param(url, 'date', RX.date)) }),
  '/api/game': async (url) => ({ source: 'espn', data: await espn.getGame(leagueParam(url), param(url, 'id', RX.id, true)) }),
  '/api/gamelog': async (url) => ({
    source: 'espn',
    data: await espn.getGamelog(leagueParam(url), param(url, 'athlete', RX.id, true), param(url, 'season', RX.season)),
  }),
  '/api/roster': async (url) => ({ source: 'espn', data: await espn.getRoster(leagueParam(url), param(url, 'team', RX.id, true)) }),
  '/api/injuries': async (url) => ({ source: 'espn', data: await espn.getInjuries(leagueParam(url)) }),
  '/api/search': async (url) => ({ source: 'espn', data: await espn.searchAthletes(leagueParam(url), param(url, 'q', RX.q, true).trim()) }),
  '/api/props': async (url) => getProps(leagueParam(url), param(url, 'game', RX.id)),
};

// Caché compartida en la CDN de Vercel (la memoria de cada instancia no se comparte): los ratings piden un calendario por equipo.
const EDGE_S = { '/api/markets': 1800, '/api/props': 1800, '/api/accuracy': 86400 };
const json = (res, status, body, edge = 0) => res.writeHead(status, {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': edge ? `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=${edge * 4}` : 'no-store',
}).end(JSON.stringify(body));

export async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw espn.httpError(405, 'Método no permitido');
      const route = ROUTES[url.pathname];
      if (!route) throw espn.httpError(404, 'No encontrado');
      json(res, 200, await route(url), EDGE_S[url.pathname] ?? 300);
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
  console.log(`Coflas Bet en http://localhost:${PORT} — partidos y estadísticas: ESPN · cuotas y props: modelo propio`);
});
