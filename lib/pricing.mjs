// Núcleo de precios: probabilidad → cuota justa y cuota con margen. price, normalOver y negBinPmf viven en
// public/betmath.js porque el navegador también cotiza (líneas personalizadas de props).
import { poissonPmf } from '../public/betmath.js';

export { MARGIN, price, negBinPmf, normalOver } from '../public/betmath.js';

export const halfLine = (x) => Math.floor(x) + 0.5;

// Marcadores 0..max con corrección Dixon-Coles en 0-0, 0-1, 1-0, 1-1; suma 1.
export function scoreGrid(lh, la, { rho = -0.1, max = 10 } = {}) {
  const tau = (i, j) => {
    if (i === 0 && j === 0) return 1 - lh * la * rho;
    if (i === 0 && j === 1) return 1 + lh * rho;
    if (i === 1 && j === 0) return 1 + la * rho;
    if (i === 1 && j === 1) return 1 - rho;
    return 1;
  };
  const g = [];
  let total = 0;
  for (let i = 0; i <= max; i++) {
    g.push([]);
    for (let j = 0; j <= max; j++) {
      const v = poissonPmf(i, lh) * poissonPmf(j, la) * tau(i, j);
      g[i].push(v);
      total += v;
    }
  }
  return g.map((row) => row.map((v) => v / total));
}

export const countOver = (pmf, line) => pmf.reduce((s, p, k) => (k > line ? s + p : s), 0);
