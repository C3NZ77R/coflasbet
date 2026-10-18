// Estadísticas de jugador por deporte. Lo comparten el servidor (lib/espn.mjs normaliza los game logs de ESPN a estas
// claves cortas y lib/props.mjs pide a The Odds API los mercados `market`) y el navegador (pestañas, insights, props).
// Cada definición: { key, label (corto, como en las pestañas), name (español), market? (The Odds API), markets? (otros
// mercados equivalentes, p. ej. Sí/No de anotar), from? (estadística derivada a partir de las claves crudas) }.

// Suma tolerante: null si falta la primera clave (la que define el tipo de jugador); las demás, si faltan, cuentan como 0.
const sum = (...keys) => (s) => (Number.isFinite(s[keys[0]]) ? keys.reduce((t, k) => t + (Number.isFinite(s[k]) ? s[k] : 0), 0) : null);
const tens = (s) => ['pts', 'reb', 'ast', 'stl', 'blk'].filter((k) => s[k] >= 10).length;
const has = (s, ...keys) => keys.every((k) => Number.isFinite(s[k]));
export const doubleDouble = (s) => (has(s, 'pts', 'reb', 'ast') ? (tens(s) >= 2 ? 1 : 0) : null);
export const tripleDouble = (s) => (has(s, 'pts', 'reb', 'ast') ? (tens(s) >= 3 ? 1 : 0) : null);

export const STATS = {
  basketball: [
    { key: 'pts', label: 'PTS', name: 'Puntos', market: 'player_points' },
    { key: 'reb', label: 'REB', name: 'Rebotes', market: 'player_rebounds' },
    { key: 'ast', label: 'AST', name: 'Asistencias', market: 'player_assists' },
    { key: '3pm', label: '3PTM', name: 'Triples anotados', market: 'player_threes' },
    { key: 'pra', label: 'PTS+REB+AST', name: 'Puntos + rebotes + asistencias', market: 'player_points_rebounds_assists', from: sum('pts', 'reb', 'ast') },
    { key: 'pr', label: 'PTS+REB', name: 'Puntos + rebotes', market: 'player_points_rebounds', from: sum('pts', 'reb') },
    { key: 'pa', label: 'PTS+AST', name: 'Puntos + asistencias', market: 'player_points_assists', from: sum('pts', 'ast') },
    { key: 'ra', label: 'REB+AST', name: 'Rebotes + asistencias', market: 'player_rebounds_assists', from: sum('reb', 'ast') },
    { key: 'stl', label: 'STL', name: 'Robos', market: 'player_steals' },
    { key: 'blk', label: 'BLK', name: 'Tapones', market: 'player_blocks' },
    { key: 'sb', label: 'STL+BLK', name: 'Robos + tapones', market: 'player_blocks_steals', from: sum('stl', 'blk') },
    { key: 'to', label: 'TO', name: 'Pérdidas', market: 'player_turnovers' },
    { key: 'fgm', label: 'FGM', name: 'Tiros de campo anotados', market: 'player_field_goals' },
    { key: 'fga', label: 'FGA', name: 'Tiros de campo intentados' },
    { key: '3pa', label: '3PTA', name: 'Triples intentados' },
    { key: 'ftm', label: 'FTM', name: 'Tiros libres anotados', market: 'player_frees_made' },
    { key: 'fta', label: 'FTA', name: 'Tiros libres intentados', market: 'player_frees_attempts' },
    { key: 'dd', label: 'DD2', name: 'Doble-doble', market: 'player_double_double', from: doubleDouble },
    { key: 'td', label: 'TD3', name: 'Triple-doble', market: 'player_triple_double', from: tripleDouble },
  ],
  football: [
    { key: 'pass_yds', label: 'PASS YDS', name: 'Yardas por pase', market: 'player_pass_yds' },
    { key: 'pass_tds', label: 'PASS TD', name: 'Touchdowns de pase', market: 'player_pass_tds' },
    { key: 'pass_cmp', label: 'CMP', name: 'Pases completos', market: 'player_pass_completions' },
    { key: 'pass_att', label: 'ATT', name: 'Pases intentados', market: 'player_pass_attempts' },
    { key: 'pass_int', label: 'INT', name: 'Intercepciones lanzadas', market: 'player_pass_interceptions' },
    { key: 'pass_long', label: 'PASS LNG', name: 'Pase más largo', market: 'player_pass_longest_completion' },
    { key: 'rush_yds', label: 'RUSH YDS', name: 'Yardas por tierra', market: 'player_rush_yds' },
    { key: 'rush_att', label: 'CAR', name: 'Acarreos', market: 'player_rush_attempts' },
    { key: 'rush_long', label: 'RUSH LNG', name: 'Carrera más larga', market: 'player_rush_longest' },
    { key: 'rec', label: 'REC', name: 'Recepciones', market: 'player_receptions' },
    { key: 'rec_yds', label: 'REC YDS', name: 'Yardas por recepción', market: 'player_reception_yds' },
    { key: 'rec_long', label: 'REC LNG', name: 'Recepción más larga', market: 'player_reception_longest' },
    { key: 'tgt', label: 'TGT', name: 'Objetivos' },
    { key: 'rush_rec_yds', label: 'RUSH+REC YDS', name: 'Yardas por tierra + recepción', market: 'player_rush_reception_yds', from: sum('rush_yds', 'rec_yds') },
    { key: 'pass_rush_yds', label: 'PASS+RUSH YDS', name: 'Yardas por pase + tierra', market: 'player_pass_rush_yds', from: sum('pass_yds', 'rush_yds') },
    { key: 'tds', label: 'TD', name: 'Touchdowns (tierra + recepción)', market: 'player_anytime_td', markets: ['player_tds_over'], from: sum('rush_tds', 'rec_tds') },
    { key: 'rush_tds', label: 'RUSH TD', name: 'Touchdowns por tierra' },
    { key: 'rec_tds', label: 'REC TD', name: 'Touchdowns por recepción' },
    { key: 'sacks', label: 'SACK', name: 'Capturas', market: 'player_sacks' },
    { key: 'tkl', label: 'TKL', name: 'Tacleadas totales', market: 'player_tackles_assists' },
    { key: 'solo', label: 'SOLO', name: 'Tacleadas en solitario', market: 'player_solo_tackles' },
  ],
  baseball: [
    { key: 'hits', label: 'H', name: 'Hits', market: 'batter_hits' },
    { key: 'tb', label: 'TB', name: 'Bases totales', market: 'batter_total_bases', from: (s) => (has(s, 'hits') ? s.hits + (s['2b'] || 0) + 2 * (s['3b'] || 0) + 3 * (s.hr || 0) : null) },
    { key: 'hr', label: 'HR', name: 'Jonrones', market: 'batter_home_runs' },
    { key: 'rbi', label: 'RBI', name: 'Carreras impulsadas', market: 'batter_rbis' },
    { key: 'runs', label: 'R', name: 'Carreras anotadas', market: 'batter_runs_scored' },
    { key: 'hrr', label: 'H+R+RBI', name: 'Hits + carreras + impulsadas', market: 'batter_hits_runs_rbis', from: sum('hits', 'runs', 'rbi') },
    { key: 'singles', label: '1B', name: 'Sencillos', market: 'batter_singles', from: (s) => (has(s, 'hits') ? s.hits - (s['2b'] || 0) - (s['3b'] || 0) - (s.hr || 0) : null) },
    { key: '2b', label: '2B', name: 'Dobles', market: 'batter_doubles' },
    { key: '3b', label: '3B', name: 'Triples', market: 'batter_triples' },
    { key: 'bb', label: 'BB', name: 'Bases por bolas', market: 'batter_walks' },
    { key: 'so', label: 'SO', name: 'Ponches (bateador)', market: 'batter_strikeouts' },
    { key: 'sb', label: 'SB', name: 'Bases robadas', market: 'batter_stolen_bases' },
    { key: 'k', label: 'K', name: 'Ponches (lanzador)', market: 'pitcher_strikeouts' },
    { key: 'outs', label: 'OUTS', name: 'Outs registrados', market: 'pitcher_outs' },
    { key: 'ha', label: 'HA', name: 'Hits permitidos', market: 'pitcher_hits_allowed' },
    { key: 'er', label: 'ER', name: 'Carreras limpias', market: 'pitcher_earned_runs' },
    { key: 'bba', label: 'BB (P)', name: 'Bases por bolas otorgadas', market: 'pitcher_walks' },
  ],
  hockey: [
    { key: 'points', label: 'PTS', name: 'Puntos', market: 'player_points' },
    { key: 'goals', label: 'G', name: 'Goles', market: 'player_goals', markets: ['player_goal_scorer_anytime'] },
    { key: 'assists', label: 'A', name: 'Asistencias', market: 'player_assists' },
    { key: 'sog', label: 'SOG', name: 'Tiros a puerta', market: 'player_shots_on_goal' },
    { key: 'ppp', label: 'PPP', name: 'Puntos en power play', market: 'player_power_play_points', from: sum('ppg', 'ppa') },
    { key: 'saves', label: 'SV', name: 'Atajadas', market: 'player_total_saves' },
    { key: 'ga', label: 'GA', name: 'Goles recibidos' },
  ],
  soccer: [
    { key: 'goals', label: 'G', name: 'Goles', market: 'player_goal_scorer_anytime' },
    { key: 'assists', label: 'A', name: 'Asistencias', market: 'player_assists' },
    { key: 'shots', label: 'TIROS', name: 'Tiros', market: 'player_shots' },
    { key: 'sot', label: 'TAP', name: 'Tiros a puerta', market: 'player_shots_on_target' },
    { key: 'fc', label: 'FC', name: 'Faltas cometidas' },
    { key: 'fs', label: 'FR', name: 'Faltas recibidas' },
    { key: 'yc', label: 'TA', name: 'Tarjetas amarillas', market: 'player_to_receive_card' },
  ],
};

const defOf = (sport, key) => STATS[sport]?.find((d) => d.key === key) ?? null;

// Valor de una estadística (cruda o derivada) en un partido; null si no se puede calcular.
export function statOf(sport, key, gameStats) {
  if (!gameStats) return null;
  const d = defOf(sport, key);
  const v = d?.from ? d.from(gameStats) : gameStats[key];
  return Number.isFinite(v) ? v : null;
}

// Definición para un mercado de The Odds API (acepta también las variantes `_alternate`).
export function statForMarket(sport, market) {
  const m = String(market || '').replace(/_alternate$/, '');
  return STATS[sport]?.find((d) => d.market === m || d.markets?.includes(m)) ?? null;
}

// Mercados de props que se piden a The Odds API para un deporte (los principales, sin alternativos).
export const propMarkets = (sport) => [...new Set((STATS[sport] ?? []).flatMap((d) => (d.market ? [d.market] : [])))];
