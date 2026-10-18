# Liga BetPlay — auditoría y plan

Fecha: 2026-10-18. Depende del plan `2026-10-18-cuotas-propias-y-tenis.md` (Tasks 3–6).

## Auditoría (datos reales de ESPN `col.1`, hoy)

**Qué hay en el código**
- `public/leagues.js`: `{ id:'colombia', espn:'col.1', sport:'soccer' }`. 20 equipos en ESPN, todos con calendario.
- Ratings (`lib/ratings.mjs`) y Dixon-Coles (`lib/pricing.mjs`) ya sirven para la liga, pero **la app no muestra cuotas de BetPlay**: faltan `lib/markets.mjs`, el backtest, `/api/markets` y las vistas (Tasks 3–5).
- `getSeasonResults` solo trae la temporada vigente (2026: Apertura + Clausura en curso) porque ya pasa de 10 partidos por equipo. No usa 2025.

**Qué dicen los datos**
| Año | Partidos | Goles/p | Local / visita | Local / empate / visita | 0-0 |
|---|---|---|---|---|---|
| 2024 | 429 | 2.17 | 1.27 / 0.90 | 45.9% / 26.8% / 27.3% | 10.3% |
| 2025 | 449 | 2.28 | 1.32 / 0.96 | 45.7% / 28.7% / 25.6% | 12.5% |
| 2026 | 334 | 2.57 | 1.52 / 1.05 | 44.3% / 31.4% / 24.3% | 7.5% |

Liga de pocos goles, muchos empates y localía fuerte (altura: Bogotá, Tunja, Pasto).

**Backtest rápido del modelo actual (2025-07 → hoy, 1X2, corte 6 h antes)**
| Variante | Brier | Log-loss | Empate predicho / real |
|---|---|---|---|
| Modelo actual con 2024–2026 | **0.6146** | 1.0221 | 0.293 / 0.299 |
| Referencia (tasas de 2025) | 0.6471 | — | — |
| Solo últimos 365 días | 0.6204 | 1.0304 | 0.284 / 0.299 |
| prior = 10 | 0.6143 | 1.0215 | 0.295 / 0.299 |
| ρ = 0 (sin Dixon-Coles) | 0.6158 | 1.0243 | 0.269 / 0.299 |

Conclusiones: el modelo ya le gana a la referencia por ~5% de Brier y calibra bien los empates. Más historia ayuda; cortar la ventana empeora. ρ = −0.1 está bien.

**Datos extra disponibles por partido** (`summary`): córners, tarjetas, remates, remates al arco, posesión, alineaciones (20 por equipo) y cuotas de DraftKings para `col.1`. Hay game logs de jugadores (Dayro Moreno: 2020–2026).

## Plan

1. **Mercados + backtest con BetPlay incluida** (Task 3 del plan general). `lib/markets.mjs`, `scripts/backtest.mjs`, `docs/accuracy.json` con `colombia`.
2. **Más historia para fútbol**: `getSeasonResults` trae siempre la temporada anterior en ligas de fútbol con dos torneos por año. Criterio: el Brier de `colombia` en el backtest no empeora.
2–3 hechos en la rama `betplay-ratings`.
3. **Peso por antigüedad** (decaimiento exponencial, vida media a calibrar entre 180 y 720 días) en `ratingsFromResults`. Se queda solo si baja el Brier.
   - Resultado: **vida media de 365 días** para fútbol. Brier 2025: 0.6097 → 0.6090; 2026: 0.6179 → 0.6168. Con menos de 180 días empeora.
4. **Localía por equipo** con shrink a la de la liga (altura). Se queda solo si baja el Brier.
   - Resultado: **descartado**. Con k = (casa/visita)^(1/4) y shrink de 5 a 80 goles ficticios, en 2025 empeora el Brier en todos los casos (0.6090 sin k → 0.6093 en el mejor) y en 2026 apenas mejora (0.6168 → 0.6157). Los k no siguen la altura (Santa Fe 0.95, Boyacá Chicó 1.17): es ruido.
5. **Recién ascendidos**: equipo sin partidos en la liga arranca bajo la media (cuartil bajo), no en la media.
   - Resultado: **prior 0.8× goles a favor y 1.1× en contra** para equipos con menos de la mitad de los partidos medianos (o sin partidos). Medido: 6 ascendidos de 2024–2026 hicieron 0.74× y recibieron 1.09× en sus primeros 10. Brier 2025: 0.6090 → 0.6085; 2026: 0.6168 → 0.6162. Aplica a todo el fútbol (en copas marca a quien no jugó la edición anterior).
6. **Rutas y vistas** (Tasks 4–5): Partidos → Liga BetPlay → detalle con 1X2, doble oportunidad, más/menos, ambos marcan, hándicap y marcador exacto; precisión medida visible.
7. **Córners y tarjetas** desde el `summary` (medias por equipo, binomial negativa). Mercado muy pedido en Colombia.
8. **Props de jugadores** (Task 6): goles y remates con game logs de `col.1`.
9. **Comparación interna con el mercado** (opcional, no se muestra): guardar la cuota de DraftKings del `summary` para medir qué tan lejos está el modelo.
