# Oddsy Bet — arquitectura y contratos

Vanilla JS sin build (ES modules en el navegador), Node >= 22 sin dependencias. UI en español. Lo que existe hoy: server.mjs (proxy de ESPN, cuotas propias + estáticos), public/betmath.js (matemática), public/app.js (UI de 4 pestañas), tests con `node --test`.
Funcionalidad objetivo: todo lo de `docs/outlier-spec.md`.

## Fuentes de datos reales
- **ESPN JSON público, sin clave** (fuente principal de partidos, game logs, lesiones, rosters, estadísticas y récords de equipos, ATS y la línea de ESPN BET/DraftKings en `pickcenter`):
  - `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD`
  - `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/summary?event={id}` (pickcenter, againstTheSpread, injuries, boxscore, leaders, predictor, lastFiveGames, standings)
  - `https://site.web.api.espn.com/apis/common/v3/sports/{sport}/{league}/athletes/{id}/gamelog[?season=YYYY]`
  - `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{id}/roster`
  - `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/injuries`
  - `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{id}` y `sports.core.api.espn.com/v2/sports/{sport}/leagues/{league}/seasons/{y}/types/2/teams/{id}/statistics`
- **Cuotas propias** (sin casas): `lib/markets.mjs` (partidos: ratings desde los calendarios de ESPN → Dixon-Coles / Poisson / normal) y `lib/props.mjs` (props: game logs de ESPN → binomial negativa / normal). Cuota justa = 1/p; cuota Oddsy = 1/(p·1.05). Precisión medida en `docs/accuracy.json` (`scripts/backtest.mjs`).
- **Mercados de predicción sin clave** (opcional, como "casas" adicionales en líneas de partido): Kalshi `https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=...` / Polymarket gamma `https://gamma-api.polymarket.com/events?tag_slug=...`. Solo si se emparejan bien con los partidos de ESPN.
- Nunca se llama a la API de Outlier.

Todas las llamadas externas pasan por server.mjs, con una caché en memoria por URL (TTL: 15 s en vivo, 5 min para scoreboard/summary, 30 min para gamelog/roster/stats). Todo error devuelve `{error}` con un status HTTP. Con un timeout de 8 s por fetch.

## Ligas (`public/leagues.js`, compartido por servidor y cliente)
`export const LEAGUES = [{ id:'nba', title:'NBA', sport:'basketball', espn:'nba' }, { id:'nfl', ... espn:'nfl' }, { id:'mlb', sport:'baseball', espn:'mlb' }, { id:'wnba', sport:'basketball', espn:'wnba' }, { id:'laliga', title:'LaLiga', sport:'soccer', espn:'esp.1' }, { id:'epl', title:'Premier League', sport:'soccer', espn:'eng.1' }, { id:'ucl', title:'Champions', sport:'soccer', espn:'uefa.champions' }, { id:'libertadores', title:'Libertadores', sport:'soccer', espn:'conmebol.libertadores' }, { id:'colombia', title:'Liga BetPlay', sport:'soccer', espn:'col.1' }]`
`export const leagueById = (id) => ...`

## API HTTP (server.mjs) — todas devuelven `{ source: 'oddsy'|'espn', data }`
- `GET /api/leagues` → LEAGUES
- `GET /api/markets?league=nba&game=ID` → `{ gameId, markets: Market[] }` (sin game: todos los partidos de `date`, por defecto hoy) + `accuracy`
- `GET /api/accuracy` → `docs/accuracy.json`
- `GET /api/games?league=nba&date=YYYYMMDD` → `Game[]`
- `GET /api/game?league=nba&id=ESPN_EVENT_ID` → `GameDetail`
- `GET /api/live?league=nfl` → `LiveGame[]` = los partidos en juego de hoy: `Game & { progress /*0..1 del tiempo reglamentario*/, stop: { kind, label, at }|null /*pausa: tiempo muerto, fin de periodo…*/, winProb /*local, de ESPN*/|null, lastPlay, lastPlayAt /*hora real de la jugada*/, players: [{ id, name, teamId, stats }] /*boxscore con las claves de STATS*/ }` (caché de borde 10 s)
- `GET /api/gamelog?league=nba&athlete=ID[&season=YYYY]` → `GameLog` (temporada actual + anterior combinadas si no se pasa season)
- `GET /api/roster?league=nba&team=ID` → `Athlete[]`
- `GET /api/injuries?league=nba` → `Injury[]`
- `GET /api/props?league=nba[&game=ESPN_EVENT_ID]` → `Prop[]` con línea propia y `books: [{ key:'oddsy' }]` (sin game: los próximos 3 partidos de hoy)
- `GET /api/search?league=nba&q=texto` → `Athlete[]`

Tipos (JSON). Las cuotas SIEMPRE en decimal (la UI convierte a americano):
```
Team    = { id, abbr, name, logo, record: '56-26'|null, score: number|null, color: '#hex'|null }
Game    = { id, league, start: ISO, status: { state: 'pre'|'in'|'post', detail }, home: Team, away: Team,
            odds: { provider, moneyline: {home, away, draw?}|null, spread: {line /*home*/, home, away}|null, total: {line, over, under}|null } | null }
GameDetail = Game & {
  injuries: Injury[],
  rosters: { home: Athlete[], away: Athlete[] },
  starters: { home: Athlete[], away: Athlete[] } | null,        // boxscore if available
  teamStats: { home: Stat[], away: Stat[] },                    // Stat = { key, label, value: number, display, rank: number|null }
  records: { home: Rec[], away: Rec[] },                        // Rec = { key: 'overall'|'home'|'road'|'vsconf'|'vsdiv'|..., label, summary: '30-11' }
  ats: { home: Rec[], away: Rec[] } | null,
  lastFive: { home: PastGame[], away: PastGame[] },             // PastGame = { date, opp, home: bool, score, result: 'W'|'L'|'T', ats?: 'W'|'L'|'P', ou?: 'O'|'U'|'P' }
  predictor: { homeWinPct, awayWinPct } | null,
  publicBetting: null                                           // no free source; UI shows "no disponible"
}
Athlete = { id, name, short, pos, jersey, headshot, teamId, teamAbbr }
Injury  = { teamId, teamAbbr, athlete: Athlete, status: 'Out'|'Questionable'|'Doubtful'|'Day-To-Day'|..., detail, date: ISO }
GameLog = { athlete: Athlete, statKeys: string[], labels: {key: label},
            games: [{ eventId, date: ISO, season: number, opp: {id, abbr}, home: bool, result: 'W'|'L'|'T'|null, margin: number|null, teamScore, oppScore, minutes: number|null, stats: { [key]: number } }] }  // ordenados del más reciente al más antiguo
Prop    = { id, league, gameId|null, eventId /*= gameId*/, start, player, athleteId|null, team|null, opp|null, market: 'player_points', stat: 'pts', line, side: 'Over'|'Under', books: [{ key, title, price }] }
```

## Estadísticas por deporte (`public/stats.js`)
`export const STATS = { basketball: [{ key:'pts', label:'PTS', name:'Puntos', market:'player_points', from: s => s.pts }, { key:'reb' ...}, { key:'ast' }, { key:'3pm', market:'player_threes' }, { key:'stl' }, { key:'blk' }, { key:'to' }, { key:'pra', label:'PTS+REB+AST', from: s => s.pts+s.reb+s.ast, market:'player_points_rebounds_assists' }, { key:'pr' }, { key:'pa' }, { key:'ra' }, { key:'sb' }, { key:'fgm' }, { key:'fga' }, { key:'3pa' }, { key:'dd', from: doubleDouble }, { key:'td' }], football: [...pass_yds, pass_tds, rush_yds, rush_att, rec, rec_yds, ...], baseball: [hits, tb, hr, rbi, runs, k (pitcher), ...], hockey: [goals, assists, points, sog, saves], soccer: [goals, assists, shots, sot] }`
`export const statOf = (sport, key, gameStats) => number|null` y `export const statForMarket = (sport, market) => statDef|null`.
El servidor normaliza los nombres de las estadísticas de ESPN a estas claves cortas en `GameLog.games[].stats`.

## Matemática (`public/betmath.js`) — funciones puras y testeadas; se conservan las actuales
Cuotas: `implied, decimalToAmerican, americanToDecimal, decimalToFractional, fractionalToDecimal, expectedValue, kelly, parlayOdds, arbitrage`.
Devig: `devig(prices: decimal[], method = 'multiplicative'|'additive'|'power'|'shin'|'probit'|'worst') → probs[]` (`noVig` se mantiene como alias multiplicativo). `vig(prices) = Σ1/p − 1`. `width(priceA, priceB)` = |americano A + americano B| para dos lados con signos opuestos (convención de los centavos del mercado: −110/−110 → 20).
EV con varias casas: `fairFromBooks(books: [{key, prices: decimal[]}], { method, weights: {key: w}, required: key[], optional: key[], minBooks }) → { probs, variation, used: key[] } | null` (promedio ponderado de las probabilidades sin vig de cada casa; variation = máx − mín de la probabilidad justa del lado entre las casas usadas).
`analyzeEvent(event, opts)` se extiende con `opts = { market, method, sharp: { required, optional, weights }, minBooks, minEv, kellyMult, maxWidth, maxVariation, minOdds, maxOdds }`; cada evBet suma `{ kelly, width, variation, vig, fairAmerican }`. Por defecto queda el comportamiento actual (Pinnacle o consenso, multiplicativo) para que los tests actuales sigan pasando.
Props: `analyzeProps(props: Prop[], opts)` → agrupa por (player, stat, line) y lados, mejor cuota, IP, devig, EV, arbitraje.
Arbitraje: `arbStakes(prices, { bankroll } | { toWin })` → `{ profit, stakes[], payout }`.
Middles: `findMiddles(lines: [{ side:'Over'|'Under'|team, line, price, book }], kind:'total'|'spread')` → `[{ legs:[a,b], gap, stakes, outcomes: [{ range:'<=31', net }, ...], middleProb, ev }]`; `middleProb` con Poisson (deportes de conteo bajo) o normal (puntos) alrededor de la línea consenso.
Acierto y splits: `hitRate(values: number[], line, side) → { hits, pushes, n, pct }`; `splitGames(games, { window:'l5'|'l10'|'l20'|'h2h'|'season'|'prev', oppId, location:'home'|'away'|'all', minMinutes, maxMinutes, daysRest, withAthlete, withoutAthlete, result:'W'|'L'|'all', maxMargin })`; `summarize(values) → { avg, median, min, max }`; `streak(values, line, side) → n`.
Insights: `insightsFor({ athlete, gamelog, prop, statDef, league }) → [{ type, text, side, line, pct, k, n }]` con plantillas en español equivalentes a las de Outlier (racha seguida, k de los últimos n, local/visita, promedio); `teamInsights(gameDetail) → [...]` (ATS local/visita, como favorito/no favorito, over/under en los últimos 5).
Calculadoras (ver docs/spec-calculators.json): `roundRobin, prizepicksEv, bonusBetConversion, hedge, hold, vigCost, predictionMarket, halfPoint, spreadToMoneyline (normal CDF), poisson`, más `normCdf, poissonPmf/Cdf`.
En vivo (`public/live.js`, lo usan la vista y lib/espn.mjs): `progress`, `remaining` (lo que le falta: el promedio previo pesa como 1 partido frente al ritmo de hoy en un jugador, sin calibrar, y como 8 en el marcador, ver abajo), `liveOver`, `paceZ`, `strength` (temprana/moderada/fuerte), `scriptFor` (contexto: marcador, faltas), `propSignals`, `totalSignal` (contra la línea previa de Oddsy, nunca la de una casa), `stopOf`, `windowLeft` e `isActive` (pausas y cuenta regresiva estimada: ESPN publica cada jugada ~6 min tarde en la NFL, medido el 2026-10-18, así que solo el medio tiempo sigue activo cuando llega).
Backtest en vivo (`scripts/live-backtest.mjs` → `docs/accuracy.json` clave `live`): marcador al final del 1.º, 2.º y 3.er cuarto (linescores del scoreboard) de la NFL 2025 (271 partidos) y la NBA 2025-26 (1231), P(Más) de `remaining` + `liveOver` contra la línea previa de Oddsy sin fuga. Log-loss por peso del previo en el marcador (1/2/3/5/8): NFL 0.569/0.551/0.546/0.542/0.540 (8 le gana a 3 por 0.0059 ± 0.0023 y sigue bajando más allá: el ritmo del marcador casi no informa); NBA 0.492/0.489/0.488/0.488/0.489 (de 2 a 8, empate dentro del error). Por eso `PRIOR.total` = 8. Umbrales de `strength` sin cambio: `paceZ` del total se comporta como desvíos (desvío 0.88–0.95 por corte; |z| ≥ 1 sale en el 27–33 % de los cortes, cerca del 32 % de una normal) y el lado de la señal acierta más a mayor nivel contra la línea previa (NFL 81/93/94 %, NBA 91/95/98 % en temprana/moderada/fuerte). Pendiente: en la NFL el 1.er cuarto rinde menos que un cuarto del total (z medio −0.35 al 25 %), lo que infla las señales de Menos tempranas; y `PRIOR.player` no se pudo medir porque las jugadas de la NFL en el summary no traen atletas.

## Frontend
- `public/index.html` = solo el shell (header, nav lateral/inferior, `<main id="view">`, panel del boleto).
- `public/app.js` = router por hash, montaje de vistas, chips de liga, boleto. Rutas:
  `#/{league}/props`, `#/{league}/props/{propKey}` (detalle), `#/{league}/games`, `#/{league}/games/{gameId}`, `#/{league}/live`, `#/{league}/insights`, `#/{league}/popular`, `#/pro/ev`, `#/pro/arbitrage`, `#/pro/middles`, `#/pro/boosts`, `#/comparador` (actual), `#/calculadoras`. La ruta por defecto es `#/nba/props`.
- Contrato de una vista: `export default { title, render(el, ctx) }`, donde `ctx = { league, params: {id?}, query: URLSearchParams, api, store, ui, navigate(hash) }`; `render` puede ser async y devolver una función `cleanup`.
- `public/api.js` = `api.get(path, params)` con caché en sessionStorage de 60 s y errores legibles; `api.leagues()`, `api.games(league, date)`, `api.game(league, id)`, `api.gamelog(league, athleteId)`, `api.props(league, gameId?)`, `api.odds(sportKey)`, `api.injuries(league)`, `api.roster(league, team)`, `api.search(league, q)`.
- `public/store.js` = estado del usuario en localStorage, siempre dentro de try/catch: `picks` (boleto: [{ id, label, price, book, league, gameId, addedAt }]), `settings` ({ oddsFormat: 'american'|'decimal', books: key[], bankroll, kellyMult, devigMethod }), `views` (contador local por propKey para "Populares"), presets guardados por vista. API: `store.get(k)`, `store.set(k, v)`, `store.on(k, fn)`, `store.addPick(p)`, `store.removePick(id)`, `store.track(propKey, 'view'|'add')`.
- `public/ui.js` = helpers compartidos: `esc, h(strings...)` (template con escape), `fmtOdds(decimal)` (según settings.oddsFormat), `fmtPct(x, d)`, `when(iso)`, `hitBar(results: boolean[] | pct)` (10 segmentos), `bookChip(key|title)`, `teamLogo(team)`, `headshot(athlete)`, `dropdown({ label, options, value, multi, onChange })`, `toggle`, `tabs`, `sortableTable({ columns, rows, sortKey })`, `empty(msg)`, `loading()`, `errorBox(err)`, `sourceBadge(source)` (live/demo/espn), `barChart({ values, labels, line, colorFn })` (SVG inline accesible), `modal`.
- Estilos: `public/styles.css` = tokens y layout globales (se conserva la estética actual: fondo negro, degradado teal/mint/peach); cada vista tiene su propio `public/css/{vista}.css` y el shell los enlaza todos.
- Vistas en `public/views/`: `props.js` (lista + detalle), `games.js` (lista + detalle), `live.js` (En vivo), `insights.js`, `popular.js`, `ev.js`, `arbitrage.js`, `middles.js`, `boosts.js`, `odds.js` (el comparador actual), `calculators.js`.

## Reglas
- Sin dependencias npm ni CDN de JS. Escapar todo el texto externo (`esc`). Accesible: botones reales, aria-pressed/selected, labels. Responsive a 375 px.
- Etiquetar con honestidad lo que no tiene fuente gratis (apuestas del público, boosts de las casas, popularidad global): mostrar "no disponible" o usar la actividad local.
- Pie de página +18 / juego responsable (ya existe).
- Tests: `node --test` debe pasar; todo cálculo nuevo con su test; el servidor se prueba con fixtures grabados en `test/fixtures/` (nada de red en los tests).
