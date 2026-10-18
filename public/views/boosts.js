// Boosts (/pro/boosts): evaluador de boosts de cuota. Ninguna fuente gratuita publica los boosts de las casas,
// así que el usuario escribe el boost y sus patas. Cada pata se toma de las cuotas reales (props de /api/props o
// líneas de /api/odds; la probabilidad justa sale del devig del consenso de casas) o se ingresa a mano.
// Probabilidad del combinado = producto de las patas (supone independencia y avisa si hay patas del mismo partido).
import { LEAGUES, leagueById } from '../leagues.js';
import { statOf } from '../stats.js';
import { devig, fairFromBooks, expectedValue, kelly, hitRate } from '../betmath.js';
import { h, raw, fmtOdds, fmtPct, fmtMoney, when, ago, bookChip, bookInfo, BOOKS, hitBar, empty, sourceBadge, dropdown, tabs } from '../ui.js';
import { METHODS, kellyOptions, optionsHtml, showMethodsInfo, parseOdds, dataOf, num, marketsOf, fullRows, started } from './ev.js';

const MAX_LEGS = 12, MAX_SAVED = 100, MAX_RESULTS = 25;
const ORDERS = [['ev', 'Mayor EV'], ['kelly', 'Mayor Kelly'], ['odds', 'Mayor cuota'], ['recent', 'Más recientes']];
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pctSigned = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—');
const blank = () => ({ id: newId(), desc: '', boosted: '', original: '', maxStake: '', book: '', legs: [], savedAt: null });

// ---------- cálculo (puro) ----------

// Probabilidad justa de una pata: { p, how, withVig }.
export function legProb(leg, method = 'multiplicative') {
  if (leg.prob > 0 && leg.prob < 1) return { p: leg.prob, how: 'Probabilidad fija (manual)' };
  if (leg.rows?.length) {
    const r = fairFromBooks(leg.rows, { method });
    const n = r?.used.length ?? 0;
    return { p: r?.probs[leg.idx] ?? null, how: n ? `Devig del consenso de ${n} ${n === 1 ? 'casa' : 'casas'}` : 'Sin cuotas para el devig' };
  }
  if (leg.price > 1 && leg.opp > 1) return { p: devig([leg.price, leg.opp], method)?.[0] ?? null, how: 'Devig de tus dos cuotas' };
  if (leg.price > 1) return { p: 1 / leg.price, how: 'Una sola cuota: incluye el vig', withVig: true };
  return { p: null, how: 'Sin probabilidad' };
}

// b: { boosted, original (decimales o null), maxStake, legs }. opts: { method, kellyMult, bankroll }.
export function evaluateBoost(b, { method = 'multiplicative', kellyMult = 1, bankroll = 0 } = {}) {
  const legs = b.legs ?? [];
  const probs = legs.map((l) => legProb(l, method));
  const boosted = b.boosted > 1 ? b.boosted : null, original = b.original > 1 ? b.original : null;
  const complete = probs.length > 0 && probs.every((x) => x.p > 0 && x.p < 1);
  const prob = complete ? probs.reduce((t, x) => t * x.p, 1) : null;
  const ev = prob != null && boosted ? expectedValue(prob, boosted) : null;
  const k = ev != null ? kelly(prob, boosted, kellyMult) : null;
  const cap = b.maxStake > 0 ? b.maxStake : Infinity;
  const full = k != null && bankroll > 0 ? k * bankroll : null;
  const games = legs.map((l) => norm(l.event)).filter(Boolean);
  return {
    probs, prob, fairOdds: prob ? 1 / prob : null, ev, kelly: k,
    stake: full == null ? null : Math.min(full, cap), capped: full != null && full > cap,
    boostPct: boosted && original ? (boosted - 1) / (original - 1) - 1 : null,
    evOriginal: prob != null && original ? expectedValue(prob, original) : null,
    missing: probs.some((x) => !(x.p > 0 && x.p < 1)), withVig: probs.some((x) => x.withVig),
    sameGame: new Set(games).size < games.length,
  };
}

// Acierto en los últimos 10 partidos (results del más antiguo al más reciente, como ui.hitBar).
export function l10(log, sport, leg) {
  const vals = (log?.games ?? []).map((g) => statOf(sport, leg.stat, g.stats)).filter(Number.isFinite).slice(0, 10);
  if (!vals.length || !Number.isFinite(leg.line)) return null;
  const r = hitRate(vals, leg.line, leg.side);
  return { ...r, decided: r.n - r.pushes, results: vals.map((v) => (v === leg.line ? null : leg.side === 'Under' ? v < leg.line : v > leg.line)).reverse() };
}

// ---------- datos guardados (localStorage: se valida todo) ----------
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');
const fin = (v) => (Number.isFinite(v) ? v : null);
function cleanLeg(l) {
  if (!l || typeof l !== 'object' || typeof l.label !== 'string' || !l.label.trim()) return null;
  const rows = Array.isArray(l.rows) ? l.rows.filter((r) => r && typeof r.key === 'string' && Array.isArray(r.prices) && r.prices.length >= 2 && r.prices.every((x) => Number.isFinite(x) && x > 1)).slice(0, 60).map((r) => ({ key: r.key.slice(0, 60), prices: r.prices.slice(0, 4) })) : [];
  return {
    id: str(l.id, 40) || newId(), kind: ['prop', 'line', 'manual'].includes(l.kind) ? l.kind : 'manual', label: str(l.label),
    league: leagueById(l.league) ? l.league : null, event: str(l.event, 120) || null, matchup: str(l.matchup), start: str(l.start, 40),
    idx: Number.isInteger(l.idx) && l.idx >= 0 && l.idx < 4 ? l.idx : 0, rows,
    price: fin(l.price), opp: fin(l.opp), prob: fin(l.prob),
    player: str(l.player, 120), athleteId: typeof l.athleteId === 'string' || Number.isFinite(l.athleteId) ? l.athleteId : null,
    stat: str(l.stat, 40) || null, line: fin(l.line), side: l.side === 'Under' ? 'Under' : 'Over', at: fin(l.at),
  };
}
export function cleanBoost(x) {
  if (!x || typeof x !== 'object') return null;
  return {
    id: str(x.id, 40) || newId(), desc: str(x.desc, 120), boosted: str(x.boosted, 20), original: str(x.original, 20), maxStake: str(String(x.maxStake ?? ''), 20),
    book: str(x.book, 40), legs: (Array.isArray(x.legs) ? x.legs : []).map(cleanLeg).filter(Boolean).slice(0, MAX_LEGS), savedAt: fin(x.savedAt),
  };
}
const parsed = (b) => ({ ...b, boosted: parseOdds(b.boosted), original: parseOdds(b.original), maxStake: num(b.maxStake) });

// Game logs en memoria durante la sesión (si falla se reintenta la próxima vez).
// shortcut: caché sin límite de tamaño, suficiente para los pocos jugadores de unos boosts.
const logs = new Map();
function gamelogFor(api, leg) {
  const k = `${leg.league}:${leg.athleteId ?? norm(leg.player)}`;
  if (!logs.has(k)) {
    const p = (async () => {
      let id = leg.athleteId;
      if (id == null && leg.player) id = dataOf(await api.search(leg.league, leg.player)).find((a) => norm(a?.name) === norm(leg.player))?.id ?? null;
      return id == null ? null : (await api.gamelog(leg.league, id))?.data ?? null;
    })();
    logs.set(k, p);
    p.catch(() => logs.delete(k));
  }
  return logs.get(k);
}

// Repinta un contenedor y devuelve el foco al elemento con el mismo atributo data-*.
function keepFocus(box, paint) {
  const a = box.contains(document.activeElement) ? document.activeElement : null;
  const attr = a && [...a.attributes].find((x) => x.name.startsWith('data-'));
  paint();
  if (attr) box.querySelector(`[${attr.name}="${CSS.escape(attr.value)}"]`)?.focus();
}

export default {
  title: 'Boosts',
  render(el, ctx) {
    const { api, store } = ctx;
    const s0 = store.get('settings') ?? {};
    const bankroll = () => Number(store.get('settings')?.bankroll) || 0;
    const o = { method: METHODS[s0.devigMethod] ? s0.devigMethod : 'multiplicative', kellyMult: Number(s0.kellyMult) > 0 && Number(s0.kellyMult) <= 1 ? Number(s0.kellyMult) : 0.25 };
    const opts = () => ({ ...o, bankroll: bankroll() });
    let alive = true;
    let draft = cleanBoost(store.get('boostDraft')) ?? blank();
    let mode = 'search';
    let search = { league: leagueById(ctx.league) ? ctx.league : 'nba', q: '', state: 'idle', list: [], notes: [], srcs: [], demo: false, skipped: 0 };
    const lf = { minEv: '', minKelly: '', leagues: [], order: 'ev' };
    const hits = new Map();
    let msgTimer = 0, qTimer = 0, hitTimer = 0;

    const saved = () => (Array.isArray(store.get('boosts')) ? store.get('boosts') : []).map(cleanBoost).filter(Boolean);
    const persist = () => store.set('boostDraft', draft);

    el.innerHTML = h`<section class="bst">
      <div class="view-head"><div><h1>Boosts</h1><p class="hint">Calcula si un boost de cuota tiene valor con la probabilidad justa (sin vig) de cada pata.</p></div></div>
      <p class="bst-limit" role="note"><b>No hay lista automática de boosts:</b> las casas no publican sus promociones en una fuente gratuita. Escribe el boost que ves en tu casa y agrega sus patas: buscándolas en las cuotas reales del mercado (devig del consenso de casas) o a mano. El combinado supone patas independientes.</p>
      <div class="toolbar bst-bar">
        <span class="ev-method"><label>Devig <select data-o="method">${optionsHtml(Object.entries(METHODS).map(([k, [t]]) => [k, t]), o.method)}</select></label><button type="button" class="icon-btn sm" data-info aria-label="Qué significa cada método de devig">?</button></span>
        <label>Kelly <select data-o="kellyMult">${optionsHtml(kellyOptions(o.kellyMult), o.kellyMult)}</select></label>
        <span class="status">Bankroll ${fmtMoney(bankroll())} · se cambia en Ajustes</span>
      </div>
      <div class="bst-grid">
        <form class="card bst-form" aria-labelledby="bst-form-h" novalidate>
          <h2 id="bst-form-h">Tu boost</h2>
          <div class="bst-fields">
            <label class="ev-field bst-wide"><span>Descripción</span><input data-d="desc" maxlength="120" autocomplete="off" placeholder="p. ej. Lakers gana y LeBron más de 24.5 puntos"></label>
            <label class="ev-field"><span>Cuota con boost *</span><input data-d="boosted" maxlength="20" autocomplete="off" placeholder="+575 o 6.75" aria-describedby="bst-odds-hint" required></label>
            <label class="ev-field"><span>Cuota original</span><input data-d="original" maxlength="20" autocomplete="off" placeholder="opcional, p. ej. +450" aria-describedby="bst-odds-hint"></label>
            <label class="ev-field"><span>Apuesta máxima</span><input data-d="maxStake" type="number" min="0" step="any" inputmode="decimal" placeholder="sin tope"></label>
            <label class="ev-field"><span>Casa</span><select data-d="book"><option value="">Sin casa</option>${Object.entries(BOOKS).map(([k, b]) => h`<option value="${k}">${b.name}</option>`)}</select></label>
          </div>
          <p class="hint" id="bst-odds-hint">Cuotas americanas (+575, −110) o decimales (6.75).</p>
          <h3>Patas <span class="bst-n" data-legs-n></span></h3>
          <ol class="bst-legs" data-legs></ol>
          <div class="bst-add">
            <h3 id="bst-add-h" tabindex="-1">Agregar pata</h3>
            <div data-tabs></div>
            <div class="bst-panel" data-panel="search" role="tabpanel" aria-label="Buscar en el mercado">
              <div class="bst-sbar">
                <label class="ev-field"><span>Liga</span><select data-s="league">${optionsHtml(LEAGUES.map((l) => [l.id, l.title]), search.league)}</select></label>
                <label class="ev-field bst-grow"><span>Buscar</span><input type="search" data-s="q" autocomplete="off" placeholder="Jugador, equipo o mercado"></label>
              </div>
              <p class="status" data-s-status></p>
              <ul class="bst-cands" data-cands></ul>
            </div>
            <div class="bst-panel" data-panel="manual" role="tabpanel" aria-label="Pata manual" hidden>
              <div class="bst-fields">
                <label class="ev-field bst-wide"><span>Pata *</span><input data-m="label" maxlength="120" autocomplete="off" placeholder="p. ej. Real Madrid gana"></label>
                <label class="ev-field"><span>Cuota de esta pata</span><input data-m="price" maxlength="20" autocomplete="off" placeholder="p. ej. -150"></label>
                <label class="ev-field"><span>Cuota del lado contrario</span><input data-m="opp" maxlength="20" autocomplete="off" placeholder="p. ej. +130"></label>
                <label class="ev-field"><span>O probabilidad justa %</span><input data-m="prob" type="number" min="0.1" max="99.9" step="any" inputmode="decimal"></label>
                <label class="ev-field"><span>Liga</span><select data-m="league"><option value="">—</option>${optionsHtml(LEAGUES.map((l) => [l.id, l.title]), '')}</select></label>
                <label class="ev-field"><span>Partido (opcional)</span><input data-m="event" maxlength="120" autocomplete="off" placeholder="p. ej. LAL @ BOS"></label>
              </div>
              <p class="hint">Con las dos cuotas se quita el vig; con una sola, la probabilidad incluye el vig. El partido sirve para avisar si dos patas están correlacionadas.</p>
              <p class="bst-err" role="alert" data-m-err></p>
              <button type="submit" class="btn" data-m-add>Agregar pata manual</button>
            </div>
          </div>
        </form>
        <aside class="card bst-result" aria-labelledby="bst-res-h"><h2 id="bst-res-h">Resultado</h2><p class="sr-only" aria-live="polite" data-live></p><div data-result></div></aside>
      </div>
      <section class="bst-saved" aria-labelledby="bst-saved-h">
        <h2 id="bst-saved-h" tabindex="-1">Boosts guardados <span class="bst-n" data-saved-n></span></h2>
        <div class="toolbar bst-lbar">
          <label>Mínimo EV % <input type="number" data-l="minEv" step="0.1" inputmode="decimal" placeholder="—"></label>
          <label>Mínimo Kelly % <input type="number" data-l="minKelly" min="0" step="0.1" inputmode="decimal" placeholder="—"></label>
          <span data-slot="leagues"></span>
          <label>Orden <select data-l="order">${optionsHtml(ORDERS, lf.order)}</select></label>
        </div>
        <div class="bst-cards" data-cards></div>
      </section>
    </section>`;
    const root = el.querySelector('.bst');
    const $ = (s) => root.querySelector(s);
    const form = $('.bst-form');

    // ---------- pestañas para agregar patas ----------
    $('[data-tabs]').append(tabs({
      label: 'Cómo agregar la pata', value: mode,
      items: [{ value: 'search', label: 'Buscar en el mercado' }, { value: 'manual', label: 'Manual' }],
      onChange: (v) => { mode = v; for (const p of root.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== v; },
    }));
    $('[data-slot="leagues"]').append(dropdown({
      label: 'Ligas', multi: true, placeholder: 'Todas', value: lf.leagues,
      options: LEAGUES.map((l) => ({ value: l.id, label: l.title })),
      onChange: (v) => { lf.leagues = v.map(String); paintSaved(); },
    }));

    // ---------- patas y resultado ----------
    function hitOf(leg) {
      if (leg.kind !== 'prop' || !leg.league || !leg.stat || !Number.isFinite(leg.line) || (!leg.player && leg.athleteId == null)) return null;
      const k = [leg.league, leg.athleteId ?? norm(leg.player), leg.stat, leg.line, leg.side].join('|');
      if (!hits.has(k)) {
        hits.set(k, { state: 'loading' });
        gamelogFor(api, leg)
          .then((log) => ({ state: 'ok', r: l10(log, leagueById(leg.league)?.sport, leg) }), () => ({ state: 'error' }))
          .then((v) => {
            hits.set(k, v);
            const repaint = () => { if (alive) { paintLegs(); paintSaved(); } };
            if (v.state === 'error') setTimeout(() => { hits.delete(k); repaint(); }, 15_000); // reintenta solo
            clearTimeout(hitTimer);
            hitTimer = setTimeout(repaint, 150);
          });
      }
      return hits.get(k);
    }
    function hitHtml(leg) {
      const st = hitOf(leg);
      if (!st) return '';
      if (st.state === 'loading') return h`<small class="bst-muted">L10 cargando…</small>`;
      if (st.state === 'error') return h`<small class="bst-muted">L10 no cargó, reintentando…</small>`;
      if (!st.r) return h`<small class="bst-muted">L10 sin historial</small>`;
      return h`${hitBar(st.r.results)}<small>L10 ${st.r.hits}/${st.r.decided}</small>`;
    }
    const legMeta = (l) => [l.matchup || l.event, leagueById(l.league)?.title, l.start ? when(l.start) : ''].filter(Boolean).join(' · ');

    function paintLegs() {
      const box = $('[data-legs]');
      $('[data-legs-n]').textContent = draft.legs.length ? `(${draft.legs.length})` : '';
      keepFocus(box, () => {
        box.innerHTML = draft.legs.length
          ? h`${draft.legs.map((l) => {
            const { p, how } = legProb(l, o.method);
            return h`<li class="bst-leg">
              <div class="bst-leg-main"><b>${l.label}</b>${legMeta(l) ? h`<small>${legMeta(l)}</small>` : ''}<small class="bst-muted">${how}</small></div>
              <div class="bst-leg-side"><b title="Probabilidad justa">${fmtPct(p, 1)}</b><span class="bst-hit">${hitHtml(l)}</span></div>
              <button type="button" class="icon-btn sm" data-rm="${l.id}" aria-label="Quitar la pata ${l.label}">✕</button></li>`;
          })}`
          : h`<li class="bst-empty">Todavía no hay patas. Búscalas abajo o agrégalas a mano.</li>`;
      });
    }

    const picked = (id) => (store.get('picks') ?? []).some((p) => p.id === id);
    function togglePick(b) {
      const id = `boost:${b.id}`;
      if (picked(id)) return store.removePick(id);
      const price = parseOdds(b.boosted);
      if (!(price > 1)) return;
      const label = `Boost: ${b.desc || b.legs.map((l) => l.label).join(' + ')}`.slice(0, 200);
      store.addPick({ id, label, price, book: b.book || null, league: b.legs.find((l) => l.league)?.league ?? null, gameId: null });
    }

    const kpi = (t, v, cls = '') => h`<div class="${cls}"><dt>${t}</dt><dd>${v}</dd></div>`;
    function paintResult() {
      const b = parsed(draft), res = evaluateBoost(b, opts());
      const box = $('[data-result]'), live = $('[data-live]');
      const warns = [];
      if (draft.boosted && !b.boosted) warns.push('La cuota con boost no es válida: usa americana (+575) o decimal (6.75).');
      if (draft.original && !b.original) warns.push('La cuota original no es válida.');
      if (res.missing && draft.legs.length) warns.push('Alguna pata no tiene probabilidad justa: complétala o quítala.');
      if (res.sameGame) warns.push('Hay patas del mismo partido: suelen estar correlacionadas, así que la probabilidad real del combinado puede ser bastante distinta del producto. Las casas suelen poner boosts justo en combinaciones correlacionadas.');
      if (res.withVig) warns.push('Hay patas con una sola cuota: su probabilidad incluye el vig, así que el EV calculado es conservador.');
      if (draft.legs.some((l) => l.at && Date.now() - l.at > 3 * 3600e3)) warns.push('Algunas patas usan cuotas guardadas hace más de 3 horas; vuelve a buscarlas para actualizarlas.');
      live.textContent = res.ev != null ? `EV ${pctSigned(res.ev)}, Kelly ${fmtPct(res.kelly, 2)}` : '';
      const inSlip = picked(`boost:${draft.id}`);
      const ready = b.boosted && draft.legs.length;
      keepFocus(box, () => {
        box.innerHTML = h`${!draft.legs.length ? empty('Agrega al menos una pata para calcular el valor del boost.') : !b.boosted ? empty('Escribe la cuota con boost.') : h`<dl class="bst-kpis">
            ${kpi('EV', pctSigned(res.ev), `bst-big ${res.ev >= 0 ? 'pos' : 'neg'}`)}
            ${kpi('Prob. justa del combinado', h`${fmtPct(res.prob, 2)} <small>cuota justa ${fmtOdds(res.fairOdds)}</small>`)}
            ${kpi('Prob. implícita del boost', fmtPct(1 / b.boosted, 2))}
            ${kpi('Kelly', fmtPct(res.kelly, 2))}
            ${kpi('Monto sugerido', h`${fmtMoney(res.stake)}${res.capped ? h` <small>tope de la casa</small>` : ''}`)}
            ${b.original ? kpi('Boost sobre la original', h`${pctSigned(res.boostPct, 1)} <small>EV sin boost ${pctSigned(res.evOriginal)}</small>`) : ''}
          </dl>`}
          ${warns.length ? h`<ul class="bst-warn">${warns.map((w) => h`<li>${w}</li>`)}</ul>` : ''}
          <div class="bst-actions">
            <button type="button" class="btn btn-primary" data-save${ready ? '' : raw(' disabled')}>${saved().some((x) => x.id === draft.id) ? 'Actualizar guardado' : 'Guardar boost'}</button>
            <button type="button" class="btn" data-pick-draft aria-pressed="${String(inSlip)}"${ready ? '' : raw(' disabled')}>${inSlip ? '✓ En el boleto' : 'Agregar al boleto'}</button>
            <button type="button" class="btn" data-new>Nuevo boost</button>
          </div>
          <p class="bst-msg" role="status" data-msg></p>`;
      });
    }

    function paintForm() {
      for (const inp of form.querySelectorAll('[data-d]')) inp.value = draft[inp.dataset.d] ?? '';
      for (const k of ['boosted', 'original']) form.querySelector(`[data-d="${k}"]`).toggleAttribute('aria-invalid', !!draft[k] && !parseOdds(draft[k]));
    }

    function flash(msg) {
      const m = $('[data-msg]');
      if (!m) return;
      m.textContent = msg;
      clearTimeout(msgTimer);
      msgTimer = setTimeout(() => { if (m.isConnected) m.textContent = ''; }, 4000);
    }

    // ---------- búsqueda en el mercado ----------
    async function loadCands(id) {
      const lg = leagueById(id);
      search = { ...search, league: id, state: 'loading', list: [], notes: [], srcs: [], demo: false, skipped: 0 };
      paintSearch();
      const jobs = [lg?.odds ? api.odds(lg.odds).then((b) => ['lines', b]) : null, api.props(id).then((b) => ['props', b])].filter(Boolean);
      const res = await Promise.allSettled(jobs);
      if (!alive || search.league !== id) return;
      const list = [], notes = [], srcs = [];
      let demo = false, skipped = 0;
      if (!lg?.odds) notes.push(`The Odds API no cubre las líneas de partido de ${lg?.title ?? id}.`);
      res.forEach((r, i) => {
        const kind = jobs.length === 2 && i === 0 ? 'lines' : 'props';
        if (r.status === 'rejected') return notes.push(`${kind === 'lines' ? 'Líneas' : 'Props'}: ${r.reason?.message ?? 'no se pudieron cargar'}`);
        const body = r.value[1];
        if (body?.source === 'demo') demo = true;
        srcs.push([kind, body]);
        for (const m of marketsOf(id, r.value[0], dataOf(body))) {
          if (started(m.start)) continue;
          const rows = fullRows(m);
          if (m.a.names.length < 2 || !rows.length) { skipped++; continue; }
          m.a.names.forEach((n, idx) => list.push({ m, n, idx, rows, label: m.label(n), hay: norm(`${m.label(n)} ${m.matchup} ${m.title}`) }));
        }
      });
      search = { ...search, state: 'ok', list, notes, srcs, demo, skipped };
      paintSearch();
    }

    function matchesQ() {
      const tokens = norm(search.q).split(/\s+/).filter(Boolean);
      return tokens.length ? search.list.filter((c) => tokens.every((t) => c.hay.includes(t))) : [];
    }

    function paintSearch() {
      const st = $('[data-s-status]'), box = $('[data-cands]');
      const found = search.state === 'ok' ? matchesQ() : [];
      const srcs = search.srcs.map(([k, b]) => h`<span>${k === 'lines' ? 'Líneas' : 'Props'} ${sourceBadge(b)}</span>`);
      st.innerHTML = search.state === 'loading' ? 'Cargando cuotas…'
        : search.state !== 'ok' ? ''
        : h`${search.q.trim() ? `${found.length} ${found.length === 1 ? 'resultado' : 'resultados'}${found.length > MAX_RESULTS ? ` (se muestran ${MAX_RESULTS})` : ''}` : `${search.list.length} selecciones con devig disponible. Escribe para buscar.`} ${srcs}
          ${search.demo ? h`<span class="bst-warn-i">Cuotas de demostración: no son reales.</span>` : ''}
          ${search.notes.map((n) => h`<span class="bst-muted">${n}</span>`)}`;
      const inDraft = new Set(draft.legs.map((l) => `${l.event}|${l.label}`));
      keepFocus(box, () => {
        box.innerHTML = h`${found.slice(0, MAX_RESULTS).map((c, i) => {
          const p = fairFromBooks(c.rows, { method: o.method })?.probs[c.idx];
          const best = c.m.a.best[c.n];
          const added = inDraft.has(`${c.m.event}|${c.label}`);
          return h`<li><button type="button" class="bst-cand" data-cand="${i}"${added ? raw(' aria-disabled="true"') : ''}>
            <span class="bst-cand-l"><span class="sr-only">${added ? 'Ya agregada: ' : 'Agregar pata: '}</span><b>${c.label}</b><small>${[c.m.matchup, when(c.m.start)].filter(Boolean).join(' · ')}</small></span>
            <span class="bst-cand-r"><b>${fmtPct(p, 1)}</b><small>justa · mejor ${fmtOdds(best?.price)} ${bookInfo(best?.key || best?.book).name}</small></span>
            ${added ? h`<span class="bst-cand-ok" aria-hidden="true">✓</span>` : ''}</button></li>`;
        })}`;
      });
    }

    function addLeg(leg) {
      if (draft.legs.length >= MAX_LEGS) { flash(`Máximo ${MAX_LEGS} patas.`); return false; }
      draft = { ...draft, legs: [...draft.legs, leg] };
      persist();
      paintLegs();
      paintResult();
      return true;
    }

    function addCandidate(c) {
      if (draft.legs.some((l) => l.event === c.m.event && l.label === c.label)) return;
      const a = c.m.a;
      const ok = addLeg({
        id: newId(), kind: c.m.kind === 'props' ? 'prop' : 'line', label: c.label, league: c.m.league, event: c.m.event, matchup: c.m.matchup,
        start: c.m.start ?? '', idx: c.idx, rows: c.rows.map((r) => ({ key: r.key, prices: [...r.prices] })), price: null, opp: null, prob: null,
        player: c.m.kind === 'props' ? a.player : '', athleteId: c.m.kind === 'props' ? a.athleteId ?? null : null,
        stat: c.m.kind === 'props' ? a.stat : null, line: c.m.kind === 'props' && Number.isFinite(a.line) ? a.line : null, side: c.n === 'Under' ? 'Under' : 'Over', at: Date.now(),
      });
      if (ok) { paintSearch(); flash(`Pata agregada: ${c.label}.`); }
    }

    function addManual() {
      const v = (k) => form.querySelector(`[data-m="${k}"]`).value.trim();
      const err = $('[data-m-err]');
      const label = v('label'), price = v('price') ? parseOdds(v('price')) : null, opp = v('opp') ? parseOdds(v('opp')) : null;
      const pct = num(v('prob'));
      const problem = !label ? 'Escribe el nombre de la pata.'
        : v('price') && !price ? 'La cuota de la pata no es válida.'
        : v('opp') && !opp ? 'La cuota del lado contrario no es válida.'
        : pct != null && !(pct > 0 && pct < 100) ? 'La probabilidad debe estar entre 0 y 100 %.'
        : pct == null && !price ? 'Escribe la cuota de la pata o su probabilidad justa.'
        : opp && !price ? 'Falta la cuota de esta pata (la contraria sola no sirve).' : '';
      err.textContent = problem;
      if (problem) return;
      const ok = addLeg({
        id: newId(), kind: 'manual', label: label.slice(0, 120), league: v('league') || null, event: v('event').slice(0, 120) || null, matchup: v('event').slice(0, 120),
        start: '', idx: 0, rows: [], price, opp, prob: pct != null ? pct / 100 : null, player: '', athleteId: null, stat: null, line: null, side: 'Over', at: null,
      });
      if (!ok) return;
      for (const k of ['label', 'price', 'opp', 'prob']) form.querySelector(`[data-m="${k}"]`).value = '';
      form.querySelector('[data-m="label"]').focus();
      flash(`Pata agregada: ${label}.`);
    }

    // ---------- guardados ----------
    function paintSaved() {
      const list = saved();
      const minEv = num(lf.minEv), minK = num(lf.minKelly);
      const rows = list.map((b) => ({ b, p: parsed(b), res: evaluateBoost(parsed(b), opts()) }))
        .filter(({ b, res }) => (minEv == null || (res.ev != null && res.ev * 100 >= minEv)) &&
          (minK == null || (res.kelly != null && res.kelly * 100 >= minK)) &&
          (!lf.leagues.length || b.legs.some((l) => lf.leagues.includes(l.league))));
      const by = { ev: (r) => r.res.ev, kelly: (r) => r.res.kelly, odds: (r) => r.p.boosted, recent: (r) => r.b.savedAt };
      rows.sort((x, y) => (by[lf.order](y) ?? -Infinity) - (by[lf.order](x) ?? -Infinity));
      $('[data-saved-n]').textContent = list.length ? `(${rows.length}/${list.length})` : '';
      const box = $('[data-cards]');
      keepFocus(box, () => {
        box.innerHTML = !list.length ? empty('Aún no guardas boosts. Evalúa uno arriba y pulsa «Guardar boost».')
          : !rows.length ? empty('Ningún boost guardado cumple los filtros.')
          : h`${rows.map(({ b, p, res }) => {
            const oldest = Math.min(...b.legs.map((l) => l.at ?? Infinity));
            const inSlip = picked(`boost:${b.id}`);
            const bk = b.book ? bookInfo(b.book).name : '';
            return h`<article class="card bst-card" aria-label="Boost a ${fmtOdds(p.boosted)}">
              <header class="bst-card-h"><b class="bst-boosted">Boost a ${fmtOdds(p.boosted)}</b><span class="bst-tag">${p.original ? `antes ${fmtOdds(p.original)}` : 'Odds boost'}</span>${b.book ? bookChip(b.book) : ''}</header>
              ${b.desc ? h`<p class="bst-desc">${b.desc}</p>` : ''}
              <ul class="bst-card-legs">${b.legs.map((l, i) => h`<li><span class="bst-cl">${l.label}${legMeta(l) ? h`<small>${legMeta(l)}</small>` : ''}</span><span class="bst-hit">${hitHtml(l)}</span><b title="Probabilidad justa">${fmtPct(res.probs[i]?.p, 1)}</b></li>`)}</ul>
              <dl class="bst-kpis bst-kpis-sm">
                ${kpi('EV', pctSigned(res.ev), res.ev >= 0 ? 'pos' : 'neg')}${kpi('Kelly', fmtPct(res.kelly, 2))}${kpi('Monto', fmtMoney(res.stake))}${kpi('Prob. justa', fmtPct(res.prob, 2))}
              </dl>
              ${res.sameGame ? h`<p class="bst-muted">Patas del mismo partido: probablemente correlacionadas.</p>` : ''}
              <p class="bst-muted">${Number.isFinite(oldest) ? `Cuotas tomadas ${ago(new Date(oldest).toISOString())}` : 'Patas manuales'}${b.savedAt ? ` · guardado ${ago(new Date(b.savedAt).toISOString())}` : ''}</p>
              <div class="bst-card-act">
                <button type="button" class="btn btn-primary" data-pick="${b.id}" aria-pressed="${String(inSlip)}"${p.boosted ? '' : raw(' disabled')}>${inSlip ? '✓ En el boleto' : `Al boleto${bk ? ` en ${bk}` : ''} ${fmtOdds(p.boosted)}`}</button>
                <button type="button" class="btn" data-edit="${b.id}">Editar</button>
                <button type="button" class="icon-btn" data-del="${b.id}" aria-label="Eliminar el boost a ${fmtOdds(p.boosted)}">✕</button>
              </div></article>`;
          })}`;
      });
    }

    // ---------- eventos ----------
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.o) {
        o[t.dataset.o] = t.dataset.o === 'kellyMult' ? Number(t.value) : t.value;
        paintLegs(); paintResult(); paintSearch(); paintSaved();
      } else if (t.dataset.s === 'league') loadCands(t.value);
      else if (t.dataset.l === 'order') { lf.order = t.value; paintSaved(); }
      else if (t.dataset.d === 'book') { draft = { ...draft, book: t.value }; persist(); paintResult(); }
    });
    root.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.d && t.dataset.d !== 'book') {
        draft = { ...draft, [t.dataset.d]: t.value };
        persist();
        if (t.dataset.d === 'boosted' || t.dataset.d === 'original') t.toggleAttribute('aria-invalid', !!t.value && !parseOdds(t.value));
        paintResult();
      } else if (t.dataset.s === 'q') {
        search.q = t.value;
        clearTimeout(qTimer);
        qTimer = setTimeout(() => alive && paintSearch(), 150);
      } else if (t.dataset.l === 'minEv' || t.dataset.l === 'minKelly') { lf[t.dataset.l] = t.value; paintSaved(); }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (mode === 'manual' && (e.submitter?.dataset.mAdd != null || form.querySelector('[data-panel="manual"]').contains(document.activeElement))) addManual();
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.info != null) return showMethodsInfo(() => b.isConnected && b.focus());
      if (b.dataset.cand != null) { const c = matchesQ()[b.dataset.cand]; if (c) addCandidate(c); return; }
      if (b.dataset.rm != null) {
        const i = draft.legs.findIndex((l) => l.id === b.dataset.rm);
        draft = { ...draft, legs: draft.legs.filter((l) => l.id !== b.dataset.rm) };
        persist(); paintLegs(); paintResult(); paintSearch();
        const next = root.querySelectorAll('[data-rm]')[Math.min(i, draft.legs.length - 1)];
        (next ?? $('#bst-add-h')).focus();
        return;
      }
      if (b.dataset.save != null) {
        const b2 = parsed(draft);
        if (!b2.boosted || !draft.legs.length) return;
        const list = saved();
        const rec = { ...structuredClone(draft), savedAt: Date.now() };
        const at = list.findIndex((x) => x.id === draft.id);
        if (at >= 0) list[at] = rec;
        else list.unshift(rec);
        store.set('boosts', list.slice(0, MAX_SAVED));
        draft = rec;
        persist(); paintResult(); paintSaved();
        flash(at >= 0 ? 'Boost actualizado.' : 'Boost guardado.');
        return;
      }
      if (b.dataset.pickDraft != null) { togglePick(draft); return; }
      if (b.dataset.new != null) {
        if (draft.legs.length && !saved().some((x) => x.id === draft.id) && !window.confirm('¿Empezar un boost nuevo? Se borra el que no guardaste.')) return;
        draft = blank();
        persist(); paintForm(); paintLegs(); paintResult(); paintSearch();
        form.querySelector('[data-d="boosted"]').focus();
        return;
      }
      const rec = saved().find((x) => x.id === (b.dataset.pick ?? b.dataset.edit ?? b.dataset.del));
      if (!rec) return;
      if (b.dataset.pick != null) togglePick(rec);
      else if (b.dataset.edit != null) {
        draft = structuredClone(rec);
        persist(); paintForm(); paintLegs(); paintResult(); paintSearch();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        form.querySelector('[data-d="boosted"]').focus({ preventScroll: true });
      } else if (b.dataset.del != null && window.confirm('¿Eliminar este boost guardado?')) {
        store.set('boosts', saved().filter((x) => x.id !== rec.id));
        paintSaved(); paintResult();
        $('#bst-saved-h').focus();
      }
    });

    const offPicks = store.on('picks', () => { if (alive) { paintResult(); paintSaved(); } });
    paintForm();
    paintLegs();
    paintResult();
    paintSaved();
    loadCands(search.league);
    return () => {
      alive = false;
      clearTimeout(msgTimer); clearTimeout(qTimer); clearTimeout(hitTimer);
      offPicks();
    };
  },
};
