# Cuotas propias (modelo Oddsy) + tenis ATP — diseño y plan

Fecha: 2026-10-18. Estado: **aprobado** (decisiones abajo).

## Intención
1. **Quitar las cuotas de casas** (The Odds API, `ODDSY_ODDS_API_KEY`, `demo-odds.json`, `demo-props.json`). Oddsy deja de mostrar precios ajenos.
2. **Calcular nuestras propias cuotas** para cada mercado, a partir de datos reales de ESPN y de un modelo por deporte. Cada cuota sale de una probabilidad: `cuota justa = 1 / p`.
3. **Agregar tenis ATP** (Outlier no lo tiene; es un servicio nuevo nuestro) con el estilo de Outlier: partidos, ficha de jugador con historial y tasas de acierto, ranking top 100 y cuotas propias.

No-objetivos: llamar a APIs privadas (Outlier, casas); WTA y dobles (después); props de saque en tenis (ESPN no publica aces ni dobles faltas; lo verifiqué con REA y con la API, ver abajo).
Anti-objetivo: mostrar cuotas que parezcan precisas sin decir qué tan bien acierta el modelo. Cada deporte enseña su precisión medida en partidos pasados.

## Datos reales disponibles (verificado hoy)
| Necesidad | Fuente (sin clave) | Nota |
|---|---|---|
| Partidos, marcadores y estadísticas de equipo | ESPN `site.api.espn.com/.../scoreboard`, `summary`, `teams/{id}/statistics` | ya en `lib/espn.mjs` |
| Game logs de jugadores (props) | ESPN `athletes/{id}/gamelog` | ya en `lib/espn.mjs` |
| **Tenis: todos los partidos ATP con sets y games** | `site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=YYYYMMDD-YYYYMMDD` | 1 request por mes. Agosto de 2026: 6 torneos, 628 partidos de singles. `linescores` trae games y tiebreak por set. |
| **Tenis: ranking ATP** | `.../tennis/atp/rankings` | 150 jugadores con puntos y tendencia; nos quedamos con el top 100 |
| Tenis: ficha e historial de un jugador | `site.web.api.espn.com/apis/common/v3/sports/tennis/atp/athletes/{id}`, `sports.core.api.espn.com/v2/sports/tennis/leagues/atp/athletes/{id}/eventlog` | Sinner tiene 55 partidos en 2026 |
| Tenis: aces, dobles faltas, % de saque | **no hay** | `competitors/{id}/statistics` da 404. La página del partido en espn.com, capturada con REA, no carga ninguna API de estadísticas. |
| Tenis: superficie | **no viene** | Mapa fijo nombre de torneo → superficie en `lib/tennis.mjs`. Torneo desconocido = dura. |

## Cómo se ponen cuotas, deporte por deporte (investigación)
La regla común es estimar la distribución del resultado, sumar la probabilidad de cada mercado y luego `cuota = 1/p`. Si hay margen: `1/(p·(1+m))`.

### Fútbol (LaLiga, Premier, Champions, Libertadores, Liga BetPlay)
- **Modelo:** Poisson bivariado con la corrección **Dixon-Coles**, que ajusta los marcadores 0-0, 1-0, 0-1 y 1-1 con un parámetro ρ y le da más peso a los partidos recientes ([Dixon-Coles, repositorio Salford](https://salford-repository.worktribe.com/OutputFile/1493215); [penaltyblog](https://penaltyblog.readthedocs.io/en/latest/models/overview.html)).
- **Goles esperados:** `λ_local = media_liga_local × ataque_local × defensa_visita`, y `λ_visita` igual. Ataque y defensa salen de goles a favor y en contra de la temporada en ESPN.
- **Mercados desde la matriz de marcadores (0..10 × 0..10):** 1X2, doble oportunidad, más/menos 0.5–4.5, ambos marcan ([BTTS en R-bloggers](https://www.r-bloggers.com/2022/02/calculating-the-probability-for-both-teams-to-score-in-r/)), hándicap asiático, marcador exacto y empate no válido.
- Bonus: Liga BetPlay **gana cuotas**; antes no tenía porque The Odds API no la cubre.

### Básquet (NBA, WNBA, NCAAB) y fútbol americano (NFL, NCAAF)
- **Modelo:** margen ~ Normal(μ, σ) y total ~ Normal(μ_T, σ_T).
- `μ = (rating_neto_local − rating_neto_visita) + ventaja_local`. El rating neto son los puntos a favor menos en contra por partido, ajustados por rival.
- **NFL:** σ ≈ 13.5 puntos ([Stern, actualizado](https://arxiv.org/pdf/2212.08116); [FiveThirtyEight](https://fivethirtyeight.com/features/how-unexpected-was-clevelands-shellacking-of-cincinnati)). Va con corrección de medio punto ([PFR](https://www.pro-football-reference.com/about/win_prob.htm)). Los números clave 3 y 7 pasan más seguido de lo que dice la normal ([nfelo](https://www.nfeloapp.com/analysis/margin-probabilities-from-nfl-spreads/)); se ajusta en una segunda versión.
- **NBA / WNBA / NCAAB:** σ **por calibrar** con nuestro backtest. No encontré una fuente confiable para el valor de ~12 que se suele citar.
- **Mercados:** ganador, spread (línea propia = μ redondeado a .5), total (línea = μ_T), totales por equipo.

### Hockey (NHL) y béisbol (MLB)
- **Modelo:** Poisson de goles/carreras por equipo, con ataque × defensa como en fútbol pero sin Dixon-Coles.
- **NHL:** si empatan en tiempo regular, la prórroga se reparte 50/50 ajustado por rating. Mercados: moneyline, puck line ±1.5, total.
- **MLB:** Poisson de carreras; en la versión 2 se ajusta por el lanzador abridor (ERA/FIP del gamelog). Mercados: moneyline, run line ±1.5, total.

### Tenis ATP (nuevo)
1. **Elo por superficie** con todos los partidos ATP de los últimos 24 meses (24 requests mensuales cacheadas). K variable `K = 250/(partidos+5)^0.4`, al estilo FiveThirtyEight. El rating de cada partido mezcla 50/50 el Elo general y el de la superficie.
2. **Probabilidad del partido:** `p = 1/(1+10^((Elo_B−Elo_A)/400))`.
3. **Modelo de Markov jerárquico** punto → game → set → partido ([Klaassen & Magnus; Barnett & Clarke; Kovalchik & Reid](https://journals.sagepub.com/doi/10.3233/JSA-200345)). Se busca la probabilidad de ganar un punto con el saque de cada jugador que reproduce la `p` del Elo, siguiendo el método de Kovalchik & Reid. Para la media de puntos de saque del circuito se usa el valor fijo 0.64 (atajo documentado). Con eso, el modelo da la distribución completa del partido.
4. **Mercados:** ganador, apuesta de sets (2-0, 2-1, 0-2, 1-2; en Grand Slam, a 5 sets), total de sets, total de games (más/menos), hándicap de games, gana al menos un set y ganador del 1.er set.
5. **Validación:** Brier y log-loss en los partidos de 2026, comparados con la regla simple de que gana el mejor rankeado. Si no la supera, no se publica.

### Props de jugador (todos los deportes de equipo)
- **Modelo:** el game log de ESPN da una distribución por jugador y estadística.
  - Conteos (rebotes, asistencias, tiros, goles, ponches): **Poisson**; si la varianza supera a la media, **binomial negativa**.
  - Volúmenes altos (puntos, yardas): **Normal**.
- Media = 0.5·últimos 10 + 0.3·todo el log (temporada actual y anterior) + 0.2·últimos 5; la varianza también sale de todo el log. Línea propia = mediana redondeada a .5. Cuotas más/menos de esa línea y de cualquier línea que elija el usuario.
- Mínimo 8 partidos; con menos se muestra "muestra insuficiente".
- Las tasas de acierto (L5/L10/L20/temporada/H2H) de la vista `props.js` **no cambian**; solo cambia de dónde sale la línea.
- **Tenis**, "props" posibles con datos reales: games ganados por el jugador, sets ganados y tasas de acierto de total de games en sus últimos partidos.

### Margen
Mostramos la **cuota justa** (sin margen) y, al lado, la **cuota Oddsy** con margen del 5%.

## Arquitectura (cambios)
- **Nuevo `lib/pricing.mjs`:** funciones puras para normal CDF, Poisson pmf, binomial negativa, matriz Dixon-Coles, `fairOdds(p)`, `withMargin(p, m)` y redondeo de líneas. Sin dependencias.
- **Nuevo `lib/ratings.mjs`:** ratings por equipo desde el calendario de cada equipo en ESPN (`teams/{id}/schedule`; los rangos de fecha del scoreboard dan 400 en ligas de equipo) (ataque/defensa o rating neto, y ventaja local por liga). Caché de 6 h.
- **Nuevo `lib/tennis.mjs`:** scoreboard mensual ATP → partidos normalizados; mapa de superficies; Elo; Markov; ranking top 100; historial por jugador.
- **Nuevo `lib/markets.mjs`:** `marketsFor(league, game) → [{ market, label, selections: [{ name, line?, p, fair, odds }] }]`.
- **`server.mjs`:**
  - Se quitan `oddsApi`, `KEY`, `/api/sports`, `/api/odds`, los fallbacks demo y `EDGE_S` de odds.
  - Se agregan `GET /api/markets?league=&game=`, `GET /api/props` (ahora con modelo propio, sin casas), `GET /api/tennis/rankings`, `GET /api/tennis/player?id=` y `GET /api/accuracy?league=` (resultado del backtest).
- **`public/leagues.js`:** se quita el campo `odds`; se agrega `{ id:'atp', title:'ATP', sport:'tennis', espn:'atp' }`.
- **`public/stats.js`:** `tennis: [games_won, sets_won, total_games, aces?]`; `aces` queda fuera porque no hay datos.
- **Vistas:**
  - `games.js` y `odds.js` muestran nuestros mercados.
  - `props.js` usa líneas propias.
  - Vistas nuevas: `tennis-player` (estilo ficha de Outlier) y `tennis-rankings` (top 100).
  - `ev.js`, `boosts.js`, `arbitrage.js` y `middles.js`: pendientes de tu decisión (ver Decisiones).
- **`api/[...path].mjs`, `vercel.json`:** revisar TTL de la CDN para las rutas nuevas.
- Se borran `demo-odds.json` y `demo-props.json`, y la variable `ODDSY_ODDS_API_KEY` de `.env.example`.

## Plan de implementación por fases
Cada fase termina con `node --test` en verde y push a `main`, que despliega en Vercel.

| # | Fase | Archivos | Listo cuando |
|---|---|---|---|
| 0 | Quitar The Odds API | `server.mjs`, `.env.example`, `demo-*.json`, `leagues.js`, `api.js`, vistas que llaman `/api/odds` | la app carga sin clave y sin errores; las vistas de cuotas muestran "calculando modelo" |
| 1 | Núcleo matemático | `lib/pricing.mjs` + `test/pricing.test.mjs` | tests: Φ(7/13.5)≈0.698; la matriz Dixon-Coles suma 1; con `p=0.5` la cuota es 2.00 |
| 2 | Ratings de equipos + backtest | `lib/ratings.mjs`, `scripts/backtest.mjs`, `test/ratings.test.mjs` (fixtures ESPN) | Brier por liga en la temporada pasada, guardado en `docs/accuracy.json` |
| 3 | Mercados por deporte en la UI | `lib/markets.mjs`, `server.mjs`, `games.js`, `odds.js` | cada partido de las 12 ligas muestra ganador, spread o hándicap y total con cuota propia |
| 4 | Props propios | `lib/props.mjs`, `props.js`, `popular.js`, `insights.js` | la línea propia y las cuotas más/menos aparecen junto a las tasas de acierto |
| 5 | Tenis: datos | `lib/tennis.mjs`, `test/tennis.test.mjs` con fixture `aug.json` recortado | ranking top 100, partidos del día y ficha de jugador con datos reales |
| 6 | Tenis: Elo + Markov + mercados | `lib/tennis.mjs`, `lib/markets.mjs`, test de Markov (p de saque 0.64 contra 0.64 → partido 50%) | el backtest de 2026 le gana a "gana el mejor rankeado" |
| 7 | Tenis: vistas estilo Outlier | `views/games.js`, nuevas `tennis-player.js` y `tennis-rankings.js`, `app.js` | se puede navegar ATP → partido → jugador → historial con tasas de acierto de games y sets |
| 8 | Compara tu casa + limpieza | borrar `arbitrage.js` y `middles.js`; `ev.js` y `boosts.js` reciben la cuota del usuario | EV calculado contra la cuota justa; no quedan referencias a arbitraje ni middles |

## Decisiones tomadas (por ti, 2026-10-18)
1. **Se borran arbitraje y middles** (`arbitrage.js`, `middles.js` y su lógica en `betmath.js`).
2. **EV+ y boosts pasan a "Compara tu casa":** el usuario escribe la cuota de su casa y le mostramos el EV contra nuestra cuota justa. En boosts, la cuota es la que ya trae el boost.
3. **Cada mercado muestra dos cuotas:** la **justa** (`1/p`) y la **cuota Oddsy** con margen del 5% (`1/(p·1.05)`).

## Decisiones que tomé yo (revísalas)
- Superficie de tenis por mapa fijo de torneos (atajo: ESPN no la da; se reemplaza si encontramos una fuente).
- Media del circuito de 0.64 puntos ganados con el saque (atajo; se calibra con el backtest).
- σ de NBA, NCAAB y WNBA calibrado con nuestro backtest, no tomado de internet.
- Solo singles masculino ATP. El top 100 sale del ranking; el Elo usa todos los partidos ATP para que los rivales fuera del top 100 también tengan rating.
