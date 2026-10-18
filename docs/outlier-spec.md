# Outlier — especificación funcional (para reimplementar desde cero)

Fuentes: recorrido en vivo de app.outlier.bet con la sesión del usuario (prueba Pro) el 2026-10-18, y el inventario de rutas del bundle público obtenido con REA (`analyze-web-bundle`). Solo describe el comportamiento; no se copia código ni se usan datos ni la API privada de Outlier (robots.txt bloquea /api/).

Rutas del bundle: `/:leagueId` → props, games, games/:gameId, insights, trending, picks/:pickId; `/pro` → ev, boosts, arbitrage, middle-bets; además login, onboarding, upgrade.
Ligas: NBA, NFL, MLB, NCAAFB, WNBA, Soccer, NHL, NCAAMB.

## Global
- Barra lateral de íconos: Insights, Populares (picks), Partidos, Props; Pro: EV+, Boosts, Arbitraje, Middles. Abajo, el bloque de casas seleccionadas.
- Chips de liga en cada página de liga.
- Panel "My Picks" a la derecha = boleto agrupado por casa (FanDuel, DraftKings, PrizePicks, Fanatics, BetMGM, Novig, ProphetX, Caesars, Underdog…), contadores "0/0", botón Compartir. Un botón flotante de ticket lo abre.
- Barra de acierto = 10 segmentos, verde (acierto) / rojo (fallo), para los últimos N partidos + etiqueta %. Logo de la casa junto a la mejor cuota. Cuotas americanas por defecto.

## Populares (/:league/trending/picks)
- Pestañas: Más investigados | Más agregados. Tarjeta: avatar del jugador + insignia del equipo, "VIS @ LOC · día hora", "Jugador - Estadística Over/Under línea", barra de acierto (% L10), mejor cuota + casa, "N investigando · M agregados". (Outlier usa la actividad de sus usuarios; nosotros solo podemos contar las vistas/agregados de nuestros propios usuarios.)

## Props (/:league/props)
- Barra: Filtros, Guardados, Propositions (tipos de estadística), Jugadores, Partidos, Over/Under, interruptor Solo EV+, Cuotas (rango), Acierto (mínimo), Matchup del rival (favorable/neutral/desfavorable), interruptor Mostrar líneas alternativas, contador "3346/15779 Props".
- Columnas: [+ agregar] Proposition (jugador, equipo, VIS @ LOC, "Over 1.5 1Q Assists"), Line, Odds (mejor cuota por casa, puede haber varias), IP (probabilidad implícita de la mejor cuota), Opp Rank ("25th NOP": ranking de la defensa del rival en esa estadística, con color), % de acierto L5, L10, L20, H2H, 2026 (temporada actual), 2025 (temporada anterior). Orden por defecto: L10 descendente. Intensidad del verde según el %.
- Detalle del prop (clic en la fila):
  - Cabecera: partido, jugador, posición, mercado; selector de lado Over/Under con cuotas; menú de LÍNEAS ALTERNATIVAS; botón para agregar al boleto con la mejor cuota y el menú de casas.
  - Pestañas de estadística (NBA): AST PTS 1Q-PTS FGM FGA 1Q-AST PTS+AST 3PTM 3PTA BLK STL STL+BLK REB 1Q-REB PTS+REB REB+AST PTS+REB+AST DD2 TD3 TO.
  - Ventana: menú local/visita, L5 L10 L20 H2H 2026 2025. Panel de filtros del gráfico: solo visita/local, días de descanso, partidos con un compañero / sin un compañero, margen (0-20) + G/P, minutos por partido.
  - Resumen: "Últimos 10: 100% (10 de 10)" + % de las demás ventanas; promedio y mediana.
  - Gráfico de barras: una barra por partido (fecha + "@ MIL"/"vs TOR"), valor encima, línea discontinua en la línea del prop, verde si supera la línea y rojo si no.
  - Estadísticas de apoyo: gráfico de minutos (promedio/mediana).
  - Lista de insights, p. ej. "X superó 1.5 asistencias en el 1er cuarto en 12 partidos seguidos (promedio 2.8)".
  - Panel derecho con pestañas Matchup | Lineup | Insights:
    - Matchup: "Defensa clave de DET en asistencias", total / vs PG/SG/SF/PF/C: estadística permitida (promedio + ranking), leyenda favorable/neutral/desfavorable. Rankings del equipo en la temporada, ataque vs defensa (eFG%, TOV%, ORB%, tasa de tiros libres, puntos, FG%, 2P%, 3P%, FT%, rebotes, tapas, robos, AST/TO, ritmo, puntos en la pintura, contraataque, segunda oportunidad, TS%), promedio + ranking de cada lado. Récords de ambos equipos: total, local, visita, conferencia, división, contra cada división y por periodo (1Q, 2Q, 1H, 3Q, 4Q, 2H). Apuestas del público: % de apuestas y % del dinero en ML / hándicap / total.
    - Lineup: alineaciones titulares esperadas de ambos equipos y lesiones por equipo (jugador, posición, motivo, estado Out/Questionable, "hace 44 minutos").

## Partidos (/:league/games)
- Franja de fechas. Tarjeta de partido: hora, equipos + récords, mejores cuotas de moneyline / hándicap / total con logo de la casa, mini barras de acierto por lado (tendencia del equipo), etiqueta "EV+" cuando una línea tiene valor, expansor "APUESTAS DEL PÚBLICO", enlace "DETALLES DEL PARTIDO".
- Detalle del partido: cabecera con equipos, récords y hora; pestañas Líneas | Props de jugador | Props de equipo | Props del partido, búsqueda. Líneas: moneyline, hándicap y total con la mejor cuota y barras de acierto del equipo (% L10 de cada lado), más hándicap alternativo, resultado (sin prórroga), doble resultado, margen de victoria y total alternativo. Panel derecho igual que en el detalle del prop.

## Insights (/:league/trending/insights)
- Filtros: Tipo de insight, Partidos, Jugadores, Equipos, Cuotas, Propositions, Acierto, Splits, Over/Under, Orden; contador "1134/1134 Insights".
- Tarjeta: entidad (equipo, o jugador + equipo), partido, hora; la frase; fila del resultado "Under 229.5 Points" + barra de acierto % + mejor cuota/casa.
- Plantillas vistas (en inglés):
  - "{P} has exceeded {line} {stat} in {n} straight games[ at home|on the road] ({avg} {stat}/game average)."
  - "{P} has failed to exceed {line} {stat} in {k} of his last {n} games[ at home] ({avg} ...)."
  - "The under hit in {k} of the {Team} last {n} games vs. bottom 10 scoring defenses"
  - "The {Team} are {w}-{l} ({pct}%) against the spread in their last {n} games at home"
  - "The {Team} are {w}-{l} ({pct}%) in their last {n} games as an underdog"

## EV+ (/pro/ev)
- Fila de preajustes guardados: NBA Player Props, MLB Player Props, NFL Player Props, Pinnacle, Outlier Odds, Sharp Gamelines.
- Filtros: Casa para devig (tabla de casas con casillas OBLIGATORIA / OPCIONAL; parámetros reqBooks, optBooks, weights p. ej. 100,25,25,25,25, minBooks), Ancho "hasta 40" (ancho máximo del mercado en centavos americanos), Variación "hasta 3%" (desacuerdo máximo entre las casas de devig), Método de devig: Multiplicativo (por defecto), Aditivo, Shin, Power, Probit; Multiplicador de Kelly (completo/medio/cuarto…), EV % mínimo (1%), Kelly % mínimo, Vig %, rango de cuotas (-300 a +200), tipo de apuesta (props / líneas de partido), ventana de tiempo (próximas 24 h), ligas, límites del mercado.
- Columnas: EV% y pick / hora de inicio (contador 351/711), cuota (logo de la casa + precio) · FV, el valor justo en americano (vig %), Kelly %, ancho, variación, acciones. Orden por EV descendente.

## Arbitraje (/pro/arbitrage)
- Filtros, Guardados, Arbitraje % mínimo. Tarjeta por partido: equipos, hora, ícono de la liga; cada arbitraje con "Arbitraje 1.79%", el mercado, las dos patas (lado, cuota, logo de la casa), lo que hay que apostar en cada pata y la ganancia (normalizada para que cada pata gane unos $10), "AGREGAR MERCADOS". Incluye props, totales de partido y líneas alternativas.

## Middles (/pro/middle-bets)
- Filtros, Guardados, Middle % mínimo, EV % mínimo. Tarjeta: "Middle -1.75%", mercado "Total O/U", pata A "Over 31.5" (cuota, 2 casas), pata B "Under 32" (+225), barras de acierto, montos ($139.54 / $60.46). Tabla de resultados según dónde caiga el marcador: "31 o menos: gana el Under, pierde el Over → -$3.50"; "exactamente 32: el Under queda en push y gana el Over → +$56.96 (31% de probabilidad implícita)"; "33 o más → -$3.50".

## Boosts (/pro/boosts)
- Filtros: método de devig, multiplicador de Kelly, EV % mínimo, Kelly % mínimo, ligas, orden. Tarjeta: "Boosted to +575 | Odds Boost", descripción, cada pata cruzada con su prop y su % de acierto, "PLACE BOOST ON CAESARS +575". Requiere una fuente de promociones de las casas que no existe gratis, así que aquí será una calculadora: el usuario escribe el boost y sus patas, y la app calcula el EV con las probabilidades justas de cada pata.

## Calculadoras
Ver `docs/spec-calculators.json`: 16 calculadoras con entradas, salidas, fórmulas y un ejemplo resuelto cada una.
