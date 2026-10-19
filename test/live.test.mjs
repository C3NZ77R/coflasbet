// En vivo: proyección por ritmo, fuerza de la señal, contexto del partido y pausas (public/live.js). Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../public/live.js';
import { SIGMA_T } from '../lib/ratings.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('progress: fracción jugada por deporte', () => {
  near(L.progress('football', 'nfl', { period: 3, clock: 450 }), 0.625); // Q3 con 7:30 por jugar
  near(L.progress('basketball', 'nba', { period: 2, clock: 0 }), 0.5);
  near(L.progress('basketball', 'wnba', { period: 4, clock: 300 }), 0.875); // cuartos de 10 min
  near(L.progress('soccer', 'epl', { clock: 2700 }), 0.5);
  near(L.progress('baseball', 'mlb', { period: 5, detail: 'Bot 5th' }), 9 / 18);
  near(L.progress('baseball', 'mlb', { period: 5, detail: 'End 5th' }), 10 / 18);
  assert.equal(L.progress('football', 'nfl', { period: 5, clock: 300 }), 1); // prórroga: ya no queda tiempo reglamentario
});

test('clockSecs: reloj de ESPN en texto', () => {
  assert.equal(L.clockSecs('15:00'), 900);
  assert.equal(L.clockSecs('0:07'), 7);
  assert.equal(L.clockSecs('45.2'), 45.2); // último minuto en la NBA
  assert.equal(L.clockSecs("67'"), 4020);
  assert.equal(L.clockSecs("45'+2'"), 2700);
  assert.equal(L.clockSecs(''), null);
  assert.equal(L.clockSecs(undefined), null);
});

test('remaining: mezcla el promedio previo con el ritmo de hoy', () => {
  // Va justo a su promedio: proyecta su promedio.
  const even = L.remaining({ current: 30, progress: 0.5, mean: 60, variance: 600 });
  near(even.mean, 30);
  near(even.projected, 60);
  near(even.variance, 300); // dispersión 600/60 = 10 × lo que falta
  // Va al doble: el ritmo empuja, pero el promedio previo frena (no proyecta 120).
  const hot = L.remaining({ current: 60, progress: 0.5, mean: 60, variance: 600 });
  near(hot.projected, 60 + 0.5 * (120 / 1.5));
  assert.equal(L.remaining({ current: 50, progress: 1, mean: 60, variance: 600 }).mean, 0);
  // Marcador: el previo pesa 8 partidos (scripts/live-backtest.mjs), así que un 0-0 temprano baja poco la proyección.
  near(L.remaining({ current: 0, progress: 0.1, mean: 53.5, variance: 174, prior: 8 }).mean, 0.9 * (8 * 53.5) / 8.1);
  const s = L.totalSignal({ id: 'g', progress: 0.1, home: { score: 0 }, away: { score: 0 } }, 53.5, 'football');
  const w = 0.19 * 0.4; // curva de la NFL: al 10 % del reloj va el 7.6 % de los puntos esperados
  near(s.projected, (1 - w) * (8 * 53.5) / (8 + w));
  near(s.expected, w * 53.5);
  assert.equal(s.progress, 0.1); // el texto muestra el reloj real
});

test('scoringShare: curva de anotación de la NFL por cuarto; lineal donde no hay curva', () => {
  for (const [f, w] of [[0, 0], [0.125, 0.095], [0.25, 0.19], [0.5, 0.5], [0.75, 0.71], [0.875, 0.855], [1, 1]]) near(L.scoringShare('football', f), w, 1e-12);
  assert.equal(L.scoringShare('basketball', 0.3), 0.3);
  assert.equal(L.scoringShare('soccer', 0.6), 0.6);
});

test('liveOver: ya superada, sin tiempo y caso normal', () => {
  const rem = L.remaining({ current: 30, progress: 0.5, mean: 60, variance: 600 });
  assert.equal(L.liveOver('normal', 70, rem, 68.5), 1);
  assert.equal(L.liveOver('normal', 50, { mean: 0, variance: 0 }, 68.5), 0);
  const p = L.liveOver('normal', 30, rem, 68.5);
  assert.ok(p > 0.01 && p < 0.5, `p=${p}`); // le faltan 38.5 y se esperan 30
  const c = L.liveOver('count', 2, L.remaining({ current: 2, progress: 0.5, mean: 5, variance: 6 }), 4.5);
  assert.ok(c > 0.2 && c < 0.6, `c=${c}`);
});

test('paceZ y strength: niveles y empuje del contexto', () => {
  near(L.paceZ({ current: 6, progress: 0.5, mean: 5, variance: 6 }), 3.5 / Math.sqrt(3));
  assert.ok(L.paceZ({ current: 0, progress: 0.5, mean: 5, variance: 6 }) < 0);
  assert.equal(L.strength(0.9), 0);
  assert.equal(L.strength(0.9, 1), 0); // sin ritmo raro no hay señal aunque el contexto ayude
  assert.equal(L.strength(1.2), 1);
  assert.equal(L.strength(-1.6), 2);
  assert.equal(L.strength(2.4), 3);
  assert.equal(L.strength(1.2, 1), 2);
  assert.equal(L.strength(2.4, 1), 3);
  assert.equal(L.strength(1.2, -1), 1);
  assert.deepEqual(L.LEVELS.slice(1), ['temprana', 'moderada', 'fuerte']);
});

test('scriptFor: perder → más pases; ganar → más carreras; faltas y paliza en básquet → Under', () => {
  assert.equal(L.scriptFor('football', 'pass_yds', 'Over', { margin: -14, progress: 0.6 }).s, 1);
  assert.equal(L.scriptFor('football', 'pass_yds', 'Under', { margin: -14, progress: 0.6 }).s, -1);
  assert.equal(L.scriptFor('football', 'rush_yds', 'Over', { margin: 10, progress: 0.7 }).s, 1);
  assert.equal(L.scriptFor('football', 'rush_yds', 'Over', { margin: 10, progress: 0.3 }), null); // primera mitad: aún no pesa
  assert.equal(L.scriptFor('football', 'rec_yds', 'Over', { margin: 3, progress: 0.8 }), null);
  assert.equal(L.scriptFor('basketball', 'pts', 'Under', { margin: 2, progress: 0.4, fouls: 4 }).s, 1);
  assert.equal(L.scriptFor('basketball', 'pts', 'Over', { margin: 22, progress: 0.7 }).s, -1);
  assert.equal(L.scriptFor('basketball', 'pts', 'Over', { margin: 5, progress: 0.7, fouls: 2 }), null);
});

const liveGame = (over = {}) => ({
  id: '1', progress: 0.5, home: { id: '10', abbr: 'GB', score: 7 }, away: { id: '20', abbr: 'DAL', score: 21 },
  players: [{ id: 'p1', teamId: '10', stats: { pass_yds: 260, pass_long: 40 } }, { id: 'p2', teamId: '20', stats: { rush_yds: 45 } }],
  ...over,
});
const prop = (athleteId, stat, line, mean, variance, side = 'Over') => ({ id: `${athleteId}|${stat}|${side}`, athleteId, player: athleteId, stat, line, side, kind: 'normal', mean, variance });

test('propSignals: ritmo raro + contexto; ignora Under duplicado, "más larga" y jugadores sin boxscore', () => {
  const props = [
    prop('p1', 'pass_yds', 239.5, 240, 3600), prop('p1', 'pass_yds', 239.5, 240, 3600, 'Under'), // 260 a la mitad: muy por encima
    prop('p1', 'pass_long', 35.5, 36, 100), prop('p2', 'rush_yds', 60.5, 60, 400), prop('p9', 'rec_yds', 50.5, 50, 400),
  ];
  const sigs = L.propSignals(props, liveGame(), 'football');
  assert.deepEqual(sigs.map((s) => s.stat), ['pass_yds', 'rush_yds']);
  const [s] = sigs;
  assert.equal(s.side, 'Over');
  assert.equal(s.level, 3); // z ≈ 3.3; GB pierde por 14 → más pases (2 de 2 razones)
  assert.deepEqual(s.aligned, [2, 2]);
  assert.equal(s.team, 'GB');
  assert.ok(s.projected > 260 && s.pOver > 0.9);
  assert.deepEqual(L.propSignals(props, liveGame({ progress: 0.05 }), 'football'), []); // muy temprano
  // Combinada del mismo jugador: queda solo la más fuerte.
  const dup = L.propSignals([...props, prop('p1', 'pass_rush_yds', 249.5, 250, 4000)], liveGame(), 'football');
  assert.deepEqual(dup.filter((x) => x.athleteId === 'p1').map((x) => x.stat), ['pass_yds']);
});

test('propSignals: el contexto sube una señal temprana (z ≈ 1) a moderada', () => {
  const sigs = L.propSignals([prop('p2', 'rush_yds', 60.5, 60, 400)], liveGame(), 'football');
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].side, 'Over');
  assert.equal(sigs[0].level, 2); // z ≈ 1.06 → temprana; DAL gana por 14 en el 2º tiempo → moderada
});

test('totalSignal: marcador contra la línea previa de Oddsy', () => {
  assert.equal(L.totalSignal(liveGame(), 44.5, 'football'), null); // 28 a la mitad vs 22 esperados: normal en la NFL
  const s = L.totalSignal(liveGame({ home: { id: '10', score: 21 }, away: { id: '20', score: 21 } }), 44.5, 'football');
  assert.equal(s.side, 'Over');
  assert.equal(s.level, 3); // 42 a la mitad: z ≈ 2.1
  assert.equal(L.totalSignal(liveGame(), null, 'football'), null);
  assert.equal(L.totalSignal(liveGame(), 44.5, 'tennis'), null);
  assert.equal(L.TOTAL.football.sd, SIGMA_T.football);
  assert.equal(L.TOTAL.basketball.sd, SIGMA_T.basketball);
});

test('stopOf y windowLeft: tipos de pausa de ESPN y cuenta regresiva estimada', () => {
  assert.equal(L.stopOf('Official Timeout').kind, 'tv');
  assert.equal(L.stopOf('Timeout').kind, 'timeout');
  assert.equal(L.stopOf('Full Timeout').kind, 'timeout');
  assert.equal(L.stopOf('Two-minute warning').kind, 'twomin');
  assert.equal(L.stopOf("Coach's Challenge (Stands)").kind, 'review');
  assert.equal(L.stopOf('End Period').kind, 'period');
  assert.equal(L.stopOf('HALFTIME').kind, 'half');
  assert.equal(L.stopOf('End of Half').kind, 'half');
  assert.equal(L.stopOf('Mid 5th').kind, 'inning');
  assert.equal(L.stopOf('IN PROGRESS'), null);
  assert.equal(L.stopOf('Pass Reception'), null);
  const at = '2026-10-19T01:00:00Z', t = Date.parse(at);
  assert.equal(L.windowLeft({ kind: 'timeout', at }, t + 30_000), 60);
  assert.equal(L.windowLeft({ kind: 'timeout', at }, t + 300_000), 0);
  assert.equal(L.windowLeft({ kind: 'timeout', at: null }, t), null);
  // ESPN publica ~6 min tarde: la pausa comercial ya terminó, el medio tiempo sigue.
  assert.equal(L.isActive({ kind: 'tv', at }, t + 340_000), false);
  assert.equal(L.isActive({ kind: 'half', at }, t + 340_000), true);
  assert.equal(L.isActive({ kind: 'half', at: null }), true);
  assert.equal(L.isActive({ kind: 'timeout', at: null }), false);
});

test('normLive: avance, pausa por la última jugada, prob. de ganar y boxscore (con yardas negativas)', async () => {
  const { normLive } = await import('../lib/espn.mjs');
  const comp = {
    id: '401873007', date: '2026-10-19T00:20Z',
    // El summary en vivo no trae el número clock, solo displayClock.
    status: { displayClock: '2:00', period: 2, type: { name: 'STATUS_IN_PROGRESS', state: 'in', shortDetail: '2:00 - 2nd' } },
    competitors: [
      { id: '9', homeAway: 'home', score: '10', team: { id: '9', abbreviation: 'GB', displayName: 'Green Bay Packers' } },
      { id: '6', homeAway: 'away', score: '14', team: { id: '6', abbreviation: 'DAL', displayName: 'Dallas Cowboys' } },
    ],
  };
  const json = {
    header: { id: '401873007', competitions: [comp] },
    drives: { previous: [{ plays: [{ type: { text: 'Kickoff' } }] }], current: { plays: [{ type: { text: 'Rush' } }, { type: { text: 'Two-minute warning' }, text: 'Two-Minute Warning', wallclock: '2026-10-19T01:40:00Z' }] } },
    winprobability: [{ homeWinPercentage: 0.5 }, { homeWinPercentage: 0.41 }],
    boxscore: { players: [{ team: { id: '6' }, statistics: [
      { name: 'passing', keys: ['completions/passingAttempts', 'passingYards', 'interceptions', 'sacks-sackYardsLost'], athletes: [{ athlete: { id: '1', displayName: 'Dak Prescott' }, stats: ['14/20', '161', '0', '1-7'] }] },
      { name: 'rushing', keys: ['rushingAttempts', 'rushingYards'], athletes: [{ athlete: { id: '1', displayName: 'Dak Prescott' }, stats: ['2', '-1'] }] },
    ] }] },
  };
  const g = normLive(json, 'nfl');
  assert.equal(g.status.state, 'in');
  assert.deepEqual([g.home.score, g.away.score], [10, 14]);
  near(g.progress, (900 + 780) / 3600);
  assert.deepEqual(g.stop, { kind: 'twomin', label: 'Aviso de dos minutos', at: '2026-10-19T01:40:00.000Z' });
  assert.equal(g.winProb, 0.41);
  assert.equal(g.lastPlay, 'Two-Minute Warning');
  assert.equal(g.lastPlayAt, '2026-10-19T01:40:00.000Z');
  const [dak] = g.players;
  assert.deepEqual([dak.teamId, dak.stats.pass_cmp, dak.stats.pass_att, dak.stats.pass_yds, dak.stats.pass_int, dak.stats.sacked, dak.stats.rush_yds], ['6', 14, 20, 161, 0, 1, -1]);
  assert.equal(dak.stats.pass_rush_yds, 160);
  // Medio tiempo por el estado del partido aunque la última jugada no lo diga.
  const half = normLive({ ...json, header: { competitions: [{ ...comp, status: { ...comp.status, type: { name: 'STATUS_HALFTIME', state: 'in' } } }] } }, 'nfl');
  assert.equal(half.stop.kind, 'half');
});
