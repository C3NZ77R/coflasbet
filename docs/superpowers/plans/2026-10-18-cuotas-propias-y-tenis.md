# Cuotas propias + tenis ATP — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar las cuotas de The Odds API por cuotas propias (justa + Oddsy con 5% de margen) calculadas con modelos por deporte sobre datos de ESPN, y agregar tenis ATP (top 100) al estilo Outlier.

**Architecture:**
- Funciones puras de probabilidad (`lib/pricing.mjs`), reusando `normCdf`/`poissonPmf` de `public/betmath.js`.
- Ratings por equipo a partir de los calendarios ESPN de cada equipo (`lib/ratings.mjs`).
- Mercados por deporte (`lib/markets.mjs`).
- Elo + Markov para tenis (`lib/tennis.mjs`).
- `server.mjs` expone rutas nuevas y las vistas existentes las consumen. Se mantiene la forma `Prop.books[]` para no reescribir las vistas de props.

**Tech Stack:** Node ≥ 22.9 sin dependencias, ES modules, vanilla JS en el navegador, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-18-cuotas-propias-y-tenis-design.md`

## Global Constraints
- Sin dependencias nuevas ni paso de build. La UI va en español.
- Cuotas siempre en **decimal** internamente; la UI convierte con `fmtOdds`.
- `fair = 1/p`; `oddsy = 1/(p·1.05)`, es decir `MARGIN = 0.05`.
- Solo fuentes públicas de ESPN. Nunca la API de Outlier ni de casas. `ODDSY_ODDS_API_KEY` desaparece.
- Toda llamada externa pasa por `espn.fetchJson` (caché + timeout de 8 s). Todo error devuelve `{ error }` con un status HTTP.
- Tenis: solo singles masculino ATP (`grouping.slug === 'mens-singles'`); el ranking se recorta al top 100.
- Cada task termina con `npm test` en verde, commit y `git push origin main` (Vercel `oddsybet` despliega solo).
- En `vercel.json`, `includeFiles` debe cubrir todo lo que importe `lib/**` desde `public/`: `public/leagues.js`, `public/stats.js` y `public/betmath.js`.

## Review Focus
1. **Inicio de temporada** (un equipo con 0–3 partidos jugados): las cuotas deben salir finitas y moderadas, nunca `Infinity` ni `NaN`. Lo cubre el shrink a la media de liga (Task 2, test `ratings: equipo sin partidos = media de liga`).
2. **Jugador de tenis sin historial** (qualy, debutante): Elo inicial 1500, el mercado se muestra igual y la ficha dice "sin historial". Test en Task 8.
3. **Retiro / walkover en tenis** (sets incompletos en `linescores` o `notes` con "ret."/"w/o"): no cuenta para el Elo ni para las tasas de acierto de games. Test en Task 8.
4. **Prop con muestra corta** (< 8 partidos): no se genera la línea y la UI muestra "muestra insuficiente". Test en Task 6.
5. **Probabilidades extremas** (p < 0.01 o > 0.99): la cuota se acota a [1.01, 101] para no mostrar cosas como 1.00 o 5000. Test en Task 1.

---

### Task 1: Núcleo de precios

**Files:**
- Create: `lib/pricing.mjs`
- Test: `test/pricing.test.mjs`

**Interfaces:**
- Consumes: `normCdf(x)`, `poissonPmf(k, λ)` de `public/betmath.js`.
- Produces:
  - `MARGIN = 0.05`
  - `price(p) → { p, fair, oddsy }`: cuotas acotadas a [1.01, 101], con 2 decimales.
  - `halfLine(x) → number`: redondea a la línea .5 más cercana (`7.2 → 7.5`, `6.9 → 6.5`).
  - `negBinPmf(k, mean, variance) → number`: si `variance <= mean`, usa Poisson.
  - `scoreGrid(lh, la, { rho = -0.1, max = 10 }) → number[][]`: matriz Dixon-Coles normalizada para que sume 1.
  - `normalOver(mu, sigma, line) → number`: `P(X > line)` con corrección de continuidad de 0.5 cuando la línea es entera (en ese caso la `p` excluye el push).
  - `countOver(pmf, line) → number`: `pmf` es un array de probabilidades por k.

- [ ] **Step 1: Write the failing tests** en `test/pricing.test.mjs`:
  - `price(0.5)` → `{ fair: 2, oddsy: 1.9 }` (`1/(0.5·1.05) = 1.9047` → 1.9).
  - `price(0.999).fair === 1.01` y `price(0.001).fair === 101`.
  - `halfLine(7.2) === 7.5`, `halfLine(6.9) === 6.5`, `halfLine(7) === 7.5`.
  - La suma de `scoreGrid(1.4, 1.1)` difiere de 1 en menos de 1e-9.
  - Con ρ = 0, `scoreGrid(1.4, 1.1)[0][0]` es igual a `poissonPmf(0,1.4)·poissonPmf(0,1.1)` (normalizado); con ρ = −0.1, la celda 0-0 es mayor.
  - `normalOver(7, 13.5, 0)` está en 0.698 ± 0.002.
  - La suma de `negBinPmf` para k = 0..60 con media 5 y varianza 9 está en 1 ± 1e-6.
- [ ] **Step 2:** Run `node --test test/pricing.test.mjs`. Expected: FAIL ("Cannot find module").
- [ ] **Step 3:** Implementar las firmas de arriba. La corrección Dixon-Coles va en las celdas (0,0), (0,1), (1,0) y (1,1) con los factores `τ` del paper: `1−lh·la·ρ`, `1+lh·ρ`, `1+la·ρ`, `1−ρ`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `"Cuotas propias: núcleo de precios (Dixon-Coles, normal, binomial negativa)"` y push.

### Task 2: Ratings de equipos desde ESPN

**Files:**
- Create: `lib/ratings.mjs`
- Modify: `lib/espn.mjs` (agregar `getTeamSchedule`)
- Test: `test/ratings.test.mjs`, `test/fixtures/schedule-nba.json` (una respuesta real de `teams/18/schedule` recortada a 10 partidos)

**Interfaces:**
- Consumes: `fetchJson`, `TTL` y la lista de equipos de la liga (`/teams`) de `lib/espn.mjs`.
- Produces:
  - `espn.getTeamSchedule(league, teamId) → Result[]`, con `Result = { id, date, homeId, awayId, homeScore, awayScore }` y solo partidos terminados. Usa `site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{id}/schedule` con TTL de 6 h. Los rangos de fecha del scoreboard **no** funcionan en ligas de equipo (dan 400).
  - `getSeasonResults(league) → Result[]`: une los calendarios de todos los equipos y quita duplicados por `id`.
  - `ratingsFromResults(results, { asOf = Infinity, prior = 5 }) → { teams: Map<id,{ gf, ga, gp }>, avgHome, avgAway }`: solo usa partidos con `date < asOf`. Shrink: `gf = (sumaGF + prior·media)/(gp + prior)`.
  - `SPORT_MODEL = { soccer:'poisson', hockey:'poisson', baseball:'poisson', basketball:'normal', football:'normal' }`
  - `SIGMA = { football: 13.5, basketball: 12 }`: el de basketball es provisional; Task 3 lo reemplaza por el calibrado.
  - `expected(sport, ratings, homeId, awayId) → { kind:'poisson', lh, la } | { kind:'normal', mu, sigma, total, sigmaT }`
    - poisson: `lh = avgHome · (gf_h/avgGoals) · (ga_a/avgGoals)`, y `la` igual.
    - normal: `mu = (gf_h−ga_h) − (gf_a−ga_a)` dividido entre 2, más `HFA` (ventaja local derivada de `avgHome−avgAway`); `total = gf_h + ga_h + gf_a + ga_a` dividido entre 2; `sigmaT = SIGMA[sport]·1.1` (atajo: se calibra en Task 3).

- [ ] **Step 1:** Tests:
  - `ratings: equipo sin partidos = media de liga`: `expected` con un id desconocido da `lh ≈ avgHome` y `la ≈ avgAway`.
  - `asOf` excluye partidos futuros: con un resultado posterior a `asOf`, `gp` sale igual.
  - El fixture de calendario se normaliza a `Result[]` con 10 elementos y marcadores numéricos.
- [ ] **Step 2:** Run y ver FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test` PASS.
- [ ] **Step 5:** Commit y push.

### Task 3: Mercados por deporte + backtest

**Files:**
- Create: `lib/markets.mjs`, `scripts/backtest.mjs`, `docs/accuracy.json` (lo genera el script)
- Test: `test/markets.test.mjs`

**Interfaces:**
- Consumes: Task 1 (`price`, `scoreGrid`, `normalOver`, `halfLine`) y Task 2 (`expected`).
- Produces:
  - `Market = { key, label, selections: [{ name, line?, p, fair, oddsy }] }`. Las `p` de un mercado suman 1, salvo cuando hay push en líneas enteras.
  - `marketsFor(sport, model) → Market[]`:
    - poisson + fútbol: `1x2`, `dc` (doble oportunidad), `dnb`, `ou` en 0.5, 1.5, 2.5, 3.5 y 4.5, `btts`, `ah` (hándicap asiático −1.5, −0.5, +0.5 y +1.5 del local) y `cs` (los 10 marcadores más probables), todos desde `scoreGrid`.
    - poisson + hockey/béisbol: `ml` (sin empate; el empate se reparte según `lh/(lh+la)`), `rl` ±1.5 y `ou` en `halfLine(lh+la)`.
    - normal: `ml`, `spread` en `halfLine(-mu)` para el local y `ou` en `halfLine(total)`.
  - `scripts/backtest.mjs [liga…]`: para cada partido de la temporada pasada calcula `ratingsFromResults(results, { asOf: fecha })`, saca la `p` del ganador y calcula Brier y log-loss. Para basketball prueba σ de 9 a 16 y se queda con el de menor log-loss. Escribe `docs/accuracy.json` con la forma `{ [league]: { n, brier, logloss, baseline: { brier }, sigma? } }`, donde el baseline es "siempre gana el local con la tasa histórica de local".
- [ ] **Step 1:** Tests:
  - `1x2` suma 1 ± 1e-9.
  - `btts.Sí` con `lh = la = 0` es 0.
  - Con mu = 0 y línea 0, el ml normal da 0.5.
  - El ml de hockey no tiene selección "Empate".
  - Cada `selection` trae `fair` y `oddsy`, y `oddsy < fair`.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** Run `node --env-file-if-exists=.env scripts/backtest.mjs nba nfl epl laliga nhl mlb`. Expected: `docs/accuracy.json` existe y cada liga tiene un `brier` menor que su `baseline.brier`. Si una liga no lo cumple, se anota en el JSON (`"publish": false`) y la UI esconde sus cuotas.
- [ ] **Step 6:** Copiar el σ calibrado de basketball a `SIGMA` en `lib/ratings.mjs`. Commit y push.

### Task 4: Quitar The Odds API y servir mercados propios

**Files:**
- Modify: `server.mjs`, `lib/props.mjs` (solo cortar la parte de Odds API), `public/leagues.js`, `public/api.js`, `.env.example`, `vercel.json`, `docs/architecture.md`
- Delete: `demo-odds.json`, `demo-props.json`, `test/fixtures/oddsapi-event-props.json` y los tests que lo usan
- Test: `test/server.test.mjs` (nuevo: llama a `handler` con un `req`/`res` falso)

**Interfaces:**
- Produces (HTTP):
  - `GET /api/markets?league=&game=` → `{ source:'oddsy', data: { gameId, model, markets: Market[], accuracy } }`
  - `GET /api/accuracy` → contenido de `docs/accuracy.json`
  - Se borran `/api/sports` y `/api/odds`.
  - `api.js` pierde `sports` y `odds`, y gana `markets(league, gameId)` y `accuracy()`.
  - `LEAGUES` pierde el campo `odds`.
  - `EDGE_S` pasa a `{ '/api/markets': 1800, '/api/props': 1800, '/api/accuracy': 86400 }`.
- [ ] **Step 1:** Tests:
  - `GET /api/odds` → 404.
  - `GET /api/markets?league=xx` → 400.
  - `GET /api/markets?league=nba&game=1` con `fetchJson` simulado (fixtures de Task 2) → 200 con `markets.length > 0`.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** Run `grep -rn "the-odds-api\|ODDSY_ODDS\|demo-odds\|demo-props" --exclude-dir=docs .`. Expected: sin resultados.
- [ ] **Step 6:** Commit y push.

### Task 5: Vistas de partidos y cuotas con modelo propio; Compara tu casa

**Files:**
- Modify: `public/views/games.js` (reemplazar `matchEvent`, `bookRows`, `marketSummary` y `fairOf` por el render de `Market[]`), `public/views/odds.js`, `public/views/ev.js`, `public/views/boosts.js`, `public/betmath.js` (quitar `arbitrage`, `arbStakes`, `findMiddles`, `analyzeEvent` y `fairFromBooks` si ya nadie los importa), `public/app.js` y `public/index.html` (quitar las pestañas de arbitraje y middles)
- Delete: `public/views/arbitrage.js`, `public/views/middles.js`
- Test: `test/ui.test.mjs` (actualizar), `test/betmath.test.mjs` (quitar los tests de las funciones borradas)

**Interfaces:**
- Consumes: `api.markets`, `api.accuracy`, `price` y la forma `Market`.
- Produces:
  - En la tarjeta de cada partido: por selección, "Justa X · Oddsy Y" y la probabilidad.
  - Debajo, "Precisión del modelo: Brier Z en N partidos".
  - Si `accuracy[league].publish === false`: "Cuotas no publicadas: el modelo aún no supera la referencia".
  - **Compara tu casa** (`ev.js`): al elegir una selección aparece un campo "Cuota de tu casa". Muestra `EV = p·cuota − 1` (`betmath.expectedValue`), Kelly (`betmath.kelly`) y una etiqueta: verde si EV > 0.
  - **Boosts:** la cuota boosteada que entra el usuario se compara contra la `p` del modelo. `evaluateBoost` usa `p` del modelo en vez de `legProb` desvigado.
- [ ] **Step 1:** Tests de UI:
  - El render de un `Market` de fixture contiene "Justa" y "Oddsy".
  - `compareBook(p=0.5, odds=2.2)` → EV 0.10.
  - `compareBook(p=0.5, odds=1.8)` → EV −0.10.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** Abrir la preview y recorrer Partidos (NBA, LaLiga, Liga BetPlay) → detalle de un partido → EV con una cuota escrita. `read_console_messages` sin errores. Captura de pantalla.
- [ ] **Step 6:** Commit y push.

### Task 6: Props con línea propia

**Files:**
- Modify: `lib/props.mjs` (reescribir `getProps`), `public/views/props.js`, `public/views/popular.js`, `public/views/insights.js` (solo donde lean `books`)
- Test: `test/props.test.mjs` (reescribir)

**Interfaces:**
- Consumes: `getRoster`, `getGamelog`, `getGame` de `lib/espn.mjs`, `STATS`/`statOf` de `public/stats.js` y `price`, `halfLine`, `negBinPmf`, `normalOver` y `countOver` de Task 1.
- Produces:
  - `propLine(values: number[], kind: 'count'|'normal') → { line, mean, pOver } | null`: devuelve `null` si `values.length < 8`. `mean = 0.5·media(últimos 10) + 0.3·media(todos) + 0.2·media(últimos 5)`; `line = halfLine(mediana)`.
  - `kind` sale de un campo nuevo `dist` en cada stat de `STATS` (`'count'` por defecto; `'normal'` para pts, pra, pass_yds, rush_yds y rec_yds).
  - `getProps(league, gameId) → { source:'oddsy', data: Prop[] }`: por equipo, los 8 jugadores con más minutos promedio en el gamelog. Un `Prop` por jugador × stat × lado, con `books: [{ key:'oddsy', title:'Oddsy', price: oddsy }]` y además `p` y `fair`. Sin `gameId` → `[]`, porque el costo serían 16 gamelogs por partido.
- [ ] **Step 1:** Tests:
  - `propLine([...7 valores])` → `null`.
  - Con 20 valores iguales a 10, `line = 10.5` y `pOver` menor que 0.5.
  - Con `dist: 'normal'` se usa `normalOver`.
  - `getProps` sobre fixtures (`roster-nba.json`, `gamelog-nba.json`) devuelve props con `books[0].key === 'oddsy'`.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** En `props.js`, cuando no hay línea, mostrar "Muestra insuficiente (menos de 8 partidos)". Verificar en la preview. Commit y push.

### Task 7: Tenis — datos

**Files:**
- Create: `lib/tennis.mjs`
- Test: `test/tennis.test.mjs`, `test/fixtures/atp-month.json` (un `scoreboard?dates=YYYYMMDD-YYYYMMDD` real recortado a ~30 partidos, con al menos un retiro), `test/fixtures/atp-rankings.json` (recortado a 5)

**Interfaces:**
- Consumes: `fetchJson`, `TTL`.
- Produces:
  - `Match = { id, date, tournament, surface: 'hard'|'clay'|'grass', round, bestOf: 3|5, state, a: Player, b: Player, winner: 'a'|'b'|null, sets: [[ga, gb, tbA?, tbB?]], retired: boolean }`
  - `Player = { id, name, short, country, flag }`
  - `SURFACE`: mapa por palabras clave del nombre del torneo. Arcilla: Roland Garros/French, Monte, Madrid, Rome/Italian, Barcelona, Hamburg, Munich, Geneva, Lyon, Estoril, Buenos Aires, Rio, Santiago, Bastad, Gstaad, Kitzbuhel, Umag, Houston, Marrakech, Bucharest. Césped: Wimbledon, Halle, Queen, 's-Hertogenbosch, Stuttgart, Mallorca, Eastbourne, Newport. El resto es dura. (Atajo: la superficie no viene en ESPN; se actualiza si aparece una fuente.)
  - `bestOf = 5` si `event.major` es true.
  - `retired = true` si un `note.text` contiene `ret.` o `w/o`, o si el último set no está completo.
  - `getMonth(yyyymm) → Match[]`: `.../tennis/atp/scoreboard?dates=YYYYMM01-YYYYMMDD`. TTL de 24 h para meses pasados y `TTL.board` para el mes actual.
  - `getHistory(months = 24) → Match[]`: ordenados por fecha y solo terminados.
  - `getRankings() → [{ rank, prev, points, player: Player }]` (top 100).
  - `getToday(date) → Match[]`
  - `getPlayer(id) → { player, rank, matches: Match[] }`: partidos de `getHistory` filtrados por jugador, del más reciente al más antiguo.
- [ ] **Step 1:** Tests:
  - El fixture se normaliza solo a singles masculino.
  - El partido con retiro tiene `retired: true`.
  - `SURFACE('Mutua Madrid Open') === 'clay'` y `SURFACE('Rolex Shanghai Masters') === 'hard'`.
  - Los rankings se recortan a ≤ 100 y vienen ordenados.
- [ ] **Step 2–4:** FAIL → implementar → PASS. Commit y push.

### Task 8: Tenis — Elo, Markov y mercados

**Files:**
- Modify: `lib/tennis.mjs`, `lib/markets.mjs`, `scripts/backtest.mjs` (agregar `atp`)
- Test: `test/tennis.test.mjs`

**Interfaces:**
- Consumes: Task 7 (`Match`, `getHistory`) y Task 1 (`price`, `halfLine`).
- Produces:
  - `eloFrom(matches, { asOf = Infinity }) → Map<playerId, { all, hard, clay, grass, n }>`: inicial 1500, `K = 250/(n+5)^0.4`. Excluye partidos con `retired`.
  - `matchProb(elo, aId, bId, surface) → number`: usa `rating = 0.5·all + 0.5·surface`.
  - `serveFromMatchProb(p, bestOf) → { sa, sb }`: busca por bisección un `d` tal que `sa = 0.64 + d` y `sb = 0.64 − d` reproduzcan `p`.
  - `matchDist(sa, sb, bestOf) → { pA, sets: { '2-0', '2-1', '1-2', '0-2' } | { '3-0', … }, games: number[] }`: `games[k]` es la probabilidad de que el partido tenga k games en total. Markov con game (deuce cerrado), set a 6 con tiebreak a 7 en 6-6 y alternancia de saque.
  - `marketsFor('tennis', { kind:'tennis', dist })`: `ml`, `sets` (resultado exacto), `ou_sets` 2.5 (o 3.5/4.5 a 5 sets), `ou_games` en `halfLine(media)`, `games_hcp` en `halfLine(-margen medio)`, `win_set` (cada jugador gana al menos un set) y `first_set`.
  - Backtest `atp`: matches de 2026, `asOf` en la fecha de cada partido; baseline "gana el mejor rankeado".
- [ ] **Step 1:** Tests:
  - `matchDist(0.64, 0.64, 3).pA` es 0.5 ± 1e-9.
  - `matchDist(0.70, 0.60, 3).pA` es mayor que 0.5.
  - La suma de `games` es 1 ± 1e-9.
  - El mínimo de games con `games[k] > 0` es 12 (6-0 6-0).
  - `serveFromMatchProb(0.75, 3)` → `matchDist(sa, sb, 3).pA` en 0.75 ± 1e-4.
  - Un jugador sin historial tiene Elo 1500.
  - Un partido con `retired` no cambia el Elo.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** `node scripts/backtest.mjs atp`. Expected: `docs/accuracy.json.atp.brier < baseline.brier`. Commit y push.

### Task 9: Tenis — liga, rutas y vistas estilo Outlier

**Files:**
- Modify: `public/leagues.js` (agregar `{ id:'atp', title:'ATP', sport:'tennis', espn:'atp' }`), `public/stats.js` (`tennis: [{ key:'games_won', … }, { key:'sets_won' }, { key:'total_games' }]`), `server.mjs`, `public/api.js`, `public/app.js`, `public/views/games.js` (rama de tenis: jugadores con bandera en vez de logos)
- Create: `public/views/tennis-player.js`, `public/views/tennis-rankings.js`
- Test: `test/server.test.mjs`, `test/ui.test.mjs`

**Interfaces:**
- Consumes: Task 7 y Task 8.
- Produces:
  - Rutas:
    - `GET /api/games?league=atp&date=` → `Match[]`, con la misma forma que `Game` (`home = a`, `away = b`) para reusar la lista.
    - `GET /api/markets?league=atp&game=`
    - `GET /api/tennis/rankings`
    - `GET /api/tennis/player?id=`
  - Rutas hash: `#/tennis-rankings` y `#/tennis-player/{id}`.
  - Ficha de jugador:
    - Encabezado con rank, puntos y Elo general y por superficie.
    - Tabla de últimos partidos: rival, torneo, superficie, marcador, games totales y sets.
    - `hitBar` de "más de X games" para L5/L10/L20, con X elegible.
    - Filtro por superficie.
  - Ranking: `sortableTable` con rank, jugador, puntos, tendencia y Elo; al hacer clic abre la ficha.
- [ ] **Step 1:** Tests:
  - `GET /api/tennis/rankings` (fixtures) → 200 y `data.length ≤ 100`.
  - `GET /api/tennis/player?id=abc` → 400.
  - El render de la ficha con fixture contiene "Elo" y el nombre del jugador.
- [ ] **Step 2–4:** FAIL → implementar → PASS.
- [ ] **Step 5:** Preview con el recorrido ATP → partido de hoy → mercados → jugador → ranking. Consola sin errores y capturas en escritorio y móvil (`resize_window` mobile).
- [ ] **Step 6:** Commit y push. Con el MCP de Vercel, confirmar que el deploy de `oddsybet` quedó `READY` y abrir `/api/tennis/rankings` en producción.
