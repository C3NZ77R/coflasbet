// En vivo: con lo que lleva un jugador (o el marcador) y cuánto falta, proyecta el final y avisa cuando el ritmo se sale
// de lo normal. Funciones puras: las usan la vista En vivo, el servidor (lib/espn.mjs → normLive) y los tests.
import { propOver } from './betmath.js';
import { statOf } from './stats.js';

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

// Fracción jugada del tiempo reglamentario (0..1). period/clock como los da ESPN: en fútbol clock son los segundos
// jugados; en NFL/NBA/WNBA, los que quedan del periodo; en béisbol cuenta medias entradas por el detalle ("Top 5th").
const PERIODS = { football: [4, 900], basketball: [4, 720], wnba: [4, 600] };
// Segundos del reloj de ESPN: el summary solo trae displayClock ("12:34", "45.2", "67'" en fútbol).
export function clockSecs(display) {
  const s = String(display ?? '').trim(), m = /^(\d+):(\d\d)/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+'/.test(s)) return parseInt(s, 10) * 60;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
export function progress(sport, league, { period, clock, detail } = {}) {
  if (sport === 'soccer') return clamp01(clock / 5400);
  if (sport === 'baseball') {
    const half = { Top: 0, Mid: 1, Bot: 1, End: 2 }[/^(Top|Mid|Bot|End)/.exec(detail ?? '')?.[1]] ?? 0;
    return clamp01(((period - 1) * 2 + half) / 18);
  }
  const [n, len] = PERIODS[league] ?? PERIODS[sport] ?? PERIODS.football;
  return clamp01(((period - 1) * len + (len - clock)) / (n * len));
}

// Cuántos partidos vale el promedio previo frente al ritmo de hoy. Marcador 8: scripts/live-backtest.mjs (NFL 2025, NBA
// 2025-26) da el menor log-loss con 8 en la NFL, donde el ritmo del marcador casi no informa, y en la NBA de 2 a 8 empatan.
// shortcut: jugador 1 sin backtest (las jugadas de la NFL no traen atletas), calibrar cuando haya historial de props en vivo.
const PRIOR = { player: 1, total: 8 };

// Lo que falta: el ritmo mezcla lo esperado antes del partido (mean) con lo que lleva (current) en la fracción jugada.
// La varianza de lo que falta conserva la dispersión del jugador (varianza / media).
export function remaining({ current, progress: f, mean, variance, prior = PRIOR.player }) {
  const rate = (mean * prior + current) / (prior + f);
  const rem = Math.max(0, (1 - f) * rate);
  return { mean: rem, variance: (mean > 0 ? variance / mean : 1) * rem, projected: current + rem };
}

// P(termina por encima de line) con lo que lleva y lo que le falta.
export function liveOver(kind, current, rem, line) {
  const need = line - current;
  if (need < 0) return 1;
  if (!(rem.mean > 0)) return 0;
  return propOver(kind, rem.mean, rem.variance, need);
}

// Qué tan raro es lo que lleva frente a lo esperado a esta altura, en desvíos (+ va por encima).
export const paceZ = ({ current, progress: f, mean, variance }) => (current - f * mean) / Math.sqrt(Math.max(variance * f, 1));

// 0 = sin señal, 1 temprana, 2 moderada, 3 fuerte. El contexto del partido sube o baja un nivel.
export const LEVELS = ['', 'temprana', 'moderada', 'fuerte'];
export function strength(z, support = 0) {
  const a = Math.abs(z);
  const base = a >= 2 ? 3 : a >= 1.5 ? 2 : a >= 1 ? 1 : 0;
  return base && Math.min(3, Math.max(1, base + support));
}

// Contexto que empuja la estadística de un jugador: s = +1 apoya el lado, −1 lo contradice. null si no aplica.
const PASSING = new Set(['pass_yds', 'pass_cmp', 'pass_att', 'rec', 'rec_yds']);
const RUSHING = new Set(['rush_yds', 'rush_att']);
export function scriptFor(sport, stat, side, { margin, progress: f, fouls = 0 }) {
  const dir = side === 'Over' ? 1 : -1;
  if (sport === 'football' && f >= 0.5 && Math.abs(margin) >= 8) {
    if (PASSING.has(stat)) return { s: margin < 0 ? dir : -dir, text: margin < 0 ? 'Su equipo va perdiendo: suele pasar más el balón.' : 'Su equipo va ganando: suele pasar menos y correr más.' };
    if (RUSHING.has(stat)) return { s: margin > 0 ? dir : -dir, text: margin > 0 ? 'Su equipo va ganando: suele correr más para gastar reloj.' : 'Su equipo va perdiendo: suele correr menos.' };
  }
  if (sport === 'basketball') {
    if (fouls >= 4) return { s: -dir, text: `Tiene ${fouls} faltas: puede sentarse para no quedar fuera.` };
    if (f >= 0.6 && Math.abs(margin) >= 18) return { s: -dir, text: 'Partido muy definido: los titulares suelen descansar al final.' };
  }
  return null;
}

const NO_PACE = /_long$|^(dd|td)$/; // la más larga y el doble-doble no se acumulan con el tiempo
const MIN_F = 0.1, MAX_F = 0.95; // al inicio el ritmo es ruido; al final ya no hay líneas

// f = fracción del reloj (lo que se muestra); w = fracción de la producción esperada a esta altura (curva de anotación).
function signal({ id, kind, current, f, w = f, mean, variance, line, script, prior }) {
  const base = { current, progress: w, mean, variance, prior };
  const z = paceZ(base);
  const side = z >= 0 ? 'Over' : 'Under';
  const sc = script?.(side) ?? null;
  const level = strength(z, sc?.s ?? 0);
  if (!level) return null;
  const rem = remaining(base);
  return { id, kind, side, current, progress: f, expected: w * mean, mean, line, z, level, rem, projected: rem.projected, pOver: liveOver(kind, current, rem, line), script: sc, aligned: [1 + (sc?.s > 0), 1 + !!sc] };
}

// Señales de props de un partido en vivo. props = Prop[] de /api/props (Over y Under de cada línea); live = normLive.
export function propSignals(props, live, sport) {
  const f = live.progress;
  if (f < MIN_F || f > MAX_F) return [];
  const players = new Map(live.players.map((p) => [p.id, p]));
  const out = [];
  for (const pr of props) {
    const pl = players.get(pr.athleteId);
    if (pr.side !== 'Over' || !pl || NO_PACE.test(pr.stat) || !(pr.mean > 0)) continue;
    const current = statOf(sport, pr.stat, pl.stats);
    if (current == null) continue;
    const [team, opp] = pl.teamId === live.home.id ? [live.home, live.away] : [live.away, live.home];
    const margin = (team.score ?? 0) - (opp.score ?? 0);
    const sig = signal({ id: pr.id, kind: pr.kind, current, f, mean: pr.mean, variance: pr.variance, line: pr.line,
      script: (side) => scriptFor(sport, pr.stat, side, { margin, progress: f, fouls: pl.stats.pf ?? 0 }) });
    if (sig) out.push({ ...sig, player: pr.player, athleteId: pr.athleteId, team: team.abbr, stat: pr.stat });
  }
  // Una por jugador, la más fuerte: las combinadas (pase + tierra) repetían la misma señal.
  const best = new Map();
  for (const s of out) {
    const b = best.get(s.athleteId);
    if (!b || s.level > b.level || (s.level === b.level && Math.abs(s.z) > Math.abs(b.z))) best.set(s.athleteId, s);
  }
  return [...best.values()];
}

// Total del partido contra la línea previa de Oddsy (mercado 'ou'). Desvíos como SIGMA_T de lib/ratings.mjs (el test
// lo compara); en conteos, varianza = dispersión × media (fútbol ~ Poisson; béisbol, sobredisperso).
export const TOTAL = { football: { kind: 'normal', sd: 13.2 }, basketball: { kind: 'normal', sd: 19.2 }, soccer: { kind: 'count', disp: 1 }, baseball: { kind: 'count', disp: 2 } };
export function totalSignal(live, line, sport) {
  const t = TOTAL[sport], f = live.progress;
  if (!t || !(line > 0) || f < MIN_F || f > MAX_F) return null;
  const variance = t.kind === 'normal' ? t.sd ** 2 : t.disp * line;
  return signal({ id: `${live.id}|total`, kind: t.kind, current: (live.home.score ?? 0) + (live.away.score ?? 0), f, w: scoringShare(sport, f), mean: line, variance, line, prior: PRIOR.total });
}

// Parte del total que se anota, en promedio, al terminar el 1.º, 2.º y 3.er cuarto. NFL 2024 (272 partidos; 2025 da lo
// mismo): el 2.º y el 4.º rinden más por los finales de mitad. La NBA reparte parejo (25/25/25/24 %): lineal, sin curva.
// shortcut: solo el marcador; los props de jugador siguen lineales hasta medir sus yardas por cuarto.
const CURVE = { football: [0.19, 0.5, 0.71] };
export function scoringShare(sport, f) {
  const c = CURVE[sport];
  if (!c) return f;
  const pts = [0, ...c, 1], i = Math.min(3, Math.floor(f * 4));
  return pts[i] + (pts[i + 1] - pts[i]) * (f * 4 - i);
}

// ---------- pausas: momento para apostar ----------
// Orden: lo específico antes que "timeout" o "end". Duraciones típicas en segundos (estimación, no reloj oficial).
const STOPS = [
  [/two-minute/i, 'twomin', 'Aviso de dos minutos', 120],
  [/official timeout|tv timeout/i, 'tv', 'Pausa comercial', 150],
  [/timeout/i, 'timeout', 'Tiempo muerto', 90],
  [/review|challenge/i, 'review', 'Revisión de jugada', 90],
  [/injury/i, 'injury', 'Atención a un lesionado', 120],
  [/halftime|end (of )?(the )?half/i, 'half', 'Medio tiempo', 900],
  [/end (of )?(the )?(period|quarter|regulation)/i, 'period', 'Fin del periodo', 120],
  [/end (of )?inning|^mid(dle)?\b|^end \d/i, 'inning', 'Cambio de entrada', 150],
];
export function stopOf(text) {
  const hit = STOPS.find(([rx]) => rx.test(String(text ?? '')));
  return hit ? { kind: hit[1], label: hit[2] } : null;
}
// Segundos que faltarían para que siga el juego; null sin hora de inicio de la pausa. at = hora real de la jugada.
export function windowLeft(stop, now = Date.now()) {
  const at = Date.parse(stop?.at ?? '');
  const dur = STOPS.find((s) => s[1] === stop?.kind)?.[3];
  return Number.isFinite(at) && dur ? Math.max(0, Math.round(dur - (now - at) / 1000)) : null;
}
// ¿La pausa sigue en el partido real? ESPN publica las jugadas ~6 min tarde (medido en la NFL el 2026-10-18), así que
// un tiempo muerto ya terminó cuando llega; el medio tiempo suele seguir. Sin hora: solo el medio tiempo.
export function isActive(stop, now = Date.now()) {
  const left = windowLeft(stop, now);
  return left == null ? stop?.kind === 'half' : left > 0;
}
