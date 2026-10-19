// Mejores apuestas (#/<liga>/picks): por partido de hoy a +2 días, las selecciones más probables según el modelo, con la
// cuota mínima a la que vale la pena y cuánto se cumplió ese tipo de predicción en el backtest (/api/picks).
import { h, fmtPct, fmtOdds, when, empty } from '../ui.js';
import { ymd } from './games.js';

// "Local o empate" → "Millonarios o empate"; el tenis ya trae los nombres de los jugadores.
const named = (text, g) => String(text).replace(/\bLocal\b/g, g.home?.name ?? 'Local').replace(/\bVisitante\b/g, g.away?.name ?? 'Visitante');
const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
const HCP = { spread: 'Spread', rl: 'Run line', games_hcp: 'Hándicap de games' };
const pickText = (p, g) => named(HCP[p.market] ? `${p.name} ${signed(p.line)} (${HCP[p.market]})`
  : p.market === '1x2' || p.market === 'ml' ? (p.name === 'Empate' ? 'Empate' : `Gana ${p.name}`)
    : `${p.label}: ${p.name}`, g);
const recordText = (r) => (r ? h`${fmtPct(r.hit, 0)} <small>de ${r.n}</small>` : "—");

function gameCard(g, picks) {
  return h`<section class="card pk-game">
    <h2>${g.home?.name} vs ${g.away?.name}</h2>
    <p class="hint">${when(g.start)}</p>
    <table class="tbl"><caption class="sr-only">Mejores apuestas de ${g.home?.name} contra ${g.away?.name}</caption>
      <thead><tr><th scope="col">Apuesta</th><th scope="col">Probabilidad</th><th scope="col">Cuota mínima</th><th scope="col">Se cumplió</th></tr></thead>
      <tbody>${picks.map((p) => h`<tr><td>${pickText(p, g)}</td><td>${fmtPct(p.p, 0)}</td><td><b>${fmtOdds(p.minOdds)}</b></td><td>${recordText(p.record)}</td></tr>`)}</tbody>
    </table></section>`;
}

export default {
  title: 'Mejores apuestas',
  async render(el, { api, leagueInfo: lg }) {
    const days = [0, 1, 2].map((i) => ymd(new Date(Date.now() + i * 864e5)));
    const res = await Promise.all(days.map((d) => Promise.all([api.games(lg.id, d), api.get('/api/picks', { league: lg.id, date: d })])));
    const games = new Map(res.flatMap(([gs]) => gs.data ?? []).map((g) => [g.id, g]));
    const acc = res[0][1].accuracy;
    const rows = res.flatMap(([, pk]) => pk.data ?? []).map((x) => [games.get(x.gameId), x.picks])
      .filter(([g, ps]) => g?.status?.state === 'pre' && ps.length).sort(([a], [b]) => a.start.localeCompare(b.start));
    el.innerHTML = h`<header class="view-head"><div><h1>Mejores apuestas · ${lg.title}</h1>
      <p class="hint">Lo más probable de cada partido según el modelo, de hoy a dos días. Apuesta solo si tu casa paga <b>igual o más</b> que la cuota mínima: por debajo pierdes plata a la larga aunque aciertes seguido. «Se cumplió» es cuántas veces pasó ese tipo de predicción en la temporada pasada, en partidos que el modelo no había visto.</p></div></header>
      ${acc?.publish === false ? empty('En esta liga el modelo todavía no le gana a la referencia del backtest: no mostramos apuestas.')
        : rows.length ? rows.map(([g, ps]) => gameCard(g, ps)) : empty('No hay partidos próximos con apuestas de 55% o más.')}`;
  },
};
