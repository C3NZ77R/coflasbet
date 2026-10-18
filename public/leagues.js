// Ligas soportadas. Lo comparten el servidor (validación y rutas de ESPN / The Odds API) y el navegador.
// sport = deporte en las URL de ESPN y clave de STATS (public/stats.js); espn = liga en ESPN; odds = sport key de The Odds API.
export const LEAGUES = [
  { id: 'nba', title: 'NBA', sport: 'basketball', espn: 'nba', odds: 'basketball_nba' },
  { id: 'nfl', title: 'NFL', sport: 'football', espn: 'nfl', odds: 'americanfootball_nfl' },
  { id: 'mlb', title: 'MLB', sport: 'baseball', espn: 'mlb', odds: 'baseball_mlb' },
  { id: 'nhl', title: 'NHL', sport: 'hockey', espn: 'nhl', odds: 'icehockey_nhl' },
  { id: 'ncaaf', title: 'NCAAF', sport: 'football', espn: 'college-football', odds: 'americanfootball_ncaaf' },
  { id: 'ncaab', title: 'NCAAB', sport: 'basketball', espn: 'mens-college-basketball', odds: 'basketball_ncaab' },
  { id: 'wnba', title: 'WNBA', sport: 'basketball', espn: 'wnba', odds: 'basketball_wnba' },
  { id: 'laliga', title: 'LaLiga', sport: 'soccer', espn: 'esp.1', odds: 'soccer_spain_la_liga' },
  { id: 'epl', title: 'Premier League', sport: 'soccer', espn: 'eng.1', odds: 'soccer_epl' },
  { id: 'ucl', title: 'Champions', sport: 'soccer', espn: 'uefa.champions', odds: 'soccer_uefa_champs_league' },
  { id: 'libertadores', title: 'Libertadores', sport: 'soccer', espn: 'conmebol.libertadores', odds: 'soccer_conmebol_copa_libertadores' },
  { id: 'colombia', title: 'Liga BetPlay', sport: 'soccer', espn: 'col.1', odds: null },
];

export const leagueById = (id) => LEAGUES.find((l) => l.id === id) ?? null;
