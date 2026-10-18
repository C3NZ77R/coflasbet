// Calculadoras (docs/spec-calculators.json): 16 formularios con resultados en vivo y enlace directo
// (#/calculadoras?c=poisson). Cada calculadora trae precargado el ejemplo resuelto de la especificación.
// Modelo: cada calculadora guarda sus valores como texto en un objeto de estado; escribir solo recalcula,
// los controles estructurales (modos, agregar/quitar patas) vuelven a dibujar el formulario.
import * as bm from '../betmath.js';
import { h, raw, fmtPct, fmtMoney } from '../ui.js';

// ---------- formato y lectura ----------

const FORMATS = { american: 'Americana', decimal: 'Decimal', fractional: 'Fraccionaria' };
const PH = { american: '-110', decimal: '1.91', fractional: '10/11' };
const FMT_HINT = { american: 'p. ej. -110 o +150; entre -99 y +99 no existe', decimal: 'mayor que 1, p. ej. 1.91', fractional: 'positiva con barra, p. ej. 10/11' };

const toNum = (v) => {
  const s = String(v ?? '').trim().replace(',', '.');
  return s === '' ? NaN : Number(s);
};
const trim = (x, dp = 4) => String(+x.toFixed(dp));

export function parseOdds(v, fmt) {
  const s = String(v ?? '').trim();
  if (fmt === 'fractional') return bm.fractionalToDecimal(s);
  const x = toNum(s);
  if (!Number.isFinite(x)) return null;
  if (fmt === 'decimal') return x > 1 ? x : null;
  return Math.abs(x) >= 100 ? bm.americanToDecimal(x) : null;
}

const okD = (d) => Number.isFinite(d) && d > 1;
const am = (d) => {
  const a = bm.decimalToAmerican(d);
  return a > 0 ? `+${a}` : `${a}`;
};
// Texto editable de una cuota en otro formato (al cambiar el formato de la calculadora).
// 5 decimales en el texto editable: con 4, −110 → 1.9091 y un parlay de dos patas se desvía un centavo.
const editOdds = (d, fmt) => (fmt === 'decimal' ? trim(d, 5) : fmt === 'fractional' ? bm.decimalToFractional(d, 1000) : am(d));

export function showOdds(d, fmt) {
  if (!okD(d)) return '—';
  if (fmt === 'fractional') return bm.decimalToFractional(d, 1000);
  if (fmt === 'decimal') {
    const s = trim(d);
    return (s.split('.')[1] ?? '').length >= 2 ? s : d.toFixed(2);
  }
  return am(d);
}
const oddsP = (p, fmt) => (p > 0 && p < 1 ? showOdds(1 / p, fmt) : '—');

const pct = (x, d = 2) => fmtPct(x, d);
const money = (x) => fmtMoney(x);
const sgn = (x, eps) => (x > eps ? '+' : x < -eps ? '−' : '');
const signed = (x) => (Number.isFinite(x) ? `${sgn(x, 0.004)}${fmtMoney(Math.abs(x))}` : '—');
const signedPct = (x, d = 2) => (Number.isFinite(x) ? `${sgn(x, 0.5 * 10 ** -(d + 2))}${Math.abs(x * 100).toFixed(d)}%` : '—');
const pp = (x) => (Number.isFinite(x) ? `${sgn(x, 0.00005)}${Math.abs(x * 100).toFixed(2)} pp` : '—');
const tone = (x) => (x > 1e-9 ? 'pos' : x < -1e-9 ? 'neg' : '');
const line = (x, isSpread) => (isSpread && x > 0 ? `+${x}` : `${x}`);

const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
function setPath(o, p, v) {
  const ks = p.split('.'), last = ks.pop();
  const t = ks.reduce((x, k) => x?.[k], o);
  if (t && typeof t === 'object') t[last] = v;
}

class Bad extends Error {
  constructor(field, msg) {
    super(msg);
    this.field = field;
  }
}

// Lector de valores del estado: devuelve números válidos o lanza Bad(campo, mensaje en español).
function reader(s, fmt) {
  const get = (p) => getPath(s, p);
  return {
    get,
    odds(p, label) {
      const d = parseOdds(get(p), fmt);
      if (d == null) throw new Bad(p, `${label}: cuota no válida (${FMT_HINT[fmt]}).`);
      return d;
    },
    // o: { min, max, gt, lt, int, empty } — empty: valor si el campo está vacío (si no, es obligatorio).
    num(p, label, o = {}) {
      const raw0 = get(p);
      if ('empty' in o && String(raw0 ?? '').trim() === '') return o.empty;
      const x = toNum(raw0);
      const bad = !Number.isFinite(x) || (o.int && !Number.isInteger(x)) || x < (o.min ?? -Infinity) || x > (o.max ?? Infinity) || (o.gt != null && !(x > o.gt)) || (o.lt != null && !(x < o.lt));
      if (!bad) return x;
      const lo = o.gt != null ? `mayor que ${o.gt}` : o.min != null ? `mínimo ${o.min}` : '';
      const hi = o.lt != null ? `menor que ${o.lt}` : o.max != null ? `máximo ${o.max}` : '';
      throw new Bad(p, `${label}: escribe un número${o.int ? ' entero' : ''}${lo || hi ? ` (${[lo, hi].filter(Boolean).join(', ')})` : ''}.`);
    },
    prob(p, label, o = {}) {
      const x = this.num(p, label, { min: 0, max: 100, ...o });
      return x == null ? null : x / 100;
    },
  };
}

// Constructores de campos para un formulario (ids únicos: solo hay un formulario a la vez).
function builder(calc, s, fmt) {
  const get = (p) => getPath(s, p);
  const id = (p) => `cx-${calc.id}-${p.replace(/\./g, '-')}`;
  const desc = (p, o) => (o.hint ? raw(` aria-describedby="${id(p)}-h"`) : '');
  const wrap = (p, label, control, o = {}) => h`<div class="cf${o.wide ? ' cf-wide' : ''}"${o.when ? raw(` data-when="${o.when}"`) : ''}>
      <label for="${id(p)}"${o.labKey ? raw(` data-lab="${o.labKey}"`) : ''}>${label}</label>${control}${o.hint ? h`<small class="cf-hint" id="${id(p)}-h">${o.hint}</small>` : ''}</div>`;
  const unit = (u, after) => (u ? h`<span class="cf-u${after ? ' after' : ''}" aria-hidden="true">${u}</span>` : '');
  return {
    num(p, label, o = {}) {
      const lim = raw([o.min != null && ` min="${o.min}"`, o.max != null && ` max="${o.max}"`].filter(Boolean).join(''));
      return wrap(p, label, h`<div class="cf-in">${unit(o.unit)}<input id="${id(p)}" name="${p}" type="number" inputmode="decimal" step="${o.step ?? 'any'}"${lim} value="${get(p) ?? ''}"${desc(p, o)}>${unit(o.after, true)}</div>`, o);
    },
    odds(p, label, o = {}) {
      return wrap(p, label, h`<div class="cf-in"><input id="${id(p)}" name="${p}" type="text" inputmode="${fmt === 'decimal' ? 'decimal' : 'text'}" autocomplete="off" spellcheck="false" data-odds placeholder="${PH[fmt]}" value="${get(p) ?? ''}"${desc(p, o)}></div>`, o);
    },
    text(p, label, o = {}) {
      return wrap(p, label, h`<div class="cf-in"><input id="${id(p)}" name="${p}" type="text" maxlength="60" autocomplete="off" placeholder="${o.placeholder ?? ''}" value="${get(p) ?? ''}"></div>`, o);
    },
    sel(p, label, options, o = {}) {
      return wrap(p, label, h`<div class="cf-in"><select id="${id(p)}" name="${p}"${o.rebuild ? raw(' data-rebuild') : ''}${desc(p, o)}>${options.map(([v, t]) => h`<option value="${v}"${String(v) === String(get(p)) ? raw(' selected') : ''}>${t}</option>`)}</select></div>`, o);
    },
    seg(p, label, options, o = {}) {
      const v = String(get(p));
      return h`<div class="cf cf-wide"><span class="cf-lab" id="${id(p)}">${label}</span><div class="seg" role="group" aria-labelledby="${id(p)}">${options.map(([val, t]) => h`<button type="button" data-set="${p}" data-val="${val}" aria-pressed="${String(v === String(val))}"${o.disabled?.includes(val) ? raw(' disabled') : ''}>${t}</button>`)}</div>${o.hint ? h`<small class="cf-hint">${o.hint}</small>` : ''}</div>`;
    },
    // Lista de filas (patas, picks) con botones para agregar y quitar.
    list(p, legend, row) {
      const items = get(p), spec = calc.lists[p];
      return h`<fieldset class="cf-list cf-wide"><legend>${legend}</legend>
        ${items.map((_, i) => h`<div class="cf-row"><span class="cf-n" aria-hidden="true">${i + 1}</span>${row(i)}<button type="button" class="icon-btn sm" data-del="${p}" data-i="${i}" aria-label="Quitar ${spec.noun} ${i + 1}"${items.length <= spec.min ? raw(' disabled') : ''}>✕</button></div>`)}
        <div class="cf-list-foot"><button type="button" class="btn" data-add="${p}"${items.length >= spec.max ? raw(' disabled') : ''}>+ Agregar ${spec.noun}</button><small class="cf-hint">${items.length} (de ${spec.min} a ${spec.max})</small></div>
      </fieldset>`;
    },
  };
}

const n1 = (i, txt) => h`<span class="sr-only">${i + 1}:</span> ${txt}`;

const table = (caption, head, rows, { more } = {}) => h`<div class="table-wrap"><table class="tbl calc-tbl"><caption>${caption}</caption>
    <thead><tr>${head.map((x) => h`<th scope="col">${x}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => h`<tr>${r.map((c, i) => (i === 0 ? h`<th scope="row">${c}</th>` : c && typeof c === 'object' && 'v' in c ? h`<td class="${c.cls ?? ''}">${c.v}</td>` : h`<td>${c}</td>`))}</tr>`)}</tbody>
  </table>${more ? h`<p class="calc-more">${more}</p>` : ''}</div>`;

const DELTAS = [-5, -2, 0, 2, 5];
const deltaLabel = (d) => (d === 0 ? 'Tu estimación' : `${d > 0 ? '+' : '−'}${Math.abs(d)} pp`);
const choose = (n, k) => Array.from({ length: k }, (_, i) => i).reduce((r, i) => (r * (n - i)) / (i + 1), 1);

// ---------- mercados de 2 o 3 resultados (sin vig, hold, vig) ----------

const marketForm = (F, s) => h`${F.seg('ways', 'Resultados del mercado', [['2', 'Dos (sin empate)'], ['3', 'Tres (con empate)']])}
  ${s.ways === '3'
    ? h`${F.odds('odds.0', 'Local')}${F.odds('odds.2', 'Empate')}${F.odds('odds.1', 'Visitante')}`
    : h`${F.odds('odds.0', 'Lado 1')}${F.odds('odds.1', 'Lado 2')}`}`;
// Orden de precios: [lado 1/local, empate, lado 2/visitante] en 3 vías; [lado 1, lado 2] en 2.
const marketIdx = (s) => (s.ways === '3' ? [0, 2, 1] : [0, 1]);
const marketLabels = (s) => (s.ways === '3' ? ['Local', 'Empate', 'Visitante'] : ['Lado 1', 'Lado 2']);
const marketPrices = (r, s) => {
  const labels = marketLabels(s);
  return marketIdx(s).map((k, i) => r.odds(`odds.${k}`, labels[i]));
};
const holdTable = (hd, labels, fmt) => table('Detalle por resultado', ['Resultado', 'Implícita', 'Sin vig', 'Cuota justa', 'Margen'],
  hd.rows.map((x, i) => [labels[i], pct(x.implied), pct(x.fair), showOdds(x.fairOdds, fmt), pp(x.margin)]));
const holdStats = (hd) => [
  ['Overround (margen)', pct(hd.overround), hd.overround < 0 ? 'pos' : ''],
  ['Hold teórico', pct(hd.hold)],
  ['Probabilidad implícita total', pct(hd.total)],
];
const arbNote = (hd) => (hd.overround < 0 ? 'Overround negativo: la suma de probabilidades es menor que 100 %, posible arbitraje entre estas cuotas.' : '');

// ---------- PrizePicks ----------

// Multiplicador bruto por número de aciertos (índice = aciertos). Power 2 = 3×, Power 4 = 10× y Flex 4 = 6×/1.5×
// coinciden con la hoja de Outlier; el resto son los pagos estándar publicados por PrizePicks (varían por estado
// y por tipo de pick), por eso son editables.
const PP_PAY = {
  power: { 2: [0, 0, 3], 3: [0, 0, 0, 5], 4: [0, 0, 0, 0, 10], 5: [0, 0, 0, 0, 0, 20], 6: [0, 0, 0, 0, 0, 0, 37.5] },
  flex: { 3: [0, 0, 1.25, 2.25], 4: [0, 0, 0, 1.5, 6], 5: [0, 0, 0, 0.4, 2, 10], 6: [0, 0, 0, 0, 0.4, 2, 25] },
};
const clonePay = () => JSON.parse(JSON.stringify(PP_PAY));
const MODE_NAME = { power: 'Power', flex: 'Flex' };

// ---------- calculadoras ----------

const SIGMAS = { nfl: ['NFL', 13.5], nba: ['NBA', 12], ncaaf: ['Fútbol americano universitario', 16], ncaab: ['Baloncesto universitario', 11], custom: ['Personalizado', null] };
const RR_RESULTS = [['win', 'Ganó'], ['loss', 'Perdió'], ['push', 'Push / anulada'], ['pending', 'Pendiente']];
const RR_TEXT = { win: 'Gana', loss: 'Pierde', push: 'Push (devuelve)', pending: 'Pendiente' };
const KELLY_MULTS = [['0.25', 'Cuarto (¼)'], ['0.5', 'Medio (½)'], ['0.75', 'Tres cuartos (¾)'], ['1', 'Completo'], ['custom', 'Personalizado']];

export const CALCS = [
  {
    id: 'parlay', name: 'Parlay', desc: 'Cuota combinada, ganancia y pago de 2 a 15 patas.', tags: 'combinada parley acumulada multiple',
    init: () => ({ stake: '100', legs: [{ label: '', odds: '-110' }, { label: '', odds: '-110' }] }),
    oddsPaths: (s) => s.legs.map((_, i) => `legs.${i}.odds`),
    lists: { legs: { min: 2, max: 15, noun: 'pata', item: () => ({ label: '', odds: '' }) } },
    form: (F) => h`${F.num('stake', 'Apuesta al parlay', { unit: '$', min: 0 })}
      ${F.list('legs', 'Patas', (i) => h`${F.text(`legs.${i}.label`, n1(i, 'Etiqueta (opcional)'), { placeholder: 'Equipo o pick' })}${F.odds(`legs.${i}.odds`, n1(i, 'Cuota'))}`)}`,
    calc(r, s, fmt) {
      const stake = r.num('stake', 'Apuesta', { gt: 0 });
      const ds = s.legs.map((_, i) => r.odds(`legs.${i}.odds`, `Pata ${i + 1}`));
      const D = bm.parlayOdds(ds);
      return {
        stats: [['Cuota combinada', showOdds(D, fmt)], ['Ganancia', money(stake * (D - 1)), 'pos'], ['Pago total', money(stake * D)], ['Prob. implícita combinada', pct(1 / D)]],
        note: 'La probabilidad combinada incluye el margen de cada casa y supone patas independientes; las del mismo partido suelen estar correlacionadas.',
        detail: table('Patas', ['Pata', 'Cuota', 'Decimal', 'Prob. implícita'], ds.map((d, i) => [s.legs[i].label?.trim() || `Pata ${i + 1}`, showOdds(d, fmt), d.toFixed(4), pct(1 / d)])),
      };
    },
    how: ['Cada pata a decimal: americana +A → 1 + A/100; −A → 1 + 100/A; fraccionaria n/m → 1 + n/m.', 'Cuota combinada D = d₁ × d₂ × … × dₙ.', 'Ganancia = apuesta × (D − 1); pago = apuesta × D; prob. implícita = 1/D.'],
  },
  {
    id: 'prizepicks', name: 'PrizePicks EV', desc: 'EV de entradas Power y Flex de 2 a 6 picks (DFS).', tags: 'dfs pick em power flex underdog sleeper',
    init: () => ({ stake: '100', mode: 'power', input: 'prob', picks: [{ label: '', prob: '60', odds: '' }, { label: '', prob: '60', odds: '' }], pay: clonePay(), bankroll: '1000', share: '25' }),
    oddsPaths: (s) => s.picks.map((_, i) => `picks.${i}.odds`),
    lists: { picks: { min: 2, max: 6, noun: 'pick', item: () => ({ label: '', prob: '', odds: '' }) } },
    onSet(s, name, fmt) {
      if (name === 'input') {
        for (const p of s.picks) {
          if (s.input === 'odds') {
            const x = toNum(p.prob);
            if (x > 0 && x < 100) p.odds = editOdds(100 / x, fmt);
          } else {
            const d = parseOdds(p.odds, fmt);
            if (d) p.prob = trim(100 / d, 2);
          }
        }
      }
      if (s.picks.length < 3) s.mode = 'power';
    },
    form(F, s) {
      const n = s.picks.length, mode = s.mode;
      const ks = Array.from({ length: n + 1 }, (_, k) => n - k);
      return h`${F.num('stake', 'Monto de la entrada', { unit: '$', min: 0.01, max: 1000000 })}
        ${F.seg('mode', 'Formato de la entrada', [['power', 'Power (aciertan todos)'], ['flex', 'Flex (3+ picks)']], { disabled: n < 3 ? ['flex'] : [] })}
        ${F.seg('input', 'Probabilidad de cada pick', [['prob', 'Probabilidad (%)'], ['odds', 'Cuota justa']], { hint: 'La cuota justa se convierte a probabilidad sin quitar vig: usa una cuota ya sin margen.' })}
        ${F.list('picks', 'Picks', (i) => h`${F.text(`picks.${i}.label`, n1(i, 'Etiqueta (opcional)'), { placeholder: 'Jugador y línea' })}${s.input === 'odds' ? F.odds(`picks.${i}.odds`, n1(i, 'Cuota justa')) : F.num(`picks.${i}.prob`, n1(i, 'Probabilidad'), { after: '%', min: 0, max: 100 })}`)}
        <fieldset class="cf-list cf-wide"><legend>Pagos ${MODE_NAME[mode]} de ${n} picks (multiplicador bruto)</legend>
          <div class="cf-pay">${ks.map((k) => F.num(`pay.${mode}.${n}.${k}`, `${k}/${n} aciertos`, { unit: '×', min: 0, max: 1000 }))}</div>
          <small class="cf-hint">Plantilla editable: Power 2 = 3×, Power 4 = 10× y Flex 4 = 6× / 1.5× vienen de la hoja de Outlier; el resto son pagos estándar publicados por PrizePicks y cambian por estado y por tipo de pick. Confírmalos en tu app.</small>
        </fieldset>
        ${F.num('bankroll', 'Bankroll (opcional)', { unit: '$', min: 0 })}
        ${F.num('share', 'Fracción de Kelly', { after: '%', min: 0, max: 100 })}`;
    },
    calc(r, s) {
      const n = s.picks.length, mode = n < 3 ? 'power' : s.mode;
      const stake = r.num('stake', 'Monto de la entrada', { min: 0.01, max: 1e6 });
      const probs = s.picks.map((_, i) => (s.input === 'odds' ? 1 / r.odds(`picks.${i}.odds`, `Pick ${i + 1}`) : r.prob(`picks.${i}.prob`, `Pick ${i + 1}: probabilidad`)));
      const payouts = Array.from({ length: n + 1 }, (_, k) => r.num(`pay.${mode}.${n}.${k}`, `Pago con ${k}/${n} aciertos`, { min: 0, max: 1000 }));
      const bankroll = r.num('bankroll', 'Bankroll', { min: 0, empty: 0 });
      const share = r.num('share', 'Fracción de Kelly', { min: 0, max: 100, empty: 100 }) / 100;
      const res = bm.prizepicksEv({ probs, payouts, stake, bankroll, kellyShare: share });
      const stats = [
        ['ROI esperado', signedPct(res.roi), tone(res.roi)],
        ['Ganancia neta esperada', signed(res.expectedProfit), tone(res.expectedProfit)],
        ['Retorno total esperado', money(res.expectedReturn)],
        ['Prob. de ganancia neta', pct(res.pProfit)],
        ['Prob. de perderlo todo', pct(res.pLoss)],
        ['Prob. de equilibrio por pick', res.breakEvenP == null ? 'inalcanzable' : pct(res.breakEvenP), '', 'si todos los picks tuvieran la misma'],
        ['Kelly completo', pct(res.kelly), '', bankroll > 0 ? `${trim(share * 100, 2)} % de Kelly → ${money(res.kellyStake)}` : 'escribe un bankroll para el monto'],
      ];
      let detail = table('Todos los resultados', ['Aciertos', 'Probabilidad', 'Multiplicador', 'Retorno', 'Neto'],
        [...res.outcomes].reverse().map((o) => [`${o.k}/${n}`, pct(o.prob), `${trim(o.mult)}×`, money(o.ret), { v: signed(o.net), cls: tone(o.net) }]));
      if (n >= 3) {
        const cmp = ['power', 'flex'].map((m) => {
          const pay = Array.from({ length: n + 1 }, (_, k) => toNum(getPath(s, `pay.${m}.${n}.${k}`)));
          const x = pay.every((v) => v >= 0) ? bm.prizepicksEv({ probs, payouts: pay, stake }) : null;
          return [MODE_NAME[m] + (m === mode ? ' (actual)' : ''), x ? { v: signedPct(x.roi), cls: tone(x.roi) } : '—', x ? signed(x.expectedProfit) : '—', x ? pct(x.pLoss) : '—'];
        });
        detail = h`${detail}${table(`Power vs. Flex con estos ${n} picks`, ['Formato', 'ROI', 'Ganancia esperada', 'Prob. de perderlo todo'], cmp)}`;
      }
      return { stats, detail, note: 'Supone picks independientes. Kelly maximiza el crecimiento logarítmico del bankroll con todos los resultados de la entrada.' };
    },
    how: ['Probabilidad desde cuota justa: −A → A/(A+100); +A → 100/(A+100).', 'Distribución de aciertos (Poisson-binomial) por programación dinámica con la probabilidad de cada pick.', 'EV = Σ P(k) × apuesta × (multiplicador_k − 1); ROI = EV / apuesta.', 'Kelly: f que maximiza Σ P(k) ln(1 + f(m_k − 1)); en Power es (P(todos)·M − 1)/(M − 1).'],
  },
  {
    id: 'round-robin', name: 'Round robin', desc: 'Todas las combinaciones de r patas entre n, con resultados simulados.', tags: 'rr sistema combinaciones',
    init: () => ({ stake: '1', size: '4', legs: Array.from({ length: 5 }, () => ({ odds: '+100', result: 'win' })) }),
    oddsPaths: (s) => s.legs.map((_, i) => `legs.${i}.odds`),
    lists: { legs: { min: 2, max: 15, noun: 'pata', item: () => ({ odds: '', result: 'pending' }) } },
    onSet(s) {
      s.size = String(Math.min(Math.max(2, Number(s.size) || 2), s.legs.length));
    },
    form: (F, s) => h`${F.num('stake', 'Apuesta por combinación', { unit: '$', min: 0 })}
      ${F.sel('size', 'Patas por parlay (n.º de parlays)', Array.from({ length: s.legs.length - 1 }, (_, i) => [String(i + 2), `${i + 2} (${choose(s.legs.length, i + 2)})`]))}
      ${F.list('legs', 'Patas', (i) => h`${F.odds(`legs.${i}.odds`, n1(i, 'Cuota'))}${F.sel(`legs.${i}.result`, n1(i, 'Resultado'), RR_RESULTS)}`)}`,
    calc(r, s, fmt) {
      const stake = r.num('stake', 'Apuesta por combinación', { gt: 0 });
      const legs = s.legs.map((l, i) => ({ price: r.odds(`legs.${i}.odds`, `Pata ${i + 1}`), result: l.result }));
      const size = Number(s.size);
      const rr = bm.roundRobin(legs, size, stake);
      if (!rr) throw new Bad('size', 'Tamaño de parlay no válido.');
      const LIMIT = 200;
      return {
        stats: [
          ['Combinaciones', `${rr.combos}`, '', `C(${legs.length}, ${size})`],
          ['Riesgo total', money(rr.totalStake)],
          ['Pago máximo', money(rr.maxPayout), '', 'si ganan todas'],
          ['Ganancia máxima', signed(rr.maxProfit), tone(rr.maxProfit)],
          ['Pago liquidado (simulado)', money(rr.payout)],
          ['Ganancia neta simulada', rr.profit == null ? 'pendiente' : signed(rr.profit), rr.profit == null ? '' : tone(rr.profit), rr.pending ? 'hay combinaciones sin resolver' : ''],
          ['Combinaciones pendientes', `${rr.pending}`],
        ],
        detail: table('Combinaciones', ['#', 'Patas', 'Apuesta', 'Cuota', 'Resultado', 'Pago'],
          rr.rows.slice(0, LIMIT).map((x, i) => [`${i + 1}`, x.legs.map((k) => k + 1).join(' + '), money(stake), showOdds(x.odds, fmt), RR_TEXT[x.result], x.payout == null ? '—' : money(x.payout)]),
          { more: rr.rows.length > LIMIT ? `Se muestran las primeras ${LIMIT} de ${rr.rows.length} combinaciones.` : '' }),
      };
    },
    how: ['Número de parlays = C(n, r) = n! / (r! (n − r)!); riesgo = C(n, r) × apuesta.', 'Una combinación con una pata perdida paga 0; las patas en push se quitan (cuota 1); si todas son push se devuelve la apuesta.', 'Con una pata pendiente (y ninguna perdida) la combinación queda pendiente, no perdida.'],
  },
  {
    id: 'ev', name: 'Valor esperado (EV)', desc: 'Ganancia esperada, punto de equilibrio y ventaja con tu probabilidad.', tags: 'expected value ev+ edge ventaja',
    init: () => ({ odds: '+110', stake: '100', pmode: 'prob', prob: '50', fair: '' }),
    oddsPaths: () => ['odds', 'fair'],
    onSet(s, name, fmt) {
      if (name !== 'pmode') return;
      if (s.pmode === 'fair') {
        const x = toNum(s.prob);
        if (x > 0 && x < 100) s.fair = editOdds(100 / x, fmt);
      } else {
        const d = parseOdds(s.fair, fmt);
        if (d) s.prob = trim(100 / d, 2);
      }
    },
    form: (F, s) => h`${F.odds('odds', 'Cuota de la casa')}${F.num('stake', 'Apuesta', { unit: '$', min: 0 })}
      ${F.seg('pmode', 'Tu probabilidad justa como', [['prob', 'Probabilidad (%)'], ['fair', 'Cuota justa']])}
      ${s.pmode === 'fair' ? F.odds('fair', 'Cuota justa (sin vig)') : F.num('prob', 'Probabilidad de ganar', { after: '%', min: 0, max: 100 })}`,
    calc(r, s) {
      const d = r.odds('odds', 'Cuota de la casa'), stake = r.num('stake', 'Apuesta', { gt: 0 });
      const p = s.pmode === 'fair' ? 1 / r.odds('fair', 'Cuota justa') : r.prob('prob', 'Probabilidad de ganar');
      const ev = p * d - 1;
      return {
        stats: [
          ['Ganancia esperada', signed(stake * ev), tone(ev)], ['EV (retorno sobre lo apostado)', signedPct(ev), tone(ev)],
          ['Punto de equilibrio', pct(1 / d)], ['Tu probabilidad justa', pct(p)], ['Ventaja', pp(p - 1 / d), tone(p - 1 / d)],
          ['Por cada 100 apuestas', signed(100 * stake * ev), tone(ev)], ['Ganancia si gana', money(stake * (d - 1))], ['Pago total si gana', money(stake * d)],
        ],
        detail: table('Sensibilidad a tu estimación', ['Cambio', 'Probabilidad', 'EV ($)', 'EV (%)'],
          DELTAS.map((x) => p + x / 100).map((q, i) => (q >= 0 && q <= 1 ? [deltaLabel(DELTAS[i]), pct(q), { v: signed(stake * (q * d - 1)), cls: tone(q * d - 1) }, signedPct(q * d - 1)] : null)).filter(Boolean)),
      };
    },
    how: ['Ganancia esperada = apuesta × (p × d − 1); EV % = p × d − 1.', 'Punto de equilibrio = 1/d; ventaja = p − 1/d (en puntos porcentuales).', 'Con cuota justa: p = 1 / cuota justa decimal.'],
  },
  {
    id: 'kelly', name: 'Criterio de Kelly', desc: 'Cuánto apostar según tu ventaja y tu bankroll.', tags: 'kelly stake bankroll gestion tamaño',
    init: () => ({ bankroll: '1000', odds: '+100', prob: '55', mult: '0.25', custom: '0.3' }),
    oddsPaths: () => ['odds'],
    form: (F, s) => h`${F.num('bankroll', 'Bankroll', { unit: '$', min: 0 })}${F.odds('odds', 'Cuota de la casa')}
      ${F.num('prob', 'Probabilidad estimada de ganar', { after: '%', min: 0, max: 100 })}
      ${F.sel('mult', 'Multiplicador de Kelly', KELLY_MULTS, { rebuild: true })}
      ${s.mult === 'custom' ? F.num('custom', 'Multiplicador personalizado', { unit: '×', min: 0, max: 1, step: '0.05', hint: 'Entre 0 y 1 (0.3 = 30 % de Kelly).' }) : ''}`,
    calc(r, s) {
      const bank = r.num('bankroll', 'Bankroll', { gt: 0 }), d = r.odds('odds', 'Cuota'), p = r.prob('prob', 'Probabilidad');
      const m = s.mult === 'custom' ? r.num('custom', 'Multiplicador', { gt: 0, max: 1 }) : Number(s.mult);
      const full = bm.kelly(p, d);
      return {
        stats: [
          ['Monto a apostar', money(bank * full * m)], ['% del bankroll', pct(full * m)], ['Kelly completo (sin escalar)', pct(full)],
          ['EV de la apuesta', signedPct(p * d - 1), tone(p * d - 1)], ['Punto de equilibrio', pct(1 / d)], ['Multiplicador', `${trim(m, 3)}× Kelly`],
        ],
        note: full === 0 ? 'Sin ventaja (EV ≤ 0): Kelly recomienda no apostar.' : '',
        detail: table('Sensibilidad a tu estimación', ['Cambio', 'Probabilidad', '% del bankroll', 'Monto'],
          DELTAS.map((x) => p + x / 100).map((q, i) => (q >= 0 && q <= 1 ? [deltaLabel(DELTAS[i]), pct(q), pct(bm.kelly(q, d) * m), money(bank * bm.kelly(q, d) * m)] : null)).filter(Boolean)),
      };
    },
    how: ['Kelly completo f = (p × d − 1) / (d − 1); si es negativo se usa 0.', 'Monto = bankroll × f × multiplicador. Un cuarto o medio Kelly reduce la volatilidad y el riesgo de sobrestimar tu ventaja.'],
  },
  {
    id: 'arbitraje', name: 'Arbitraje y cobertura', desc: 'Reparte un presupuesto entre dos lados o cubre una apuesta ya hecha.', tags: 'arbitrage arb hedge surebet',
    init: () => ({ mode: 'budget', budget: '100', stake: '100', d1: '+110', d2: '+110' }),
    oddsPaths: () => ['d1', 'd2'],
    form: (F, s) => h`${F.seg('mode', 'Modo', [['budget', 'Repartir un presupuesto'], ['hedge', 'Cubrir una apuesta existente']])}
      ${s.mode === 'hedge' ? F.num('stake', 'Apuesta ya hecha en el resultado 1', { unit: '$', min: 0 }) : F.num('budget', 'Presupuesto total', { unit: '$', min: 0 })}
      ${F.odds('d1', 'Cuota del resultado 1')}${F.odds('d2', 'Cuota del resultado 2')}`,
    calc(r, s) {
      const d1 = r.odds('d1', 'Cuota del resultado 1'), d2 = r.odds('d2', 'Cuota del resultado 2');
      const res = s.mode === 'hedge' ? bm.hedge([d1, d2], { stake: r.num('stake', 'Apuesta existente', { gt: 0 }) }) : bm.hedge([d1, d2], { budget: r.num('budget', 'Presupuesto', { gt: 0 }) });
      const S = 1 / d1 + 1 / d2;
      return {
        stats: [
          ['Ganancia neta mínima', signed(res.minProfit), tone(res.minProfit)], ['Apuesta en el resultado 1', money(res.stakes[0])],
          ['Apuesta en el resultado 2', money(res.stakes[1])], ['Total apostado', money(res.total)], ['Retorno sobre el total', signedPct(res.roi), tone(res.roi)],
        ],
        note: res.isArb ? `Arbitraje: 1/d₁ + 1/d₂ = ${pct(S)} < 100 %, ganas pase lo que pase.` : `Sin arbitraje: 1/d₁ + 1/d₂ = ${pct(S)} ≥ 100 %; este reparto fija una pérdida.`,
        detail: table('Si gana cada resultado', ['Resultado', 'Pago', 'Ganancia neta'], res.payouts.map((x, i) => [`Gana el resultado ${i + 1}`, money(x), { v: signed(res.profits[i]), cls: tone(res.profits[i]) }])),
      };
    },
    how: ['Presupuesto B: s₁ = B × d₂ / (d₁ + d₂), s₂ = B − s₁ (mismo pago en ambos lados).', 'Cobertura: s₂ = s₁ × d₁ / d₂.', 'Los montos se redondean a centavos antes de calcular las ganancias; el titular es la menor de las dos.'],
  },
  {
    id: 'bono', name: 'Conversión de bono', desc: 'Convierte una apuesta gratis en efectivo cubriendo el otro lado.', tags: 'bonus bet free bet apuesta gratis freebet promo',
    init: () => ({ type: 'standard', amount: '100', odds: '+300', hedge: '-300' }),
    oddsPaths: () => ['odds', 'hedge'],
    form: (F) => h`${F.seg('type', 'Tipo de bono', [['standard', 'No devuelve la apuesta (estándar)'], ['returned', 'Devuelve la apuesta como efectivo']])}
      ${F.num('amount', 'Monto del bono', { unit: '$', min: 0 })}${F.odds('odds', 'Cuota de la apuesta con bono')}${F.odds('hedge', 'Cuota de la cobertura en efectivo (lado contrario)')}`,
    calc(r, s) {
      const res = bm.bonusBetConversion({ amount: r.num('amount', 'Monto del bono', { gt: 0 }), odds: r.odds('odds', 'Cuota del bono'), hedgeOdds: r.odds('hedge', 'Cuota de la cobertura'), stakeReturned: s.type === 'returned' });
      return {
        stats: [['Efectivo asegurado', signed(res.profit), tone(res.profit)], ['Tasa de conversión', pct(res.rate)], ['Cobertura en efectivo', money(res.hedge)], ['Pago del bono si gana', money(res.bonusPayout)]],
        note: 'Las cuotas altas en el bono (+300 o más) y un mercado ajustado en la cobertura dan las mejores conversiones.',
        detail: table('Ganancia neta en efectivo', ['Si gana', 'Ganancia neta'], [['La apuesta con bono', { v: signed(res.ifBonus), cls: tone(res.ifBonus) }], ['La cobertura', { v: signed(res.ifHedge), cls: tone(res.ifHedge) }]]),
      };
    },
    how: ['Pago del bono = B × (d − 1) si no devuelve la apuesta; B × d si la devuelve.', 'Cobertura H = pago del bono / h.', 'Si gana el bono: pago − H; si gana la cobertura: H × (h − 1). Conversión = la menor / B.'],
  },
  {
    id: 'conversor', name: 'Conversor de cuotas', desc: 'Americana, decimal, fraccionaria y probabilidad implícita.', tags: 'odds converter americana decimal fraccionaria convertir',
    init: () => ({ odds: '+150', stake: '100' }),
    oddsPaths: () => ['odds'],
    form: (F) => h`${F.odds('odds', 'Cuota a convertir', { hint: 'El formato de entrada es el elegido arriba.' })}${F.num('stake', 'Apuesta', { unit: '$', min: 0 })}`,
    calc(r) {
      const d = r.odds('odds', 'Cuota'), stake = r.num('stake', 'Apuesta', { min: 0 });
      return { stats: [['Americana', am(d)], ['Decimal', d.toFixed(4)], ['Fraccionaria', bm.decimalToFractional(d, 1000), '', 'aprox., denominador ≤ 1000'], ['Punto de equilibrio', pct(1 / d)], ['Ganancia si gana', money(stake * (d - 1))], ['Pago total si gana', money(stake * d)]] };
    },
    how: ['+A → d = 1 + A/100; −A → d = 1 + 100/A; n/m → d = 1 + n/m.', 'd ≥ 2 → +(d − 1) × 100; d < 2 → −100/(d − 1).', 'Punto de equilibrio = 1/d.'],
  },
  {
    id: 'probabilidad', name: 'Probabilidad implícita', desc: 'La probabilidad que exige una cuota y tu ventaja sobre ella.', tags: 'implied probability break even equilibrio',
    init: () => ({ odds: '-110', stake: '100', est: '55' }),
    oddsPaths: () => ['odds'],
    form: (F) => h`${F.odds('odds', 'Cuota ofrecida')}${F.num('stake', 'Apuesta', { unit: '$', min: 0 })}${F.num('est', 'Tu probabilidad estimada (opcional)', { after: '%', min: 0, max: 100 })}`,
    calc(r) {
      const d = r.odds('odds', 'Cuota'), stake = r.num('stake', 'Apuesta', { min: 0 }), est = r.prob('est', 'Tu probabilidad', { empty: null });
      const p = 1 / d;
      return {
        stats: [
          ['Probabilidad implícita', pct(p), '', 'la que necesitas para no perder'], ['Tu ventaja', est == null ? '—' : pp(est - p), est == null ? '' : tone(est - p)],
          ['Americana', am(d)], ['Decimal', d.toFixed(4)], ['Fraccionaria', bm.decimalToFractional(d, 1000)], ['Ganancia si gana', money(stake * (d - 1))], ['Pago total si gana', money(stake * d)],
        ],
      };
    },
    how: ['p = 1/d; con americana +A → 100/(A + 100), −A → A/(A + 100).', 'Ventaja = tu estimación − p.'],
  },
  {
    id: 'sin-vig', name: 'Cuota justa sin vig', desc: 'Quita el margen de un mercado de 2 o 3 resultados.', tags: 'no vig fair odds devig margen justa',
    init: () => ({ ways: '2', odds: ['-110', '-110', ''] }),
    oddsPaths: () => ['odds.0', 'odds.1', 'odds.2'],
    form: marketForm,
    calc(r, s, fmt) {
      const labels = marketLabels(s), hd = bm.hold(marketPrices(r, s));
      return {
        stats: [...hd.rows.map((x, i) => [labels[i], pct(x.fair), '', `cuota justa ${showOdds(x.fairOdds, fmt)}`]), ['Margen eliminado', pct(hd.overround)]],
        note: arbNote(hd), detail: holdTable(hd, labels, fmt),
      };
    },
    how: ['q_i = 1/d_i; S = Σ q_i.', 'Método proporcional (multiplicativo): p_i = q_i / S; cuota justa = 1/p_i.', 'Overround = S − 1; margen de cada lado = q_i − p_i.'],
  },
  {
    id: 'hold', name: 'Hold', desc: 'Overround y hold teórico de un mercado.', tags: 'hold margen overround juice casa',
    init: () => ({ ways: '2', odds: ['+120', '-125', ''] }),
    oddsPaths: () => ['odds.0', 'odds.1', 'odds.2'],
    form: marketForm,
    calc(r, s, fmt) {
      const labels = marketLabels(s), hd = bm.hold(marketPrices(r, s));
      return { stats: holdStats(hd), note: arbNote(hd), detail: holdTable(hd, labels, fmt) };
    },
    how: ['S = Σ 1/d_i; overround = S − 1.', 'Hold teórico = (S − 1)/S: lo que la casa retiene en promedio si el dinero se reparte en proporción a las probabilidades.'],
  },
  {
    id: 'vig', name: 'Costo del vig', desc: 'Cuánto te cuesta en dólares el margen de tu apuesta.', tags: 'vig juice comision costo margen',
    init: () => ({ ways: '2', odds: ['-110', '-110', ''], sel: '0', stake: '100' }),
    oddsPaths: () => ['odds.0', 'odds.1', 'odds.2'],
    onSet(s) {
      if (Number(s.sel) >= Number(s.ways)) s.sel = '0';
    },
    form: (F, s) => h`${marketForm(F, s)}${F.sel('sel', 'Resultado al que apuestas', marketLabels(s).map((l, i) => [String(i), l]))}${F.num('stake', 'Apuesta', { unit: '$', min: 0 })}`,
    calc(r, s, fmt) {
      const labels = marketLabels(s), prices = marketPrices(r, s), i = Number(s.sel) || 0;
      const v = bm.vigCost(prices, i, r.num('stake', 'Apuesta', { gt: 0 }));
      return {
        stats: [
          ['Costo estimado del vig', signed(v.cost), v.cost > 0 ? 'neg' : v.cost < 0 ? 'pos' : '', v.cost < 0 ? 'negativo: precio a tu favor' : ''],
          [`Cuota justa de ${labels[i]}`, showOdds(v.fairOdds, fmt), '', `probabilidad sin vig ${pct(v.fair)}`], ...holdStats(v),
        ],
        note: arbNote(v), detail: holdTable(v, labels, fmt),
      };
    },
    how: ['p_i = (1/d_i) / Σ 1/d_j (sin vig, proporcional).', 'Costo del vig = apuesta × (1 − p_sel × d_sel): lo que pierdes en promedio frente a una cuota justa.'],
  },
  {
    id: 'prediccion', name: 'Mercados de predicción', desc: 'Precio del contrato (¢) a cuotas, con comisiones (Kalshi, Polymarket).', tags: 'prediction markets kalshi polymarket contratos centavos',
    init: () => ({ from: 'cents', cents: '65', odds: '', contracts: '100', fee: '0' }),
    oddsPaths: () => ['odds'],
    onSet(s, name, fmt) {
      if (name !== 'from') return;
      if (s.from === 'odds') {
        const c = toNum(s.cents);
        if (c > 0 && c < 100) s.odds = editOdds(100 / c, fmt);
      } else {
        const d = parseOdds(s.odds, fmt);
        if (d) s.cents = trim(100 / d, 2);
      }
    },
    form: (F, s) => h`${F.seg('from', 'Convertir desde', [['cents', 'Precio del contrato (¢)'], ['odds', 'Cuota']])}
      ${s.from === 'odds' ? F.odds('odds', 'Cuota') : F.num('cents', 'Precio del contrato', { after: '¢', min: 0, max: 100 })}
      ${F.num('contracts', 'Número de contratos', { min: 1, step: '1' })}${F.num('fee', 'Comisión total por contrato', { after: '¢', min: 0, hint: 'Todo incluido; cada plataforma cobra distinto.' })}`,
    calc(r, s) {
      const fee = r.num('fee', 'Comisión', { min: 0 }), contracts = r.num('contracts', 'Contratos', { min: 1, int: true });
      const cents = s.from === 'odds' ? undefined : r.num('cents', 'Precio del contrato', { gt: 0, lt: 100 });
      const odds = s.from === 'odds' ? r.odds('odds', 'Cuota') : undefined;
      const pm = bm.predictionMarket({ cents, odds, contracts, fee });
      if (!pm) throw new Bad(s.from === 'odds' ? 'odds' : 'cents', 'El precio debe quedar entre 0 y 100 centavos.');
      return {
        stats: [
          ['Ganancia neta si aciertas', signed(pm.profit), tone(pm.profit)], ['Costo total', money(pm.cost)], ['Pago si aciertas', money(pm.payout)],
          ['Equilibrio con comisiones', pct(pm.breakEven)], ['Precio del contrato', `${trim(pm.cents, 2)}¢`], ['Prob. implícita bruta', pct(pm.prob)],
          ['Americana', am(pm.decimal), '', 'bruta, sin comisiones'], ['Decimal', pm.decimal.toFixed(4)], ['Fraccionaria', pm.fractional],
          ['Precio complementario (No)', `${trim(pm.complement, 2)}¢`, '', 'teórico: 100 − precio'], ['Comisiones', money(pm.fees)],
        ],
      };
    },
    how: ['Probabilidad = c/100; decimal = 100/c (desde cuota: c = 100/d).', 'Costo = N × (c + comisión)/100; cada contrato ganador paga $1.', 'Equilibrio con comisiones = (c + comisión)/100.'],
  },
  {
    id: 'medio-punto', name: 'Medio punto', desc: 'Cuánto vale comprar o vender medio punto de hándicap o total.', tags: 'half point comprar puntos key numbers numeros clave',
    init: () => ({ side: 'spread', line: '-3', d1: '-110', d2: '-110', push: '8', pushLower: '', pushHigher: '' }),
    oddsPaths: () => ['d1', 'd2'],
    form: (F) => h`${F.seg('side', 'Lado elegido', [['spread', 'Hándicap del equipo'], ['over', 'Over (más)'], ['under', 'Under (menos)']])}
      ${F.num('line', 'Línea base (entera o .5)', { step: '0.5' })}${F.odds('d1', 'Cuota del lado elegido')}${F.odds('d2', 'Cuota del lado contrario')}
      ${F.num('push', 'Prob. de caer justo en la línea (push)', { after: '%', min: 0, max: 100, when: 'whole', labKey: 'push' })}
      ${F.num('pushLower', 'Prob. de caer justo en la línea de abajo', { after: '%', min: 0, max: 100, when: 'half', labKey: 'lower' })}
      ${F.num('pushHigher', 'Prob. de caer justo en la línea de arriba', { after: '%', min: 0, max: 100, when: 'half', labKey: 'higher' })}`,
    // Muestra los campos de push según la línea (entera o .5) y nombra los números vecinos.
    sync(form, s) {
      const l = toNum(s.line), half = Number.isFinite(l) && !Number.isInteger(l), isSpread = s.side === 'spread';
      for (const el of form.querySelectorAll('[data-when]')) el.hidden = el.dataset.when !== (half ? 'half' : 'whole');
      if (!Number.isFinite(l)) return;
      const set = (k, txt) => {
        const lab = form.querySelector(`[data-lab="${k}"]`);
        if (lab) lab.textContent = txt;
      };
      set('push', `Prob. de caer justo en ${line(l, isSpread)} (push)`);
      set('lower', `Prob. de caer justo en ${line(Math.floor(l), isSpread)}`);
      set('higher', `Prob. de caer justo en ${line(Math.ceil(l), isSpread)}`);
    },
    calc(r, s, fmt) {
      const l = r.num('line', 'Línea base');
      if (!Number.isInteger(l * 2)) throw new Bad('line', 'Línea base: debe ser entera o terminar en .5.');
      const prices = [r.odds('d1', 'Cuota del lado elegido'), r.odds('d2', 'Cuota del lado contrario')];
      const whole = Number.isInteger(l), isSpread = s.side === 'spread';
      const res = bm.halfPoint({
        prices, line: l, side: s.side,
        push: whole ? r.prob('push', 'Prob. de push', { lt: 100 }) : 0,
        pushLower: whole ? 0 : r.prob('pushLower', `Prob. de caer en ${line(Math.floor(l), isSpread)}`, { lt: 100 }),
        pushHigher: whole ? 0 : r.prob('pushHigher', `Prob. de caer en ${line(Math.ceil(l), isSpread)}`, { lt: 100 }),
      });
      if (!res) throw new Bad('line', 'Revisa las probabilidades: no pueden sumar 100 % o más.');
      const [lo, base, hi] = res.rows;
      return {
        stats: [[`Cuota justa en ${line(base.line, isSpread)} (base)`, showOdds(base.fair, fmt)], [`Cuota justa en ${line(lo.line, isSpread)}`, showOdds(lo.fair, fmt)], [`Cuota justa en ${line(hi.line, isSpread)}`, showOdds(hi.fair, fmt)]],
        note: `Probabilidad sin vig del lado elegido entre los resultados que no son push: ${pct(res.p)}.`,
        detail: table('Por línea', ['Línea', 'Gana', 'Push', 'Cuota justa (elegido)', 'Cuota justa (contrario)'],
          res.rows.map((x) => [`${line(x.line, isSpread)}${x === base ? ' (base)' : ''}`, pct(x.win), pct(x.push), showOdds(x.fair, fmt), showOdds(x.oppFair, fmt)])),
      };
    },
    how: ['p sin vig = (1/d₁) / (1/d₁ + 1/d₂), entre los resultados que no son push.', 'Línea entera con push q: gana p(1 − q). Medio punto a favor: el push pasa a ganar (+q); en contra: pasa a perder.', 'Línea .5: a favor, el número perdedor vecino pasa a push; en contra, el ganador vecino pasa a push.', 'Cuota justa = (1 − push) / gana.'],
  },
  {
    id: 'handicap', name: 'Hándicap a moneyline', desc: 'Moneyline justo desde el hándicap con un modelo normal (σ).', tags: 'point spread moneyline sigma normal',
    init: () => ({ league: 'nfl', spread: '-3', sigma: '13.5' }),
    onSet(s, name) {
      if (name === 'league' && SIGMAS[s.league]?.[1]) s.sigma = String(SIGMAS[s.league][1]);
    },
    form: (F) => h`${F.sel('league', 'Liga (preajusta σ)', Object.entries(SIGMAS).map(([k, [t, v]]) => [k, v ? `${t} (σ ${v})` : t]), { rebuild: true })}
      ${F.num('spread', 'Hándicap del equipo elegido', { step: '0.5', hint: 'Negativo = favorito.' })}
      ${F.num('sigma', 'Desviación típica del margen (σ)', { after: 'pts', min: 0, step: '0.1' })}`,
    calc(r, s, fmt) {
      const spread = r.num('spread', 'Hándicap'), sigma = r.num('sigma', 'σ', { gt: 0 });
      const x = bm.spreadToMoneyline(spread, sigma);
      return {
        stats: [['Prob. de ganar (elegido)', pct(x.prob)], ['Moneyline justo (elegido)', showOdds(x.decimal, fmt)], ['Prob. de ganar (rival)', pct(x.oppProb)], ['Moneyline justo (rival)', showOdds(x.oppDecimal, fmt)]],
        note: 'Los σ por liga son valores de referencia aproximados, no ajustados con datos. El modelo normal no captura los números clave (3 y 7 en la NFL).',
        detail: table('Sensibilidad a σ', ['σ', 'Prob. (elegido)', 'ML justo (elegido)', 'ML justo (rival)'],
          [0.8, 1, 1.2].map((k) => {
            const y = bm.spreadToMoneyline(spread, sigma * k);
            return [`${trim(sigma * k, 2)}${k === 1 ? ' (base)' : ''}`, pct(y.prob), showOdds(y.decimal, fmt), showOdds(y.oppDecimal, fmt)];
          })),
      };
    },
    how: ['Margen ~ Normal(μ = −hándicap, σ).', 'P(ganar) = Φ(μ/σ); rival = 1 − P.', 'Cuota justa = 1/P, convertida al formato elegido.'],
  },
  {
    id: 'poisson', name: 'Poisson', desc: 'Probabilidad de k eventos (goles, carreras, tiros) y over/under.', tags: 'goles distribucion conteo over under',
    init: () => ({ lambda: '2.5', mode: 'exact', k: '3', line: '2.5' }),
    form: (F, s) => h`${F.num('lambda', 'Promedio esperado (λ)', { min: 0, max: 200, hint: 'En el mismo periodo que la apuesta.' })}
      ${F.seg('mode', 'Modo', [['exact', 'Exacto / al menos / como máximo'], ['ou', 'Over/under de una línea']])}
      ${s.mode === 'ou' ? F.num('line', 'Línea (entera o .5)', { min: 0, step: '0.5' }) : F.num('k', 'Número de eventos (k)', { min: 0, max: 1000, step: '1' })}`,
    calc(r, s, fmt) {
      const lambda = r.num('lambda', 'λ', { min: 0, max: 200 });
      if (s.mode === 'ou') {
        const l = r.num('line', 'Línea', { min: 0 });
        if (!Number.isInteger(l * 2)) throw new Bad('line', 'Línea: debe ser entera o terminar en .5.');
        const x = bm.poisson(lambda, { line: l });
        const sides = [['Over', x.over], ['Under', x.under]];
        return {
          stats: [...sides.map(([n, y]) => [`${n} ${l}`, pct(y.win), '', `cuota justa ${showOdds(y.fair, fmt)}`]), ...(Number.isInteger(l) ? [['Push', pct(x.over.push)]] : [])],
          detail: table('Over/under', ['Lado', 'Gana', 'Pierde', 'Push', 'Cuota justa'], sides.map(([n, y]) => [`${n} ${l}`, pct(y.win), pct(y.loss), pct(y.push), showOdds(y.fair, fmt)])),
        };
      }
      const k = r.num('k', 'k', { min: 0, max: 1000, int: true });
      const x = bm.poisson(lambda, { k });
      return {
        stats: [[`Exactamente ${k}`, pct(x.exact), '', `cuota justa ${oddsP(x.exact, fmt)}`], [`Al menos ${k}`, pct(x.atLeast), '', `cuota justa ${oddsP(x.atLeast, fmt)}`], [`Como máximo ${k}`, pct(x.atMost), '', `cuota justa ${oddsP(x.atMost, fmt)}`]],
      };
    },
    how: ['P(X = k) = e^(−λ) λ^k / k!; P(X ≤ k) = Σ P(X = i) para i ≤ k; P(X ≥ k) = 1 − P(X ≤ k − 1).', 'Over de línea .5: gana con X ≥ ⌈L⌉. Línea entera: X = L es push.', 'Cuota justa = (1 − push) / gana, sin margen.'],
  },
];
const BY_ID = Object.fromEntries(CALCS.map((c) => [c.id, c]));

// Estado inicial de una calculadora en el formato pedido (los ejemplos están escritos en americana).
export function initState(calc, fmt = 'american') {
  const s = calc.init();
  if (fmt !== 'american') convertOdds(calc, s, 'american', fmt);
  return s;
}
function convertOdds(calc, s, from, to) {
  for (const p of calc.oddsPaths?.(s) ?? []) {
    const d = parseOdds(getPath(s, p), from);
    if (d != null) setPath(s, p, editOdds(d, to));
  }
}

// Resultado de una calculadora para un estado: { stats, note, detail } o { error, field }.
export function compute(calc, s, fmt) {
  try {
    return calc.calc(reader(s, fmt), s, fmt);
  } catch (err) {
    if (err instanceof Bad) return { error: err.message, field: err.field };
    throw err;
  }
}

const norm = (x) => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- vista ----------

export default {
  title: (ctx) => (BY_ID[ctx.query?.get('c')] ? `Calculadora: ${BY_ID[ctx.query.get('c')].name}` : 'Calculadoras'),
  render(el, { query, store }) {
    const initialFmt = store?.get('settings')?.oddsFormat === 'decimal' ? 'decimal' : 'american';
    const data = {}; // id → { s, fmt }
    let cur = BY_ID[query?.get('c')] ?? CALCS[0];

    el.innerHTML = h`<header class="view-head"><div><h1>Calculadoras</h1>
        <p class="hint">${CALCS.length} calculadoras con resultados en vivo. Cada una trae un ejemplo resuelto: cambia los valores y todo se recalcula al instante. Comparte el enlace para abrir una calculadora directo.</p></div></header>
      <div class="calc-layout">
        <nav class="calc-nav card" aria-label="Lista de calculadoras">
          <label class="sr-only" for="calcSearch">Buscar calculadora</label>
          <input type="search" id="calcSearch" placeholder="Buscar calculadora…" autocomplete="off" data-search>
          <ul class="calc-list">${CALCS.map((c) => h`<li data-item="${c.id}"><a href="#/calculadoras?c=${c.id}" data-calc="${c.id}"><b>${c.name}</b><small>${c.desc}</small></a></li>`)}</ul>
          <p class="calc-none" data-none hidden>Ninguna calculadora coincide.</p>
        </nav>
        <section class="calc-panel card" aria-labelledby="calcTitle" data-panel></section>
      </div>`;
    const panel = el.querySelector('[data-panel]');
    let form, out, detail;

    const st = () => (data[cur.id] ??= { s: initState(cur, initialFmt), fmt: initialFmt });

    function update() {
      const { s, fmt } = st();
      for (const x of form.querySelectorAll('[aria-invalid]')) x.removeAttribute('aria-invalid');
      cur.sync?.(form, s, fmt);
      let r;
      try {
        r = compute(cur, s, fmt);
      } catch (err) {
        console.error(err);
        r = { error: 'No se pudo calcular con estos valores.' };
      }
      if (r.error) {
        if (r.field) form.querySelector(`[name="${CSS.escape(r.field)}"]`)?.setAttribute('aria-invalid', 'true');
        out.innerHTML = h`<span class="calc-err">${r.error}</span>`;
        detail.innerHTML = '';
        return;
      }
      out.innerHTML = h`${r.stats.map(([l, v, t, sub]) => h`<span class="st"><span class="st-l">${l}</span><b class="st-v ${t ?? ''}">${v}</b>${sub ? h`<span class="st-s">${sub}</span>` : ''}</span>`)}${r.note ? h`<span class="calc-note">${r.note}</span>` : ''}`;
      detail.innerHTML = r.detail ? String(r.detail) : '';
    }

    function rebuild(focusSel) {
      const { s, fmt } = st();
      form.innerHTML = String(cur.form(builder(cur, s, fmt), s, fmt));
      update();
      if (focusSel) panel.querySelector(focusSel)?.focus();
    }

    function show(id, { focus = false } = {}) {
      cur = BY_ID[id] ?? CALCS[0];
      const { fmt } = st();
      for (const a of el.querySelectorAll('[data-calc]')) {
        if (a.dataset.calc === cur.id) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
      // Lleva la calculadora actual a la vista dentro de la lista (sin mover la página, a diferencia de scrollIntoView).
      const a = el.querySelector(`[data-calc="${cur.id}"]`), ul = a?.closest('.calc-list');
      for (const box of a ? [ul, ul.parentElement] : []) {
        const b = box.getBoundingClientRect(), r = a.getBoundingClientRect();
        if (r.left < b.left || r.right > b.right) box.scrollLeft += r.left - b.left - 8;
        if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - 8;
      }
      panel.innerHTML = h`<div class="calc-head">
          <div><h2 id="calcTitle" tabindex="-1">${cur.name}</h2><p class="hint">${cur.desc}</p></div>
          <div class="seg" role="group" aria-label="Formato de cuotas de esta calculadora">${Object.entries(FORMATS).map(([k, t]) => h`<button type="button" data-fmt="${k}" aria-pressed="${String(k === fmt)}">${t}</button>`)}</div>
        </div>
        <form class="calc-form" data-form novalidate autocomplete="off"></form>
        <h3 class="sr-only" id="calcOutTitle">Resultados</h3>
        <output class="calc-out" aria-live="polite" aria-labelledby="calcOutTitle" data-out></output>
        <div class="calc-detail" data-detail></div>
        <details class="calc-how"><summary>Cómo se calcula</summary><ul>${cur.how.map((x) => h`<li>${x}</li>`)}</ul></details>`;
      form = panel.querySelector('[data-form]');
      out = panel.querySelector('[data-out]');
      detail = panel.querySelector('[data-detail]');
      rebuild();
      document.title = `Calculadora: ${cur.name} | Oddsy Bet`;
      if (focus) panel.querySelector('#calcTitle').focus({ preventScroll: !window.matchMedia('(max-width: 1023px)').matches });
    }

    el.querySelector('.calc-nav').addEventListener('click', (e) => {
      const a = e.target.closest('[data-calc]');
      if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
      e.preventDefault();
      // replaceState no dispara hashchange: se cambia de calculadora sin volver a montar la vista.
      history.replaceState(history.state, '', `#/calculadoras?c=${a.dataset.calc}`);
      show(a.dataset.calc, { focus: true });
    });

    el.querySelector('[data-search]').addEventListener('input', (e) => {
      const q = norm(e.target.value.trim());
      let n = 0;
      for (const li of el.querySelectorAll('[data-item]')) {
        const c = BY_ID[li.dataset.item];
        const hit = !q || norm(`${c.name} ${c.desc} ${c.tags} ${c.id}`).includes(q);
        li.hidden = !hit;
        n += hit;
      }
      el.querySelector('[data-none]').hidden = n > 0;
    });

    panel.addEventListener('submit', (e) => e.preventDefault());
    panel.addEventListener('input', (e) => {
      const t = e.target;
      if (!t.name || !form.contains(t)) return;
      const { s, fmt } = st();
      setPath(s, t.name, t.value);
      if (t.hasAttribute('data-rebuild')) {
        cur.onSet?.(s, t.name, fmt);
        rebuild(`#${CSS.escape(t.id)}`);
      } else update();
    });
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      const box = st(), { s } = box;
      if (b.dataset.fmt && b.dataset.fmt !== box.fmt) {
        convertOdds(cur, s, box.fmt, b.dataset.fmt);
        box.fmt = b.dataset.fmt;
        for (const x of panel.querySelectorAll('[data-fmt]')) x.setAttribute('aria-pressed', String(x.dataset.fmt === box.fmt));
        rebuild();
      } else if (b.dataset.set) {
        setPath(s, b.dataset.set, b.dataset.val);
        cur.onSet?.(s, b.dataset.set, box.fmt);
        rebuild(`[data-set="${CSS.escape(b.dataset.set)}"][data-val="${CSS.escape(b.dataset.val)}"]`);
      } else if (b.dataset.add) {
        const list = getPath(s, b.dataset.add), spec = cur.lists[b.dataset.add];
        if (list.length >= spec.max) return;
        list.push(spec.item(s));
        cur.onSet?.(s, b.dataset.add, box.fmt);
        rebuild(`[name^="${CSS.escape(`${b.dataset.add}.${list.length - 1}.`)}"]`);
      } else if (b.dataset.del) {
        const list = getPath(s, b.dataset.del), spec = cur.lists[b.dataset.del];
        if (list.length <= spec.min) return;
        list.splice(Number(b.dataset.i), 1);
        cur.onSet?.(s, b.dataset.del, box.fmt);
        rebuild(`[data-add="${CSS.escape(b.dataset.del)}"]`);
      }
    });

    show(cur.id);
  },
};
