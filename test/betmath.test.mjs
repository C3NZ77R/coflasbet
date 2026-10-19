import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../public/betmath.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const am = m.americanToDecimal;
const METHODS = ['multiplicative', 'additive', 'power', 'shin', 'probit'];
const total = (xs) => xs.reduce((s, x) => s + x, 0);

test('conversiones de cuotas', () => {
  assert.equal(m.decimalToAmerican(2.5), 150);
  assert.equal(m.decimalToAmerican(1.5), -200);
  near(m.americanToDecimal(150), 2.5);
  near(m.americanToDecimal(-200), 1.5);
  assert.equal(m.decimalToFractional(2.5), '3/2');
  assert.equal(m.decimalToFractional(1.5), '1/2');
});

test('no-vig, EV, Kelly y parlay', () => {
  const [a, b] = m.noVig([1.91, 1.91]);
  near(a, 0.5);
  near(b, 0.5);
  near(m.expectedValue(0.5, 2.1), 0.05);
  near(m.kelly(0.5, 2.1), 0.04545);
  assert.equal(m.kelly(0.4, 2), 0); // sin ventaja no se apuesta
  near(m.parlayOdds([2, 1.5, 3]), 9);
});

test('fraccional: entrada y salida', () => {
  near(m.fractionalToDecimal('3/2'), 2.5);
  near(m.fractionalToDecimal(' 10 / 11 '), 1.9091);
  assert.equal(m.fractionalToDecimal('0/5'), null);
  assert.equal(m.fractionalToDecimal('abc'), null);
  assert.equal(m.fractionalToDecimal('-3/2'), null);
  assert.equal(m.decimalToFractional(am(-110), 1000), '10/11');
});

test('devig: todos los métodos dan 50/50 en un mercado simétrico y suman 1', () => {
  for (const method of METHODS) {
    const p = m.devig([1.91, 1.91], method);
    near(p[0], 0.5, 1e-9);
    near(p[1], 0.5, 1e-9);
    for (const prices of [[1.5, 2.6], [2.3, 3.1, 3.5], [1.05, 15, 30], [2.1, 2.2]]) near(total(m.devig(prices, method)), 1, 1e-9);
  }
});

test('devig: cada método cumple su definición', () => {
  const prices = [1.5, 2.6], q = prices.map((d) => 1 / d);
  const mult = m.devig(prices, 'multiplicative');
  near(mult[0], q[0] / total(q), 1e-12);
  const add = m.devig(prices, 'additive');
  near(q[0] - add[0], q[1] - add[1], 1e-12); // mismo margen restado a cada lado
  const pow = m.devig(prices, 'power');
  near(Math.log(pow[0]) / Math.log(q[0]), Math.log(pow[1]) / Math.log(q[1]), 1e-9); // mismo exponente k
  const shin = m.devig(prices, 'shin');
  near(shin[0], add[0], 1e-9); // con dos resultados Shin coincide con el aditivo
  const pro = m.devig([2.3, 3.1, 3.5], 'probit'), q3 = [2.3, 3.1, 3.5].map((d) => 1 / d);
  const shifts = pro.map((p, i) => m.normInv(q3[i]) - m.normInv(p));
  near(shifts[0], shifts[1], 1e-9);
  near(shifts[1], shifts[2], 1e-9);
  assert.ok(pow[0] > mult[0] && shin[0] > mult[0]); // ambos corrigen el sesgo favorito-batacazo
});

test('devig worst: el mínimo por lado entre métodos', () => {
  const prices = [2.3, 3.1, 3.5];
  const worst = m.devig(prices, 'worst');
  for (const method of METHODS) m.devig(prices, method).forEach((p, i) => assert.ok(worst[i] <= p + 1e-15));
  assert.ok(total(worst) <= 1);
});

test('devig: aditivo recorta a 0 los batacazos; entradas inválidas', () => {
  const p = m.devig([1.2, 3.5, 60], 'additive');
  assert.equal(p[2], 0);
  near(total(p), 1, 1e-12);
  for (const bad of [[1, 2], [2], [], [NaN, 2], [0.5, 3], null]) assert.equal(m.devig(bad, 'power'), null);
  assert.throws(() => m.devig([2, 2], 'magia'), RangeError);
  assert.deepEqual(m.devig([2.1, 2.1], 'shin'), [0.5, 0.5]); // sin margen: Shin cae a multiplicativo
});

test('vig y ancho en centavos', () => {
  near(m.vig([1.91, 1.91]), 0.0471);
  assert.equal(m.vig([1, 2]), null);
  assert.equal(m.width(am(-110), am(-110)), 20);
  assert.equal(m.width(am(-150), am(130)), 20);
  assert.equal(m.width(1.91, 1.91), 20);
  assert.equal(m.width(am(-105), am(120)), -15); // mercado con arbitraje
  assert.equal(m.width(1, 2), null);
});

test('hitRate, streak y summarize', () => {
  assert.deepEqual(m.hitRate([30, 25, 27.5, 31, null], 27.5, 'Over'), { hits: 2, pushes: 1, n: 4, pct: 2 / 3 });
  assert.deepEqual(m.hitRate([20, 21], 25.5, 'Under'), { hits: 2, pushes: 0, n: 2, pct: 1 });
  assert.equal(m.hitRate([], 1.5).pct, null);
  assert.equal(m.streak([30, 29, 20, 35], 27.5), 2);
  assert.equal(m.streak([30, 29, 20, 35], 27.5, 'Under'), 0);
  assert.equal(m.streak([3, 2, 4], 2), 1); // el push corta
  assert.deepEqual(m.summarize([3, 1, 2, 10]), { n: 4, avg: 4, median: 2.5, min: 1, max: 10 });
  assert.equal(m.summarize([5, null, 7, 9]).median, 7);
  assert.deepEqual(m.summarize([]), { n: 0, avg: null, median: null, min: null, max: null });
});

// 12 partidos, del más reciente al más antiguo, uno cada 2 días salvo un back-to-back.
const day = (i) => new Date(Date.UTC(2026, 3, 30) - i * 2 * 864e5 + (i >= 1 ? 864e5 : 0)).toISOString();
const GAMES = Array.from({ length: 12 }, (_, i) => ({
  eventId: `ev${i}`, date: day(i), season: i < 8 ? 2026 : 2025, opp: { id: i % 3 === 0 ? '13' : '5', abbr: i % 3 === 0 ? 'LAL' : 'MIA' },
  home: i % 2 === 0, result: i % 4 === 3 ? 'L' : 'W', margin: i % 4 === 3 ? -4 : 5 + i, teamScore: 110, oppScore: 100,
  minutes: 30 + i, stats: { pts: 20 + i },
}));

test('splitGames: ventanas, local/visita, rival, minutos, descanso, compañeros, resultado y margen', () => {
  assert.equal(m.splitGames(GAMES, { window: 'l5' }).length, 5);
  assert.deepEqual(m.splitGames(GAMES, { window: 'l3', location: 'home' }).map((g) => g.eventId), ['ev0', 'ev2', 'ev4']);
  assert.ok(m.splitGames(GAMES, { location: 'away' }).every((g) => !g.home));
  assert.deepEqual(m.splitGames(GAMES, { window: 'h2h', oppId: 13 }).map((g) => g.eventId), ['ev0', 'ev3', 'ev6', 'ev9']);
  assert.deepEqual(m.splitGames(GAMES, { window: 'h2h' }), []);
  assert.equal(m.splitGames(GAMES, { window: 'season' }).length, 8);
  assert.equal(m.splitGames(GAMES, { window: 'prev' }).length, 4);
  assert.equal(m.splitGames(GAMES, { window: '2025' }).length, 4);
  assert.equal(m.splitGames(GAMES, { minMinutes: 35, maxMinutes: 38 }).length, 4);
  assert.deepEqual(m.splitGames(GAMES, { daysRest: 0 }).map((g) => g.eventId), ['ev0']); // back-to-back
  assert.equal(m.splitGames(GAMES, { daysRest: 1 }).length, 10); // el más antiguo no tiene dato
  assert.equal(m.splitGames(GAMES, { daysRest: '1+' }).length, 10);
  assert.deepEqual(m.splitGames(GAMES, { withAthlete: { games: [{ eventId: 'ev1' }, { eventId: 'ev2' }] } }).map((g) => g.eventId), ['ev1', 'ev2']);
  assert.equal(m.splitGames(GAMES, { withoutAthlete: new Set(['ev1', 'ev2']) }).length, 10);
  assert.ok(m.splitGames(GAMES, { result: 'L' }).every((g) => g.result === 'L'));
  assert.ok(m.splitGames(GAMES, { maxMargin: 6 }).every((g) => Math.abs(g.margin) <= 6));
  assert.equal(m.splitGames(GAMES, { window: 'l10', result: 'W' }).length, 9); // solo hay 9 victorias en 12
  assert.equal(m.splitGames(GAMES, { window: 'l5', result: 'W' }).at(-1).eventId, 'ev5'); // filtra (salta ev3) y luego corta
  assert.deepEqual(m.splitGames(null), []);
});

const gamelogOf = (pts) => ({ athlete: { name: 'Jayson Tatum' }, games: pts.map((v, i) => ({ ...GAMES[i], stats: { pts: v } })) });
const PTS = { key: 'pts', name: 'Puntos' };

test('insightsFor: racha seguida, k de n, local/visita y textos en español', () => {
  const streakIns = m.insightsFor({ athlete: { name: 'Jayson Tatum' }, gamelog: gamelogOf([30, 31, 29, 33, 28, 35, 20, 30, 31, 32]), prop: { line: 27.5, stat: 'pts' }, statDef: PTS });
  const top = streakIns[0];
  assert.equal(top.type, 'streak');
  assert.equal(top.text, 'Jayson Tatum superó 27.5 puntos en 6 partidos seguidos (promedio 31)');
  assert.deepEqual([top.side, top.line, top.k, top.n, top.pct, top.location], ['Over', 27.5, 6, 6, 1, 'all']);

  const ins = m.insightsFor({ gamelog: gamelogOf([20, 40, 22, 21, 23, 24, 25, 26, 27, 28]), prop: { line: 29.5, stat: 'pts', player: 'X' }, statDef: PTS });
  const texts = ins.map((i) => i.text);
  assert.ok(texts.includes('Jayson Tatum quedó por debajo de 29.5 puntos en 9 de sus últimos 10 partidos (promedio 25.6)'));
  assert.ok(texts.includes('Jayson Tatum quedó por debajo de 29.5 puntos en 5 partidos seguidos de local (promedio 23.4)'));
  assert.ok(texts.includes('Jayson Tatum quedó por debajo de 29.5 puntos en 4 de sus últimos 5 partidos de visitante (promedio 27.8)'));
  const kofn = ins.find((i) => i.type === 'kofn' && i.location === 'all');
  assert.deepEqual([kofn.k, kofn.n, kofn.pct, kofn.side], [9, 10, 0.9, 'Under']);
});

test('insightsFor: promedio lejos de la línea, statDef.from y casos vacíos', () => {
  const ins = m.insightsFor({ gamelog: gamelogOf(Array(10).fill(40)), prop: { line: 25.5 }, statDef: { key: 'pts', name: 'Puntos', from: (s) => s.pts } });
  const avg = ins.find((i) => i.type === 'avg');
  assert.equal(avg.text, 'Jayson Tatum promedia 40 puntos en sus últimos 10 partidos, por encima de la línea de 25.5');
  assert.equal(avg.side, 'Over');
  assert.deepEqual(m.insightsFor({ gamelog: gamelogOf([10]), prop: {} }), []);
  assert.deepEqual(m.insightsFor({}), []);
});

test('teamInsights: ATS, favorito/no favorito, over/under y forma en los últimos 5', () => {
  const g = (result, ats, ou) => ({ date: '2026-04-01', opp: 'MIA', home: true, score: '110-100', result, ats, ou });
  const gd = {
    home: { id: '2', abbr: 'BOS', name: 'Boston Celtics' },
    away: { id: '13', abbr: 'LAL', name: 'Los Angeles Lakers' },
    ats: {
      home: [{ key: 'home', label: 'Local ATS', summary: '8-2-0' }, { key: 'overall', label: 'ATS', summary: '12-8' }],
      away: [{ key: 'underdog', label: 'Underdog ATS', summary: '5-1' }, { key: 'vsconf', label: 'Conferencia', summary: '3-3' }],
    },
    records: { home: [{ key: 'home', label: 'Local', summary: '30-11' }], away: [{ key: 'underdog', label: 'No favorito', summary: '7-3' }] },
    lastFive: { home: [g('W', 'W', 'O'), g('W', 'W', 'O'), g('W', 'W', 'O'), g('W', 'W', 'O'), g('L', 'L', 'U')], away: [g('W', 'P', 'U'), g('L', 'L', 'U'), g('W', 'W', 'O')] },
  };
  const ins = m.teamInsights(gd);
  const texts = ins.map((i) => i.text);
  for (const t of [
    'Boston Celtics va 8-2 (80%) contra el hándicap de local',
    'Boston Celtics va 12-8 (60%) contra el hándicap en la temporada',
    'Los Angeles Lakers va 5-1 (83%) contra el hándicap como no favorito',
    'Los Angeles Lakers va 7-3 (70%) como no favorito esta temporada',
    'Boston Celtics va 4-1 contra el hándicap en sus últimos 5 partidos',
    'Los partidos de Boston Celtics terminaron por encima del total en 4 de los últimos 5',
    'Boston Celtics ganó 4 de sus últimos 5 partidos',
    'Los Angeles Lakers va 1-1-1 contra el hándicap en sus últimos 3 partidos',
    'Los partidos de Los Angeles Lakers terminaron por debajo del total en 2 de los últimos 3',
  ]) assert.ok(texts.includes(t), t);
  assert.ok(!texts.some((t) => /Conferencia|30-11/.test(t)));
  const ou = ins.find((i) => i.type === 'ou' && i.team === 'home');
  assert.deepEqual([ou.side, ou.market, ou.k, ou.n, ou.teamId], ['Over', 'total', 4, 5, '2']);
  assert.deepEqual(m.teamInsights(null), []);
  assert.deepEqual(m.teamInsights({ home: { name: 'A' }, away: { name: 'B' } }), []);
});

// ---------- Calculadoras (ejemplos de docs/spec-calculators.json) ----------

test('roundRobin: 5 patas a +100 en parlays de 4', () => {
  const pending = m.roundRobin([2, 2, 2, 2, 2], 4, 1);
  assert.deepEqual([pending.combos, pending.totalStake, pending.maxPayout, pending.maxProfit, pending.pending, pending.profit], [5, 5, 80, 75, 5, null]);
  const legs = (results) => results.map((result) => ({ price: 2, result }));
  assert.equal(m.roundRobin(legs(['win', 'win', 'win', 'win', 'win']), 4).profit, 75);
  assert.equal(m.roundRobin(legs(['loss', 'win', 'win', 'win', 'win']), 4).payout, 16);
  assert.equal(m.roundRobin(legs(['push', 'win', 'win', 'win', 'win']), 4).payout, 4 * 8 + 16);
  const allPush = m.roundRobin(legs(['push', 'push', 'push', 'push', 'push']), 4, 10);
  assert.equal(allPush.payout, 50);
  assert.equal(allPush.rows[0].result, 'push');
  const partial = m.roundRobin(legs(['loss', 'pending', 'win', 'win', 'win']), 4);
  assert.equal(partial.pending, 1);
  assert.equal(partial.profit, null);
  assert.equal(m.roundRobin(Array(10).fill(2), 3).combos, 120);
  assert.equal(m.roundRobin([2, 2], 1), null);
  assert.equal(m.roundRobin([2, 1], 2), null);
  assert.equal(m.roundRobin(Array(16).fill(2), 2), null);
});

test('prizepicksEv: Power 2 picks al 60% y comparación Power/Flex de 4 picks', () => {
  const r = m.prizepicksEv({ probs: [0.6, 0.6], payouts: [0, 0, 3], stake: 100, bankroll: 1000, kellyShare: 0.25 });
  near(r.expectedProfit, 8, 1e-9);
  near(r.roi, 0.08, 1e-12);
  near(r.pLoss, 0.64, 1e-12);
  near(r.pProfit, 0.36, 1e-12);
  near(r.kelly, 0.04, 1e-9);
  near(r.kellyStake, 10, 1e-6);
  near(r.breakEvenP, Math.sqrt(1 / 3), 1e-9);
  near(total(r.dist), 1, 1e-12);

  const probs = [-153, -125, -125, -125].map((a) => m.implied(am(a)));
  near(m.prizepicksEv({ probs, payouts: [0, 0, 0, 0, 10] }).roi, 0.0369, 1e-4);
  const flex = m.prizepicksEv({ probs, payouts: [0, 0, 0, 1.5, 6] });
  near(flex.roi, 0.0971, 1e-4);
  const growth = (f) => total(flex.outcomes.map((o) => o.prob * Math.log(1 + f * (o.mult - 1))));
  assert.ok(flex.kelly > 0 && growth(flex.kelly) >= growth(flex.kelly + 0.001) && growth(flex.kelly) >= growth(flex.kelly - 0.001));
  assert.equal(m.prizepicksEv({ probs: [0.4, 0.4], payouts: [0, 0, 3] }).kelly, 0);
  assert.equal(m.prizepicksEv({ probs: [0.5, 0.5], payouts: [0, 0, 0.9] }).breakEvenP, null);
  assert.equal(m.prizepicksEv({ probs: [1.2], payouts: [0, 2] }), null);
});

test('bonusBetConversion: $100 a +300 cubierto a -300 convierte 75%', () => {
  const r = m.bonusBetConversion({ amount: 100, odds: 4, hedgeOdds: am(-300) });
  assert.deepEqual([r.bonusPayout, r.hedge, r.ifBonus, r.ifHedge, r.profit, r.rate], [300, 225, 75, 75, 75, 0.75]);
  const cash = m.bonusBetConversion({ amount: 100, odds: 4, hedgeOdds: am(-300), stakeReturned: true });
  assert.equal(cash.hedge, 300);
  assert.equal(m.bonusBetConversion({ amount: 100, odds: 1, hedgeOdds: 2 }), null);
});

test('hedge: reparto de presupuesto y cobertura de una apuesta existente', () => {
  const plus = m.hedge([2.1, 2.1], { budget: 100 });
  assert.deepEqual([plus.stakes, plus.minProfit, plus.roi, plus.isArb], [[50, 50], 5, 0.05, true]);
  assert.equal(m.hedge([am(-110), am(-110)], { budget: 100 }).minProfit, -4.55);
  const h = m.hedge([2.5, 1.5], { stake: 100 });
  assert.deepEqual(h.stakes, [100, 166.67]);
  assert.equal(h.minProfit, -16.67);
  assert.equal(m.hedge([2.5, 1.5], {}), null);
  assert.equal(m.hedge([2.5, 1.5, 3], { budget: 100 }), null);
});

test('hold y vigCost', () => {
  const h = m.hold([am(120), am(-125)]);
  near(h.overround, 0.0101, 1e-4);
  near(h.hold, 0.01, 1e-4);
  assert.deepEqual(h.rows.map((r) => r.fairAmerican), [122, -122]);
  const std = m.hold([am(-110), am(-110)]);
  near(std.overround, 0.0476, 1e-4);
  near(std.hold, 0.04545, 1e-4);
  near(std.rows[0].margin, 0.0238, 1e-4);
  const v = m.vigCost([am(-110), am(-110)], 0, 100);
  near(v.cost, 4.545, 1e-3);
  assert.equal(v.fairAmerican, 100);
  assert.equal(m.vigCost([am(-110), am(-110)], 5), null);
  assert.equal(m.hold([2]), null);
});

test('predictionMarket: 65 centavos, con y sin comisión', () => {
  const r = m.predictionMarket({ cents: 65, contracts: 100 });
  near(r.decimal, 1.5385, 1e-4);
  assert.deepEqual([r.american, r.fractional, r.cost, r.profit, r.payout, r.complement], [-186, '7/13', 65, 35, 100, 35]);
  const fee = m.predictionMarket({ cents: 65, contracts: 100, fee: 2 });
  assert.deepEqual([fee.cost, fee.profit, fee.fees, fee.breakEven], [67, 33, 2, 0.67]);
  assert.equal(m.predictionMarket({ odds: 2 }).cents, 50);
  assert.equal(m.predictionMarket({ cents: 100 }), null);
  assert.equal(m.predictionMarket({ cents: 0 }), null);
});

test('halfPoint: -3 con 8% de push y línea .5 con vecinos', () => {
  const r = m.halfPoint({ prices: [am(-110), am(-110)], line: -3, side: 'spread', push: 0.08 });
  const [lo, base, hi] = r.rows;
  assert.deepEqual([lo.line, base.line, hi.line], [-3.5, -3, -2.5]);
  near(base.win, 0.46, 1e-9);
  near(base.fair, 2, 1e-9);
  assert.equal(base.fairAmerican, 100);
  assert.equal(hi.fairAmerican, -117);
  assert.equal(lo.fairAmerican, 117);
  assert.equal(lo.oppFairAmerican, -117);

  const half = m.halfPoint({ prices: [2, 2], line: -2.5, side: 'spread', pushLower: 0.08, pushHigher: 0.06 });
  near(half.rows[2].fair, 0.94 / 0.5, 1e-9); // -2: el 2 deja de perder (push)
  near(half.rows[0].fair, 0.92 / 0.42, 1e-9); // -3: el 3 deja de ganar (push)
  const over = m.halfPoint({ prices: [2, 2], line: 44.5, side: 'over', pushLower: 0.03, pushHigher: 0.04 });
  near(over.rows[0].win, 0.5, 1e-12); // Over 44: hacia el apostador
  near(over.rows[2].win, 0.46, 1e-12); // Over 45: en contra
  assert.equal(m.halfPoint({ prices: [2, 2], line: -2.25 }), null);
  assert.equal(m.halfPoint({ prices: [2, 2], line: -3, side: 'moneyline' }), null);
});

test('spreadToMoneyline: -3 con sigma 13.5, 10.8 y 16.2', () => {
  const r = m.spreadToMoneyline(-3, 13.5);
  near(r.prob, 0.5879, 1e-4);
  assert.deepEqual([r.american, r.oppAmerican], [-143, 143]);
  near(m.spreadToMoneyline(-3, 10.8).prob, 0.6094, 1e-4);
  assert.equal(m.spreadToMoneyline(-3, 10.8).american, -156);
  near(m.spreadToMoneyline(-3, 16.2).prob, 0.5735, 1e-4);
  assert.equal(m.spreadToMoneyline(-3, 16.2).american, -134);
  near(m.spreadToMoneyline(0).prob, 0.5, 1e-12);
  assert.equal(m.spreadToMoneyline(-3, 0), null);
});

test('poisson: lambda 2.5 exacto / al menos / como máximo y over/under con push', () => {
  const r = m.poisson(2.5, { k: 3 });
  near(r.exact, 0.2138, 1e-4);
  near(r.atLeast, 0.4562, 1e-4);
  near(r.atMost, 0.7576, 1e-4);
  assert.deepEqual(r.american, { exact: 368, atLeast: 119, atMost: -313 });
  const ou = m.poisson(2.5, { line: 2.5 });
  near(ou.over.win, r.atLeast, 1e-12);
  assert.equal(ou.over.push, 0);
  const whole = m.poisson(2.5, { line: 3 });
  near(whole.over.push, r.exact, 1e-12);
  near(whole.over.win + whole.under.win + whole.over.push, 1, 1e-12);
  near(whole.over.fair, (1 - r.exact) / whole.over.win, 1e-12);
  assert.equal(m.poisson(-1, { k: 1 }), null);
  assert.equal(m.poisson(2, { k: 1.5 }), null);
  assert.equal(m.poisson(2, { line: 2.25 }), null);
});

test('normCdf, normInv, poissonPmf/Cdf: precisión y valores extremos', () => {
  near(m.normCdf(0), 0.5, 1e-15);
  near(m.normCdf(1), 0.841344746068543, 1e-12);
  near(m.normCdf(-3), 0.00134989803163, 1e-12);
  near(m.normCdf(1.96) + m.normCdf(-1.96), 1, 1e-14);
  assert.equal(m.normCdf(Infinity), 1);
  assert.equal(m.normCdf(-Infinity), 0);
  near(m.normInv(0.975), 1.959963984540054, 1e-9);
  for (const p of [1e-10, 0.001, 0.3, 0.5, 0.9, 0.999999]) near(m.normCdf(m.normInv(p)) / p, 1, 1e-6);
  assert.equal(m.normInv(0), -Infinity);
  assert.equal(m.normInv(1), Infinity);
  near(m.poissonPmf(0, 2.5), Math.exp(-2.5), 1e-15);
  assert.equal(m.poissonPmf(0, 0), 1);
  assert.equal(m.poissonPmf(2, 0), 0);
  const big = m.poissonPmf(200, 200); // 200! desborda como número, en logaritmos no
  assert.ok(big > 0.02 && big < 0.03);
  assert.ok(Number.isFinite(m.poissonPmf(1000, 200)));
  near(m.poissonCdf(1000, 200), 1, 1e-12);
  assert.equal(m.poissonCdf(-1, 3), 0);
  assert.equal(m.poissonCdf(Infinity, 3), 1);
  near(m.poissonCdf(3, 2.5), 0.7576, 1e-4);
});

test('compareBook: EV y Kelly de la p del modelo contra la cuota de la casa', () => {
  const a = m.compareBook(0.5, 2.2), b = m.compareBook(0.5, 1.8);
  near(a.ev, 0.1, 1e-12);
  near(a.kelly, 0.1 / 1.2, 1e-12); // 0.0833
  near(b.ev, -0.1, 1e-12);
  assert.equal(b.kelly, 0);
  near(m.compareBook(0.5, 2.2, 0.25).kelly, 0.1 / 1.2 / 4, 1e-12);
});
