// Arbitraje (/pro/arbitrage): cuotas de casas distintas cuya suma de probabilidades implícitas es < 1, en líneas de
// partido (ganador, hándicap, total y sus alternativas cuando la fuente las trae) y props de jugador.
// Datos: /api/odds y /api/props (The Odds API o demo). Todo texto externo pasa por h`` (escapado).
// También exporta las piezas que reutiliza views/middles.js: carga por liga, filtro de casas, explode, guardados, campos.
import * as bm from '../betmath.js';
import { LEAGUES, leagueById } from '../leagues.js';
import { statForMarket } from '../stats.js';
import { h, raw, fmtOdds, fmtPct, fmtMoney, when, bookChip, bookInfo, BOOKS, dropdown, empty, loading, sourceBadge } from '../ui.js';

// ---------- piezas compartidas con middles.js ----------
export const ODDS_LEAGUES = LEAGUES.filter((l) => l.odds);
export const defaultLeague = (id) => (leagueById(id)?.odds ? id : ODDS_LEAGUES[0].id);
export const bookKey = (k) => bookInfo(k).key;
export const num = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
export const signed = (x) => (x > 0 ? `+${x}` : `${x}`);
export const signedMoney = (x) => (x < 0 ? `−${fmtMoney(-x)}` : `+${fmtMoney(x)}`);
export const sideName = (s) => ({ Over: 'Más de', Under: 'Menos de', Draw: 'Empate', Yes: 'Sí', No: 'No' })[s] ?? s;
export const TYPES = { all: 'Todo', lines: 'Líneas', props: 'Props' };
const MARKET = { h2h: 'Ganador del partido', spreads: 'Hándicap', totals: 'Total' };

export const statLabel = (p) => statForMarket(leagueById(p.league)?.sport, p.market)?.name ?? p.stat ?? p.market ?? 'Prop';

const grab = (cache, key, fn, fresh) => {
  if (fresh || !cache.has(key)) cache.set(key, fn().then((body) => ({ ok: true, body }), (error) => ({ ok: false, error })));
  return cache.get(key);
};

// Cuotas de partido (lines) y props por liga. cache: Map propia de la vista (evita repetir peticiones al cambiar filtros).
export async function loadMarkets(api, ids, { lines = true, props = true, fresh = false, cache = new Map() } = {}) {
  const out = { events: [], props: [], sources: [], errors: [] };
  const take = (lg, what, add) => (r) => {
    if (!r.ok) return void out.errors.push(`${lg.title} · ${what}: ${r.error?.message ?? r.error}`);
    add(Array.isArray(r.body?.data) ? r.body.data : []);
    out.sources.push({ league: lg.title, what, source: r.body?.source, remaining: r.body?.remaining });
  };
  await Promise.all(ids.map(leagueById).filter((lg) => lg?.odds).flatMap((lg) => [
    lines && grab(cache, `o:${lg.id}`, () => api.get('/api/odds', { sport: lg.odds }, { fresh }), fresh)
      .then(take(lg, 'líneas', (d) => out.events.push(...d.map((e) => ({ ...e, league: lg.id }))))),
    props && grab(cache, `p:${lg.id}`, () => api.get('/api/props', { league: lg.id }, { fresh }), fresh)
      .then(take(lg, 'props', (d) => out.props.push(...d.map((p) => ({ ...p, league: p.league ?? lg.id }))))),
  ].filter(Boolean)));
  return out;
}

// Deja solo las casas elegidas (claves de ui.BOOKS; vacío = todas). Se filtra ANTES de buscar la mejor cuota.
export function onlyBooks(data, sel) {
  const s = new Set(sel ?? []);
  if (!s.size) return data;
  const keep = (b) => s.has(bookKey(b.key ?? b.title));
  return {
    ...data,
    events: data.events.map((e) => ({ ...e, bookmakers: (e.bookmakers ?? []).filter(keep) })),
    props: data.props.map((p) => ({ ...p, books: (p.books ?? []).filter(keep) })),
  };
}

// Une mercados principales y alternativos (alternate_spreads / alternate_totals) por (mercado, línea).
// line: el punto del total, o el hándicap del LOCAL. Cada grupo trae un evento sintético con un único mercado
// 'h2h' por casa: así bm.analyzeEvent mete todas las casas en el mismo grupo (ya comparten línea) aunque una
// casa solo publique un lado de una línea alternativa.
export function explode(ev) {
  const groups = new Map();
  for (const b of ev.bookmakers ?? []) {
    for (const m of b.markets ?? []) {
      const alt = String(m.key).startsWith('alternate_');
      const base = String(m.key).replace(/^alternate_/, '');
      if (!MARKET[base]) continue;
      for (const o of m.outcomes ?? []) {
        if (!(o?.price > 1)) continue;
        const line = base === 'h2h' ? null : base === 'totals' ? o.point : o.name === ev.home_team ? o.point : -o.point;
        if (base !== 'h2h' && !Number.isFinite(line)) continue;
        const k = `${base}|${line}`;
        if (!groups.has(k)) groups.set(k, { base, line, main: false, books: new Map() });
        const g = groups.get(k);
        g.main ||= !alt;
        if (!g.books.has(b.key)) g.books.set(b.key, { key: b.key, title: b.title, markets: [{ key: 'h2h', outcomes: [] }] });
        const outs = g.books.get(b.key).markets[0].outcomes;
        if (!outs.some((x) => x.name === o.name)) outs.push({ name: o.name, price: o.price, point: o.point });
      }
    }
  }
  return [...groups.values()].map(({ books, ...g }) => ({ ...g, event: { ...ev, bookmakers: [...books.values()] } }));
}

// Nombre de un lado con su línea: "Más de 224.5", "Celtics −5.5", "Empate".
export function lineLabel(ev, base, line, name) {
  if (base === 'totals') return `${sideName(name)} ${line}`;
  if (base === 'spreads') return `${name} ${signed(name === ev.home_team ? line : -line)}`;
  return sideName(name);
}
export const marketName = (base, alt) => `${MARKET[base]}${alt ? ' (línea alternativa)' : ''}`;

export const gameIndex = (events) => new Map(events.map((e) => [e.id, { key: e.id, title: `${e.away_team} @ ${e.home_team}`, start: e.commence_time, league: e.league }]));
export const gameOfProp = (p, idx) => idx.get(p.eventId) ?? {
  key: p.eventId ?? p.gameId ?? p.player,
  title: p.team && p.opp ? `${p.team} vs ${p.opp}` : p.player,
  start: p.start,
  league: p.league,
};

export const gameHead = (g) => h`<header class="pro-game">
  <span class="pro-lg">${leagueById(g.league)?.title ?? g.league}</span>
  <h2 class="pro-gt">${g.title}</h2>
  ${g.start ? h`<time datetime="${g.start}">${when(g.start)}</time>` : ''}
</header>`;

// Agrupa ítems (ya ordenados) por partido, hasta `limit` ítems. → { html por partido, shown: ítems mostrados }
export function byGame(items, limit, card) {
  const games = new Map();
  const shown = items.slice(0, limit);
  shown.forEach((it, i) => {
    const k = `${it.league}|${it.game.key}`;
    if (!games.has(k)) games.set(k, { game: it.game, parts: [] });
    games.get(k).parts.push(card(it, i));
  });
  return { shown, html: h`${[...games.values()].map((g) => h`<article class="pro-card">${gameHead(g.game)}${g.parts}</article>`)}` };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt('Copia este texto:', text);
    return false;
  }
}

// ---------- controles de la barra (devuelven HTMLElement) ----------
const node = (tag, cls, html) => Object.assign(document.createElement(tag), { className: cls, innerHTML: html ?? '' });

export function numField(label, value, { min, step = 'any', placeholder = '', onInput } = {}) {
  const l = node('label', 'pro-num', h`<span>${label}</span><input type="number" inputmode="decimal" step="${step}"${min != null ? raw(` min="${min}"`) : ''} placeholder="${placeholder}" value="${value ?? ''}">`);
  let t;
  l.querySelector('input').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => onInput(e.target.value), 250);
  });
  return l;
}

export function seg(label, options, value, onChange) {
  const wrap = node('div', 'pro-field', h`<span class="pro-lab" aria-hidden="true">${label}</span><div class="seg pro-seg" role="group" aria-label="${label}">${Object.entries(options).map(([v, t]) => h`<button type="button" data-v="${v}" aria-pressed="${String(v === String(value))}">${t}</button>`)}</div>`);
  const g = wrap.lastElementChild;
  g.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    for (const x of g.children) x.setAttribute('aria-pressed', String(x === b));
    onChange(b.dataset.v);
  });
  return wrap;
}

export const leaguesDropdown = (value, onChange) => dropdown({ label: 'Ligas', multi: true, placeholder: 'Ninguna', value, options: ODDS_LEAGUES.map((l) => ({ value: l.id, label: l.title })), onChange });

// Opciones: las casas conocidas (ui.BOOKS) más las que aparezcan en los datos.
export const booksDropdown = (value, seen, onChange) => dropdown({
  label: 'Casas', multi: true, placeholder: 'Todas', value,
  options: [...new Set([...Object.keys(BOOKS), ...seen])].map((k) => ({ value: k, label: bookInfo(k).name })),
  onChange,
});

export function seenBooks(data) {
  const s = new Set();
  for (const e of data.events) for (const b of e.bookmakers ?? []) s.add(bookKey(b.key ?? b.title));
  for (const p of data.props) for (const b of p.books ?? []) s.add(bookKey(b.key ?? b.title));
  s.delete('');
  return s;
}

// Filtros guardados en store.presets[view] (architecture.md). current() da los filtros; apply(f) los aplica.
export function presetsBox(store, view, current, apply) {
  const box = node('details', 'pro-presets');
  const list = () => {
    const all = store.get('presets');
    return Array.isArray(all?.[view]) ? all[view] : [];
  };
  const save = (arr) => store.set('presets', { ...(store.get('presets') ?? {}), [view]: arr });
  const paint = () => {
    const ps = list();
    box.innerHTML = h`<summary class="btn">Guardados${ps.length ? ` (${ps.length})` : ''}</summary>
      <div class="pro-pop">
        <ul>${ps.length
          ? ps.map((p, i) => h`<li><button type="button" class="pro-link" data-load="${i}">${p.name}</button><button type="button" class="icon-btn sm" data-del="${i}" aria-label="Borrar ${p.name}">✕</button></li>`)
          : h`<li class="pro-muted">Aún no hay filtros guardados.</li>`}</ul>
        <form class="pro-save"><label><span class="sr-only">Nombre del filtro</span><input name="name" maxlength="40" placeholder="Nombre del filtro"></label><button type="submit" class="btn btn-primary">Guardar actual</button></form>
      </div>`;
  };
  box.addEventListener('click', (e) => {
    const ld = e.target.closest('[data-load]'), del = e.target.closest('[data-del]');
    if (ld) {
      box.open = false;
      apply(list()[+ld.dataset.load]?.f ?? {});
    } else if (del) {
      save(list().filter((_, i) => i !== +del.dataset.del));
      paint();
      box.querySelector('summary').focus();
    }
  });
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = (new FormData(e.target).get('name') || '').toString().trim().slice(0, 40) || `Filtro ${list().length + 1}`;
    save([...list().filter((p) => p.name !== name), { name, f: current() }].slice(-20));
    paint();
    box.querySelector('summary').focus();
  });
  paint();
  return box;
}

export const sourcesLine = (d) => h`${d.sources.map((s) => h`<span class="pro-src">${s.league} ${s.what} ${sourceBadge(s.source, s.remaining)}</span>`)}`;
export const errorsLine = (d) => (d.errors.length ? h`<ul class="pro-errs" role="alert">${d.errors.map((e) => h`<li>${e}</li>`)}</ul>` : '');

// ---------- lógica del arbitraje ----------

// Ganancia > 0.001% (Σ1/p < 1 por puro redondeo en +115/−115 no cuenta) y patas en al menos dos casas.
const real = (arb) => arb?.isArb && arb.profit > 1e-5 && new Set(arb.legs.map((l) => l.key ?? l.book)).size > 1;

// Arbitrajes de las líneas de partido y de los props. → { items (ordenados por % desc), markets: mercados analizados }
export function findArbs({ events = [], props = [] }, { type = 'all' } = {}) {
  const idx = gameIndex(events);
  const items = [];
  let markets = 0;
  if (type !== 'props') {
    for (const ev of events) {
      for (const g of explode(ev)) {
        markets++;
        const a = bm.analyzeEvent(g.event, { market: 'h2h' })[0];
        if (!real(a?.arb)) continue;
        items.push({
          kind: 'lines', key: `${ev.id}|${g.base}|${g.line}`, league: ev.league, gameId: null, game: idx.get(ev.id),
          market: marketName(g.base, !g.main), pct: a.arb.profit,
          legs: a.arb.legs.map((l) => ({ name: l.outcome, label: lineLabel(ev, g.base, g.line, l.outcome), price: l.price, book: l.book, bookKey: bookKey(l.key ?? l.book) })),
        });
      }
    }
  }
  if (type !== 'lines') {
    for (const a of bm.analyzeProps(props)) {
      markets++;
      if (!real(a.arb)) continue;
      items.push({
        kind: 'props', key: a.key, league: a.league, gameId: a.gameId ?? null, game: gameOfProp(a, idx),
        market: `${a.player} · ${statLabel(a)}`, pct: a.arb.profit,
        legs: a.arb.legs.map((l) => ({ name: l.outcome, label: `${sideName(l.outcome)}${a.line != null ? ` ${a.line}` : ''}`, price: l.price, book: l.book, bookKey: bookKey(l.key ?? l.book) })),
      });
    }
  }
  return { items: items.sort((x, y) => y.pct - x.pct), markets };
}

// Montos del arbitraje: mode 'win' = cada pata cobra `amount` (stake + ganancia); 'total' = se reparte `amount`.
// round > 0 redondea cada stake a múltiplos de round (mínimo round) y recalcula la ganancia de cada resultado.
export function arbPlan(prices, { mode = 'win', amount = 10, round = 0 } = {}) {
  const r = bm.arbStakes(prices, mode === 'total' ? { bankroll: amount } : { toWin: amount });
  if (!r) return null;
  const legs = r.stakes.map((s, i) => ({ stake: s, win: s * (prices[i] - 1) }));
  let rounded = null;
  if (round > 0) {
    const stakes = r.stakes.map((s) => Math.max(round, Math.round(s / round) * round));
    const total = stakes.reduce((t, s) => t + s, 0);
    const profits = stakes.map((s, i) => s * prices[i] - total);
    rounded = { stakes, total, profits, min: Math.min(...profits), max: Math.max(...profits) };
  }
  return { ...r, legs, rounded };
}

const LIMIT = 40;
const ROUND = { 0: 'Sin redondeo', 1: 'A $1', 5: 'A $5', 10: 'A $10' };

export default {
  title: 'Arbitraje',
  render(el, { league, api, store }) {
    const settings = store.get('settings') ?? {};
    const def = () => ({ minPct: 0, leagues: [defaultLeague(league)], books: [...(settings.books ?? [])], type: 'all', mode: 'win', toWin: 10, bankroll: num(settings.bankroll, 100), round: 0 });
    const clean = (x = {}) => {
      const d = def();
      const pos = (v, dv) => (num(v, dv) > 0 ? num(v, dv) : dv);
      return {
        minPct: Math.max(0, num(x.minPct, d.minPct)),
        leagues: Array.isArray(x.leagues) ? x.leagues.filter((id) => leagueById(id)?.odds) : d.leagues,
        books: Array.isArray(x.books) ? x.books.map(String) : d.books,
        type: TYPES[x.type] ? x.type : d.type,
        mode: x.mode === 'total' ? 'total' : 'win',
        toWin: pos(x.toWin, d.toWin),
        bankroll: pos(x.bankroll, d.bankroll),
        round: ROUND[x.round] ? Number(x.round) : 0,
      };
    };
    let f = def();
    let data = null, dead = false, seq = 0, limit = LIMIT, shown = [], seen = new Set();
    const cache = new Map();

    el.innerHTML = h`<section class="pro arb">
      <div class="view-head"><div>
        <h1>Arbitraje</h1>
        <p class="hint">Cuotas de casas distintas que, combinadas, dejan ganancia pase lo que pase. Busca en ganador, hándicap, totales, líneas alternativas (cuando la fuente las trae) y props de jugador.</p>
      </div></div>
      <div class="toolbar pro-bar"></div>
      <div class="pro-meta"><p class="pro-status" role="status" aria-live="polite"></p><p class="pro-srcs"></p></div>
      <div class="pro-errbox"></div>
      <div class="pro-list"></div>
      <p class="pro-note">Las cuotas cambian rápido: confirma ambas cuotas en cada casa antes de apostar. Algunas casas limitan cuentas o anulan apuestas por error de línea, y las bolsas (exchanges) cobran comisión, que aquí no se descuenta.</p>
      <p class="sr-only" aria-live="polite" data-live></p>
    </section>`;
    const $ = (s) => el.querySelector(s);
    const bar = $('.pro-bar'), listEl = $('.pro-list');
    const say = (msg) => { $('[data-live]').textContent = msg; };

    let booksSlot;
    function paintBar() {
      const amountField = () => numField(f.mode === 'total' ? 'Monto total' : 'Cobro por pata', f.mode === 'total' ? f.bankroll : f.toWin, {
        min: 0.01, step: '0.01', onInput: (v) => {
          const x = num(v, 0);
          if (!(x > 0)) return;
          f[f.mode === 'total' ? 'bankroll' : 'toWin'] = x;
          draw();
        },
      });
      let amount = amountField();
      booksSlot = node('div', 'pro-slot');
      booksSlot.append(booksDropdown(f.books, seen, (v) => { f.books = v.map(String); draw(); }));
      const round = node('label', 'pro-num', h`<span>Redondeo</span><select>${Object.entries(ROUND).map(([v, t]) => h`<option value="${v}"${Number(v) === f.round ? raw(' selected') : ''}>${t}</option>`)}</select>`);
      round.querySelector('select').addEventListener('change', (e) => { f.round = Number(e.target.value) || 0; draw(); });
      let lt;
      bar.replaceChildren(
        presetsBox(store, 'arbitrage', () => ({ ...f }), (p) => { f = clean(p); paintBar(); load(); }),
        numField('Arbitraje % mínimo', f.minPct, { min: 0, step: '0.1', onInput: (v) => { f.minPct = Math.max(0, num(v, 0)); draw(); } }),
        leaguesDropdown(f.leagues, (v) => { f.leagues = v.map(String); clearTimeout(lt); lt = setTimeout(load, 400); }),
        booksSlot,
        seg('Tipo', TYPES, f.type, (v) => { f.type = v; load(); }),
        seg('Montos', { win: 'Por pata', total: 'Total' }, f.mode, (v) => {
          f.mode = v;
          const next = amountField();
          amount.replaceWith(next);
          amount = next;
          draw();
        }),
        amount,
        round,
        Object.assign(node('button', 'btn', 'Actualizar cuotas'), { type: 'button', onclick: () => load(true) }),
      );
    }

    async function load(fresh = false) {
      const my = ++seq;
      limit = LIMIT;
      if (!f.leagues.length) {
        data = { events: [], props: [], sources: [], errors: [] };
        return draw();
      }
      listEl.innerHTML = loading(4);
      $('.pro-status').textContent = 'Buscando arbitrajes…';
      const res = await loadMarkets(api, f.leagues, { lines: f.type !== 'props', props: f.type !== 'lines', fresh, cache });
      if (dead || my !== seq) return;
      data = res;
      const s = seenBooks(res);
      if ([...s].some((k) => !seen.has(k))) {
        seen = new Set([...seen, ...s]);
        // No se rehace el desplegable de casas si el usuario lo tiene abierto.
        if (booksSlot && !booksSlot.querySelector('[aria-expanded="true"]')) booksSlot.replaceChildren(booksDropdown(f.books, seen, (v) => { f.books = v.map(String); draw(); }));
      }
      draw();
    }

    const picksOf = (it) => it.legs.map((l) => ({
      id: `arb|${it.league}|${it.key}|${l.name}|${l.bookKey}`,
      label: `${it.game?.title ?? ''} · ${it.market}: ${l.label}`,
      price: l.price, book: l.bookKey || l.book, league: it.league, gameId: it.gameId,
    }));
    const inSlip = (it) => picksOf(it).every((p) => store.hasPick(p.id));
    const addLabel = (it) => (inSlip(it) ? 'En el boleto ✓' : it.legs.length === 2 ? 'Agregar ambas patas' : `Agregar las ${it.legs.length} patas`);
    const plan = (it) => arbPlan(it.legs.map((l) => l.price), { mode: f.mode, amount: f.mode === 'total' ? f.bankroll : f.toWin, round: f.round });

    function card(it, i) {
      const p = plan(it);
      const rd = p.rounded;
      return h`<div class="arb-item" role="group" aria-label="Arbitraje ${fmtPct(it.pct, 2)}: ${it.market}">
        <div class="arb-head">
          <b class="arb-pct">Arbitraje ${fmtPct(it.pct, 2)}</b>
          <span class="arb-mkt">${it.market}</span>
        </div>
        <ul class="arb-legs">${it.legs.map((l, j) => h`<li class="arb-leg">
          <span class="arb-side">${l.label}</span>
          <span class="arb-price"><b>${fmtOdds(l.price)}</b>${bookChip(l.book)}</span>
          <dl class="arb-amt">
            <div><dt>Apostar</dt><dd>${fmtMoney(rd ? rd.stakes[j] : p.legs[j].stake)}</dd></div>
            <div><dt>A ganar</dt><dd>${fmtMoney(rd ? rd.stakes[j] * (l.price - 1) : p.legs[j].win)}</dd></div>
          </dl>
        </li>`)}</ul>
        <p class="arb-sum">Ganancia segura <b class="pos">${signedMoney(p.profit)}</b> sobre ${fmtMoney(p.total)} apostados (cada pata cobra ${fmtMoney(p.payout)})${rd
          ? h`<br><span class="arb-round">Redondeado: ${fmtMoney(rd.total)} apostados → ${Math.abs(rd.max - rd.min) < 0.005
            ? h`<b class="${rd.min >= 0 ? 'pos' : 'neg'}">${signedMoney(rd.min)}</b>`
            : h`entre <b class="${rd.min >= 0 ? 'pos' : 'neg'}">${signedMoney(rd.min)}</b> y <b class="${rd.max >= 0 ? 'pos' : 'neg'}">${signedMoney(rd.max)}</b>`} según el resultado</span>`
          : ''}</p>
        <div class="pro-actions">
          <button type="button" class="btn" data-copy="${i}">Copiar</button>
          <button type="button" class="btn btn-primary" data-add="${i}" aria-pressed="${String(inSlip(it))}">${addLabel(it)}</button>
        </div>
      </div>`;
    }

    function draw() {
      if (dead || !data) return;
      $('.pro-srcs').innerHTML = sourcesLine(data);
      $('.pro-errbox').innerHTML = errorsLine(data);
      if (!f.leagues.length) {
        $('.pro-status').textContent = '';
        listEl.innerHTML = empty('Elige al menos una liga en el filtro «Ligas».');
        return;
      }
      const { items: all, markets } = findArbs(onlyBooks(data, f.books), { type: f.type });
      const items = all.filter((it) => it.pct * 100 >= f.minPct - 1e-9);
      const out = byGame(items, limit, card);
      shown = out.shown;
      $('.pro-status').textContent = `${items.length} ${items.length === 1 ? 'arbitraje' : 'arbitrajes'} en ${markets} mercados analizados`;
      listEl.innerHTML = items.length
        ? h`${out.html}${items.length > limit ? h`<button type="button" class="btn pro-more" data-more>Mostrar más (${items.length - limit} restantes)</button>` : ''}`
        : empty(markets ? 'No hay arbitrajes con estos filtros ahora mismo. Prueba con más ligas o casas.' : 'No hay cuotas disponibles para las ligas elegidas.');
    }

    function copyFor(it) {
      const p = plan(it);
      const st = p.rounded?.stakes ?? p.stakes;
      return [
        `Arbitraje ${fmtPct(it.pct, 2)} · ${it.game?.title ?? ''}${it.game?.start ? ` · ${when(it.game.start)}` : ''}`,
        it.market,
        ...it.legs.map((l, j) => `- ${l.label} ${fmtOdds(l.price)} en ${bookInfo(l.book).name}: apostar ${fmtMoney(st[j])}`),
        p.rounded
          ? `Ganancia (redondeado): ${signedMoney(p.rounded.min)} sobre ${fmtMoney(p.rounded.total)}`
          : `Ganancia segura: ${signedMoney(p.profit)} sobre ${fmtMoney(p.total)}`,
      ].join('\n');
    }

    listEl.addEventListener('click', async (e) => {
      const more = e.target.closest('[data-more]');
      if (more) {
        limit += LIMIT;
        draw();
        return;
      }
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        const it = shown[+cp.dataset.copy];
        if (it && (await copyText(copyFor(it)))) say('Arbitraje copiado al portapapeles.');
        return;
      }
      const add = e.target.closest('[data-add]');
      const it = add && shown[+add.dataset.add];
      if (!it) return;
      const picks = picksOf(it);
      if (inSlip(it)) {
        picks.forEach((p) => store.removePick(p.id));
        say('Patas quitadas del boleto.');
      } else {
        picks.forEach((p) => store.addPick({ ...p, addedAt: Date.now() }));
        say(`${picks.length} patas agregadas al boleto.`);
      }
    });

    // El boleto cambió (aquí u otra vista): se actualizan los botones en su sitio, sin perder el foco.
    const off = store.on('picks', () => {
      for (const b of el.querySelectorAll('[data-add]')) {
        const it = shown[+b.dataset.add];
        if (!it) continue;
        b.setAttribute('aria-pressed', String(inSlip(it)));
        b.textContent = addLabel(it);
      }
    });

    paintBar();
    load();
    return () => {
      dead = true;
      off();
    };
  },
};
