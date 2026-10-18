// Partidos: lista por fecha (#/{liga}/games) y detalle (#/{liga}/games/{id}).
// Cuotas: ESPN (pickcenter) + The Odds API emparejada por nombres de equipo. Apuestas del público: sin fuente gratuita.
import * as bm from '../betmath.js';
import { leagueById } from '../leagues.js';
import { statForMarket } from '../stats.js';

const DAYS = 15; // hoy + 14
const REFRESH_MS = 60_000;
const MATCH_WINDOW_MS = 12 * 3600_000;
const REC_ORDER = ['overall', 'home', 'road', 'vsconf', 'vsdiv'];
const REC_LABEL = { overall: 'Total', home: 'Local', road: 'Visita', vsconf: 'Conferencia', vsdiv: 'División' };
const MARKETS = { ml: 'Moneyline', spread: 'Hándicap', total: 'Total' };

let ui; // ctx.ui de la vista montada (solo hay una a la vez)
const esc = (s) => ui.esc(s ?? '');

// ---------- utilidades puras (exportadas para pruebas) ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const sameTeam = (a, b) => {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};
const signed = (x) => (x == null ? '' : x > 0 ? `+${x}` : x === 0 ? 'PK' : String(x));

// Evento de The Odds API del mismo partido (ambos equipos y ±12 h). flip = local/visita invertidos.
export function matchEvent(game, events) {
  const t = Date.parse(game.start);
  for (const e of events ?? []) {
    if (Math.abs(Date.parse(e.commence_time) - t) > MATCH_WINDOW_MS) continue;
    if (sameTeam(e.home_team, game.home.name) && sameTeam(e.away_team, game.away.name)) return { event: e, flip: false };
    if (sameTeam(e.home_team, game.away.name) && sameTeam(e.away_team, game.home.name)) return { event: e, flip: true };
  }
  return null;
}

// Una fila por casa: { key, title, src, ml:{home,away,draw?}, spread:{line(local),home,away}, total:{line,over,under} } (decimal).
export function bookRows(game, match) {
  const rows = [];
  if (match) {
    const { event: ev, flip } = match;
    const sideOf = (name) => (name === 'Draw' ? 'draw' : (name === ev.home_team) !== flip ? 'home' : 'away');
    for (const b of ev.bookmakers ?? []) {
      const out = (k) => b.markets?.find((m) => m.key === k)?.outcomes ?? [];
      const row = { key: b.key, title: b.title, src: 'odds', ml: null, spread: null, total: null };
      const h2h = out('h2h');
      if (h2h.length) row.ml = Object.fromEntries(h2h.map((o) => [sideOf(o.name), o.price]));
      const sp = out('spreads');
      const sh = sp.find((o) => sideOf(o.name) === 'home'), sa = sp.find((o) => sideOf(o.name) === 'away');
      if (sh && sa) row.spread = { line: sh.point, home: sh.price, away: sa.price };
      const tot = out('totals');
      const ov = tot.find((o) => o.name === 'Over'), un = tot.find((o) => o.name === 'Under');
      if (ov && un) row.total = { line: ov.point, over: ov.price, under: un.price };
      if (row.ml || row.spread || row.total) rows.push(row);
    }
  }
  const o = game.odds;
  const title = o?.provider || 'ESPN';
  // La casa de ESPN puede venir también por The Odds API: se queda la de The Odds API.
  if (o && (o.moneyline || o.spread || o.total) && !rows.some((r) => norm(r.title) === norm(title))) {
    rows.push({ key: norm(title).replace(/ /g, '') || 'espn', title, src: 'espn', ml: o.moneyline, spread: o.spread, total: o.total });
  }
  return rows;
}

const mode = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [x, k] of c) if (k > n) [best, n] = [x, k];
  return best;
};

// Mejor cuota por lado; en hándicap y total solo entre las casas con la línea más común.
export function marketSummary(rows) {
  const pick = (mk, sides, hasLine) => {
    const have = rows.filter((r) => r[mk]);
    const line = hasLine ? mode(have.map((r) => r[mk].line).filter((l) => l != null)) : null;
    const at = hasLine ? have.filter((r) => r[mk].line === line) : have;
    const best = {};
    for (const s of sides) {
      for (const r of at) if (r[mk][s] > 1 && r[mk][s] > (best[s]?.price ?? 0)) best[s] = { price: r[mk][s], key: r.key, title: r.title };
    }
    return { line, rows: at, best };
  };
  return { ml: pick('ml', ['home', 'away', 'draw']), spread: pick('spread', ['home', 'away'], true), total: pick('total', ['over', 'under'], true) };
}

// Probabilidad justa: promedio del devig de cada casa con todos los lados (en la línea principal).
export function fairOf(rows, mk, sides, devig) {
  const full = rows.filter((r) => sides.every((s) => r[mk]?.[s] > 1));
  if (!full.length) return null;
  const all = full.map((r) => devig(sides.map((s) => r[mk][s])));
  return { n: full.length, probs: Object.fromEntries(sides.map((s, i) => [s, all.reduce((t, p) => t + p[i], 0) / all.length])) };
}

// Mercados de The Odds API donde betmath.analyzeEvent encuentra +EV.
function evMarkets(event) {
  if (!event) return [];
  const names = { h2h: 'Moneyline', spreads: 'Hándicap', totals: 'Total' };
  return Object.keys(names).filter((market) => {
    try {
      return bm.analyzeEvent(event, { market }).some((a) => a.evBets.length);
    } catch {
      return false;
    }
  }).map((k) => names[k]);
}

// ---------- piezas de UI ----------
const unwrap = (r) => (r && !Array.isArray(r) && 'data' in r ? r : { data: r, source: null });
const timeOf = (iso) => new Date(iso).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
const isLive = (g) => g.status?.state === 'in' || (g.status?.state === 'pre' && Date.parse(g.start) <= Date.now());
const devigFn = (store) => {
  const method = store?.get('settings')?.devigMethod || 'multiplicative';
  return (p) => (bm.devig ? bm.devig(p, method) : bm.noVig(p));
};

// Barra de tendencia: un segmento por partido (más reciente a la derecha).
function trend(values, good, bad, what) {
  const v = (values ?? []).filter((x) => x != null);
  if (!v.length) return '<span class="gm-trend gm-na">—</span>';
  const k = v.filter((x) => x === good).length;
  const label = `${what}: ${k} de ${v.length}`;
  return `<span class="gm-trend" role="img" aria-label="${esc(label)}" title="${esc(label)}"><span class="gm-segs">${[...v].reverse().map((x) => `<i class="${x === good ? 'w' : x === bad ? 'l' : 'p'}"></i>`).join('')}</span><small>${k}/${v.length}</small></span>`;
}
const lastResults = (past, key) => (past ?? []).map((p) => p[key]);

function statusHtml(g) {
  const st = g.status?.state;
  if (st === 'in') return `<span class="gm-live">En vivo</span> <span>${esc(g.status.detail)}</span>`;
  if (st === 'post') return `<span>${esc(g.status.detail || 'Final')}</span>`;
  return `<span>${esc(timeOf(g.start))}</span>`;
}

function priceCell(line, q) {
  if (!q) return '<span class="gm-na">—</span>';
  return `${line ? `<span class="gm-line">${esc(line)}</span>` : ''}<b>${esc(ui.fmtOdds(q.price))}</b>${ui.bookChip(q.title, { name: false })}`;
}

function teamRow(g, side, sum, extra) {
  const t = g[side];
  const score = g.status?.state !== 'pre' && t.score != null ? `<b class="gm-score">${esc(t.score)}</b>` : '';
  const sp = sum.spread, tot = sum.total;
  const spLine = sp.line == null ? '' : signed(side === 'home' ? sp.line : -sp.line);
  const totSide = side === 'away' ? 'over' : 'under';
  const totLine = tot.line == null ? '' : `${side === 'away' ? 'O' : 'U'} ${tot.line}`;
  const past = extra.detail?.lastFive?.[side];
  return `<div class="gm-team">${ui.teamLogo(t)}<span class="gm-tname"><span class="gm-tl"><b>${esc(t.abbr || t.name)}</b> <small>${esc(t.name)}</small></span>
      <span class="gm-tl">${t.record ? `<small class="gm-rec">${esc(t.record)}</small>` : ''}<span class="gm-tr" data-trend="${side}">${past ? trend(lastResults(past, 'result'), 'W', 'L', 'Ganó') : '<span class="gm-trend gm-na" aria-hidden="true">…</span>'}</span></span></span>${score}</div>
    <div class="gm-cell" data-label="${MARKETS.ml}">${priceCell('', sum.ml.best[side])}</div>
    <div class="gm-cell" data-label="${MARKETS.spread}">${priceCell(spLine, sp.best[side])}</div>
    <div class="gm-cell" data-label="${MARKETS.total}">${priceCell(totLine, tot.best[totSide])}</div>`;
}

function cardHtml(g, league, extra) {
  const sum = marketSummary(extra.rows);
  const src = [...new Set(extra.rows.map((r) => (r.src === 'espn' ? `ESPN (${r.title})` : 'The Odds API')))].join(' + ');
  return `<article class="gm-card" data-id="${esc(g.id)}">
    <div class="gm-top"><span class="gm-status" data-status>${statusHtml(g)}</span>
      ${extra.ev.length ? `<span class="gm-ev" title="${esc(`Valor esperado positivo en: ${extra.ev.join(', ')}`)}">EV+</span>` : ''}</div>
    <div class="gm-grid">
      <div class="gm-corner" aria-hidden="true"></div>
      <div class="gm-hd">${MARKETS.ml}</div><div class="gm-hd">${MARKETS.spread}</div><div class="gm-hd">${MARKETS.total}</div>
      ${teamRow(g, 'away', sum, extra)}
      ${teamRow(g, 'home', sum, extra)}
      ${sum.ml.best.draw ? `<div class="gm-team gm-draw">Empate</div><div class="gm-cell">${priceCell('', sum.ml.best.draw)}</div><div></div><div></div>` : ''}
    </div>
    <p class="gm-src">${extra.rows.length ? `Cuotas: ${esc(src)}` : 'Sin cuotas publicadas para este partido.'}</p>
    <div class="gm-foot">
      <details class="gm-public" data-public="${esc(g.id)}"${extra.open ? ' open' : ''}><summary>Apuestas del público</summary>
        <p>No disponible: no existe una fuente gratuita del % de apuestas ni del % del dinero del público.</p></details>
      <a class="gm-more" href="#/${esc(league)}/games/${encodeURIComponent(g.id)}">Detalles del partido →</a>
    </div>
  </article>`;
}

// Pestañas accesibles propias (id único por grupo).
function tabsHtml(id, label, items) {
  return `<div role="tablist" class="gm-tabs" aria-label="${esc(label)}">${items.map((t, i) => `<button type="button" role="tab" id="${id}-t-${t.id}" aria-controls="${id}-p-${t.id}" aria-selected="${i === 0}">${esc(t.label)}</button>`).join('')}</div>
    ${items.map((t, i) => `<div role="tabpanel" class="gm-panel" id="${id}-p-${t.id}" aria-labelledby="${id}-t-${t.id}" data-tab="${t.id}"${i ? ' hidden' : ''}>${t.html}</div>`).join('')}`;
}
function onTabClick(root, e, onOpen) {
  const t = e.target.closest('[role="tab"]');
  if (!t || !root.contains(t)) return false;
  for (const b of t.parentElement.children) {
    const sel = b === t;
    b.setAttribute('aria-selected', String(sel));
    const p = root.querySelector(`#${CSS.escape(b.getAttribute('aria-controls'))}`);
    if (p) p.hidden = !sel;
    if (sel && p) onOpen?.(p);
  }
  return true;
}

// ---------- lista ----------
async function renderList(root, ctx, lg, state) {
  const { api } = ctx;
  root.innerHTML = `<header class="gm-header"><h1>Partidos · ${esc(lg.title)}</h1><span class="gm-badges" data-badges></span></header>
    <nav class="gm-dates" aria-label="Fechas" data-dates></nav>
    <p class="gm-note" data-note hidden></p>
    <div class="gm-list" data-list>${ui.loading()}</div>`;

  const today = new Date();
  const days = Array.from({ length: DAYS }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  const oddsP = lg.odds ? api.odds(lg.odds).then(unwrap) : Promise.resolve(null);
  const res = await Promise.allSettled(days.map((d) => api.games(lg.id, ymd(d)).then(unwrap)));
  if (state.dead) return;
  const byDate = new Map();
  res.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.data?.length) byDate.set(ymd(days[i]), r.value.data);
  });
  if (!byDate.size) {
    const err = res.find((r) => r.status === 'rejected');
    root.querySelector('[data-list]').innerHTML = err && res.every((r) => r.status === 'rejected')
      ? ui.errorBox(err.reason)
      : ui.empty(`No hay partidos de ${lg.title} programados entre hoy y los próximos 14 días.`);
    return;
  }

  const odds = await oddsP.catch((err) => ({ error: err }));
  if (state.dead) return;
  const note = root.querySelector('[data-note]');
  const events = odds?.source === 'live' ? odds.data : null;
  // Las cuotas demo no son reales: no se mezclan con partidos reales.
  if (odds?.source === 'demo') note.textContent = 'Cuotas de varias casas no disponibles (modo demo, falta COFLAS_ODDS_API_KEY): solo se muestra la línea de ESPN.';
  else if (odds?.error) note.textContent = `No se pudieron cargar las cuotas de The Odds API (${odds.error.message || odds.error}): solo se muestra la línea de ESPN.`;
  else if (!lg.odds) note.textContent = 'The Odds API no cubre esta liga: solo se muestra la línea de ESPN.';
  note.hidden = !note.textContent;
  root.querySelector('[data-badges]').innerHTML = ui.sourceBadge('espn') + (events ? ui.sourceBadge(odds) : '');

  const dates = [...byDate.keys()];
  const wanted = ctx.query?.get('date');
  state.date = byDate.has(wanted) ? wanted : dates[0];
  const label = (k) => {
    const d = days.find((x) => ymd(x) === k);
    const i = days.indexOf(d);
    if (i < 2) return i ? 'Mañana' : 'Hoy';
    const s = d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
    return s[0].toUpperCase() + s.slice(1);
  };
  const drawDates = () => {
    root.querySelector('[data-dates]').innerHTML = dates.map((k) => `<button type="button" data-date="${k}" aria-pressed="${k === state.date}">${esc(label(k))} <small>${byDate.get(k).length}</small></button>`).join('');
  };

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); loadTrend(en.target); }
  }, { rootMargin: '200px' }) : null;
  state.cleanups.push(() => io?.disconnect());

  // Tendencia de cada lado desde GameDetail.lastFive (se pide solo para las tarjetas visibles).
  const loadTrend = async (card) => {
    const id = card.dataset.id;
    if (!state.details.has(id)) state.details.set(id, api.game(lg.id, id).then((r) => unwrap(r).data).catch(() => null));
    const d = await state.details.get(id);
    if (state.dead || !card.isConnected) return;
    for (const side of ['away', 'home']) {
      const slot = card.querySelector(`[data-trend="${side}"]`);
      if (slot) slot.innerHTML = trend(lastResults(d?.lastFive?.[side], 'result'), 'W', 'L', 'Ganó en los últimos partidos');
    }
  };

  const drawList = () => {
    const games = [...byDate.get(state.date)].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const list = root.querySelector('[data-list]');
    io?.disconnect();
    list.innerHTML = games.map((g) => {
      const match = events ? matchEvent(g, events) : null;
      return cardHtml(g, lg.id, { rows: bookRows(g, match), ev: evMarkets(match?.event), open: state.open.has(g.id), detail: null });
    }).join('');
    for (const card of list.querySelectorAll('.gm-card')) io ? io.observe(card) : loadTrend(card);
  };

  drawDates();
  drawList();

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-date]');
    if (!b) return;
    state.date = b.dataset.date;
    try {
      history.replaceState(null, '', `#/${lg.id}/games?date=${state.date}`);
    } catch { /* sin history: no pasa nada */ }
    drawDates();
    drawList();
  });
  root.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('[data-public]');
    if (d) d.open ? state.open.add(d.dataset.public) : state.open.delete(d.dataset.public);
  }, true);

  // Marcadores en vivo: cada 60 s si el día elegido tiene partidos en juego.
  state.timer = setInterval(async () => {
    if (!byDate.get(state.date)?.some(isLive)) return;
    try {
      const fresh = unwrap(await api.get('/api/games', { league: lg.id, date: state.date }, { fresh: true })).data;
      if (state.dead || !fresh?.length) return;
      byDate.set(state.date, fresh);
      drawList();
    } catch { /* se reintenta en el siguiente ciclo */ }
  }, REFRESH_MS);
}

// ---------- detalle ----------
function headerHtml(d) {
  const team = (side) => {
    const t = d[side];
    return `<div class="gm-hteam gm-${side}">${ui.teamLogo(t, { size: 40 })}<div><b>${esc(t.name)}</b><small>${side === 'home' ? 'Local' : 'Visita'}${t.record ? ` · ${esc(t.record)}` : ''}</small></div>
      ${d.status?.state !== 'pre' && t.score != null ? `<span class="gm-hscore">${esc(t.score)}</span>` : ''}</div>`;
  };
  const p = d.predictor;
  const pct = (x) => (x > 1 ? x / 100 : x); // ESPN puede dar 0-100
  const pred = p && p.homeWinPct != null && p.awayWinPct != null
    ? `<div class="gm-pred"><span>${esc(d.away.abbr)} ${esc(ui.fmtPct(pct(p.awayWinPct), 0))}</span>
        <span class="gm-predbar" role="img" aria-label="${esc(`Predictor de ESPN: ${d.away.abbr} ${ui.fmtPct(pct(p.awayWinPct), 0)}, ${d.home.abbr} ${ui.fmtPct(pct(p.homeWinPct), 0)}`)}"><i style="width:${(pct(p.awayWinPct) * 100).toFixed(1)}%"></i></span>
        <span>${esc(ui.fmtPct(pct(p.homeWinPct), 0))} ${esc(d.home.abbr)}</span><small>Predictor de ESPN (probabilidad de ganar)</small></div>`
    : '';
  const when = d.status?.state === 'pre' ? esc(ui.when(d.start)) : statusHtml(d);
  return `<div class="gm-hrow">${team('away')}<span class="gm-at">@</span>${team('home')}</div>
    <p class="gm-hstatus">${when}</p>${pred}`;
}

function linesHtml(d, rows, sum, fairFn) {
  if (!rows.length) return ui.empty('No hay líneas publicadas para este partido en ESPN ni en The Odds API.');
  const A = esc(d.away.abbr), H = esc(d.home.abbr);
  const cell = (mk, r, s, line, main) => {
    const price = r[mk]?.[s];
    if (!(price > 1)) return '<td class="gm-na">—</td>';
    const best = main && sum[mk].best[s]?.price === price;
    return `<td class="${best ? 'best' : ''}${main ? '' : ' gm-off'}">${line ? `<span class="gm-line">${esc(line)}</span> ` : ''}${esc(ui.fmtOdds(price))}${best ? '<span class="gm-sr"> (mejor cuota)</span>' : ''}</td>`;
  };
  const table = (mk, cols, lineOf, trends) => {
    const have = rows.filter((r) => r[mk]);
    if (!have.length) return `<section class="gm-mk"><h3>${MARKETS[mk]}</h3>${ui.empty('Sin cuotas para este mercado.')}</section>`;
    const sides = cols.map((c) => c.side);
    const fair = fairFn(sum[mk].rows, mk, sides);
    const mainLine = sum[mk].line;
    return `<section class="gm-mk"><h3>${MARKETS[mk]}${mainLine != null ? ` <small>línea principal ${esc(mk === 'spread' ? `${d.home.abbr} ${signed(mainLine)}` : mainLine)}</small>` : ''}</h3>
      <div class="scroll"><table><thead><tr><th scope="col">Casa</th>${cols.map((c) => `<th scope="col">${c.label}</th>`).join('')}</tr></thead><tbody>
      ${have.map((r) => {
        const main = mainLine == null || r[mk].line === mainLine;
        return `<tr><th scope="row">${ui.bookChip(r.title)}${r.src === 'espn' ? ' <small class="gm-tag">ESPN</small>' : ''}</th>${cols.map((c) => cell(mk, r, c.side, lineOf?.(r[mk], c.side), main)).join('')}</tr>`;
      }).join('')}
      </tbody>${fair ? `<tfoot><tr class="fair"><th scope="row">Justa <small>(sin vig, ${fair.n} ${fair.n === 1 ? 'casa' : 'casas'})</small></th>${cols.map((c) => `<td>${esc(ui.fmtOdds(1 / fair.probs[c.side]))} <small>${esc(ui.fmtPct(fair.probs[c.side], 1))}</small></td>`).join('')}</tr></tfoot>` : ''}
      </table></div>${trends}</section>`;
  };
  const lf = d.lastFive ?? {};
  const tr = (key, good, bad, what) => `<p class="gm-trends"><span>${A} ${trend(lastResults(lf.away, key), good, bad, `${d.away.abbr} ${what}`)}</span><span>${H} ${trend(lastResults(lf.home, key), good, bad, `${d.home.abbr} ${what}`)}</span><small>últimos ${Math.max(lf.away?.length ?? 0, lf.home?.length ?? 0) || 5}</small></p>`;
  const mlCols = [{ side: 'away', label: A }, { side: 'home', label: H }];
  if (rows.some((r) => r.ml?.draw > 1)) mlCols.push({ side: 'draw', label: 'Empate' });
  return table('ml', mlCols, null, tr('result', 'W', 'L', 'ganó'))
    + table('spread', [{ side: 'away', label: A }, { side: 'home', label: H }], (m, s) => signed(s === 'home' ? m.line : -m.line), tr('ats', 'W', 'L', 'cubrió el hándicap'))
    + table('total', [{ side: 'over', label: 'Over' }, { side: 'under', label: 'Under' }], (m) => String(m.line), tr('ou', 'O', 'U', 'fue Over'))
    + `<section class="gm-mk"><h3>Récords contra el hándicap (ATS)</h3>${d.ats ? recTable(d, d.ats) : ui.empty('ESPN no publica el récord ATS de este partido.')}</section>`;
}

function recTable(d, recs) {
  const keys = [...new Set([...(recs.away ?? []), ...(recs.home ?? [])].map((r) => r.key))]
    .sort((a, b) => (REC_ORDER.indexOf(a) + 1 || 99) - (REC_ORDER.indexOf(b) + 1 || 99));
  if (!keys.length) return ui.empty('Sin récords.');
  const get = (side, k) => recs[side]?.find((r) => r.key === k);
  return `<div class="scroll"><table class="gm-rt"><thead><tr><th scope="col"></th><th scope="col">${esc(d.away.abbr)}</th><th scope="col">${esc(d.home.abbr)}</th></tr></thead><tbody>
    ${keys.map((k) => `<tr><th scope="row">${esc(REC_LABEL[k] || get('away', k)?.label || get('home', k)?.label || k)}</th><td>${esc(get('away', k)?.summary ?? '—')}</td><td>${esc(get('home', k)?.summary ?? '—')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function propsHtml(props, league, gameId, sport, kind) {
  const pick = {
    player: (p) => p.player && String(p.market || '').startsWith('player_'),
    team: (p) => /team/.test(p.market || ''),
    game: (p) => !String(p.market || '').startsWith('player_') && !/team/.test(p.market || ''),
  }[kind];
  const list = props.filter(pick);
  if (!list.length) {
    return ui.empty({
      player: 'No hay props de jugador para este partido en la fuente de cuotas.',
      team: 'Sin props de equipo: la fuente de cuotas configurada no entrega mercados de equipo (totales por equipo) para este partido.',
      game: 'Sin props del partido: la fuente de cuotas configurada no entrega hándicap/total alternativos, resultado sin prórroga ni margen de victoria para este partido.',
    }[kind]);
  }
  const top = (p) => (p.books ?? []).reduce((b, x) => (x.price > (b?.price ?? 0) ? x : b), null);
  const statName = (p) => statForMarket(sport, p.market)?.name || p.stat || p.market;
  const keyOf = (p) => encodeURIComponent(JSON.stringify({ a: p.athleteId ?? null, p: p.player, s: p.stat, l: p.line, o: p.side, g: p.gameId ?? gameId }));
  // Jugador → (estadística, línea) → lados.
  const groups = new Map();
  for (const p of list) {
    const who = p.player || 'Partido';
    if (!groups.has(who)) groups.set(who, { team: p.team, lines: new Map() });
    const lk = `${p.stat ?? p.market}|${p.line}`;
    const lines = groups.get(who).lines;
    if (!lines.has(lk)) lines.set(lk, { p, sides: {} });
    lines.get(lk).sides[p.side] = p;
  }
  const sideCell = (p) => {
    if (!p) return '<td class="gm-na">—</td>';
    const b = top(p);
    const label = `${p.side === 'Over' ? 'Más de' : p.side === 'Under' ? 'Menos de' : p.side} ${p.line}`;
    return `<td>${kind === 'player' ? `<a href="#/${esc(league)}/props/${keyOf(p)}" aria-label="${esc(`${p.player}: ${label} ${statName(p)}, ver detalle`)}">` : ''}${esc(p.side === 'Over' ? 'O' : p.side === 'Under' ? 'U' : p.side)} ${esc(p.line)} ${b ? `<b>${esc(ui.fmtOdds(b.price))}</b>${ui.bookChip(b.title || b.key)}` : ''}${kind === 'player' ? '</a>' : ''}</td>`;
  };
  return [...groups].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([who, g]) => `<section class="gm-player"><h3>${esc(who)}${g.team ? ` <small>${esc(g.team)}</small>` : ''}</h3>
    <div class="scroll"><table><thead><tr><th scope="col">Mercado</th><th scope="col">Over</th><th scope="col">Under</th></tr></thead><tbody>
    ${[...g.lines.values()].map(({ p, sides }) => `<tr><th scope="row">${esc(statName(p))}</th>${sideCell(sides.Over)}${sideCell(sides.Under)}</tr>`).join('')}
    </tbody></table></div></section>`).join('');
}

function matchupHtml(d) {
  const A = esc(d.away.abbr), H = esc(d.home.abbr);
  const rank = (s) => (s?.rank ? ` <small class="gm-rank">${esc(s.rank)}º</small>` : '');
  const ts = d.teamStats ?? {};
  const keys = [...new Set([...(ts.away ?? []), ...(ts.home ?? [])].map((s) => s.key))];
  const get = (side, k) => ts[side]?.find((s) => s.key === k);
  const stats = keys.length
    ? `<div class="scroll"><table class="gm-rt"><thead><tr><th scope="col">Estadística</th><th scope="col">${A}</th><th scope="col">${H}</th></tr></thead><tbody>
      ${keys.map((k) => `<tr><th scope="row">${esc(get('away', k)?.label || get('home', k)?.label || k)}</th><td>${esc(get('away', k)?.display ?? '—')}${rank(get('away', k))}</td><td>${esc(get('home', k)?.display ?? '—')}${rank(get('home', k))}</td></tr>`).join('')}
      </tbody></table></div><p class="gm-src">Promedios de la temporada y ranking de la liga (ESPN).</p>`
    : ui.empty('ESPN no publica estadísticas de equipo para este partido.');
  const last = (side) => {
    const list = d.lastFive?.[side] ?? [];
    if (!list.length) return ui.empty('Sin partidos recientes.');
    const res = { W: 'G', L: 'P', T: 'E', P: 'E' }; // ganó / perdió / empate o push
    return `<ul class="gm-last">${list.map((p) => `<li><span>${esc(new Date(p.date).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }))}</span>
      <span>${p.home ? 'vs' : '@'} ${esc(p.opp?.abbr ?? p.opp?.name ?? p.opp)}</span>
      <b class="gm-r${esc(p.result)}">${esc(res[p.result] ?? p.result ?? '')} ${esc(p.score ?? '')}</b>
      <span>${p.ats ? `ATS ${esc(res[p.ats] ?? p.ats)}` : ''}</span><span>${p.ou ? `O/U ${esc(p.ou)}` : ''}</span></li>`).join('')}</ul>`;
  };
  return `<section class="gm-mk"><h3>Apuestas del público</h3><p class="gm-src">No disponible: no hay una fuente gratuita del % de apuestas ni del dinero del público.</p></section>
    <section class="gm-mk"><h3>Estadísticas: ${A} vs ${H}</h3>${stats}</section>
    <section class="gm-mk"><h3>Récords</h3>${recTable(d, d.records ?? {})}</section>
    <section class="gm-mk"><h3>Últimos partidos · ${A}</h3>${last('away')}</section>
    <section class="gm-mk"><h3>Últimos partidos · ${H}</h3>${last('home')}</section>`;
}

function lineupHtml(d) {
  const side = (s) => {
    const t = d[s];
    const starters = d.starters?.[s];
    const people = starters?.length ? starters : d.rosters?.[s] ?? [];
    const row = (a) => `<li>${ui.headshot(a)}<span><b>${esc(a.name)}</b> <small>${esc([a.pos, a.jersey != null && a.jersey !== '' ? `#${a.jersey}` : ''].filter(Boolean).join(' · '))}</small></span></li>`;
    const inj = (d.injuries ?? []).filter((i) => String(i.teamId) === String(t.id) || i.teamAbbr === t.abbr);
    const list = starters?.length
      ? `<h4>Titulares</h4><ul class="gm-people">${people.map(row).join('')}</ul>`
      : people.length
        ? `<details><summary>Plantilla (${people.length}) <small>· ESPN aún no publica titulares</small></summary><ul class="gm-people">${people.map(row).join('')}</ul></details>`
        : ui.empty('Sin alineación ni plantilla disponibles.');
    return `<section class="gm-mk"><h3>${ui.teamLogo(t)} ${esc(t.name)}</h3>${list}
      <h4>Lesiones</h4>${inj.length ? `<ul class="gm-inj">${inj.map((i) => `<li><span><b>${esc(i.athlete?.name)}</b> <small>${esc(i.athlete?.pos ?? '')}</small><br><small>${esc(i.detail ?? '')}${i.date ? ` · ${esc(ui.when(i.date))}` : ''}</small></span><span class="gm-st gm-st-${esc(String(i.status).toLowerCase().replace(/[^a-z]/g, ''))}">${esc(i.status)}</span></li>`).join('')}</ul>` : '<p class="gm-src">Sin lesionados reportados.</p>'}</section>`;
  };
  return side('away') + side('home');
}

function insightsHtml(d) {
  let list = [];
  try {
    list = bm.teamInsights?.(d) ?? [];
  } catch { /* datos incompletos: sin insights */ }
  if (!list.length) return ui.empty('No hay suficientes datos de ESPN para generar insights de este partido.');
  return `<ul class="gm-ins">${list.map((i) => `<li><p>${esc(i.text)}</p>${i.pct != null ? `<small>${esc(ui.fmtPct(i.pct, 0))}${i.n ? ` · ${esc(i.k)} de ${esc(i.n)}` : ''}</small>` : ''}</li>`).join('')}</ul>`;
}

async function renderDetail(root, ctx, lg, id, state) {
  const { api } = ctx;
  root.innerHTML = `<a class="gm-back" href="#/${esc(lg.id)}/games">← Partidos</a><div data-detail>${ui.loading()}</div>`;
  const [dRes, oRes] = await Promise.allSettled([api.game(lg.id, id).then(unwrap), lg.odds ? api.odds(lg.odds).then(unwrap) : Promise.resolve(null)]);
  if (state.dead) return;
  const box = root.querySelector('[data-detail]');
  if (dRes.status === 'rejected' || !dRes.value.data) {
    box.innerHTML = ui.errorBox(dRes.reason ?? new Error('Partido no encontrado'));
    return;
  }
  const d = dRes.value.data;
  const odds = oRes.status === 'fulfilled' ? oRes.value : null;
  const match = odds?.source === 'live' ? matchEvent(d, odds.data) : null;
  const rows = bookRows(d, match);
  const sum = marketSummary(rows);
  const devig = devigFn(ctx.store);
  const fair = (r, mk, sides) => fairOf(r, mk, sides, devig);
  const ev = evMarkets(match?.event);
  const note = odds?.source === 'demo'
    ? 'Modo demo (falta COFLAS_ODDS_API_KEY): solo la línea de ESPN; las cuotas demo no se mezclan con partidos reales.'
    : oRes.status === 'rejected' ? `No se pudieron cargar las cuotas de The Odds API (${oRes.reason?.message ?? oRes.reason}).`
      : !lg.odds ? 'The Odds API no cubre esta liga: solo la línea de ESPN.'
        : !match ? 'The Odds API no tiene este partido emparejado: solo la línea de ESPN.' : '';
  const lazy = (kind) => `<div data-props="${kind}">${ui.loading()}</div>`;

  box.innerHTML = `<header class="gm-head" data-head>${headerHtml(d)}</header>
    <div class="gm-cols">
      <section class="gm-main" aria-label="Mercados">
        ${tabsHtml('gmm', 'Mercados', [
          { id: 'lines', label: 'Líneas', html: `${ev.length ? `<p class="gm-evline"><span class="gm-ev">EV+</span> Valor esperado positivo en: ${esc(ev.join(', '))}</p>` : ''}${note ? `<p class="gm-note">${esc(note)}</p>` : ''}${linesHtml(d, rows, sum, fair)}` },
          { id: 'player', label: 'Props de jugador', html: lazy('player') },
          { id: 'team', label: 'Props de equipo', html: lazy('team') },
          { id: 'game', label: 'Props del partido', html: lazy('game') },
        ])}
      </section>
      <aside class="gm-side" aria-label="Análisis del partido">
        ${tabsHtml('gms', 'Análisis', [
          { id: 'matchup', label: 'Matchup', html: matchupHtml(d) },
          { id: 'lineup', label: 'Lineup', html: lineupHtml(d) },
          { id: 'insights', label: 'Insights', html: insightsHtml(d) },
        ])}
      </aside>
    </div>`;

  // Props: se piden al abrir la pestaña (gastan créditos de The Odds API).
  let propsP = null;
  const loadProps = async (panel) => {
    const slot = panel.querySelector('[data-props]');
    if (!slot || slot.dataset.done) return;
    slot.dataset.done = '1';
    propsP ??= api.props(lg.id, id).then(unwrap);
    try {
      const r = await propsP;
      if (state.dead) return;
      slot.innerHTML = (r.source ? `<p class="gm-src">${ui.sourceBadge(r.source)}</p>` : '') + propsHtml(r.data ?? [], lg.id, id, lg.sport, slot.dataset.props);
    } catch (err) {
      if (!state.dead) slot.innerHTML = ui.errorBox(err);
      delete slot.dataset.done;
      propsP = null;
    }
  };
  root.addEventListener('click', (e) => onTabClick(root, e, loadProps));

  state.timer = setInterval(async () => {
    if (!isLive(d)) return;
    try {
      const fresh = unwrap(await api.get('/api/game', { league: lg.id, id }, { fresh: true })).data;
      if (state.dead || !fresh) return;
      Object.assign(d, { status: fresh.status, home: fresh.home, away: fresh.away });
      root.querySelector('[data-head]').innerHTML = headerHtml(d);
    } catch { /* se reintenta en el siguiente ciclo */ }
  }, REFRESH_MS);
}

export default {
  title: 'Partidos',
  async render(el, ctx) {
    ui = ctx.ui;
    const lg = typeof ctx.league === 'string' ? leagueById(ctx.league) : ctx.league;
    const state = { dead: false, timer: null, date: null, details: new Map(), open: new Set(), cleanups: [] };
    const cleanup = () => {
      state.dead = true;
      clearInterval(state.timer);
      for (const f of state.cleanups) f();
    };
    el.innerHTML = '<div class="gm"></div>';
    const root = el.firstElementChild;
    if (!lg) {
      root.innerHTML = ui.empty('Liga desconocida.');
      return cleanup;
    }
    const id = ctx.params?.id;
    try {
      await (id ? renderDetail(root, ctx, lg, id, state) : renderList(root, ctx, lg, state));
    } catch (err) {
      if (!state.dead) root.innerHTML = ui.errorBox(err);
    }
    return cleanup;
  },
};
