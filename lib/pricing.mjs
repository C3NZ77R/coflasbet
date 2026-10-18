// Núcleo de precios: probabilidad → cuota justa y cuota con margen.
import { normCdf, poissonPmf } from '../public/betmath.js';

export const MARGIN = 0.05;

const clamp = (o) => Math.round(Math.min(101, Math.max(1.01, o)) * 100) / 100;

export function price(p) {
  return { p, fair: clamp(1 / p), coflas: clamp(1 / (p * (1 + MARGIN))) };
}

export const halfLine = (x) => Math.floor(x) + 0.5;

// Binomial negativa por recurrencia; sin sobredispersión cae a Poisson.
export function negBinPmf(k, mean, variance) {
  if (!(variance > mean)) return poissonPmf(k, mean);
  const r = (mean * mean) / (variance - mean);
  const q = variance > 0 ? mean / (r + mean) : 0;
  let pk = Math.pow(1 - q, r);
  for (let i = 1; i <= k; i++) pk *= ((i - 1 + r) / i) * q;
  return pk;
}

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

// P(X > line); con línea entera usa P(X >= line + 0.5) (sin push).
export function normalOver(mu, sigma, line) {
  const cut = Number.isInteger(line) ? line + 0.5 : line;
  return 1 - normCdf((cut - mu) / sigma);
}

export const countOver = (pmf, line) => pmf.reduce((s, p, k) => (k > line ? s + p : s), 0);
