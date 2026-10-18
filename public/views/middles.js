// Middles (/pro/middles): dos lados opuestos en casas distintas con líneas diferentes (Más de 31.5 y Menos de 32,
// Celtics −2.5 y Lakers +3.5…). Si el resultado cae entre las líneas se cobran ambas; si no, se pierde poco.
// Totales y hándicaps de partido (con alternativas cuando vienen) y props de jugador. Matemática: bm.findMiddles.
// Las probabilidades salen de un modelo (normal o Poisson) alrededor de la línea consenso: son estimaciones.
import * as bm from '../betmath.js';
import { leagueById } from '../leagues.js';
import { statOf, statForMarket } from '../stats.js';
import { h, fmtOdds, fmtPct, fmtMoney, when, bookChip, bookInfo, hitBar, empty, loading } from '../ui.js';
import {
  defaultLeague, bookKey, num, signed, signedMoney, sideName, TYPES, statLabel, loadMarkets, onlyBooks, explode, gameIndex, gameOfProp,
  byGame, copyText, numField, seg, leaguesDropdown, booksDropdown, seenBooks, presetsBox, sourcesLine, errorsLine,
} from './arbitrage.js';

const MARKET = { totals: 'Total', spreads: 'Hándicap' };
const VERB = { win: 'gana', loss: 'pierde', push: 'push en' };
const SHORT = { win: 'gana', loss: 'pierde', push: 'push' };
const r1 = (x) => Math.round(x * 10) / 10;
const median = (xs) => bm.summarize(xs).median;
const okLine = (l) => l.price > 1 && Number.isInteger(l.line * 2);

export const rangeText = (o) => (o.min === -Infinity ? `${o.max} o menos` : o.max === Infinity ? `${o.min} o más` : o.min === o.max ? `Exactamente ${o.min}` : `De ${o.min} a ${o.max}`);

// Todos los middles entre casas distintas. → { items (EV desc), markets: mercados analizados }
export function findAllMiddles({ events = [], props = [] }, { type = 'all', bankroll = 100 } = {}) {
  const idx = gameIndex(events);
  const items = [];
  let markets = 0;
  const add = (m, lines, label, it) => {
    const [a, b] = m.legs;
    if (a.bookKey === b.bookKey) return;
    // Casas que igualan la mejor cuota de cada pata (Outlier muestra "2 casas").
    const books = (l) => [...new Set(lines.filter((x) => x.side === l.side && x.line === l.line && x.price === l.price).map((x) => x.book))];
    items.push({ ...it, key: `${it.key}|${a.side}${a.line}|${b.side}${b.line}`, m, legs: m.legs.map((l) => ({ ...l, label: label(l), books: books(l) })) });
  };

  if (type !== 'props') {
    for (const ev of events) {
      const sport = leagueById(ev.league)?.sport;
      const groups = explode(ev);
      for (const base of ['totals', 'spreads']) {
        // Principales primero: en hándicaps fijan el equipo cuyo margen modela findMiddles (teams[0]).
        const gs = groups.filter((g) => g.base === base).sort((x, y) => y.main - x.main);
        const lines = gs.flatMap((g) => g.event.bookmakers.flatMap((b) => b.markets[0].outcomes.map((o) => ({ side: o.name, line: o.point, price: o.price, book: b.title ?? b.key, bookKey: bookKey(b.key ?? b.title) }))));
        const first = lines.find(okLine)?.side;
        if (!first) continue;
        markets++;
        // Media del modelo: la línea principal (mediana entre casas), no la de las alternativas.
        const mains = gs.filter((g) => g.main).map((g) => (base === 'totals' ? g.line : first === ev.home_team ? -g.line : g.line));
        const label = (l) => (base === 'totals' ? `${sideName(l.side)} ${l.line}` : `${l.side} ${signed(l.line)}`);
        for (const m of bm.findMiddles(lines, base === 'totals' ? 'total' : 'spread', { sport, bankroll, mean: median(mains) })) {
          add(m, lines, label, { kind: 'lines', base, key: `${ev.id}|${base}`, league: ev.league, gameId: null, game: idx.get(ev.id), market: MARKET[base] });
        }
      }
    }
  }

  if (type !== 'lines') {
    const groups = new Map();
    for (const p of props) {
      if (p.line == null || !/^(over|under)$/i.test(p.side)) continue;
      const k = [p.league, p.eventId ?? p.gameId, p.player, p.stat ?? p.market].join('|');
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const [k, ps] of groups) {
      const lines = ps.flatMap((p) => (p.books ?? []).map((b) => ({ side: p.side, line: Number(p.line), price: b.price, book: b.title ?? b.key, bookKey: bookKey(b.key ?? b.title) })));
      const mu = median(lines.filter(okLine).map((l) => l.line));
      if (mu == null) continue;
      markets++;
      const p = ps[0];
      // shortcut: dispersión típica de un prop (CV ≈ 0.3), no la del jugador; usar su game log si se quiere afinar.
      // Solo aplica con la normal (media ≥ 15); por debajo findMiddles usa Poisson.
      const sigma = Math.max(Math.sqrt(Math.abs(mu)), 0.3 * Math.abs(mu));
      for (const m of bm.findMiddles(lines, 'total', { bankroll, sigma })) {
        add(m, lines, (l) => `${sideName(l.side)} ${l.line}`, {
          kind: 'props', base: 'props', key: k, league: p.league, gameId: p.gameId ?? null, game: gameOfProp(p, idx),
          market: `${p.player} · ${statLabel(p)}`, prop: { athleteId: p.athleteId ?? null, stat: p.stat, market: p.market, league: p.league },
        });
      }
    }
  }
  return { items: items.sort((x, y) => y.m.ev - x.m.ev), markets };
}

const LIMIT = 30;

export default {
  title: 'Middles',
  render(el, { league, api, store }) {
    const settings = store.get('settings') ?? {};
    const def = () => ({ minMid: -5, minEv: null, leagues: [defaultLeague(league)], books: [...(settings.books ?? [])], type: 'all', bankroll: num(settings.bankroll, 100) > 0 ? num(settings.bankroll, 100) : 100 });
    const clean = (x = {}) => {
      const d = def();
      return {
        minMid: num(x.minMid, d.minMid),
        minEv: x.minEv == null || x.minEv === '' ? null : num(x.minEv, null),
        leagues: Array.isArray(x.leagues) ? x.leagues.filter((id) => leagueById(id)?.odds) : d.leagues,
        books: Array.isArray(x.books) ? x.books.map(String) : d.books,
        type: TYPES[x.type] ? x.type : d.type,
        bankroll: num(x.bankroll, 0) > 0 ? num(x.bankroll, 0) : d.bankroll,
      };
    };
    let f = def();
    let data = null, dead = false, seq = 0, limit = LIMIT, shown = [], seen = new Set();
    const cache = new Map();
    const logs = new Map(); // `${league}|${athleteId}` → GameLog | null
    const pending = new Set();

    el.innerHTML = h`<section class="pro mid">
      <div class="view-head"><div>
        <h1>Middles</h1>
        <p class="hint">Dos lados opuestos con líneas distintas en casas distintas. Si el resultado cae entre las dos líneas cobras ambas apuestas; si no, pierdes poco (el «Middle %»).</p>
      </div></div>
      <div class="toolbar pro-bar"></div>
      <div class="pro-meta"><p class="pro-status" role="status" aria-live="polite"></p><p class="pro-srcs"></p></div>
      <div class="pro-errbox"></div>
      <div class="pro-list"></div>
      <p class="pro-note"><b>Middle %</b> = lo que se gana o pierde (sobre el monto total) si el resultado no cae en el medio. <b>EV %</b> = valor esperado con las probabilidades del modelo (normal o Poisson alrededor de la línea consenso; en props, dispersión típica del 30%). Son estimaciones: confirma las cuotas antes de apostar.</p>
      <p class="sr-only" aria-live="polite" data-live></p>
    </section>`;
    const $ = (s) => el.querySelector(s);
    const bar = $('.pro-bar'), listEl = $('.pro-list');
    const say = (msg) => { $('[data-live]').textContent = msg; };

    let booksSlot;
    function paintBar() {
      booksSlot = Object.assign(document.createElement('div'), { className: 'pro-slot' });
      booksSlot.append(booksDropdown(f.books, seen, (v) => { f.books = v.map(String); draw(); }));
      let lt;
      bar.replaceChildren(
        presetsBox(store, 'middles', () => ({ ...f }), (p) => { f = clean(p); paintBar(); load(); }),
        numField('Middle % mínimo', f.minMid, { step: '0.1', onInput: (v) => { f.minMid = num(v, -Infinity); draw(); } }),
        numField('EV % mínimo', f.minEv, { step: '0.1', placeholder: 'Cualquiera', onInput: (v) => { f.minEv = v === '' ? null : num(v, null); draw(); } }),
        leaguesDropdown(f.leagues, (v) => { f.leagues = v.map(String); clearTimeout(lt); lt = setTimeout(load, 400); }),
        booksSlot,
        seg('Tipo', TYPES, f.type, (v) => { f.type = v; load(); }),
        numField('Monto total', f.bankroll, { min: 0.01, step: '0.01', onInput: (v) => { if (num(v, 0) > 0) { f.bankroll = num(v, 0); draw(); } } }),
        Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Actualizar cuotas', onclick: () => load(true) }),
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
      $('.pro-status').textContent = 'Buscando middles…';
      const res = await loadMarkets(api, f.leagues, { lines: f.type !== 'props', props: f.type !== 'lines', fresh, cache });
      if (dead || my !== seq) return;
      data = res;
      const s = seenBooks(res);
      if ([...s].some((k) => !seen.has(k))) {
        seen = new Set([...seen, ...s]);
        if (booksSlot && !booksSlot.querySelector('[aria-expanded="true"]')) booksSlot.replaceChildren(booksDropdown(f.books, seen, (v) => { f.books = v.map(String); draw(); }));
      }
      draw();
    }

    // ---------- barras de acierto L10 (props) ----------
    const logKey = (it) => `${it.league}|${it.prop.athleteId}`;
    function hitHtml(it, l) {
      if (!it.prop.athleteId) return h`<small>Sin game log</small>`;
      if (!logs.has(logKey(it))) return h`<small>Cargando acierto…</small>`;
      const sport = leagueById(it.league)?.sport;
      const key = it.prop.stat ?? statForMarket(sport, it.prop.market)?.key;
      const vals = (logs.get(logKey(it))?.games ?? []).map((g) => statOf(sport, key, g.stats)).filter(Number.isFinite).slice(0, 10);
      if (!vals.length) return h`<small>Sin game log</small>`;
      // Del más antiguo al más reciente; null = push (igual a la línea).
      const res = vals.map((v) => (v === l.line ? null : l.side === 'Under' ? v < l.line : v > l.line)).reverse();
      return h`${hitBar(res, { label: true })}<small>L10 · ${res.filter((x) => x === true).length}/${res.filter((x) => x != null).length}</small>`;
    }
    function fillHits(k) {
      shown.forEach((it, i) => {
        if (it.kind !== 'props' || logKey(it) !== k) return;
        it.legs.forEach((l, j) => {
          const s = el.querySelector(`[data-hit="${i}-${j}"]`);
          if (s) s.innerHTML = hitHtml(it, l);
        });
      });
    }
    async function ensureLogs() {
      const need = [...new Map(shown.filter((it) => it.kind === 'props' && it.prop.athleteId && !logs.has(logKey(it)) && !pending.has(logKey(it))).map((it) => [logKey(it), it])).values()];
      need.forEach((it) => pending.add(logKey(it)));
      let next = 0;
      const worker = async () => {
        while (next < need.length && !dead) {
          const it = need[next++], k = logKey(it);
          try {
            logs.set(k, (await api.gamelog(it.league, it.prop.athleteId))?.data ?? null);
          } catch {
            logs.set(k, null);
          }
          pending.delete(k);
          if (!dead) fillHits(k);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, need.length) }, worker));
    }

    // ---------- tarjetas ----------
    const picksOf = (it) => it.legs.map((l, j) => ({
      id: `mid|${it.league}|${it.key}|${j}|${l.bookKey}`,
      label: `${it.game?.title ?? ''} · ${it.market}: ${l.label}`,
      price: l.price, book: l.bookKey || l.book, league: it.league, gameId: it.gameId,
    }));
    const inSlip = (it) => picksOf(it).every((p) => store.hasPick(p.id));
    const addLabel = (it) => (inSlip(it) ? 'En el boleto ✓' : 'Agregar ambas patas');
    const varName = (it) => (it.base === 'spreads' ? `Margen de ${it.m.marginOf}` : it.base === 'props' ? statLabel(it.prop) : 'Total');
    const legsText = (it, o) => o.legs.map((r, j) => `${VERB[r]} ${it.legs[j].label}`).join(', ');
    const legsShort = (o) => o.legs.map((r, j) => `${'AB'[j]} ${SHORT[r]}`).join(', ');
    const pct = (x) => fmtPct(x, x < 0.1 ? 1 : 0);

    function card(it, i) {
      const m = it.m;
      return h`<div class="mid-item" role="group" aria-label="Middle ${fmtPct(m.missPct, 2)}: ${it.market}">
        <div class="arb-head">
          <b class="mid-pct ${m.missPct >= 0 ? 'pos' : 'neg'}">Middle ${fmtPct(m.missPct, 2)}</b>
          <span class="mid-ev ${m.ev >= 0 ? 'pos' : 'neg'}">EV ${m.ev >= 0 ? '+' : ''}${fmtPct(m.ev, 2)}</span>
          <span class="arb-mkt">${it.market}</span>
        </div>
        <ul class="arb-legs">${it.legs.map((l, j) => h`<li class="arb-leg">
          <small class="mid-tag">Pata ${'AB'[j]}</small>
          <span class="arb-side">${l.label}</span>
          <span class="arb-price"><b>${fmtOdds(l.price)}</b>${l.books.map((b) => bookChip(b))}</span>
          ${it.kind === 'props' ? h`<span class="mid-hit" data-hit="${i}-${j}">${hitHtml(it, l)}</span>` : ''}
          <dl class="arb-amt">
            <div><dt>Apostar</dt><dd>${fmtMoney(m.stakes[j])}</dd></div>
            <div><dt>Cobra</dt><dd>${fmtMoney(m.stakes[j] * l.price)}</dd></div>
          </dl>
        </li>`)}</ul>
        <div class="mid-scroll"><table class="mid-zones">
          <caption>Resultado según dónde caiga ${it.base === 'spreads' ? `el margen de ${m.marginOf} (negativo = pierde)` : it.base === 'props' ? `${it.market}` : 'el total'}</caption>
          <thead><tr><th scope="col">${varName(it)}</th><th scope="col">Patas</th><th scope="col" class="al-right">Neto</th><th scope="col" class="al-right">Prob.</th></tr></thead>
          <tbody>${m.outcomes.map((o) => h`<tr class="${o.legs.includes('loss') ? '' : 'mid-win'}">
            <th scope="row">${rangeText(o)}</th><td>${legsShort(o)}</td>
            <td class="al-right ${o.net >= 0 ? 'pos' : 'neg'}">${signedMoney(o.net)}</td><td class="al-right">${pct(o.prob)}</td>
          </tr>`)}</tbody>
        </table></div>
        <p class="mid-model">Probabilidad de middle ${fmtPct(m.middleProb, 1)} según un modelo ${m.dist === 'poisson' ? 'Poisson' : `normal (σ ${r1(m.sigma)})`} centrado en ${r1(m.mean)}: es una estimación, no una probabilidad de la casa.</p>
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
      const { items: all, markets } = findAllMiddles(onlyBooks(data, f.books), { type: f.type, bankroll: f.bankroll });
      const items = all.filter((it) => it.m.missPct * 100 >= f.minMid - 1e-9 && (f.minEv == null || it.m.ev * 100 >= f.minEv - 1e-9));
      const out = byGame(items, limit, card);
      shown = out.shown;
      $('.pro-status').textContent = `${items.length} ${items.length === 1 ? 'middle' : 'middles'} en ${markets} mercados analizados`;
      listEl.innerHTML = items.length
        ? h`${out.html}${items.length > limit ? h`<button type="button" class="btn pro-more" data-more>Mostrar más (${items.length - limit} restantes)</button>` : ''}`
        : empty(markets ? 'No hay middles con estos filtros. Baja el «Middle % mínimo» o agrega ligas y casas.' : 'No hay cuotas disponibles para las ligas elegidas.');
      ensureLogs();
    }

    function copyFor(it) {
      const m = it.m;
      return [
        `Middle ${fmtPct(m.missPct, 2)} · EV ${fmtPct(m.ev, 2)} · ${it.game?.title ?? ''}${it.game?.start ? ` · ${when(it.game.start)}` : ''}`,
        it.market,
        ...it.legs.map((l, j) => `- Pata ${'AB'[j]}: ${l.label} ${fmtOdds(l.price)} en ${l.books.map((b) => bookInfo(b).name).join(' / ')}: apostar ${fmtMoney(m.stakes[j])}`),
        ...m.outcomes.map((o) => `${rangeText(o)}: ${legsText(it, o)} → ${signedMoney(o.net)} (${pct(o.prob)})`),
      ].join('\n');
    }

    listEl.addEventListener('click', async (e) => {
      if (e.target.closest('[data-more]')) {
        limit += LIMIT;
        draw();
        return;
      }
      const cp = e.target.closest('[data-copy]');
      if (cp) {
        const it = shown[+cp.dataset.copy];
        if (it && (await copyText(copyFor(it)))) say('Middle copiado al portapapeles.');
        return;
      }
      const add = e.target.closest('[data-add]');
      const it = add && shown[+add.dataset.add];
      if (!it) return;
      if (inSlip(it)) {
        picksOf(it).forEach((p) => store.removePick(p.id));
        say('Patas quitadas del boleto.');
      } else {
        picksOf(it).forEach((p) => store.addPick({ ...p, addedAt: Date.now() }));
        say('2 patas agregadas al boleto.');
      }
    });

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
