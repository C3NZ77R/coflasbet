// EV+ (/pro/ev): apuestas con valor esperado positivo frente a una probabilidad justa sin vig.
// La probabilidad justa sale del devig de las casas elegidas (obligatorias / opcionales con peso, o el consenso de
// todas). Fuentes: líneas de partido de /api/odds (The Odds API) y props de jugador de /api/props. Sin clave de
// The Odds API el servidor devuelve datos de demostración y la vista lo dice.
// Los helpers exportados (marketsOf, fullRows, METHODS, parseOdds, …) los usa también boosts.js (mismo dueño).
import { LEAGUES, leagueById } from '../leagues.js';
import { STATS, statForMarket } from '../stats.js';
import { analyzeEvent, analyzeProps, americanToDecimal, vig as vigOf } from '../betmath.js';
import { h, raw, fmtOdds, fmtPct, fmtMoney, when, bookChip, bookInfo, BOOKS, empty, loading, sourceBadge, dropdown, sortableTable, modal } from '../ui.js';

// ======================= compartido con boosts.js =======================

export const METHODS = {
  multiplicative: ['Multiplicativo', 'Divide la probabilidad implícita de cada lado entre la suma de todas: el margen se reparte en proporción a cada probabilidad. Es el método estándar.'],
  additive: ['Aditivo', 'Resta la misma cantidad de margen a cada lado. Castiga más al no favorito (su probabilidad baja proporcionalmente más), así que tiende a favorecer al favorito.'],
  shin: ['Shin', 'Modelo de Shin (1993): supone que parte del dinero viene de apostadores con información privilegiada y que la casa se protege cargando más margen al no favorito. Corrige el sesgo favorito–no favorito; útil con cuotas muy desiguales.'],
  power: ['Power', 'Eleva cada probabilidad implícita a un mismo exponente k hasta que sumen 100 %. También asigna más margen al no favorito que el multiplicativo.'],
  probit: ['Probit', 'Pasa cada probabilidad a la escala normal (z), desplaza todos los lados la misma distancia y vuelve a probabilidades hasta que sumen 100 %.'],
  worst: ['Peor caso', 'Calcula todos los métodos anteriores y, para cada lado, usa la probabilidad más baja. Es la estimación más conservadora: si una apuesta tiene EV+ aquí, lo tiene con cualquier método.'],
};

export function kellyOptions(cur) {
  const base = [[1, 'Completo'], [0.5, 'Medio (½)'], [0.25, 'Cuarto (¼)'], [0.125, 'Octavo (⅛)']];
  const c = Number(cur);
  return !(c > 0 && c <= 1) || base.some(([v]) => v === c) ? base : [...base, [c, `×${c}`]].sort((a, b) => b[0] - a[0]);
}

export const optionsHtml = (list, cur) => list.map(([v, t]) => h`<option value="${v}"${String(v) === String(cur) ? raw(' selected') : ''}>${t}</option>`);

export function showMethodsInfo(onClose) {
  const item = ([n, t]) => h`<div><dt>${n}</dt><dd>${t}</dd></div>`;
  modal({
    title: 'Cómo se calcula la probabilidad justa',
    className: 'ev-info',
    onClose,
    body: h`<p>Las casas cobran un margen (vig): sus probabilidades implícitas suman más de 100 %. El <b>devig</b> quita ese margen para estimar la probabilidad real de cada lado. Con varias casas se promedia el devig de cada una según su peso.</p>
      <dl class="ev-info-list">${Object.values(METHODS).map(item)}</dl>
      <h3>Columnas</h3>
      <dl class="ev-info-list">${[
        ['EV %', 'Ganancia esperada por cada $1 apostado: probabilidad justa × cuota − 1.'],
        ['FV', 'Cuota justa (valor justo) = 1 / probabilidad justa. El vig es el margen promedio de las casas usadas en el devig.'],
        ['Kelly %', 'Fracción del bankroll que sugiere el criterio de Kelly, ya multiplicada por el multiplicador elegido.'],
        ['Ancho', 'Suma de los centavos americanos de los dos lados respecto a la par (−110/−110 = 20). Un mercado ancho es menos fiable.'],
        ['Variación', 'Diferencia máxima entre la probabilidad justa que da cada casa usada. Si las casas no coinciden, el EV es menos fiable.'],
      ].map(item)}</dl>`,
  });
}

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

const MARKET = { h2h: 'Ganador', spreads: 'Hándicap', totals: 'Total' };
const SIDES = { Over: 'Más de', Under: 'Menos de', Draw: 'Empate', Yes: 'Sí', No: 'No' };
export const sideText = (name) => String(name ?? '').replace(/^(Over|Under|Draw|Yes|No)\b/, (w) => SIDES[w]);

export function statLabel(sport, stat, market) {
  const d = STATS[sport]?.find((x) => x.key === stat) ?? statForMarket(sport, market);
  return d?.name ?? stat ?? String(market ?? '').replace(/^(player|batter|pitcher)_/, '').replace(/_/g, ' ');
}

// Mismo formato que props.js, para que el detalle y el boleto reconozcan el prop.
export const propKey = (p) => encodeURIComponent(JSON.stringify({ a: p.athleteId ?? null, p: p.player, s: p.stat, l: p.line ?? null, o: p.side, g: p.gameId ?? null }));

// Normaliza los datos de una liga a mercados analizados.
// kind 'lines': eventos de The Odds API v4; kind 'props': Prop[] de /api/props. opts va a analyzeEvent/analyzeProps.
// Mercado = { id, kind, league, event (id para detectar el mismo partido), gameId (ESPN), matchup, start, title, label(lado), a }.
export function marketsOf(leagueId, kind, items, opts = {}) {
  const out = [];
  if (kind === 'lines') {
    for (const ev of items ?? []) {
      if (!ev || !Array.isArray(ev.bookmakers)) continue;
      for (const market of Object.keys(MARKET)) {
        let res = [];
        try { res = analyzeEvent(ev, { market, ...opts }); } catch { /* evento mal formado: se omite */ }
        for (const a of res) {
          out.push({
            id: `ln:${ev.id}:${market}:${a.line ?? ''}`, kind, league: leagueId, event: String(ev.id), gameId: null,
            matchup: `${ev.away_team} @ ${ev.home_team}`, start: ev.commence_time, title: MARKET[market],
            label: (n) => `${sideText(n)} · ${MARKET[market]}`, a,
          });
        }
      }
    }
    return out;
  }
  const sport = leagueById(leagueId)?.sport;
  let res = [];
  try { res = analyzeProps((items ?? []).filter((p) => p && Array.isArray(p.books)), opts); } catch { /* props mal formados */ }
  for (const a of res) {
    const stat = statLabel(sport, a.stat, a.market);
    out.push({
      id: `pr:${a.key}`, kind, league: leagueId, event: a.eventId ?? a.gameId ?? null, gameId: a.gameId ?? null,
      matchup: [a.team, a.opp].filter(Boolean).join(' vs '), start: a.start, title: stat,
      label: (n) => `${a.player} ${sideText(n)} ${a.line ?? ''} ${stat}`.replace(/\s+/g, ' ').trim(), a,
    });
  }
  return out;
}

// Casas con cuota en todos los lados del mercado (las únicas a las que se les puede quitar el vig).
export const fullRows = (m) => m.a.books.filter((b) => m.a.names.every((n) => b.outcomes[n] > 1)).map((b) => ({ key: b.key, prices: m.a.names.map((n) => b.outcomes[n]) }));

export const started = (iso) => Number.isFinite(Date.parse(iso)) && Date.parse(iso) <= Date.now();

// ======================= vista EV+ =======================

const KIND = { lines: 'líneas', props: 'props' };
const WINDOWS = [['all', 'Cualquier fecha'], ['6', 'Próximas 6 h'], ['24', 'Próximas 24 h'], ['48', 'Próximas 48 h']];
const TYPES = [['all', 'Props y líneas'], ['props', 'Props de jugador'], ['lines', 'Líneas de partido']];
const NUMS = ['minBooks', 'minEv', 'minKelly', 'maxVig', 'maxWidth', 'maxVariation', 'minAm', 'maxAm'];
const LISTS = ['leagues', 'required', 'optional', 'betBooks'];
const PRESETS = [
  { name: 'Props NBA', set: { leagues: ['nba'], type: 'props' } },
  { name: 'Props NFL', set: { leagues: ['nfl'], type: 'props' } },
  { name: 'Props MLB', set: { leagues: ['mlb'], type: 'props' } },
  { name: 'Pinnacle', set: { required: ['pinnacle'], optional: [], weights: {}, minBooks: '1' } },
  { name: 'Consenso', set: { required: [], optional: [], weights: {}, minBooks: '2' } },
  { name: 'Líneas sharp', set: { type: 'lines', required: [], optional: ['pinnacle', 'lowvig', 'betonlineag'], weights: { pinnacle: '100', lowvig: '25', betonlineag: '25' }, minBooks: '1' } },
];
const MAX_PRESETS = 20;

const pctSigned = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const amToDec = (v, d) => {
  const a = num(v);
  return a != null && Math.abs(a) >= 100 ? americanToDecimal(a) : d;
};
const badAm = (v) => v !== '' && v != null && !(Math.abs(num(v, 0)) >= 100);

function defaults(ctx) {
  const s = ctx.store.get('settings') ?? {};
  return {
    leagues: leagueById(ctx.league) ? [ctx.league] : ['nba'], type: 'all', window: 'all',
    method: METHODS[s.devigMethod] ? s.devigMethod : 'multiplicative', kellyMult: Number(s.kellyMult) > 0 ? Number(s.kellyMult) : 0.25,
    required: [], optional: [], weights: {}, minBooks: '2',
    minEv: '1', minKelly: '', maxVig: '', maxWidth: '', maxVariation: '', minAm: '', maxAm: '',
    betBooks: Array.isArray(s.books) ? [...s.books] : [],
  };
}

// Filtros guardados (localStorage): se valida cada campo antes de usarlo.
function clean(x, base) {
  const f = { ...base, weights: { ...base.weights } };
  if (!x || typeof x !== 'object') return f;
  for (const k of LISTS) if (Array.isArray(x[k])) f[k] = x[k].filter((v) => typeof v === 'string' && v.length < 60).slice(0, 60);
  f.leagues = f.leagues.filter((id) => leagueById(id));
  if (TYPES.some(([v]) => v === x.type)) f.type = x.type;
  if (WINDOWS.some(([v]) => v === String(x.window))) f.window = String(x.window);
  if (METHODS[x.method]) f.method = x.method;
  if (Number(x.kellyMult) > 0 && Number(x.kellyMult) <= 1) f.kellyMult = Number(x.kellyMult);
  for (const k of NUMS) if (x[k] === '' || (x[k] != null && Number.isFinite(Number(x[k])))) f[k] = String(x[k]);
  if (x.weights && typeof x.weights === 'object') {
    f.weights = Object.fromEntries(Object.entries(x.weights).filter(([k, w]) => k.length < 60 && (w === '' || Number(w) >= 0)).slice(0, 60).map(([k, w]) => [k, String(w)]));
  }
  return f;
}

// Firma comparable de un valor de filtro (listas sin orden; pesos vacíos o 1 = sin peso).
const sigOf = (k, v) => {
  if (Array.isArray(v)) return JSON.stringify([...v].sort());
  if (k === 'weights') return JSON.stringify(Object.entries(v ?? {}).filter(([, w]) => w !== '' && Number(w) !== 1).map(([a, w]) => [a, Number(w)]).sort());
  return String(v);
};
const matches = (f, set) => Object.keys(set).every((k) => sigOf(k, f[k]) === sigOf(k, set[k]));

export default {
  title: 'EV+',
  render(el, ctx) {
    const { api, store } = ctx;
    let alive = true;
    let f = defaults(ctx);
    const data = new Map(); // `${kind}:${league}` → { state: 'loading'|'ok'|'error', body, items, error }
    let ver = 0, memo = { sig: '', markets: [] }, rowById = new Map(), timer = 0, booksSig = '';

    el.innerHTML = h`<section class="ev">
      <div class="view-head">
        <div><h1>EV+</h1><p class="hint">Apuestas con valor esperado positivo frente a la probabilidad justa (sin vig) de las casas que elijas.</p></div>
        <p class="ev-count" role="status" aria-live="polite"></p>
      </div>
      <div class="ev-presets" role="group" aria-label="Preajustes de filtros"></div>
      <form class="ev-filters" aria-label="Filtros de EV+"></form>
      <div class="ev-sources"></div>
      <div class="ev-notes"></div>
      <div class="ev-results"></div>
    </section>`;
    const root = el.querySelector('.ev');
    const $ = (s) => root.querySelector(s);
    const form = $('.ev-filters'), presetsEl = $('.ev-presets'), results = $('.ev-results');
    form.addEventListener('submit', (e) => e.preventDefault());

    // ---------- carga de datos ----------
    const kindsFor = (lg) => [f.type !== 'props' && lg.odds ? 'lines' : null, f.type !== 'lines' ? 'props' : null].filter(Boolean);
    function ensure() {
      for (const id of f.leagues) {
        const lg = leagueById(id);
        if (!lg) continue;
        for (const kind of kindsFor(lg)) {
          const k = `${kind}:${id}`;
          if (data.has(k)) continue;
          data.set(k, { state: 'loading' });
          (kind === 'lines' ? api.odds(lg.odds) : api.props(id))
            .then((body) => data.set(k, { state: 'ok', body, items: dataOf(body) }), (error) => data.set(k, { state: 'error', error }))
            .finally(() => { ver++; if (alive) update(); });
        }
      }
    }

    // ---------- cálculo ----------
    const analysisOpts = () => ({
      method: f.method,
      kellyMult: f.kellyMult,
      minEv: -Infinity, // los filtros se aplican aquí para poder mostrar N/M
      minBooks: Math.max(1, Math.round(num(f.minBooks, 1))),
      sharp: {
        required: f.required,
        optional: f.optional,
        weights: Object.fromEntries(Object.entries(f.weights).filter(([, w]) => num(w) != null && num(w) >= 0).map(([k, w]) => [k, Number(w)])),
      },
    });
    function markets() {
      const opts = analysisOpts();
      const sig = JSON.stringify([ver, opts.method, opts.kellyMult, opts.minBooks, opts.sharp]);
      if (sig !== memo.sig) {
        const list = [];
        for (const [k, d] of data) {
          if (d.state !== 'ok') continue;
          const [kind, league] = k.split(':');
          list.push(...marketsOf(league, kind, d.items, opts));
        }
        memo = { sig, markets: list };
      }
      return memo.markets;
    }

    function computeRows() {
      const now = Date.now();
      const lim = {
        minEv: num(f.minEv, -Infinity) / 100, minKelly: num(f.minKelly, -Infinity) / 100, maxVig: num(f.maxVig, Infinity) / 100,
        maxWidth: num(f.maxWidth, Infinity), maxVar: num(f.maxVariation, Infinity) / 100,
        minOdds: amToDec(f.minAm, 1), maxOdds: amToDec(f.maxAm, Infinity),
        until: f.window === 'all' ? Infinity : now + Number(f.window) * 3600e3, books: new Set(f.betBooks),
      };
      const leagues = new Set(f.leagues);
      const all = [];
      for (const m of markets()) {
        if (!leagues.has(m.league) || (f.type !== 'all' && f.type !== m.kind) || started(m.start)) continue;
        for (const b of m.a.evBets) {
          all.push({
            rid: `${m.id}|${b.outcome}|${b.bookKey}`, m, outcome: b.outcome, label: m.label(b.outcome),
            pickId: m.kind === 'props' ? propKey({ ...m.a, side: b.outcome }) : `${m.id}:${b.outcome}`,
            bookKey: b.bookKey, book: b.book, price: b.price, prob: b.prob, fairOdds: b.fairOdds, ev: b.ev, kelly: b.kelly,
            width: b.width, variation: b.variation, vig: b.vig, start: m.start,
          });
        }
      }
      const rows = all.filter((r) => r.ev >= lim.minEv && r.kelly >= lim.minKelly && !(r.vig > lim.maxVig) && !(r.width > lim.maxWidth) &&
        !(r.variation > lim.maxVar) && r.price >= lim.minOdds && r.price <= lim.maxOdds &&
        (!lim.books.size || lim.books.has(bookInfo(r.bookKey || r.book).key)) && !(Date.parse(r.start) > lim.until));
      return { all, rows };
    }

    // ---------- boleto ----------
    const picked = (r) => (store.get('picks') ?? []).some((p) => p.id === r.pickId && bookInfo(p.book).key === bookInfo(r.bookKey || r.book).key);
    function togglePick(r) {
      if (picked(r)) return store.removePick(r.pickId);
      store.addPick({ id: r.pickId, label: r.m.matchup ? `${r.label} (${r.m.matchup})` : r.label, price: r.price, book: r.bookKey || r.book, league: r.m.league, gameId: r.m.gameId });
      if (r.m.kind === 'props') store.track(r.pickId, 'add');
    }

    // ---------- tabla ----------
    const lab = (t) => h`<span class="ev-cl" aria-hidden="true">${t}</span>`;
    const addBtn = (r) => h`<button type="button" class="btn ev-btn ev-add" data-add="${r.rid}" aria-pressed="${String(picked(r))}" aria-label="Agregar al boleto: ${r.label}, ${bookInfo(r.bookKey || r.book).name} ${fmtOdds(r.price)}">${picked(r) ? '✓ En boleto' : '+ Boleto'}</button>`;
    const columns = [
      { key: 'ev', label: 'EV % · Pick', className: 'ev-c-pick', sort: (r) => r.ev, render: (r) => h`<div class="ev-pick">
          <b class="ev-pct ${r.ev >= 0 ? 'pos' : 'neg'}">${pctSigned(r.ev)}</b>
          <span class="ev-lbl">${r.label}</span>
          <small>${[r.m.matchup, leagueById(r.m.league)?.title, when(r.start)].filter(Boolean).join(' · ')}</small></div>` },
      { key: 'price', label: 'Cuota · FV', className: 'ev-c-odds', sort: (r) => r.price, render: (r) => h`${lab('Cuota · FV')}<span class="ev-odds">${bookChip(r.bookKey || r.book)}<b>${fmtOdds(r.price)}</b></span><small>FV ${fmtOdds(r.fairOdds)} (vig ${fmtPct(r.vig, 1)})</small>` },
      { key: 'kelly', label: 'Kelly %', className: 'ev-c-num', sort: (r) => r.kelly, render: (r) => h`${lab('Kelly')}<b>${fmtPct(r.kelly, 2)}</b><small>${fmtMoney(r.kelly * (Number(store.get('settings')?.bankroll) || 0))}</small>` },
      { key: 'width', label: 'Ancho', className: 'ev-c-num', sort: (r) => r.width, defaultDir: 'asc', render: (r) => h`${lab('Ancho')}${r.width == null ? '—' : Math.round(r.width)}` },
      { key: 'variation', label: 'Variación', className: 'ev-c-num', sort: (r) => r.variation, defaultDir: 'asc', render: (r) => h`${lab('Variación')}${fmtPct(r.variation, 1)}` },
      { key: 'act', label: 'Acciones', className: 'ev-c-act', sortable: false, render: (r) => h`<div class="ev-actions">${addBtn(r)}<button type="button" class="btn ev-btn" data-detail="${r.rid}" aria-label="Ver detalle: ${r.label}, ${bookInfo(r.bookKey || r.book).name}">Detalle</button></div>` },
    ];
    const table = sortableTable({ columns, rows: [], sortKey: 'ev', sortDir: 'desc', pageSize: 100, caption: 'Apuestas con valor esperado, ordenadas por EV' });
    const emptyEl = document.createElement('div');
    results.append(emptyEl, table);
    let shownRows = [];

    table.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) {
        const r = rowById.get(add.dataset.add);
        if (!r) return;
        togglePick(r); // store.on('picks') vuelve a pintar la tabla: se devuelve el foco al botón nuevo
        table.querySelector(`[data-add="${CSS.escape(r.rid)}"]`)?.focus();
        return;
      }
      const det = e.target.closest('[data-detail]');
      if (det && rowById.has(det.dataset.detail)) openDetail(rowById.get(det.dataset.detail), det);
    });

    function openDetail(r, opener) {
      const a = r.m.a, used = new Set(a.ref?.used ?? []);
      const lg = leagueById(r.m.league);
      const stat = (t, v) => h`<div><dt>${t}</dt><dd>${v}</dd></div>`;
      const body = document.createElement('div');
      const paint = () => {
        body.innerHTML = h`<p class="ev-d-meta">${[r.m.matchup, lg?.title, when(r.start)].filter(Boolean).join(' · ')}</p>
          <p class="ev-d-pick"><b>${r.label}</b> <span class="ev-odds">${bookChip(r.bookKey || r.book)}<b>${fmtOdds(r.price)}</b></span></p>
          <dl class="ev-d-stats">
            ${stat('EV', h`<span class="${r.ev >= 0 ? 'pos' : 'neg'}">${pctSigned(r.ev)}</span>`)}${stat('Prob. justa', fmtPct(r.prob, 1))}${stat('FV', fmtOdds(r.fairOdds))}
            ${stat('Kelly', fmtPct(r.kelly, 2))}${stat('Ancho', r.width == null ? '—' : Math.round(r.width))}${stat('Variación', fmtPct(r.variation, 1))}
          </dl>
          <p class="hint">Devig ${METHODS[f.method][0].toLowerCase()} con ${a.fairSource ?? '—'} (${used.size} ${used.size === 1 ? 'casa' : 'casas'}).</p>
          <div class="table-wrap"><table class="ev-d-tbl"><caption class="sr-only">Cuotas por casa en este mercado</caption>
            <thead><tr><th scope="col">Casa</th>${a.names.map((n) => h`<th scope="col">${sideText(n)}</th>`)}<th scope="col">Vig</th><th scope="col">En devig</th></tr></thead>
            <tbody>${a.books.map((b) => h`<tr${b.key === r.bookKey ? raw(' class="ev-d-me"') : ''}><th scope="row">${bookChip(b.key || b.title)}</th>${a.names.map((n) => h`<td>${fmtOdds(b.outcomes[n])}</td>`)}<td>${fmtPct(vigOf(a.names.map((n) => b.outcomes[n])), 1)}</td><td>${used.has(b.key) ? 'Sí' : 'No'}</td></tr>`)}
              <tr class="fair"><th scope="row">Justa</th>${a.names.map((n) => h`<td>${fmtOdds(1 / a.fair[n])} · ${fmtPct(a.fair[n], 1)}</td>`)}<td></td><td></td></tr></tbody>
          </table></div>
          ${r.m.kind === 'props' ? h`<p><a href="#/${r.m.league}/props/${propKey({ ...a, side: r.outcome })}">Ver historial y acierto del prop →</a></p>` : ''}
          <div class="modal-actions">${addBtn(r)}</div>`;
      };
      paint();
      body.addEventListener('click', (e) => {
        if (!e.target.closest('[data-add]')) return;
        togglePick(r);
        paint();
        body.querySelector('[data-add]')?.focus();
      });
      const d = modal({ title: `${pctSigned(r.ev)} · ${r.m.title}`, body, className: 'ev-detail', onClose: () => { if (opener?.isConnected) opener.focus(); } });
      d.addEventListener('click', (e) => { if (e.target.closest('a[href^="#"]')) d.close(); });
    }

    // ---------- filtros ----------
    const devigSummary = () => {
      const minB = Math.max(1, Math.round(num(f.minBooks, 1)));
      if (!f.required.length && !f.optional.length) return `consenso de todas (mín. ${minB})`;
      return [...f.required.map((k) => `${bookInfo(k).name} (obligatoria)`), ...f.optional.map((k) => bookInfo(k).name)].join(', ') + ` · mín. ${minB}`;
    };

    function paintFilters() {
      const open = [...form.querySelectorAll('details')].map((d) => d.open);
      const n = (k, label, attrs = {}) => h`<label class="ev-field"><span>${label}</span><input type="number" data-f="${k}" value="${f[k]}" step="${attrs.step ?? 'any'}"${attrs.min != null ? raw(` min="${attrs.min}"`) : ''} inputmode="decimal" placeholder="${attrs.ph ?? 'sin límite'}"></label>`;
      form.innerHTML = h`<div class="toolbar ev-bar">
          <span data-slot="leagues"></span>
          <label>Tipo <select data-f="type">${optionsHtml(TYPES, f.type)}</select></label>
          <label>Ventana <select data-f="window">${optionsHtml(WINDOWS, f.window)}</select></label>
          <span class="ev-method"><label>Devig <select data-f="method">${optionsHtml(Object.entries(METHODS).map(([k, [t]]) => [k, t]), f.method)}</select></label><button type="button" class="icon-btn sm" data-info aria-label="Qué significa cada método de devig y cada columna">?</button></span>
          <label>Kelly <select data-f="kellyMult">${optionsHtml(kellyOptions(f.kellyMult), f.kellyMult)}</select></label>
          <label>EV % mín. <input type="number" data-f="minEv" value="${f.minEv}" step="0.1" inputmode="decimal" placeholder="sin límite"></label>
        </div>
        <div class="ev-panels">
          <details class="ev-panel"><summary>Más filtros</summary>
            <div class="ev-grid">
              ${n('minKelly', 'Kelly % mínimo', { min: 0, step: 0.1 })}
              ${n('maxVig', 'Vig % máximo', { min: 0, step: 0.1, ph: 'p. ej. 6' })}
              ${n('maxWidth', 'Ancho máximo (centavos)', { min: 0, step: 1, ph: 'p. ej. 40' })}
              ${n('maxVariation', 'Variación máxima %', { min: 0, step: 0.1, ph: 'p. ej. 3' })}
              ${n('minAm', 'Cuota mínima (americana)', { step: 1, ph: 'p. ej. -300' })}
              ${n('maxAm', 'Cuota máxima (americana)', { step: 1, ph: 'p. ej. +200' })}
              <div class="ev-field"><span>Casas donde apostar</span><span data-slot="betBooks"></span></div>
            </div>
          </details>
          <details class="ev-panel"><summary>Casas para devig: <span data-devig-sum></span></summary>
            <p class="hint">Sin casillas marcadas se usa el consenso de todas las casas que tengan ambos lados. Una casa <b>obligatoria</b> debe tener cuota en el mercado (si falta, el mercado se omite); una <b>opcional</b> entra si está. El peso pondera el promedio (vacío = 1).</p>
            ${n('minBooks', 'Mínimo de casas', { min: 1, step: 1, ph: '1' })}
            <div data-books></div>
          </details>
        </div>`;
      form.querySelectorAll('details').forEach((d, i) => { d.open = !!open[i]; });
      form.querySelector('[data-slot="leagues"]').append(dropdown({
        label: 'Ligas', multi: true, placeholder: 'Ninguna', value: f.leagues,
        options: LEAGUES.map((l) => ({ value: l.id, label: l.title })),
        onChange: (v) => { f.leagues = v.map(String); ensure(); update(); },
      }));
      booksSig = '';
      paintBooks();
    }

    function bookKeys() {
      const count = new Map();
      const bump = (k) => k && count.set(k, (count.get(k) ?? 0) + 1);
      for (const [k, d] of data) {
        if (d.state !== 'ok') continue;
        if (k.startsWith('lines:')) for (const ev of d.items) for (const b of ev?.bookmakers ?? []) bump(b?.key);
        else for (const p of d.items) for (const b of p?.books ?? []) bump(b?.key);
      }
      for (const k of ['pinnacle', ...f.required, ...f.optional]) if (!count.has(k)) count.set(k, 0);
      return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    }

    function paintBooks() {
      form.querySelector('[data-devig-sum]').textContent = devigSummary();
      const list = bookKeys();
      const sig = list.map(([k]) => k).join(',');
      if (sig === booksSig) return;
      booksSig = sig;
      const req = new Set(f.required), opt = new Set(f.optional);
      const box = form.querySelector('[data-books]');
      box.innerHTML = h`<div class="ev-btbl-wrap"><table class="ev-btbl"><caption class="sr-only">Casas para quitar el vig</caption>
        <thead><tr><th scope="col">Casa</th><th scope="col">Obligatoria</th><th scope="col">Opcional</th><th scope="col">Peso</th></tr></thead>
        <tbody>${list.map(([k, cnt]) => {
          const name = bookInfo(k).name;
          return h`<tr><th scope="row">${bookChip(k)} <small>${cnt ? `${cnt} ${cnt === 1 ? 'mercado' : 'mercados'}` : 'sin datos'}</small></th>
            <td><input type="checkbox" data-req="${k}" aria-label="${name}: obligatoria"${req.has(k) ? raw(' checked') : ''}></td>
            <td><input type="checkbox" data-opt="${k}" aria-label="${name}: opcional"${opt.has(k) ? raw(' checked') : ''}></td>
            <td><input type="number" min="0" step="any" inputmode="decimal" data-w="${k}" value="${f.weights[k] ?? ''}" placeholder="1" aria-label="Peso de ${name}"></td></tr>`;
        })}</tbody></table></div>`;
      const keys = [...new Set([...Object.keys(BOOKS), ...list.map(([k]) => bookInfo(k).key), ...f.betBooks].filter(Boolean))];
      form.querySelector('[data-slot="betBooks"]').replaceChildren(dropdown({
        label: 'Casas', multi: true, placeholder: 'Todas', value: f.betBooks,
        options: keys.map((k) => ({ value: k, label: bookInfo(k).name })),
        onChange: (v) => { f.betBooks = v.map(String); update(); },
      }));
    }

    function onField(e) {
      const t = e.target;
      if (t.dataset.f) {
        f[t.dataset.f] = t.dataset.f === 'kellyMult' ? Number(t.value) : t.value;
        if (t.dataset.f === 'type') ensure();
        if (t.dataset.f === 'minBooks') form.querySelector('[data-devig-sum]').textContent = devigSummary();
        return schedule(t.tagName === 'SELECT' ? 0 : 250);
      }
      if (t.dataset.w != null) {
        f.weights = { ...f.weights, [t.dataset.w]: t.value };
        return schedule(250);
      }
      const k = t.dataset.req ?? t.dataset.opt;
      if (k == null || e.type !== 'change') return;
      const isReq = t.dataset.req != null;
      f.required = f.required.filter((x) => x !== k);
      f.optional = f.optional.filter((x) => x !== k);
      if (t.checked) {
        (isReq ? f.required : f.optional).push(k);
        const other = form.querySelector(`[data-${isReq ? 'opt' : 'req'}="${CSS.escape(k)}"]`);
        if (other) other.checked = false;
      }
      form.querySelector('[data-devig-sum]').textContent = devigSummary();
      schedule(0);
    }
    form.addEventListener('input', onField);
    form.addEventListener('change', onField);
    form.addEventListener('click', (e) => { const b = e.target.closest('[data-info]'); if (b) showMethodsInfo(() => b.isConnected && b.focus()); });

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(() => alive && update(), ms);
    }

    // ---------- preajustes ----------
    const userPresets = () => {
      const all = store.get('presets');
      return Array.isArray(all?.ev) ? all.ev.filter((p) => p && typeof p.name === 'string' && p.filters && typeof p.filters === 'object') : [];
    };
    const savePresets = (list) => store.set('presets', { ...(store.get('presets') ?? {}), ev: list.slice(-MAX_PRESETS) });
    let presetsHtml = '';
    function paintPresets() {
      const mine = userPresets();
      const base = defaults(ctx);
      const html = String(h`${PRESETS.map((p, i) => h`<button type="button" class="ev-chip" data-preset="${i}" aria-pressed="${String(matches(f, p.set))}">${p.name}</button>`)}
        ${mine.map((p, i) => h`<span class="ev-mine"><button type="button" class="ev-chip" data-mine="${i}" aria-pressed="${String(matches(f, clean(p.filters, base)))}">${p.name.slice(0, 40)}</button><button type="button" class="ev-del" data-del="${i}" aria-label="Eliminar el preajuste ${p.name.slice(0, 40)}">✕</button></span>`)}
        <button type="button" class="ev-chip ev-save" data-save>+ Guardar filtros</button>`);
      if (html === presetsHtml) return;
      // Se repinta solo si algo cambió y se devuelve el foco al mismo chip.
      const a = presetsEl.contains(document.activeElement) ? document.activeElement : null;
      const sel = a && ['preset', 'mine', 'del', 'save'].map((k) => (a.dataset[k] != null ? `[data-${k}="${a.dataset[k]}"]` : null)).find(Boolean);
      presetsHtml = html;
      presetsEl.innerHTML = html;
      if (sel) presetsEl.querySelector(sel)?.focus();
    }
    function applyFilters(next) {
      f = next;
      paintFilters();
      ensure();
      update();
    }
    presetsEl.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.preset != null) applyFilters({ ...f, ...structuredClone(PRESETS[b.dataset.preset].set) });
      else if (b.dataset.mine != null) { const p = userPresets()[b.dataset.mine]; if (p) applyFilters(clean(p.filters, defaults(ctx))); }
      else if (b.dataset.del != null) {
        const list = userPresets(), p = list[b.dataset.del];
        if (p && window.confirm(`¿Eliminar el preajuste «${p.name}»?`)) { list.splice(b.dataset.del, 1); savePresets(list); paintPresets(); presetsEl.querySelector('[data-save]').focus(); }
        return;
      } else if (b.dataset.save != null) savePreset(b);
    });

    function savePreset(opener) {
      const box = document.createElement('form');
      box.method = 'dialog';
      box.innerHTML = h`<label class="ev-field"><span>Nombre del preajuste</span><input name="name" required maxlength="40" autocomplete="off"></label>
        <p class="hint">Guarda todos los filtros actuales (ligas, casas para devig, método, límites) en este dispositivo.</p>
        <div class="modal-actions"><button type="submit" class="btn" value="cancel" formnovalidate>Cancelar</button><button type="submit" class="btn btn-primary" value="save">Guardar</button></div>`;
      box.addEventListener('submit', (e) => {
        if (e.submitter?.value !== 'save') return;
        const name = String(new FormData(box).get('name') ?? '').trim().slice(0, 40);
        if (!name) return e.preventDefault();
        savePresets([...userPresets().filter((p) => p.name !== name), { name, filters: structuredClone(f) }]);
        paintPresets();
      });
      modal({ title: 'Guardar filtros de EV+', body: box, onClose: () => (opener.isConnected ? opener : presetsEl.querySelector('[data-save]'))?.focus() });
      box.querySelector('input').focus();
    }

    // ---------- pintar ----------
    function update() {
      if (!alive) return;
      const { all, rows } = computeRows();
      rowById = new Map(rows.map((r) => [r.rid, r]));
      shownRows = rows;
      paintPresets();
      paintBooks();
      for (const k of ['minAm', 'maxAm']) {
        const inp = form.querySelector(`[data-f="${k}"]`);
        if (inp) inp.toggleAttribute('aria-invalid', badAm(f[k]));
      }

      let pending = false, demo = false;
      const srcs = [], errs = [], noOdds = [];
      for (const id of f.leagues) {
        const lg = leagueById(id);
        if (!lg) continue;
        if (f.type !== 'props' && !lg.odds) noOdds.push(lg.title);
        for (const kind of kindsFor(lg)) {
          const d = data.get(`${kind}:${id}`);
          if (!d || d.state === 'loading') pending = true;
          else if (d.state === 'error') errs.push(`${lg.title} · ${KIND[kind]}: ${d.error?.message ?? 'error desconocido'}`);
          else {
            if (d.body?.source === 'demo') demo = true;
            srcs.push(h`<span class="ev-src">${lg.title} · ${KIND[kind]} ${sourceBadge(d.body)}</span>`);
          }
        }
      }
      $('.ev-count').innerHTML = h`<b>${rows.length}/${all.length}</b> apuestas${pending ? ' · cargando…' : ''}`;
      $('.ev-sources').innerHTML = h`${srcs}`;
      $('.ev-notes').innerHTML = h`${demo ? h`<p class="ev-warn">Hay cuotas de <b>demostración</b> (el servidor no tiene clave de The Odds API): esos EV no corresponden a cuotas reales.</p>` : ''}
        ${noOdds.length ? h`<p class="ev-note">${noOdds.join(', ')}: The Odds API no cubre sus líneas de partido.</p>` : ''}
        ${errs.length ? h`<div class="error-box" role="alert"><b>Algunas fuentes no cargaron</b><ul>${errs.map((x) => h`<li>${x}</li>`)}</ul><button type="button" class="btn" data-ev-retry>Reintentar</button></div>` : ''}`;

      table.hidden = !rows.length;
      if (rows.length) {
        emptyEl.innerHTML = '';
        table.setRows(rows);
      } else {
        emptyEl.innerHTML = !f.leagues.length ? empty('Elige al menos una liga.')
          : pending && !all.length ? loading(4)
          : all.length ? empty('Ninguna apuesta cumple los filtros. Prueba bajar el EV % mínimo o quitar límites en «Más filtros».')
          : empty('No hay mercados con probabilidad justa para estas ligas y casas de devig (puede faltar una casa obligatoria o no haber partidos próximos).');
      }
    }

    root.addEventListener('click', (e) => {
      if (!e.target.closest('[data-ev-retry]')) return;
      for (const [k, d] of data) if (d.state === 'error') data.delete(k);
      ensure();
      update();
    });

    const offPicks = store.on('picks', () => { if (alive && shownRows.length) table.setRows(shownRows); });
    paintFilters();
    ensure();
    update();
    return () => {
      alive = false;
      clearTimeout(timer);
      offPicks();
    };
  },
};
