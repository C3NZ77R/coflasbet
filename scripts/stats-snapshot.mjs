// Genera data/stats-<liga>.json con córners y tarjetas por partido (summary de ESPN) de la temporada vigente y
// la anterior. Uso: node scripts/stats-snapshot.mjs [colombia]
// shortcut: se refresca a mano; getStatsHistory completa en vivo hasta 40 partidos nuevos.
import { writeFileSync } from 'node:fs';
import { leagueMatchIds, pullStats } from '../lib/corners.mjs';

const league = process.argv[2] ?? 'colombia';
const year = new Date().getUTCFullYear();
const ids = new Map();
for (const q of [`season=${year - 1}`, '']) {
  const ms = await leagueMatchIds(league, q);
  console.log(q || 'vigente', ms.length);
  for (const m of ms) ids.set(m.id, m.date);
}
const rows = await pullStats(league, [...ids.keys()], 2); // pocas a la vez: ESPN (Akamai) bloquea ráfagas
if (rows.length < ids.size * 0.9) throw new Error(`Solo ${rows.length} de ${ids.size} summaries: ESPN falló, no se escribe el snapshot`);
writeFileSync(new URL(`../data/stats-${league}.json`, import.meta.url), JSON.stringify({ at: new Date().toISOString(), rows }));
console.log('partidos', ids.size, 'con estadísticas', rows.length, rows[0]?.date, rows.at(-1)?.date);
