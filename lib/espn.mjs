// Capa de datos de ESPN (JSON público, sin clave): normalizadores puros (testeados con fixtures en test/fixtures/)
// y envoltorios de fetch con caché en memoria por URL. Todo lo que llega de ESPN es dato no confiable: solo se
// copian campos conocidos, como texto o número; la UI los escapa al pintarlos.
import { leagueById } from '../public/leagues.js';
import { STATS, statOf } from '../public/stats.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const WEB = 'https://site.web.api.espn.com/apis/common/v3';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
export const TTL = { live: 60_000, board: 5 * 60_000, slow: 30 * 60_000 };
const TIMEOUT_MS = 8000;
const CACHE_MAX = 300; // los summary de ESPN pesan hasta ~600 KB: tope de memoria

// ---------- fetch con caché ----------
const cache = new Map(); // url -> { at, ttl, promise }

export const httpError = (status, message) => Object.assign(new Error(message), { status });

// ttl puede ser un número o una función del cuerpo (p. ej. 60 s si hay un partido en vivo).
export async function fetchJson(url, ttl = TTL.board, { headers, label = 'ESPN', meta = false } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const promise = (async () => {
    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw httpError(504, err?.name === 'TimeoutError' ? `${label} no respondió en ${TIMEOUT_MS / 1000} s` : `No se pudo conectar con ${label}`);
    }
    if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, `${label} respondió ${res.status}`);
    const body = await res.json().catch(() => {
      throw httpError(502, `${label} devolvió una respuesta que no es JSON`);
    });
    return meta ? { body, headers: res.headers } : body;
  })();
  const entry = { at: Date.now(), ttl: typeof ttl === 'number' ? ttl : TTL.board, promise };
  cache.set(url, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  promise.then((v) => { if (typeof ttl === 'function') entry.ttl = ttl(meta ? v.body : v); }, () => cache.delete(url));
  return promise;
}

const soft = (p) => p.catch(() => null); // datos complementarios: si fallan, la sección queda vacía

// ---------- utilidades puras ----------
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/^[ou+]/i, ''));
  return Number.isFinite(n) ? n : null;
};
const str = (v) => (v == null ? null : String(v));
const iso = (d) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// Cuota americana de ESPN ("-110", "+150", "EVEN", 120) → decimal con 4 decimales; null si no hay línea.
export function americanToDec(v) {
  if (v == null) return null;
  if (/^even$/i.test(String(v).trim())) return 2;
  const a = num(String(v).trim().replace(/^\+/, ''));
  if (a == null || Math.abs(a) < 100) return null;
  return Math.round((a > 0 ? 1 + a / 100 : 1 + 100 / -a) * 10000) / 10000;
}

const shortName = (a) => a.shortName || (a.firstName && a.lastName ? `${a.firstName[0]}. ${a.lastName}` : a.displayName || a.fullName || null);
const idFromLinks = (a) => {
  for (const l of a?.links ?? []) {
    const m = /\/id\/(\d+)/.exec(l?.href ?? '');
    if (m) return m[1];
  }
  return /\/players\/full\/(\d+)\./.exec(a?.headshot?.href ?? '')?.[1] ?? null;
};

export function normAthlete(a, team = null) {
  if (!a) return null;
  return {
    id: str(a.id ?? idFromLinks(a)),
    name: a.displayName || a.fullName || null,
    short: shortName(a),
    pos: a.position?.abbreviation ?? null,
    jersey: str(a.jersey ?? null),
    headshot: a.headshot?.href ?? null,
    teamId: str(team?.id ?? a.team?.id ?? null),
    teamAbbr: team?.abbreviation ?? team?.abbr ?? a.team?.abbreviation ?? null,
  };
}

// ---------- partidos ----------
const pick = (side) => side?.current ?? side?.close ?? side?.open ?? null; // en vivo > cierre > apertura

// Acepta el objeto de cuotas del scoreboard (competitions[0].odds[i]) o del summary (pickcenter[i]).
export function normOdds(o) {
  if (!o) return null;
  const mlH = pick(o.moneyline?.home), mlA = pick(o.moneyline?.away), mlD = pick(o.moneyline?.draw);
  const home = americanToDec(mlH?.odds ?? o.homeTeamOdds?.moneyLine);
  const away = americanToDec(mlA?.odds ?? o.awayTeamOdds?.moneyLine);
  const draw = americanToDec(mlD?.odds ?? o.drawOdds?.moneyLine);
  const moneyline = home && away ? { home, away, ...(draw ? { draw } : {}) } : null;

  const spH = pick(o.pointSpread?.home), spA = pick(o.pointSpread?.away);
  const spLine = num(spH?.line) ?? num(o.spread);
  const spHome = americanToDec(spH?.odds ?? o.homeTeamOdds?.spreadOdds), spAway = americanToDec(spA?.odds ?? o.awayTeamOdds?.spreadOdds);
  const spread = spLine != null && spHome && spAway ? { line: spLine, home: spHome, away: spAway } : null;

  const over = pick(o.total?.over), under = pick(o.total?.under);
  const tLine = num(over?.line) ?? num(o.overUnder);
  const tOver = americanToDec(over?.odds ?? o.overOdds), tUnder = americanToDec(under?.odds ?? o.underOdds);
  const total = tLine != null && tOver && tUnder ? { line: tLine, over: tOver, under: tUnder } : null;

  if (!moneyline && !spread && !total) return null;
  return { provider: o.provider?.displayName || o.provider?.name || 'ESPN BET', moneyline, spread, total };
}

const recordOf = (c) => {
  const list = c.records ?? c.record ?? [];
  const r = Array.isArray(list) ? list.find((x) => x?.type === 'total' || x?.name === 'overall') ?? list[0] : null;
  return r?.summary ?? null;
};

export function normTeam(c, state) {
  const t = c?.team ?? {};
  const score = state === 'pre' ? null : num(typeof c?.score === 'object' ? c.score?.value ?? c.score?.displayValue : c?.score);
  return {
    id: str(t.id ?? c?.id),
    abbr: t.abbreviation ?? null,
    name: t.displayName ?? t.name ?? null,
    logo: t.logo ?? t.logos?.[0]?.href ?? null,
    record: recordOf(c ?? {}),
    score,
    color: /^[0-9a-f]{6}$/i.test(t.color ?? '') ? `#${t.color}` : null,
  };
}

// comp = competitions[0] (scoreboard) o header.competitions[0] (summary).
function gameFrom(id, comp, status, league, oddsList) {
  const state = status?.type?.state ?? 'pre';
  const side = (ha) => comp?.competitors?.find((c) => c.homeAway === ha);
  return {
    id: str(id),
    league,
    start: iso(comp?.date),
    status: { state, detail: status?.type?.shortDetail ?? status?.type?.detail ?? null },
    home: normTeam(side('home'), state),
    away: normTeam(side('away'), state),
    odds: normOdds((oddsList ?? []).find(Boolean)),
  };
}

export const normEvent = (ev, league) => gameFrom(ev.id, ev.competitions?.[0], ev.status ?? ev.competitions?.[0]?.status, league, ev.competitions?.[0]?.odds);

export const normScoreboard = (json, league) => (json?.events ?? []).map((e) => normEvent(e, league));

// ---------- detalle del partido ----------
const REC_LABELS = { overall: 'General', home: 'Local', road: 'Visita', vsdiv: 'División', vsconf: 'Conferencia', lasttengames: 'Últimos 10' };
const REC_KEYS = { total: 'overall', homerecord: 'home', awayrecord: 'road' };
const recItem = (r) => {
  const t = String(r.type || r.name || '').toLowerCase();
  const key = REC_KEYS[t] ?? t;
  return r.summary ? { key, label: REC_LABELS[key] ?? r.displayName ?? r.name ?? key, summary: String(r.summary) } : null;
};
export const normRecords = (json) => (Array.isArray(json) ? json : json?.items ?? []).map(recItem).filter(Boolean);

// summary.againstTheSpread[i].records (casi siempre vacío hoy; formato genérico por si ESPN lo vuelve a llenar).
const normAtsSummary = (records) => (records ?? []).map((r) => (r?.summary ? { key: String(r.type || r.id || r.name || 'ats'), label: r.displayName || r.description || 'ATS', summary: String(r.summary) } : null)).filter(Boolean);

// Estadísticas de equipo (core API) seleccionadas por deporte: [categoría|null, nombre, etiqueta, nombre del ranking?, por partido?]
const TEAM_STATS = {
  basketball: [
    [null, 'avgPoints', 'Puntos por partido', 'points'], [null, 'fieldGoalPct', 'FG%'], [null, 'twoPointFieldGoalPct', '2P%'],
    [null, 'threePointFieldGoalPct', '3P%'], [null, 'freeThrowPct', 'TL%'], [null, 'effectiveFGPct', 'eFG%'], [null, 'trueShootingPct', 'TS%'],
    [null, 'avgRebounds', 'Rebotes por partido'], [null, 'avgOffensiveRebounds', 'Rebotes ofensivos', 'offensiveRebounds'],
    [null, 'avgAssists', 'Asistencias por partido', 'assists'], [null, 'avgSteals', 'Robos por partido', 'steals'],
    [null, 'avgBlocks', 'Tapones por partido', 'blocks'], [null, 'avgTurnovers', 'Pérdidas por partido', 'turnovers'],
    [null, 'assistTurnoverRatio', 'AST/TO'], [null, 'paceFactor', 'Ritmo'], [null, 'pointsInPaint', 'Puntos en la pintura', null, true],
    [null, 'fastBreakPoints', 'Puntos de contraataque', null, true],
  ],
  football: [
    [null, 'totalPointsPerGame', 'Puntos por partido'], [null, 'yardsPerGame', 'Yardas por partido'],
    ['passing', 'passingYardsPerGame', 'Yardas por pase / partido'], ['rushing', 'rushingYardsPerGame', 'Yardas por tierra / partido'],
    ['rushing', 'yardsPerRushAttempt', 'Yardas por acarreo'], ['passing', 'completionPct', '% de pases completos'],
    ['miscellaneous', 'thirdDownConvPct', '% de conversión en 3.ª'], ['miscellaneous', 'redzoneTouchdownPct', '% de TD en zona roja'],
    ['defensive', 'sacks', 'Capturas'], ['miscellaneous', 'totalTakeaways', 'Balones recuperados'], ['miscellaneous', 'turnOverDifferential', 'Diferencial de pérdidas'],
  ],
  baseball: [
    ['batting', 'avg', 'AVG'], ['batting', 'onBasePct', 'OBP'], ['batting', 'slugAvg', 'SLG'], ['batting', 'OPS', 'OPS'],
    ['batting', 'runs', 'Carreras por partido', 'runs', true], ['batting', 'homeRuns', 'Jonrones'], ['batting', 'stolenBases', 'Bases robadas'],
    ['batting', 'strikeouts', 'Ponches (bateo)'], ['pitching', 'ERA', 'ERA'], ['pitching', 'WHIP', 'WHIP'],
    ['pitching', 'strikeoutsPerNineInnings', 'K/9'], ['pitching', 'opponentAvg', 'AVG del rival'], ['pitching', 'saves', 'Salvamentos'],
  ],
  hockey: [
    [null, 'avgGoals', 'Goles por partido', 'goals'], [null, 'avgGoalsAgainst', 'Goles recibidos por partido'],
    [null, 'avgShots', 'Tiros por partido', 'shotsTotal'], [null, 'avgShotsAgainst', 'Tiros recibidos por partido', 'shotsAgainst'],
    [null, 'powerPlayPct', '% de power play'], [null, 'penaltyKillPct', '% en inferioridad'], [null, 'savePct', '% de atajadas'],
    [null, 'shootingPct', '% de tiro'], [null, 'faceoffPercent', '% de faceoffs'],
  ],
  soccer: [
    [null, 'avgGoals', 'Goles por partido'], [null, 'avgGoalsConceded', 'Goles recibidos por partido'], [null, 'possessionPct', 'Posesión %'],
    [null, 'totalShots', 'Tiros por partido', null, true], [null, 'shotsOnTarget', 'Tiros a puerta por partido', null, true],
    [null, 'passPct', '% de pases'], [null, 'wonCorners', 'Córners por partido', null, true], [null, 'avgExpectedGoals', 'xG por partido'],
    [null, 'cleanSheet', 'Vallas invictas'], [null, 'yellowCards', 'Tarjetas amarillas'],
  ],
};

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 3 : 1));
export function normTeamStats(json, sport) {
  const cats = json?.splits?.categories ?? [];
  const find = (cat, name) => (cat ? cats.filter((c) => c.name === cat) : cats).flatMap((c) => c.stats ?? []).find((s) => s.name === name);
  const games = ['gamesPlayed', 'teamGamesPlayed', 'appearances', 'games'].map((n) => find(null, n)?.value).find((v) => v > 0);
  return (TEAM_STATS[sport] ?? []).flatMap(([cat, name, label, rankName, perGame]) => {
    const s = find(cat, name);
    if (!s || !Number.isFinite(s.value)) return [];
    const value = perGame ? (games ? s.value / games : null) : s.value;
    if (value == null) return [];
    const rank = s.rank ?? (rankName ? find(cat, rankName)?.rank : null) ?? null;
    return [{ key: cat ? `${cat}.${name}` : name, label, value, display: perGame ? fmt(value) : s.displayValue ?? fmt(value), rank }];
  });
}
// Respaldo: estadísticas de equipo que trae el propio summary (sin ranking salvo en MLB).
export function normBoxTeamStats(list) {
  return (list ?? []).flatMap((s) => (Array.isArray(s.stats) ? s.stats.map((x) => ({ ...x, name: `${s.name}.${x.name}` })) : [s]))
    .map((s) => ({ key: s.name, label: s.label || s.displayName || s.abbreviation || s.name, value: num(s.value ?? s.displayValue), display: s.displayValue ?? null, rank: s.rank ?? null }))
    .filter((s) => s.key && s.display != null);
}

function normLastFive(list) {
  return (list?.events ?? []).map((e) => {
    const home = e.atVs === 'vs' || (e.homeTeamId != null && String(e.homeTeamId) === String(list.team?.id));
    const ts = num(home ? e.homeTeamScore : e.awayTeamScore), os = num(home ? e.awayTeamScore : e.homeTeamScore);
    return {
      eventId: str(e.id), date: iso(e.gameDate), opp: { id: str(e.opponent?.id), abbr: e.opponent?.abbreviation ?? null, logo: e.opponent?.logo ?? null },
      home, score: ts != null && os != null ? `${ts}-${os}` : e.score ?? null, result: e.gameResult === 'D' ? 'T' : e.gameResult ?? null,
    };
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

const normInjury = (i, team) => {
  const d = i.details ?? {};
  const spec = (v) => (v && v !== 'Not Specified' ? v : null);
  return {
    teamId: str(team?.id ?? i.athlete?.team?.id ?? null),
    teamAbbr: team?.abbreviation ?? i.athlete?.team?.abbreviation ?? null,
    athlete: normAthlete(i.athlete, team ?? i.athlete?.team),
    status: i.status ?? i.type?.description ?? null,
    detail: [spec(d.type), spec(d.side), spec(d.detail)].filter(Boolean).join(' · ') || i.shortComment || null,
    comment: i.shortComment ?? null,
    returnDate: d.returnDate ?? null,
    date: iso(i.date),
  };
};
// /injuries de la liga: [{ id, displayName, injuries: [...] }] o summary.injuries: [{ team, injuries: [...] }]
export const normInjuries = (list) => (list ?? []).flatMap((t) => (t.injuries ?? []).map((i) => normInjury(i, t.team ?? i.athlete?.team ?? { id: t.id })));

export function normRoster(json) {
  const team = json?.team ? { id: json.team.id, abbreviation: json.team.abbreviation } : null;
  const list = (json?.athletes ?? []).flatMap((g) => (Array.isArray(g.items) ? g.items : [g]));
  return list.map((a) => normAthlete(a, team)).filter((a) => a?.id);
}

function startersFrom(json) {
  const out = {};
  for (const p of json?.boxscore?.players ?? []) {
    const list = (p.statistics?.[0]?.athletes ?? []).filter((a) => a.starter).map((a) => normAthlete(a.athlete, p.team));
    if (list.length) out[String(p.team?.id)] = list;
  }
  for (const r of json?.rosters ?? []) {
    const list = (r.roster ?? []).filter((a) => a.starter).map((a) => normAthlete({ ...a.athlete, position: a.position ?? a.athlete?.position, jersey: a.jersey ?? a.athlete?.jersey }, r.team));
    if (list.length && r.team?.id) out[String(r.team.id)] = list;
  }
  return out;
}

const summaryRosters = (json) => Object.fromEntries((json?.rosters ?? []).filter((r) => r.team?.id).map((r) => [String(r.team.id), (r.roster ?? []).map((a) => normAthlete({ ...a.athlete, position: a.position ?? a.athlete?.position, jersey: a.jersey ?? a.athlete?.jersey }, r.team))]));

// summary + datos complementarios (cada uno opcional, ya pedido por el wrapper) → GameDetail.
// extra = { rosters: {home, away}, records: {home, away}, stats: {home, away} } con el JSON crudo de ESPN.
// ATS: solo summary.againstTheSpread (hoy casi siempre vacío → null). El endpoint core odds-records se descartó porque sus
// cifras no cuadran con los récords reales de los equipos.
export function normSummary(json, league, extra = {}) {
  const lg = leagueById(league);
  const comp = json?.header?.competitions?.[0];
  const game = gameFrom(json?.header?.id ?? comp?.id, comp, comp?.status, league, [...(json?.pickcenter ?? []), ...(json?.odds ?? [])]);
  const ids = { home: game.home.id, away: game.away.id };
  const both = (fn) => ({ home: fn('home'), away: fn('away') });
  const byTeam = (list, getId) => both((s) => list?.find((x) => String(getId(x)) === ids[s]));
  const headerComp = byTeam(comp?.competitors, (c) => c.id ?? c.team?.id);

  const starters = startersFrom(json);
  const sumRosters = summaryRosters(json);
  const box = byTeam(json?.boxscore?.teams, (t) => t.team?.id);
  const ats = byTeam(json?.againstTheSpread, (t) => t.team?.id);
  const atsBoth = both((s) => normAtsSummary(ats[s]?.records));
  const pred = json?.predictor;
  const pct = (v) => (num(v) == null ? null : Math.round(num(v) * 10) / 1000);
  const recordsOf = (s) => {
    const core = normRecords(extra.records?.[s]);
    return core.length ? core : normRecords(headerComp[s]?.record);
  };
  const statsOf = (s) => {
    const core = normTeamStats(extra.stats?.[s], lg?.sport);
    return core.length ? core : normBoxTeamStats(box[s]?.statistics);
  };
  const rosterOf = (s) => {
    const r = extra.rosters?.[s] ? normRoster(extra.rosters[s]) : [];
    return r.length ? r : sumRosters[ids[s]] ?? [];
  };
  const l5 = byTeam(json?.lastFiveGames, (t) => t.team?.id);
  return {
    ...game,
    injuries: normInjuries(json?.injuries),
    rosters: both(rosterOf),
    starters: starters[ids.home] || starters[ids.away] ? { home: starters[ids.home] ?? [], away: starters[ids.away] ?? [] } : null,
    teamStats: both(statsOf),
    teamStatsSeason: num(/\/seasons\/(\d{4})/.exec(extra.stats?.home?.season?.$ref ?? extra.stats?.away?.season?.$ref ?? '')?.[1]), // puede ser la temporada anterior si la actual aún no tiene datos
    records: both(recordsOf),
    ats: atsBoth.home.length || atsBoth.away.length ? atsBoth : null,
    lastFive: both((s) => normLastFive(l5[s])),
    predictor: pred?.homeTeam && pct(pred.homeTeam.gameProjection) != null
      ? { homeWinPct: pct(pred.homeTeam.gameProjection), awayWinPct: pct(pred.awayTeam?.gameProjection) ?? Math.round((1 - pct(pred.homeTeam.gameProjection)) * 1000) / 1000 }
      : null,
    publicBetting: null, // no hay fuente gratuita del % de apuestas / dinero del público
  };
}

// ---------- game logs ----------
const NAME_MAP = {
  basketball: {
    minutes: 'min', points: 'pts', totalRebounds: 'reb', offensiveRebounds: 'oreb', defensiveRebounds: 'dreb', assists: 'ast', steals: 'stl',
    blocks: 'blk', turnovers: 'to', fouls: 'pf', fieldGoalsMade: 'fgm', fieldGoalsAttempted: 'fga', threePointFieldGoalsMade: '3pm',
    threePointFieldGoalsAttempted: '3pa', freeThrowsMade: 'ftm', freeThrowsAttempted: 'fta',
  },
  football: {
    completions: 'pass_cmp', passingAttempts: 'pass_att', passingYards: 'pass_yds', passingTouchdowns: 'pass_tds', longPassing: 'pass_long',
    rushingAttempts: 'rush_att', rushingYards: 'rush_yds', rushingTouchdowns: 'rush_tds', longRushing: 'rush_long', receptions: 'rec',
    receivingTargets: 'tgt', receivingYards: 'rec_yds', receivingTouchdowns: 'rec_tds', longReception: 'rec_long', fumbles: 'fum',
    fumblesLost: 'fum_lost', totalTackles: 'tkl', soloTackles: 'solo',
  },
  batting: {
    atBats: 'ab', runs: 'runs', hits: 'hits', doubles: '2b', triples: '3b', homeRuns: 'hr', RBIs: 'rbi', walks: 'bb', hitByPitch: 'hbp',
    strikeouts: 'so', stolenBases: 'sb', caughtStealing: 'cs',
  },
  pitching: { innings: 'outs', hits: 'ha', runs: 'ra', earnedRuns: 'er', homeRuns: 'hra', walks: 'bba', strikeouts: 'k', pitches: 'pitches', battersFaced: 'bf' },
  hockey: {
    goals: 'goals', assists: 'assists', points: 'points', plusMinus: 'pm', penaltyMinutes: 'pim', shotsTotal: 'sog', powerPlayGoals: 'ppg',
    powerPlayAssists: 'ppa', shortHandedGoals: 'shg', timeOnIcePerGame: 'min', saves: 'saves', goalsAgainst: 'ga', shotsAgainst: 'sa',
  },
  soccer: { totalGoals: 'goals', goalAssists: 'assists', totalShots: 'shots', shotsOnTarget: 'sot', foulsCommitted: 'fc', foulsSuffered: 'fs', offsides: 'off', yellowCards: 'yc', redCards: 'rc' },
};

const statValue = (key, raw) => {
  const s = String(raw ?? '').trim();
  if (key === 'min' && /^\d+:\d\d$/.test(s)) { const [m, sec] = s.split(':').map(Number); return Math.round((m + sec / 60) * 100) / 100; }
  if (key === 'outs' && /^\d+(\.[0-2])?$/.test(s)) { const [w, f = '0'] = s.split('.'); return Number(w) * 3 + Number(f); } // 6.1 entradas = 19 outs
  return num(s);
};

// Mapa nombre de ESPN → clave corta según el deporte (y la categoría del game log en béisbol / fútbol americano).
function nameMapFor(sport, json) {
  if (sport === 'baseball') return json?.filters?.find((f) => f.name === 'category')?.value === 'pitching' ? NAME_MAP.pitching : NAME_MAP.batting;
  if (sport === 'football') {
    const passer = json?.names?.includes('passingAttempts');
    return { ...NAME_MAP.football, interceptions: passer ? 'pass_int' : 'def_int', sacks: passer ? 'sacked' : 'sacks' };
  }
  return NAME_MAP[sport] ?? {};
}

const SKIP_SEASON = /preseason|spring training|pretemporada|all-star/i;

// Un game log de ESPN (una temporada) → partidos normalizados, del más reciente al más antiguo.
export function normGamelog(json, sport, season = num(json?.filters?.find((f) => f.name === 'season')?.value)) {
  const names = json?.names ?? [];
  const map = nameMapFor(sport, json);
  const out = [];
  for (const st of json?.seasonTypes ?? []) {
    if (SKIP_SEASON.test(st.displayName ?? '')) continue;
    for (const cat of st.categories ?? []) {
      for (const ev of cat.type === 'event' ? cat.events ?? [] : []) {
        const meta = json.events?.[ev.eventId];
        if (!meta || meta.team?.isAllStar) continue;
        const stats = {};
        names.forEach((n, i) => {
          const parts = n.split('-'), vals = String(ev.stats?.[i] ?? '').split('-');
          if (parts.length > 1 && vals.length === parts.length) parts.forEach((p, j) => { if (map[p]) { const v = statValue(map[p], vals[j]); if (v != null) stats[map[p]] = v; } });
          else if (map[n]) { const v = statValue(map[n], ev.stats?.[i]); if (v != null) stats[map[n]] = v; }
        });
        for (const d of STATS[sport] ?? []) if (d.from) { const v = statOf(sport, d.key, stats); if (v != null) stats[d.key] = v; }
        const teamId = str(meta.team?.id);
        const home = meta.homeTeamId != null && teamId ? String(meta.homeTeamId) === teamId : meta.atVs === 'vs';
        const teamScore = num(home ? meta.homeTeamScore : meta.awayTeamScore), oppScore = num(home ? meta.awayTeamScore : meta.homeTeamScore);
        out.push({
          eventId: str(ev.eventId), date: iso(meta.gameDate), season, opp: { id: str(meta.opponent?.id), abbr: meta.opponent?.abbreviation ?? null },
          home, result: meta.gameResult === 'D' ? 'T' : ['W', 'L', 'T'].includes(meta.gameResult) ? meta.gameResult : null,
          margin: teamScore != null && oppScore != null ? teamScore - oppScore : null, teamScore, oppScore,
          minutes: stats.min ?? null, stats,
        });
      }
    }
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export function buildGameLog(athlete, sport, gameLists) {
  const seen = new Set();
  const games = gameLists.flat().filter((g) => g.eventId && !seen.has(g.eventId) && seen.add(g.eventId))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const defs = (STATS[sport] ?? []).filter((d) => games.some((g) => statOf(sport, d.key, g.stats) != null));
  return { athlete, statKeys: defs.map((d) => d.key), labels: Object.fromEntries(defs.map((d) => [d.key, d.label])), games };
}

export const normAthleteProfile = (json) => normAthlete(json?.athlete, json?.athlete?.team);

export function normSearch(json, espnLeague) {
  return (json?.items ?? []).filter((i) => i.type === 'player' && (!espnLeague || !i.league || i.league === espnLeague))
    .map((i) => normAthlete(i, i.teamRelationships?.find((t) => t.type === 'team')?.core ?? null)).filter((a) => a?.id);
}

// ---------- fetch wrappers ----------
const L = (league) => {
  const lg = leagueById(league);
  if (!lg) throw httpError(400, 'Liga inválida');
  return lg;
};
const base = (lg) => `${SITE}/${lg.sport}/${lg.espn}`;
const liveTtl = (isLive) => (body) => (isLive(body) ? TTL.live : TTL.board);
const COLLEGE_GROUPS = { 'college-football': '80', 'mens-college-basketball': '50' }; // todos los partidos de FBS / División I

export async function getGames(league, date) {
  const lg = L(league);
  const url = new URL(`${base(lg)}/scoreboard`);
  if (date) url.searchParams.set('dates', date);
  if (COLLEGE_GROUPS[lg.espn]) url.searchParams.set('groups', COLLEGE_GROUPS[lg.espn]);
  url.searchParams.set('limit', '300');
  const json = await fetchJson(url.href, liveTtl((b) => b?.events?.some((e) => e.status?.type?.state === 'in')));
  return normScoreboard(json, lg.id);
}

const coreTeam = (lg, year, type, teamId, what) => `${CORE}/${lg.sport}/leagues/${lg.espn}/seasons/${year}/types/${type}/teams/${teamId}/${what}`;

export async function getGame(league, id) {
  const lg = L(league);
  const json = await fetchJson(`${base(lg)}/summary?event=${id}`, liveTtl((b) => b?.header?.competitions?.[0]?.status?.type?.state === 'in'));
  const comp = json?.header?.competitions?.[0];
  if (!comp) throw httpError(404, 'Partido no encontrado en ESPN');
  const year = num(json.header.season?.year) ?? new Date().getUTCFullYear();
  const type = lg.sport === 'soccer' ? 1 : 2; // temporada regular
  const teamId = (ha) => comp.competitors?.find((c) => c.homeAway === ha)?.id ?? comp.competitors?.find((c) => c.homeAway === ha)?.team?.id;
  const stats = (tid) => fetchJson(coreTeam(lg, year, type, tid, 'statistics'), TTL.slow).catch(() => fetchJson(coreTeam(lg, year - 1, type, tid, 'statistics'), TTL.slow));
  const sides = ['home', 'away'];
  const ids = sides.map(teamId);
  const [rosters, records, teamStats] = await Promise.all([
    Promise.all(ids.map((t) => (t ? soft(fetchJson(`${base(lg)}/teams/${t}/roster`, TTL.slow)) : null))),
    Promise.all(ids.map((t) => (t ? soft(fetchJson(coreTeam(lg, year, type, t, 'record'), TTL.slow)) : null))),
    Promise.all(ids.map((t) => (t ? soft(stats(t)) : null))),
  ]);
  const pair = (arr) => ({ home: arr[0], away: arr[1] });
  return normSummary(json, lg.id, { rosters: pair(rosters), records: pair(records), stats: pair(teamStats) });
}

const athleteUrl = (lg, id) => `${WEB}/sports/${lg.sport}/${lg.espn}/athletes/${id}`;

// Sin season: temporada actual (la que ESPN da por defecto) + la anterior, combinadas.
export async function getGamelog(league, athleteId, season) {
  const lg = L(league);
  const profile = soft(fetchJson(athleteUrl(lg, athleteId), TTL.slow));
  const first = await fetchJson(`${athleteUrl(lg, athleteId)}/gamelog${season ? `?season=${season}` : ''}`, TTL.slow);
  const current = num(first?.filters?.find((f) => f.name === 'season')?.value);
  const lists = [normGamelog(first, lg.sport)];
  if (!season && current) {
    const prev = await soft(fetchJson(`${athleteUrl(lg, athleteId)}/gamelog?season=${current - 1}`, TTL.slow));
    if (prev) lists.push(normGamelog(prev, lg.sport, current - 1));
  }
  const athlete = normAthleteProfile(await profile) ?? { id: String(athleteId), name: null, short: null, pos: null, jersey: null, headshot: null, teamId: null, teamAbbr: null };
  return buildGameLog(athlete, lg.sport, lists);
}

export async function getRoster(league, teamId) {
  const lg = L(league);
  return normRoster(await fetchJson(`${base(lg)}/teams/${teamId}/roster`, TTL.slow));
}

export async function getInjuries(league) {
  const lg = L(league);
  const json = await fetchJson(`${base(lg)}/injuries`, TTL.board).catch((err) => {
    if (err.status === 404) return { injuries: [] }; // ESPN no publica lesiones para algunas ligas (fútbol)
    throw err;
  });
  return normInjuries(json?.injuries);
}

export async function searchAthletes(league, q) {
  const lg = L(league);
  const url = new URL(`${WEB}/search`);
  url.search = new URLSearchParams({ query: q, type: 'player', limit: '20', sport: lg.sport, league: lg.espn });
  return normSearch(await fetchJson(url.href, TTL.slow), lg.espn);
}
