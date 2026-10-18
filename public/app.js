// Shell de Oddsy Bet: router por hash, montaje de vistas, chips de liga, ajustes y boleto "Mis picks".
import { api } from './api.js';
import { store, encodePicks, decodePicks } from './store.js';
import { ui, h, empty, fmtOdds, fmtPct, bookInfo, bookChip, BOOKS, modal, raw } from './ui.js';
import { LEAGUES, leagueById } from './leagues.js';
import { parlayOdds } from './betmath.js';

const $ = (s) => document.querySelector(s);
const LEAGUE_VIEWS = ['props', 'games', 'insights', 'popular'];
const DETAIL_VIEWS = ['props', 'games'];
const NAMES = { props: 'Props', games: 'Partidos', insights: 'Insights', popular: 'Populares', odds: 'Comparador', 'tennis-rankings': 'Ranking ATP', 'tennis-player': 'Jugador ATP' };
const lastLeague = () => leagueById(store.get('league')) ?? LEAGUES[0];
// El tenis solo tiene Partidos (sin props, insights ni populares).
const viewsOf = (lg) => (lg.sport === 'tennis' ? ['games'] : LEAGUE_VIEWS);
const home = (lg) => `#/${lg.id}/${viewsOf(lg).includes('props') ? 'props' : 'games'}`;
const defaultHash = () => home(lastLeague());

// '#/nba/props/abc?x=1' → { name, league, params, query } | null
function parse(hash) {
  const [path, qs = ''] = String(hash).replace(/^#\/?/, '').split('?');
  const seg = path.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = new URLSearchParams(qs);
  const r = (name, league = null, id) => ({ name, league, params: id != null ? { id } : {}, query });
  if (seg[0] === 'share' && seg.length === 1) return r('share');
  if (seg[0] === 'comparador' && seg.length === 1) return r('odds');
  if (seg[0] === 'tennis-rankings' && seg.length === 1) return r('tennis-rankings');
  if (seg[0] === 'tennis-player' && seg.length === 2) return r('tennis-player', null, seg[1]);
  const lg = leagueById(seg[0]);
  if (lg && viewsOf(lg).includes(seg[1]) && (seg.length === 2 || (seg.length === 3 && DETAIL_VIEWS.includes(seg[1])))) return r(seg[1], lg, seg[2]);
  return null;
}

function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash.startsWith('/') ? '' : '/'}${hash}`;
  if (target === location.hash) return route();
  if (replace) location.replace(target);
  else location.hash = target;
}

// ---------- router ----------
let seq = 0, cleanup = null, lastKey = '', lastName = '';
function runCleanup() {
  const fn = cleanup;
  cleanup = null;
  try { fn?.(); } catch (err) { console.error(err); }
}

async function route() {
  const r = parse(location.hash);
  if (!r) return location.replace(defaultHash());
  if (r.name === 'share') return importShare(r.query);
  const my = ++seq;
  runCleanup();
  if (r.league && r.league.id !== store.get('league')) store.set('league', r.league.id);
  const league = r.league ?? lastLeague();
  updateChrome(r, league);

  const main = $('#view');
  const el = document.createElement('div');
  el.className = `view view-${r.name}`;
  el.innerHTML = ui.loading();
  main.replaceChildren(el);
  main.setAttribute('aria-busy', 'true');
  const key = `${r.name}/${league.id}/${r.params.id ?? ''}`;
  if (key !== lastKey) {
    window.scrollTo(0, 0);
    if (lastName && r.name !== lastName) main.focus({ preventScroll: true });
  }
  lastKey = key;
  lastName = r.name;
  setTitle(NAMES[r.name], r.league);

  const ctx = { league: league.id, leagueInfo: league, route: r.name, params: r.params, query: r.query, api, store, ui, navigate };
  try {
    const mod = (await import(`./views/${r.name}.js`).catch((err) => {
      throw new Error(`No se pudo cargar la vista «${NAMES[r.name]}». ${err.message}`);
    })).default;
    if (my !== seq) return;
    if (!mod?.render) throw new Error(`La vista «${NAMES[r.name]}» no exporta render().`);
    setTitle((typeof mod.title === 'function' ? mod.title(ctx) : mod.title) || NAMES[r.name], r.league);
    const ret = await mod.render(el, ctx);
    if (typeof ret !== 'function') return;
    if (my === seq) cleanup = ret;
    else try { ret(); } catch (err) { console.error(err); }
  } catch (err) {
    if (my !== seq) return;
    console.error(err);
    el.innerHTML = ui.errorBox(err);
  } finally {
    if (my === seq) main.removeAttribute('aria-busy');
  }
}

function setTitle(title, league) {
  document.title = `${title}${league ? ` · ${league.title}` : ''} | Oddsy Bet`;
}

function updateChrome(r, league) {
  for (const a of document.querySelectorAll('#nav [data-nav]')) {
    const v = a.dataset.nav;
    if (LEAGUE_VIEWS.includes(v)) a.href = `#/${(viewsOf(league).includes(v) ? league : LEAGUES[0]).id}/${v}`;
    if (v === r.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('.nav-more').classList.toggle('has-current', !LEAGUE_VIEWS.includes(r.name));
  setMore(false);
  $('.brand').href = home(league);
  const chips = $('#leagues');
  chips.hidden = !r.league;
  if (r.league) {
    chips.innerHTML = h`${LEAGUES.map((l) => h`<a href="#/${l.id}/${viewsOf(l).includes(r.name) ? r.name : 'games'}"${l.id === r.league.id ? raw(' aria-current="page"') : ''}>${l.title}</a>`)}`;
    const cur = chips.querySelector('[aria-current]');
    if (cur) chips.scrollLeft = cur.offsetLeft - chips.offsetLeft - 16; // solo horizontal: no mueve la página
  }
}

// ---------- compartir picks ----------
function importShare(query) {
  const incoming = decodePicks(query.get('p'));
  const have = new Set(store.get('picks').map((p) => p.id));
  const add = incoming.filter((p) => !have.has(p.id)).map((p) => ({ ...p, addedAt: Date.now() }));
  if (add.length) store.set('picks', [...store.get('picks'), ...add]);
  toast(incoming.length
    ? `Se agregaron ${add.length} de ${incoming.length} picks del enlace compartido.`
    : 'El enlace compartido no trae picks válidos.');
  if (incoming.length) openSlip();
  location.replace(defaultHash());
}

async function sharePicks() {
  const url = `${location.origin}${location.pathname}#/share?p=${encodePicks(store.get('picks'))}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Enlace copiado. Quien lo abra verá estos picks en su boleto.');
  } catch {
    window.prompt('Copia este enlace para compartir tus picks:', url);
  }
}

// ---------- boleto ----------
const leagueTitle = (id) => leagueById(id)?.title ?? id;
const combined = (list) => {
  const prices = list.map((p) => p.price).filter((x) => x > 1);
  return prices.length ? parlayOdds(prices) : null;
};

function renderSlip() {
  const picks = store.get('picks');
  $('#slipCount').textContent = picks.length || '';
  $('#fabCount').textContent = picks.length;
  const body = $('#slipBody'), foot = $('#slipFoot');
  if (!picks.length) {
    body.innerHTML = empty('Tu boleto está vacío. Agrega picks con el botón + en Props, Partidos, Insights o el Comparador.');
    foot.innerHTML = '';
    return;
  }
  const groups = new Map();
  for (const p of picks) {
    const k = bookInfo(p.book).key;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  body.innerHTML = h`${[...groups.values()].map((list) => h`<section class="slip-group" aria-label="${bookInfo(list[0].book).name}: ${list.length} ${list.length === 1 ? 'pick' : 'picks'}">
      <header class="slip-ghead">${bookChip(list[0].book)}<span class="slip-n">${list.length}/${picks.length}</span>${list.length > 1 ? h`<span class="slip-par" title="Cuota combinada en esta casa">${fmtOdds(combined(list))}</span>` : ''}</header>
      <ul>${list.map((p) => h`<li class="slip-pick">
        <div class="slip-txt"><span class="slip-label">${p.label}</span>${p.league ? h`<small>${leagueTitle(p.league)}</small>` : ''}</div>
        <b class="slip-price">${fmtOdds(p.price)}</b>
        <button type="button" class="icon-btn sm" data-remove="${p.id}" aria-label="Quitar ${p.label}">✕</button>
      </li>`)}</ul></section>`)}`;
  const total = combined(picks);
  foot.innerHTML = h`<dl class="slip-total">
      <div><dt>Picks</dt><dd>${picks.length}</dd></div>
      <div><dt>Cuota combinada</dt><dd>${fmtOdds(total)}</dd></div>
      <div><dt>Prob. implícita</dt><dd>${fmtPct(total ? 1 / total : null, 1)}</dd></div>
    </dl>
    <p class="slip-note">La combinada es informativa: patas del mismo partido están correlacionadas y cada casa tiene sus reglas.</p>
    <div class="slip-actions"><button type="button" class="btn btn-primary" data-share>Compartir</button><button type="button" class="btn" data-clear>Vaciar</button></div>`;
}

const wide = window.matchMedia('(min-width: 1280px)');
let slipOpen = false;
function syncSlip() {
  const drawer = !wide.matches;
  $('#slip').hidden = drawer && !slipOpen;
  $('#slip').classList.toggle('open', drawer && slipOpen);
  $('#slipFab').setAttribute('aria-expanded', String(drawer && slipOpen));
}
function openSlip() {
  slipOpen = true;
  syncSlip();
  if (!wide.matches) $('#slip .slip-close').focus();
}
function closeSlip(focusFab) {
  slipOpen = false;
  syncSlip();
  if (focusFab) $('#slipFab').focus();
}

// ---------- ajustes ----------
const DEVIG = { multiplicative: 'Multiplicativo', additive: 'Aditivo', power: 'Power', shin: 'Shin', probit: 'Probit', worst: 'Peor caso' };
const KELLY = { 1: 'Completo (1)', 0.5: 'Medio (½)', 0.25: 'Cuarto (¼)', 0.1: 'Décimo (0.1)' };
function openSettings() {
  const s = store.get('settings');
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'settings-form';
  form.innerHTML = h`<fieldset><legend>Mis casas</legend>
      <p class="hint">Se usan para filtrar cuotas y armar el boleto. Si no marcas ninguna, se muestran todas.</p>
      <div class="book-grid">${Object.keys(BOOKS).map((k) => h`<label class="book-opt"><input type="checkbox" name="books" value="${k}"${s.books.includes(k) ? raw(' checked') : ''}> ${bookChip(k)}</label>`)}</div>
    </fieldset>
    <div class="settings-row">
      <label>Bankroll <input name="bankroll" type="number" min="1" step="1" required value="${s.bankroll}"></label>
      <label>Multiplicador de Kelly <select name="kellyMult">${Object.entries(KELLY).map(([v, t]) => h`<option value="${v}"${Number(v) === Number(s.kellyMult) ? raw(' selected') : ''}>${t}</option>`)}</select></label>
      <label>Método de devig <select name="devigMethod">${Object.entries(DEVIG).map(([v, t]) => h`<option value="${v}"${v === s.devigMethod ? raw(' selected') : ''}>${t}</option>`)}</select></label>
    </div>
    <div class="modal-actions"><button type="submit" class="btn" value="cancel" formnovalidate>Cancelar</button><button type="submit" class="btn btn-primary" value="save">Guardar</button></div>`;
  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    const f = new FormData(form);
    const bankroll = Number(f.get('bankroll'));
    store.set('settings', {
      ...store.get('settings'),
      books: f.getAll('books').map(String),
      bankroll: bankroll > 0 ? bankroll : s.bankroll,
      kellyMult: Number(f.get('kellyMult')) || s.kellyMult,
      devigMethod: DEVIG[f.get('devigMethod')] ? f.get('devigMethod') : s.devigMethod,
    });
    toast('Ajustes guardados.');
    route();
  });
  modal({ title: 'Ajustes', body: form, onClose: () => $('#settingsBtn').focus() });
}

let lastFormat = store.get('settings').oddsFormat;
function syncOddsToggle() {
  for (const b of document.querySelectorAll('[data-odds]')) b.setAttribute('aria-pressed', String(b.dataset.odds === lastFormat));
}

// ---------- utilidades del shell ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

function setMore(open) {
  $('.nav-more').setAttribute('aria-expanded', String(open));
  $('#nav').classList.toggle('more-open', open);
}

// ---------- eventos ----------
$('#view').addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) route(); });
$('[data-skip]').addEventListener('click', (e) => { e.preventDefault(); $('#view').focus(); });
$('.nav-more').addEventListener('click', () => setMore($('.nav-more').getAttribute('aria-expanded') !== 'true'));
document.addEventListener('click', (e) => { if (!e.target.closest('#nav')) setMore(false); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if ($('#nav').classList.contains('more-open')) { setMore(false); $('.nav-more').focus(); }
  else if (slipOpen && !wide.matches) closeSlip(true);
});

for (const b of document.querySelectorAll('[data-odds]')) {
  b.addEventListener('click', () => store.set('settings', { ...store.get('settings'), oddsFormat: b.dataset.odds }));
}
$('#settingsBtn').addEventListener('click', openSettings);

$('#slipFab').addEventListener('click', () => (slipOpen ? closeSlip() : openSlip()));
$('#slip').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-remove]');
  if (rm) { store.removePick(rm.dataset.remove); $('#slipTitle').focus(); return; }
  if (e.target.closest('[data-slip-close]')) return closeSlip(true);
  if (e.target.closest('[data-share]')) return sharePicks();
  if (e.target.closest('[data-clear]') && window.confirm('¿Vaciar todos los picks del boleto?')) store.set('picks', []);
});
wide.addEventListener('change', syncSlip);

store.on('picks', renderSlip);
store.on('settings', (s) => {
  if (s?.oddsFormat === lastFormat) return;
  lastFormat = s.oddsFormat;
  syncOddsToggle();
  renderSlip();
  route();
});

if (!store.get('heroSeen')) {
  $('#hero').hidden = false;
  store.set('heroSeen', true);
}
$('[data-hero-close]').addEventListener('click', () => { $('#hero').hidden = true; $('#view').focus(); });

window.addEventListener('hashchange', route);
syncOddsToggle();
syncSlip();
renderSlip();
route();
