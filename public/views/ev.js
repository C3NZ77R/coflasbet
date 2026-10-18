// EV+ (/pro/ev) · "Compara tu casa": el usuario escribe la cuota de SU casa en cada selección y se compara con la
// probabilidad del modelo Coflas: EV = p · cuota − 1, Kelly con multiplicador y etiqueta EV+ si EV > 0.
// Fuentes: mercados de partido de /api/markets (+ /api/games para nombres y hora) y props de jugador de /api/props.
// Los helpers exportados (selectionsOf, parseOdds, kellyOptions, …) los usa también boosts.js (mismo dueño).
import { LEAGUES, leagueById } from '../leagues.js';
import { STATS, statForMarket } from '../stats.js';
import { americanToDecimal, expectedValue, kelly } from '../betmath.js';
import { h, raw, fmtOdds, fmtPct, fmtMoney, when, empty, loading, sourceBadge } from '../ui.js';

// ======================= compartido con boosts.js =======================

export function kellyOptions(cur) {
  const base = [[1, 'Completo'], [0.5, 'Medio (½)'], [0.25, 'Cuarto (¼)'], [0.125, 'Octavo (⅛)']];
  const c = Number(cur);
  return !(c > 0 && c <= 1) || base.some(([v]) => v === c) ? base : [...base, [c, `×${c}`]].sort((a, b) => b[0] - a[0]);
}

export const optionsHtml = (list, cur) => list.map(([v, t]) => h`<option value="${v}"${String(v) === String(cur) ? raw(' selected') : ''}>${t}</option>`);

// Cuota escrita por el usuario: americana (+575, -110, 150) o decimal (6.75, "2,5"). Inválida → null.
export function parseOdds(input) {
  const s = String(input ?? '').trim().replace(/\s+/g, '').replace(',', '.').replace(/^−/, '-');
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const x = Number(s);
  if (/^[+-]/.test(s) || Math.abs(x) >= 100) return Math.abs(x) >= 100 ? americanToDecimal(x) : null;
  return x > 1 ? x : null;
}

export const dataOf = (body) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);
export const num = (v, d = null) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
export const pctSigned = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
export const started = (iso) => Number.isFinite(Date.parse(iso)) && Date.parse(iso) <= Date.now();

export function statLabel(sport, stat, market) {
  const d = STATS[sport]?.find((x) => x.key === stat) ?? statForMarket(sport, market);
  return d?.name ?? stat ?? String(market ?? '').replace(/^(player|batter|pitcher)_/, '').replace(/_/g, ' ');
}

// Mismo formato que props.js, para que el detalle y el boleto reconozcan el prop.
export const propKey = (p) => encodeURIComponent(JSON.stringify({ a: p.athleteId ?? null, p: p.player, s: p.stat, l: p.line ?? null, o: p.side, g: p.gameId ?? null }));

const signed = (x) => (x > 0 ? `+${x}` : String(x));

// Selecciones con probabilidad del modelo de una liga (partidos de hoy y props de los próximos partidos).
// Sel = { id, kind:'line'|'prop', league, gameId, matchup, start, title, label, p, fair, coflas, prop? }.
export async function selectionsOf(api, league) {
  const lg = leagueById(league);
  const [mk, gm, pr] = await Promise.allSettled([api.markets(league), api.games(league), api.props(league)]);
  const list = [], notes = [], srcs = [];
  const games = new Map(gm.status === 'fulfilled' ? dataOf(gm.value).filter((g) => g?.id != null).map((g) => [String(g.id), g]) : []);
  if (mk.status === 'rejected') notes.push(`Partidos: ${mk.reason?.message ?? 'no se pudieron cargar'}`);
  else if (mk.value?.accuracy?.publish === false) notes.push(`${lg?.title ?? league}: el modelo de partidos no supera la referencia en el backtest, así que no se ofrecen sus mercados.`);
  else {
    srcs.push(['Partidos', mk.value]);
    for (const { gameId, markets } of dataOf(mk.value)) {
      const g = games.get(String(gameId));
      if (g && started(g.start)) continue;
      const home = g?.home?.abbr || g?.home?.name || 'Local', away = g?.away?.abbr || g?.away?.name || 'Visitante';
      const matchup = g ? `${away} @ ${home}` : '';
      const who = (n) => String(n ?? '').replace(/\bLocal\b/, home).replace(/\bVisitante\b/, away);
      for (const m of markets ?? []) {
        for (const s of m.selections ?? []) {
          if (!(s.p > 0 && s.p < 1)) continue;
          // En spreads la línea va con el lado; en totales ya viene en la etiqueta del mercado.
          const name = m.key === 'spread' && Number.isFinite(s.line) ? `${who(s.name)} ${signed(s.line)}` : who(s.name);
          list.push({ id: `mk:${gameId}:${m.key}:${s.name}:${s.line ?? ''}`, kind: 'line', league, gameId: String(gameId), matchup, start: g?.start ?? '',
            title: m.label, label: `${name} · ${m.label}`, p: s.p, fair: s.fair, coflas: s.coflas });
        }
      }
    }
  }
  if (pr.status === 'rejected') notes.push(`Props: ${pr.reason?.message ?? 'no se pudieron cargar'}`);
  else {
    srcs.push(['Props', pr.value]);
    for (const p of dataOf(pr.value)) {
      if (!p || !(p.p > 0 && p.p < 1) || started(p.start)) continue;
      const stat = statLabel(lg?.sport, p.stat, p.market);
      list.push({ id: `pr:${p.id}`, kind: 'prop', league, gameId: p.gameId ?? null, matchup: [p.team, p.opp].filter(Boolean).join(' vs '), start: p.start ?? '',
        title: stat, label: `${p.player} ${p.side === 'Under' ? 'Menos de' : 'Más de'} ${p.line ?? ''} ${stat}`.replace(/\s+/g, ' ').trim(),
        p: p.p, fair: p.fair, coflas: p.books?.find((b) => b?.key === 'coflas')?.price ?? null, prop: p });
    }
  }
  return { list, notes, srcs };
}

// ======================= vista EV+ =======================

const TYPES = [['all', 'Partidos y props'], ['line', 'Partidos'], ['prop', 'Props de jugador']];
const ORDERS = [['start', 'Hora'], ['ev', 'EV (con tu cuota)']];
const MAX_ROWS = 200;

export default {
  title: 'EV+',
  render(el, ctx) {
    const { api, store } = ctx;
    const s0 = store.get('settings') ?? {};
    let alive = true;
    const f = { league: leagueById(ctx.league) ? ctx.league : 'nba', type: 'all', q: '', order: 'start', onlyEv: false,
      kellyMult: Number(s0.kellyMult) > 0 && Number(s0.kellyMult) <= 1 ? Number(s0.kellyMult) : 0.25 };
    let src = { state: 'loading', list: [], notes: [], srcs: [] }, qTimer = 0;
    const odds = new Map(); // id de la selección → texto escrito (se conserva al cambiar de liga mientras dure la vista)
    const bankroll = () => Number(store.get('settings')?.bankroll) || 0;

    el.innerHTML = h`<section class="ev">
      <div class="view-head">
        <div><h1>EV+ · Compara tu casa</h1><p class="hint">Escribe la cuota que te da tu casa y la comparamos con la probabilidad del modelo Coflas: EV = probabilidad × cuota − 1.</p></div>
        <p class="ev-count" role="status" aria-live="polite"></p>
      </div>
      <form class="toolbar ev-bar" aria-label="Filtros de EV+">
        <label>Liga <select data-f="league">${optionsHtml(LEAGUES.map((l) => [l.id, l.title]), f.league)}</select></label>
        <label>Tipo <select data-f="type">${optionsHtml(TYPES, f.type)}</select></label>
        <label>Buscar <input type="search" data-f="q" autocomplete="off" placeholder="Equipo, jugador o mercado"></label>
        <label>Orden <select data-f="order">${optionsHtml(ORDERS, f.order)}</select></label>
        <label>Kelly <select data-f="kellyMult">${optionsHtml(kellyOptions(f.kellyMult), f.kellyMult)}</select></label>
        <label class="ev-chk"><input type="checkbox" data-f="onlyEv"> Solo EV+</label>
      </form>
      <p class="hint">Cuotas americanas (+150, −110) o decimales (2.50). Justa = 1 / probabilidad; Coflas = la cuota justa con nuestro margen.</p>
      <div class="ev-sources"></div>
      <div class="ev-notes"></div>
      <div class="ev-results"></div>
    </section>`;
    const root = el.querySelector('.ev');
    const $ = (s) => root.querySelector(s);
    const results = $('.ev-results');
    $('.ev-bar').addEventListener('submit', (e) => e.preventDefault());

    async function load() {
      const id = f.league;
      src = { state: 'loading', list: [], notes: [], srcs: [] };
      paint();
      const r = await selectionsOf(api, id);
      if (!alive || f.league !== id) return;
      src = { state: 'ok', ...r };
      paint();
    }

    // EV y Kelly de una selección con la cuota del usuario (null si no hay cuota válida).
    function calc(s) {
      const price = parseOdds(odds.get(s.id));
      if (!price) return null;
      const ev = expectedValue(s.p, price);
      return { price, ev, kelly: kelly(s.p, price, f.kellyMult) };
    }

    const resHtml = (s) => {
      const t = odds.get(s.id), r = calc(s);
      if (!r) return t ? h`<span class="ev-bad">Cuota no válida</span>` : h`<span class="ev-dim">—</span>`;
      return h`<b class="ev-pct ${r.ev > 0 ? 'pos' : 'neg'}">${pctSigned(r.ev)}</b>${r.ev > 0 ? h` <span class="ev-tag">EV+</span>` : ''}
        <small>Kelly ${fmtPct(r.kelly, 2)} · ${fmtMoney(r.kelly * bankroll())}</small>`;
    };

    const picked = (s) => (store.get('picks') ?? []).some((p) => p.id === pickId(s));
    const pickId = (s) => (s.kind === 'prop' ? propKey(s.prop) : s.id);
    const addHtml = (s) => {
      const ok = !!calc(s);
      return h`<button type="button" class="btn ev-btn ev-add" data-add="${s.id}" aria-pressed="${String(picked(s))}"${ok || picked(s) ? '' : raw(' disabled title="Escribe primero la cuota de tu casa"')} aria-label="Agregar al boleto: ${s.label}">${picked(s) ? '✓ En boleto' : '+ Boleto'}</button>`;
    };
    function togglePick(s) {
      if (picked(s)) return store.removePick(pickId(s));
      const r = calc(s);
      if (!r) return;
      store.addPick({ id: pickId(s), label: s.matchup ? `${s.label} (${s.matchup})` : s.label, price: r.price, book: null, league: s.league, gameId: s.gameId });
      if (s.kind === 'prop') store.track(pickId(s), 'add');
    }

    function rows() {
      const tokens = f.q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
      const hay = (s) => `${s.label} ${s.matchup}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      let list = src.list.filter((s) => (f.type === 'all' || s.kind === f.type) && tokens.every((t) => hay(s).includes(t)));
      if (f.onlyEv) list = list.filter((s) => calc(s)?.ev > 0);
      const t = (s) => Date.parse(s.start) || Infinity;
      return f.order === 'ev' ? [...list].sort((a, b) => (calc(b)?.ev ?? -Infinity) - (calc(a)?.ev ?? -Infinity) || t(a) - t(b)) : [...list].sort((a, b) => t(a) - t(b));
    }

    function paintCount() {
      const filled = src.list.map(calc).filter(Boolean);
      $('.ev-count').innerHTML = src.state === 'loading' ? 'Cargando…' : h`<b>${filled.filter((r) => r.ev > 0).length}</b> EV+ de ${filled.length} con tu cuota · ${src.list.length} selecciones`;
    }

    function paint() {
      if (!alive) return;
      paintCount();
      $('.ev-sources').innerHTML = h`${src.srcs.map(([k, b]) => h`<span class="ev-src">${k} ${sourceBadge(b)}</span>`)}`;
      $('.ev-notes').innerHTML = h`${src.notes.map((n) => h`<p class="ev-note">${n}</p>`)}`;
      if (src.state === 'loading') { results.innerHTML = loading(6); return; }
      const list = rows();
      if (!list.length) {
        results.innerHTML = src.list.length ? empty(f.onlyEv ? 'Ninguna selección con tu cuota tiene EV+ todavía.' : 'Ninguna selección coincide con la búsqueda.')
          : empty('No hay partidos ni props próximos con probabilidad del modelo para esta liga hoy.');
        return;
      }
      // Se repinta sin perder el foco ni el cursor del input que se estaba editando.
      const a = results.contains(document.activeElement) ? document.activeElement : null;
      const focus = a && (a.dataset.odds ?? a.dataset.add), caret = a?.dataset.odds != null ? a.selectionStart : null;
      results.innerHTML = h`<div class="table-wrap"><table class="tbl ev-tbl"><caption class="sr-only">Selecciones del modelo Coflas con la cuota de tu casa</caption>
        <thead><tr><th scope="col">Selección</th><th scope="col">Prob.</th><th scope="col">Justa</th><th scope="col">Coflas</th><th scope="col">Cuota de tu casa</th><th scope="col">EV · Kelly</th><th scope="col"><span class="sr-only">Boleto</span></th></tr></thead>
        <tbody>${list.slice(0, MAX_ROWS).map((s) => h`<tr data-row="${s.id}">
          <td class="ev-c-pick"><div class="ev-pick"><span class="ev-lbl">${s.label}</span><small>${[s.matchup, when(s.start)].filter(Boolean).join(' · ')}</small></div></td>
          <td data-l="Prob.">${fmtPct(s.p, 1)}</td><td data-l="Justa">${fmtOdds(s.fair)}</td><td data-l="Coflas">${fmtOdds(s.coflas)}</td>
          <td class="ev-c-in"><input class="ev-in" data-odds="${s.id}" value="${odds.get(s.id) ?? ''}" maxlength="10" inputmode="decimal" autocomplete="off" placeholder="−110 o 1.91" aria-label="Cuota de tu casa: ${s.label}"${odds.get(s.id) && !calc(s) ? raw(' aria-invalid="true"') : ''}></td>
          <td class="ev-c-res" aria-live="polite">${resHtml(s)}</td>
          <td>${addHtml(s)}</td></tr>`)}</tbody></table></div>
        ${list.length > MAX_ROWS ? h`<p class="hint">Se muestran ${MAX_ROWS} de ${list.length}: usa la búsqueda para encontrar el resto.</p>` : ''}`;
      if (focus) {
        const el2 = results.querySelector(`[data-odds="${CSS.escape(focus)}"]`) ?? results.querySelector(`[data-add="${CSS.escape(focus)}"]`);
        el2?.focus();
        if (caret != null && el2?.setSelectionRange) el2.setSelectionRange(caret, caret);
      }
    }

    // Al escribir solo se actualiza la fila; el orden por EV y "Solo EV+" se aplican al salir del campo.
    function paintRow(id) {
      const s = src.list.find((x) => x.id === id), tr = results.querySelector(`[data-row="${CSS.escape(id)}"]`);
      if (!s || !tr) return;
      tr.querySelector('.ev-c-res').innerHTML = resHtml(s);
      tr.querySelector('[data-odds]').toggleAttribute('aria-invalid', !!odds.get(id) && !calc(s));
      tr.querySelector('[data-add]').outerHTML = String(addHtml(s));
      paintCount();
    }

    root.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.odds != null) { odds.set(t.dataset.odds, t.value.trim()); paintRow(t.dataset.odds); return; }
      if (t.dataset.f === 'q') { f.q = t.value; clearTimeout(qTimer); qTimer = setTimeout(() => alive && paint(), 150); }
    });
    root.addEventListener('change', (e) => {
      const t = e.target, k = t.dataset.f;
      if (t.dataset.odds != null) { if (f.order === 'ev' || f.onlyEv) paint(); return; }
      if (!k || k === 'q') return;
      f[k] = k === 'kellyMult' ? Number(t.value) : k === 'onlyEv' ? t.checked : t.value;
      if (k === 'league') load(); else paint();
    });
    results.addEventListener('click', (e) => {
      const b = e.target.closest('[data-add]');
      const s = b && src.list.find((x) => x.id === b.dataset.add);
      if (!s) return;
      togglePick(s); // store.on('picks') repinta la fila: se devuelve el foco al botón nuevo
      results.querySelector(`[data-add="${CSS.escape(s.id)}"]`)?.focus();
    });

    const offPicks = store.on('picks', () => { if (alive) for (const tr of results.querySelectorAll('[data-row]')) paintRow(tr.dataset.row); });
    load();
    return () => {
      alive = false;
      clearTimeout(qTimer);
      offPicks();
    };
  },
};
