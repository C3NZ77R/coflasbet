// Comparador: cuotas de The Odds API por casa para un mercado (ganador, hándicap o totales), agrupadas por línea.
import { analyzeEvent } from '../betmath.js';
import { LEAGUES } from '../leagues.js';

const MARKETS = { h2h: 'Ganador', spreads: 'Hándicap', totals: 'Totales' };
const label = (name) => name.replace(/^Draw$/, 'Empate').replace(/^Over /, 'Más de ').replace(/^Under /, 'Menos de ');
const leagueOf = (sportKey) => LEAGUES.find((l) => l.odds === sportKey)?.id ?? null;

export default {
  title: 'Comparador de cuotas',
  render(el, { api, store, ui }) {
    const { h, raw } = ui;
    const state = { sport: 'upcoming', market: 'h2h', q: '', rows: [], body: null };
    let picks = []; // índice → pick para los botones de cuota
    let alive = true, token = 0;

    el.innerHTML = h`<header class="view-head"><div><h1>Comparador de cuotas</h1>
        <p class="hint">Cuotas del mercado elegido por casa, agrupadas por línea (solo se comparan cuotas de la misma línea). La mejor de cada resultado va resaltada; toca una cuota para agregarla a Mis picks.</p></div></header>
      <nav class="chips" data-sports aria-label="Deporte"><button type="button" data-sport="upcoming" aria-pressed="true">Todos</button></nav>
      <div class="toolbar">
        <label>Mercado <select data-market>${Object.entries(MARKETS).map(([k, v]) => h`<option value="${k}">${v}</option>`)}</select></label>
        <label>Buscar <input type="search" data-q placeholder="Equipo o liga"></label>
        <button type="button" class="btn btn-primary" data-refresh>Actualizar</button>
        <span class="status" data-status role="status"></span>
      </div>
      <div class="odds-list" data-list></div>`;
    const $ = (s) => el.querySelector(s);

    api.sports().then((body) => {
      if (!alive) return;
      $('[data-sports]').insertAdjacentHTML('beforeend', h`${(body.data ?? []).map((s) => h`<button type="button" data-sport="${s.key}" aria-pressed="false">${s.title}</button>`)}`);
    }).catch(() => { /* sin lista de deportes: queda "Todos" */ });

    async function load(fresh = false) {
      const my = ++token;
      $('[data-status]').textContent = 'Cargando cuotas…';
      $('[data-list]').innerHTML = ui.loading(3);
      try {
        const body = await api.get('/api/odds', { sport: state.sport }, { fresh });
        if (!alive || my !== token) return;
        state.body = body;
        state.rows = (body.data ?? []).flatMap((event) => analyzeEvent(event, { market: state.market }).map((a) => ({ event, a })));
        draw();
      } catch (err) {
        if (!alive || my !== token) return;
        $('[data-status]').textContent = '';
        $('[data-list]').innerHTML = ui.errorBox(err);
      }
    }

    function draw() {
      const q = state.q.trim().toLowerCase();
      const shown = state.rows
        .filter(({ event: e }) => !q || [e.home_team, e.away_team, e.sport_title].some((t) => String(t).toLowerCase().includes(q)))
        .sort((x, y) => new Date(x.event.commence_time) - new Date(y.event.commence_time));
      const events = new Set(shown.map((r) => r.event.id)).size;
      $('[data-status]').innerHTML = h`${ui.sourceBadge(state.body)} ${events} ${events === 1 ? 'evento' : 'eventos'}`;
      picks = [];
      const inSlip = new Set(store.get('picks').map((p) => p.id));
      $('[data-list]').innerHTML = shown.length
        ? h`${shown.map(({ event: e, a }) => h`<article class="card odds-card">
            <div class="odds-meta"><span class="odds-league">${e.sport_title}</span><time datetime="${e.commence_time}">${ui.when(e.commence_time)}</time></div>
            <h2 class="odds-match">${e.away_team} <small>@</small> ${e.home_team}${a.line != null ? h` <span class="odds-line">${MARKETS[state.market]} ${a.line}</span>` : ''}</h2>
            <div class="scroll"><table class="odds-table">
              <caption class="sr-only">${MARKETS[state.market]}: ${e.away_team} en ${e.home_team}</caption>
              <thead><tr><th scope="col">Casa</th>${a.names.map((n) => h`<th scope="col">${label(n)}</th>`)}</tr></thead>
              <tbody>${a.books.map((b) => h`<tr><th scope="row">${ui.bookChip(b.key || b.title)}</th>${a.names.map((n) => {
                const price = b.outcomes[n];
                if (!price) return h`<td class="odds-na">—</td>`;
                const best = price === a.best[n].price;
                const pick = { id: `odds:${e.id}:${state.market}:${n}:${b.key}`, label: `${label(n)} (${MARKETS[state.market]}) · ${e.away_team} @ ${e.home_team}`, price, book: b.key || b.title, league: leagueOf(e.sport_key), gameId: e.id };
                picks.push(pick);
                return h`<td class="${best ? 'best' : ''}"><button type="button" class="odds-btn" data-pick="${picks.length - 1}" aria-pressed="${inSlip.has(pick.id)}" aria-label="${label(n)} a ${ui.fmtOdds(price)} en ${b.title}${best ? ' (mejor cuota)' : ''}">${ui.fmtOdds(price)}</button></td>`;
              })}</tr>`)}</tbody>
              ${a.fair ? h`<tfoot><tr class="fair"><th scope="row">Justa <small>(${a.fairSource})</small></th>${a.names.map((n) => h`<td>${ui.fmtOdds(1 / a.fair[n])} <small>${ui.fmtPct(a.fair[n], 1)}</small></td>`)}</tr></tfoot>` : raw('')}
            </table></div>
          </article>`)}`
        : ui.empty(state.rows.length ? 'Ningún evento coincide con la búsqueda.' : 'No hay cuotas de este mercado para este deporte.');
    }

    el.addEventListener('click', (e) => {
      const sp = e.target.closest('[data-sport]');
      if (sp) {
        state.sport = sp.dataset.sport;
        for (const b of $('[data-sports]').children) b.setAttribute('aria-pressed', String(b === sp));
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
    $('[data-market]').addEventListener('change', (e) => { state.market = e.target.value; load(); });
    $('[data-q]').addEventListener('input', (e) => { state.q = e.target.value; if (state.body) draw(); });

    // El boleto puede cambiar desde el panel: se refleja en los botones sin redibujar.
    const off = store.on('picks', (list) => {
      const ids = new Set(list.map((p) => p.id));
      for (const b of el.querySelectorAll('[data-pick]')) b.setAttribute('aria-pressed', String(ids.has(picks[b.dataset.pick]?.id)));
    });

    load();
    return () => { alive = false; off(); };
  },
};
