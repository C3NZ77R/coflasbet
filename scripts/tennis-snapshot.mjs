// Genera data/atp-history.json: partidos ATP de singles terminados de los últimos 24 meses (sin el mes actual ni
// el anterior, que getHistory trae en vivo). Uso: node scripts/tennis-snapshot.mjs
// shortcut: se refresca a mano corriendo este script; pasar a un cron si el Elo se queda viejo.
import { writeFileSync } from 'node:fs';
import { getMonth, uniqueById, finished } from '../lib/tennis.mjs';

const now = new Date();
const all = [];
for (let k = 23; k >= 2; k--) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
  const yyyymm = d.toISOString().slice(0, 7).replace('-', '');
  const ms = await getMonth(yyyymm);
  console.log(yyyymm, ms.length);
  all.push(...ms);
}
// sin banderas para achicar el archivo: la ficha del jugador las toma del ranking
const matches = finished(uniqueById(all)).map(({ a, b, ...m }) => ({ ...m, a: { ...a, flag: undefined }, b: { ...b, flag: undefined } }));
writeFileSync(new URL('../data/atp-history.json', import.meta.url), JSON.stringify({ at: now.toISOString(), matches }));
console.log('partidos', matches.length);
