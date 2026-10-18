// Cliente del API de server.mjs. Cada función devuelve el cuerpo completo { source, data, remaining? }.
// Caché en sessionStorage de 60 s por URL y deduplicación de peticiones simultáneas.
const TTL = 60_000;
const inflight = new Map();

const param = (v) => (v && typeof v === 'object' ? v.id ?? String(v) : v); // acepta ctx.league (objeto) o 'nba'

export async function get(path, params = {}, { fresh = false } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, param(v));
  const url = qs.size ? `${path}?${qs}` : path;
  const ck = `api:${url}`;
  if (!fresh) {
    try {
      const hit = JSON.parse(sessionStorage.getItem(ck));
      if (hit && Date.now() - hit.at < TTL) return hit.body;
    } catch { /* sin sessionStorage */ }
    if (inflight.has(url)) return inflight.get(url);
  }
  const p = (async () => {
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('No se pudo conectar con el servidor. Revisa tu conexión.');
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw Object.assign(new Error(`Respuesta inválida del servidor (${res.status}).`), { status: res.status });
    }
    if (!res.ok) throw Object.assign(new Error(body?.error || `El servidor respondió ${res.status}.`), { status: res.status });
    try { sessionStorage.setItem(ck, JSON.stringify({ at: Date.now(), body })); } catch { /* cuota llena: sin caché */ }
    return body;
  })();
  inflight.set(url, p);
  try {
    return await p;
  } finally {
    inflight.delete(url);
  }
}

export const api = {
  get,
  leagues: () => get('/api/leagues'),
  sports: () => get('/api/sports'),
  odds: (sportKey) => get('/api/odds', { sport: sportKey }),
  games: (league, date) => get('/api/games', { league, date }),
  game: (league, id) => get('/api/game', { league, id }),
  gamelog: (league, athleteId, season) => get('/api/gamelog', { league, athlete: athleteId, season }),
  props: (league, gameId) => get('/api/props', { league, game: gameId }),
  injuries: (league) => get('/api/injuries', { league }),
  roster: (league, team) => get('/api/roster', { league, team }),
  search: (league, q) => get('/api/search', { league, q }),
};
export default api;
