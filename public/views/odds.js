// Comparador (#/comparador): tablero de cuotas propias del modelo Oddsy por liga y mercado, próximos 3 días (hoy incluido).
// Por selección: probabilidad, cuota justa (1/p) y cuota Oddsy (con margen). Toca la cuota Oddsy para agregarla a Mis picks.
import { LEAGUES } from '../leagues.js';

const KEYS = { '1x2': 'Resultado (1X2)', ml: 'Ganador', spread: 'Spread', rl: 'Run/Puck line', ah: 'Hándicap asiático', aou: 'Total asiático', ou: 'Totales', ou_home: 'Goles local', ou_away: 'Goles visitante', dc: 'Doble oportunidad', dnb: 'Empate no válido', btts: 'Ambos marcan', cs: 'Marcador exacto',
  sets: 'Resultado en sets', ou_sets: 'Total de sets', ou_games: 'Total de games', games_hcp: 'Hándicap de games', win_set: 'Gana al menos un set', first_set: 'Primer set' };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const signed = (x) => (x > 0 ? `+${x}` : String(x));
const abbr = (t) => t?.abbr || t?.name || '';
// Fecha de Bogotá del partido: el detalle de tenis la usa para encontrarlo (las demás ligas la ignoran).
const day = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).replaceAll('-', '');

export default {
  title: 'Comparador de cuotas',
  render(el, { api, store, ui }) {
    const { h, raw } = ui;
    const state = { league: LEAGUES[0].id, market: null, q: '', games: [], accuracy: null };
    let picks = []; // índice → pick para los botones de cuota
    let alive = true, token = 0;

    el.innerHTML = h`<header class="view-head"><div><h1>Comparador de cuotas</h1>
        <p class="hint">Cuotas propias del modelo Oddsy para los próximos 3 días: probabilidad, cuota justa (sin margen) y cuota Oddsy (con 5% de margen). Toca una cuota Oddsy para agregarla a Mis picks.</p></div></header>
      <nav class="chips" data-leagues aria-label="Liga">${LEAGUES.map((l, i) => h`<button type="button" data-league="${l.id}" aria-pressed="${i === 0}">${l.title}</button>`)}</nav>
      <div class="toolbar">
        <label>Mercado <select data-market></select></label>
        <label>Buscar <input type="search" data-q placeholder="Equipo"></label>
        <button type="button" class="btn btn-primary" data-refresh>Actualizar</button>
        <span class="status" data-status role="status"></span>
      </div>
      <div class="odds-list" data-list></div>
      <p class="hint" data-acc></p>`;
    const $ = (s) => el.querySelector(s);

    async function load(fresh = false) {
      const my = ++token;
      $('[data-status]').textContent = 'Cargando cuotas…';
      $('[data-list]').innerHTML = ui.loading(3);
      $('[data-acc]').textContent = '';
      const now = new Date();
      const dates = [0, 1, 2].map((i) => ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)));
      try {
        const opt = { fresh };
        const res = await Promise.all(dates.flatMap((date) => [
          api.get('/api/games', { league: state.league, date }, opt),
          api.get('/api/markets', { league: state.league, date }, opt),
        ]));
        if (!alive || my !== token) return;
        const byId = new Map(res.filter((_, i) => i % 2).flatMap((r) => r.data ?? []).map((x) => [String(x.gameId), x.markets]));
        state.accuracy = res[1].accuracy;
        state.games = res.filter((_, i) => !(i % 2)).flatMap((r) => r.data ?? [])
          .filter((g) => g.status?.state !== 'post' && byId.has(String(g.id)))
          .map((g) => ({ g, markets: byId.get(String(g.id)) }))
          .sort((a, b) => Date.parse(a.g.start) - Date.parse(b.g.start));
        // Selector: los mercados presentes en esta liga (se conserva el elegido si existe).
        const keys = [...new Set(state.games.flatMap((x) => x.markets.map((m) => m.key)))];
        if (!keys.includes(state.market)) state.market = keys[0] ?? null;
        $('[data-market]').innerHTML = h`${keys.map((k) => h`<option value="${k}"${raw(k === state.market ? ' selected' : '')}>${KEYS[k] ?? k}</option>`)}`;
        draw();
      } catch (err) {
        if (!alive || my !== token) return;
        $('[data-status]').textContent = '';
        $('[data-list]').innerHTML = ui.errorBox(err);
      }
    }

    function draw() {
      const acc = state.accuracy;
      $('[data-acc]').textContent = acc?.brier != null
        ? `Precisión del modelo: Brier ${acc.brier.toFixed(3)} en ${acc.n} partidos (referencia ${acc.baseline?.brier?.toFixed(3) ?? '—'})`
        : 'Precisión del modelo: sin backtest para esta liga.';
      if (acc?.publish === false) {
        $('[data-status]').innerHTML = ui.sourceBadge('oddsy');
        $('[data-list]').innerHTML = ui.empty('Cuotas no publicadas: el modelo aún no supera la referencia');
        return;
      }
      const q = state.q.trim().toLowerCase();
      const shown = state.games.filter(({ g }) => !q || [g.home.name, g.away.name, g.home.abbr, g.away.abbr].some((t) => String(t ?? '').toLowerCase().includes(q)));
      $('[data-status]').innerHTML = h`${ui.sourceBadge('oddsy')} ${shown.length} ${shown.length === 1 ? 'partido' : 'partidos'}`;
      picks = [];
      const inSlip = new Set(store.get('picks').map((p) => p.id));
      const name = (g, s) => (s.name === 'Local' ? abbr(g.home) : s.name === 'Visitante' ? abbr(g.away) : s.name);
      const table = (g, m) => h`<div class="scroll"><table class="odds-table">
          <caption class="sr-only">${m.label}: ${g.away.name} en ${g.home.name}</caption>
          <thead><tr><th scope="col">${m.label}</th>${m.selections.map((s) => h`<th scope="col">${name(g, s)}${s.line != null ? ` ${m.key.startsWith('ou') ? s.line : signed(s.line)}` : ''}</th>`)}</tr></thead>
          <tbody>
            <tr><th scope="row">Prob.</th>${m.selections.map((s) => h`<td>${ui.fmtPct(s.p)}</td>`)}</tr>
            <tr><th scope="row">Justa</th>${m.selections.map((s) => h`<td>${ui.fmtOdds(s.fair)}</td>`)}</tr>
            <tr><th scope="row">Oddsy</th>${m.selections.map((s) => {
              const n = `${name(g, s)}${s.line != null ? ` ${m.key.startsWith('ou') ? s.line : signed(s.line)}` : ''}`;
              // Mismo id que en Partidos: el pick se reconoce en ambas vistas.
              const pick = { id: `oddsy:${state.league}:${g.id}:${m.key}:${m.label}:${s.name}`, label: `${n} (${m.label}) · ${abbr(g.away)} @ ${abbr(g.home)}`, price: s.oddsy, book: 'oddsy', league: state.league, gameId: g.id };
              picks.push(pick);
              return h`<td><button type="button" class="odds-btn" data-pick="${picks.length - 1}" aria-pressed="${String(inSlip.has(pick.id))}" aria-label="${n} a ${ui.fmtOdds(s.oddsy)} (Oddsy)">${ui.fmtOdds(s.oddsy)}</button></td>`;
            })}</tr>
          </tbody></table></div>`;
      $('[data-list]').innerHTML = shown.length
        ? h`${shown.map(({ g, markets }) => h`<article class="card odds-card">
            <div class="odds-meta"><span class="odds-league">${LEAGUES.find((l) => l.id === state.league)?.title}</span><time datetime="${g.start}">${ui.when(g.start)}</time></div>
            <h2 class="odds-match"><a href="#/${state.league}/games/${encodeURIComponent(g.id)}?date=${day(g.start)}">${g.away.name} <small>@</small> ${g.home.name}</a></h2>
            ${markets.filter((m) => m.key === state.market).map((m) => table(g, m))}
          </article>`)}`
        : ui.empty(state.games.length ? 'Ningún partido coincide con la búsqueda.' : 'No hay partidos con cuotas del modelo en los próximos 3 días en esta liga.');
    }

    el.addEventListener('click', (e) => {
      const lb = e.target.closest('[data-league]');
      if (lb) {
        state.league = lb.dataset.league;
        for (const b of $('[data-leagues]').children) b.setAttribute('aria-pressed', String(b === lb));
        load();
        return;
      }
      if (e.target.closest('[data-refresh]')) return load(true);
      const btn = e.target.closest('[data-pick]');
      const pick = btn && picks[btn.dataset.pick];
      if (!pick) return;
      if (store.hasPick(pick.id)) store.removePick(pick.id);
      else store.addPick(pick);
    });
    $('[data-market]').addEventListener('change', (e) => { state.market = e.target.value; draw(); });
    $('[data-q]').addEventListener('input', (e) => { state.q = e.target.value; draw(); });

    // El boleto puede cambiar desde el panel: se refleja en los botones sin redibujar.
    const off = store.on('picks', (list) => {
      const ids = new Set(list.map((p) => p.id));
      for (const b of el.querySelectorAll('[data-pick]')) b.setAttribute('aria-pressed', String(ids.has(picks[b.dataset.pick]?.id)));
    });

    load();
    return () => { alive = false; off(); };
  },
};
