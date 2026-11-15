/**
 * The fire repo's spread model (fireproj.spread: simplified Rothermel, Anderson L/B ellipse, 16-neighbour Minimum
 * Travel Time, Monte Carlo), ported line by line for the browser. Inputs come from tools/export_spread_grid.py:
 * the same grid, fuel classes, terrain, weather and settings as the precomputed forecasts.
 *
 * Differences from Python, on purpose: the Monte Carlo draws use a seeded JavaScript generator (NumPy's PCG64 and
 * its normal sampler are not reproduced), so a browser ensemble matches the Python one statistically, not draw by
 * draw; a single run without perturbation (`runs: 0`) matches it cell by cell (tests/spread.test.ts).
 */

export interface SpreadModelFile {
  grid: { crs: string; utm_zone: number; width: number; height: number; resolution_m: number; transform: number[] };
  classes: Record<string, { R0_m_per_min: number; wind_C: number; wind_B: number; waf: number; beta: number; mex: number }>;
  settings: { mc_runs: number; seed: number; wind_dir_sigma_deg: number; wind_speed_rel_sigma: number; r0_lognormal_sigma: number;
    moisture_noise_sigma: number; use_gust_fraction: number; max_lb_ratio: number; max_slope_deg: number; probability: number;
    horizons_hours: number[]; safety_buffer_m: number };
  weather: { time: string[]; wind_speed_10m: number[]; wind_gusts_10m: number[]; wind_direction_10m: number[];
    temperature_2m: number[]; relative_humidity_2m: number[] };
}

/** Per-cell model inputs (Float32Array, row-major, row 0 = north). */
export interface SpreadGrid {
  file: SpreadModelFile;
  width: number; height: number; res: number;
  r0: Float32Array; windC: Float32Array; windB: Float32Array; waf: Float32Array; beta: Float32Array; mex: Float32Array;
  phiSlope: Float32Array; upSin: Float32Array; upCos: Float32Array;
  /** Median R0 of burnable cells: an ignition cell on a non-burnable class still spreads (as in run_mtt). */
  fallbackR0: number;
}

const KMH_TO_M_PER_MIN = 1000 / 60;
const KMH_TO_MPH = 0.621371192237334;
const f32 = Math.fround;

/** Builds the per-cell arrays from the exported grid: fuel parameters by class, slope factor and upslope vector. */
export function prepareGrid(file: SpreadModelFile, raw: ArrayBuffer): SpreadGrid {
  const { width, height } = file.grid;
  const n = width * height;
  const lc = new Uint8Array(raw, 0, n);
  const dv = new DataView(raw);
  const slope = (i: number) => dv.getUint16(n + 2 * i, true) / 100;
  const aspect = (i: number) => dv.getUint16(n + 2 * n + 2 * i, true) / 100;
  const g: SpreadGrid = {
    file, width, height, res: file.grid.resolution_m,
    r0: new Float32Array(n), windC: new Float32Array(n), windB: new Float32Array(n).fill(1), waf: new Float32Array(n),
    beta: new Float32Array(n).fill(0.02), mex: new Float32Array(n).fill(0.25),
    phiSlope: new Float32Array(n), upSin: new Float32Array(n), upCos: new Float32Array(n), fallbackR0: 1.5,
  };
  const maxSlope = file.settings.max_slope_deg;
  for (let i = 0; i < n; i++) {
    const c = file.classes[String(lc[i])];
    if (c) { g.r0[i] = c.R0_m_per_min; g.windC[i] = c.wind_C; g.windB[i] = c.wind_B; g.waf[i] = c.waf; g.beta[i] = c.beta; g.mex[i] = c.mex; }
    const s = Math.min(Math.max(slope(i), 0), maxSlope);
    const t = Math.tan((s * Math.PI) / 180);
    g.phiSlope[i] = 5.275 * Math.pow(Math.max(g.beta[i], 1e-4), -0.3) * t * t;
    const up = (((aspect(i) + 180) % 360) * Math.PI) / 180;
    g.upSin[i] = Math.sin(up); g.upCos[i] = Math.cos(up);
  }
  const pos = Array.from(g.r0).filter((x) => x > 0).sort((a, b) => a - b);
  if (pos.length) {
    const m = pos.length >> 1;
    g.fallbackR0 = pos.length % 2 ? pos[m] : (pos[m - 1] + pos[m]) / 2;
  }
  return g;
}

/** Fine dead-fuel equilibrium moisture (fraction), Simard / NFDRS, as fireproj.fuel.estimate_equilibrium_moisture_content. */
export function emc(rhPct: number, tempC: number): number {
  const H = Math.min(Math.max(rhPct, 1), 100);
  const Tf = tempC * 1.8 + 32;
  const pct = H < 10 ? 0.03229 + 0.281073 * H - 0.000578 * H * Tf
    : H < 50 ? 2.22749 + 0.160107 * H - 0.014784 * Tf
      : 21.0606 + 0.005565 * H * H - 0.00035 * H * Tf - 0.483199 * H;
  return Math.min(Math.max(pct / 100, 0.01), 0.6);
}

/** Rothermel moisture damping in [0, 1], as fireproj.fuel.compute_moisture_damping. */
export function damping(mf: number, mex: number): number {
  const mx = Math.max(mex, 0.05);
  if (mf >= mx) return 0;
  const rm = Math.min(Math.max(mf / mx, 0), 1);
  return Math.min(Math.max(1 - 2.59 * rm + 5.11 * rm * rm - 3.52 * rm * rm * rm, 0), 1);
}

export interface Weather { ws: Float32Array; wd: Float32Array; mm: Float32Array; refRh: number; refTc: number }

/** Hourly series from `t0` on, as fireproj.spread.montecarlo.extract_hourly_weather_series (gusts, moisture ratio). */
export function weatherFrom(file: SpreadModelFile, t0: number, maxHours: number): Weather {
  const w = file.weather;
  const n = Math.max(Math.floor(maxHours) + 1, 2);
  const times = w.time.map((s) => Date.parse(s));
  let start = times.findIndex((t) => t >= t0 - 30 * 60000);
  if (start < 0) start = Math.max(0, times.length - n);
  const idx = Array.from({ length: Math.min(n, times.length - start) }, (_, k) => start + k);
  const gust = file.settings.use_gust_fraction;
  const ws = idx.map((i) => { const s = w.wind_speed_10m[i]; return gust > 0 ? s + gust * (Math.max(w.wind_gusts_10m[i], s) - s) : s; });
  const wd = idx.map((i) => (w.wind_direction_10m[i] + 180) % 360);
  const rh = idx.map((i) => w.relative_humidity_2m[i]);
  const tc = idx.map((i) => w.temperature_2m[i]);
  const refRh = rh[0], refTc = tc[0];
  const etaRef = Math.max(damping(Math.max(emc(refRh, refTc), 0.01), 0.25), 0.05);
  const mm = idx.map((_, k) => Math.min(Math.max(damping(emc(rh[k], tc[k]), 0.25) / etaRef, 0.2), 2));
  while (ws.length < n) { ws.push(ws[ws.length - 1]); wd.push(wd[wd.length - 1]); mm.push(mm[mm.length - 1]); }
  return { ws: Float32Array.from(ws), wd: Float32Array.from(wd), mm: Float32Array.from(mm), refRh, refTc };
}

/** Static moisture damping per cell for the reference humidity and temperature (prepare_terrain_and_moisture_arrays). */
export function moistureBase(g: SpreadGrid, refRh: number, refTc: number): Float32Array {
  const mf = emc(refRh, refTc);
  const out = new Float32Array(g.r0.length);
  for (let i = 0; i < out.length; i++) out[i] = damping(mf, g.mex[i]);
  return out;
}

// 16 neighbours: 8 Moore + 8 knight moves (fireproj.spread.mtt).
const DR = [-1, -1, 0, 1, 1, 1, 0, -1, -2, -2, -1, 1, 2, 2, 1, -1];
const DC = [0, 1, 1, 1, 0, -1, -1, -1, 1, -1, 2, 2, 1, -1, -2, -2];
const DIST = DR.map((r, k) => f32(Math.hypot(r, DC[k])));
const AZ = DR.map((r, k) => f32(Math.atan2(DC[k], -r)));

/** Binary min-heap of (time, cell) with float32 keys, like the Numba heap in mtt.py. */
class Heap {
  keys = new Float32Array(1024); nodes = new Int32Array(1024); size = 0;
  push(k: number, n: number) {
    if (this.size === this.keys.length) {
      const k2 = new Float32Array(this.size * 2); k2.set(this.keys); this.keys = k2;
      const n2 = new Int32Array(this.size * 2); n2.set(this.nodes); this.nodes = n2;
    }
    let i = this.size++;
    const kk = this.keys, nn = this.nodes;
    while (i > 0) { const p = (i - 1) >> 1; if (kk[p] <= k) break; kk[i] = kk[p]; nn[i] = nn[p]; i = p; }
    kk[i] = k; nn[i] = n;
  }
  pop(): [number, number] {
    const kk = this.keys, nn = this.nodes;
    const topK = kk[0], topN = nn[0];
    const lk = kk[--this.size], ln = nn[this.size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i, mk = lk;
      if (l < this.size && kk[l] < mk) { m = l; mk = kk[l]; }
      if (r < this.size && kk[r] < mk) { m = r; mk = kk[r]; }
      if (m === i) break;
      kk[i] = kk[m]; nn[i] = nn[m]; i = m;
    }
    if (this.size > 0) { kk[i] = lk; nn[i] = ln; }
    return [topK, topN];
  }
}

export interface RunInput {
  grid: SpreadGrid;
  ignition: Uint8Array;
  ws: Float32Array; wsin: Float32Array; wcos: Float32Array; mm: Float32Array;
  mBase: Float32Array;
  maxTimeMin: number; maxLb: number; r0Mult: number;
}

/** One Minimum Travel Time run: arrival time in minutes per cell (Infinity where not reached). */
export function runMtt(p: RunInput): Float32Array {
  const g = p.grid, W = g.width, H = g.height, n = W * H;
  const INF = f32(1e30);
  const arrival = new Float32Array(n).fill(INF);
  const r0 = g.r0.slice();
  for (let i = 0; i < n; i++) if (p.ignition[i] && r0[i] <= 0) r0[i] = f32(g.fallbackR0);
  const heap = new Heap();
  for (let i = 0; i < n; i++) if (p.ignition[i]) { arrival[i] = 0; heap.push(0, i); }
  const nHr = p.ws.length;
  while (heap.size > 0) {
    const [tu, u] = heap.pop();
    if (tu > p.maxTimeMin) break;
    if (tu > arrival[u] + 1e-6) continue;
    const r0c = r0[u] * p.r0Mult;
    if (r0c <= 1e-7) continue;
    // Hourly weather at the arrival time, linearly interpolated (wind direction as a unit vector).
    let ws: number, wsin: number, wcos: number, mm: number;
    const hf = tu / 60;
    if (nHr === 1 || hf <= 0) { ws = p.ws[0]; wsin = p.wsin[0]; wcos = p.wcos[0]; mm = p.mm[0]; } else {
      const k = Math.floor(hf);
      if (k >= nHr - 1) { ws = p.ws[nHr - 1]; wsin = p.wsin[nHr - 1]; wcos = p.wcos[nHr - 1]; mm = p.mm[nHr - 1]; } else {
        const fr = hf - k;
        ws = (1 - fr) * p.ws[k] + fr * p.ws[k + 1];
        wsin = (1 - fr) * p.wsin[k] + fr * p.wsin[k + 1];
        wcos = (1 - fr) * p.wcos[k] + fr * p.wcos[k + 1];
        const nm = Math.hypot(wsin, wcos);
        if (nm > 1e-9) { wsin /= nm; wcos /= nm; } else { wsin = p.wsin[k]; wcos = p.wcos[k]; }
        mm = (1 - fr) * p.mm[k] + fr * p.mm[k + 1];
      }
    }
    const eta = Math.min(Math.max(p.mBase[u] * mm, 0), 1);
    const r0eff = r0c * eta;
    if (r0eff <= 1e-7) continue;
    const umidKmh = g.waf[u] * Math.max(ws, 0);
    const umid = umidKmh * KMH_TO_M_PER_MIN;
    const pw = umid > 0 ? g.windC[u] * Math.pow(umid, g.windB[u]) : 0;
    const ps = g.phiSlope[u];
    const vx = pw * wsin + ps * g.upSin[u];
    const vy = pw * wcos + ps * g.upCos[u];
    const phi = Math.hypot(vx, vy);
    const head = phi > 1e-9 ? Math.atan2(vx, vy) : Math.atan2(wsin, wcos);
    const rHead = r0eff * (1 + phi);
    if (rHead <= 1e-7) continue;
    const mph = umidKmh * KMH_TO_MPH;
    let lb = 0.936 * Math.exp(0.2566 * mph) + 0.461 * Math.exp(-0.1548 * mph) - 0.397;
    lb = Math.min(Math.max(lb, 1), p.maxLb);
    const ecc = Math.sqrt(Math.max(lb * lb - 1, 0)) / lb;
    const ome = 1 - ecc;
    const r = Math.floor(u / W), c = u - r * W;
    for (let k = 0; k < 16; k++) {
      const nr = r + DR[k], nc = c + DC[k];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const v = nr * W + nc;
      // Target cell must be burnable; a knight move may not jump across a one-cell barrier (Python's // is floor).
      if (r0[v] <= 1e-7) continue;
      if (k >= 8 && r0[(r + Math.floor(DR[k] / 2)) * W + (c + Math.floor(DC[k] / 2))] <= 1e-7) continue;
      const rt = (rHead * ome) / (1 - ecc * Math.cos(AZ[k] - head));
      if (rt <= 1e-7) continue;
      // Compared in double precision, stored in single precision (as the Numba code does).
      const tNew = tu + (DIST[k] * g.res) / rt;
      if (tNew < arrival[v] && tNew <= p.maxTimeMin) { arrival[v] = f32(tNew); heap.push(f32(tNew), v); }
    }
  }
  for (let i = 0; i < n; i++) if (arrival[i] >= 1e29) arrival[i] = Infinity;
  return arrival;
}

/** Seeded generator (mulberry32) with normal and log-normal draws. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let spare: number | null = null;
  const normal = (mu = 0, sd = 1) => {
    if (spare != null) { const z = spare; spare = null; return mu + sd * z; }
    let a = 0, b = 0;
    while (a <= 1e-12) a = u();
    b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return mu + sd * r * Math.cos(2 * Math.PI * b);
  };
  return { u, normal, lognormal: (mu: number, sd: number) => Math.exp(normal(mu, sd)) };
}

export interface EnsembleInput {
  grid: SpreadGrid;
  ignition: Uint8Array;
  /** Issue time (epoch ms): the weather from then on. */
  t0: number;
  /** Longest horizon (hours). */
  maxHours: number;
  /** Monte Carlo runs; 0 = one run without perturbation. */
  runs: number;
  seed: number;
  /** Called between runs; return true to stop (a newer request replaced this one). */
  cancelled?: () => boolean | Promise<boolean>;
  progress?: (done: number, total: number) => void;
}

/**
 * The ensemble's P >= 50 % arrival time per cell: the time by which at least half of the runs have reached it (the
 * ceil(N/2)-th smallest arrival), Infinity where fewer than half reach it within `maxHours`. A cell is inside the
 * P >= 50 % contour of horizon h exactly when this time is <= h.
 */
export async function ensemble(p: EnsembleInput): Promise<Float32Array | null> {
  const g = p.grid, n = g.width * g.height, s = g.file.settings;
  const w = weatherFrom(g.file, p.t0, Math.ceil(p.maxHours) + 1);
  const mBase = moistureBase(g, w.refRh, w.refTc);
  const total = Math.max(p.runs, 1);
  const k = Math.ceil(0.5 * total);
  const arrivals: Float32Array[] = [];
  const R = rng(p.seed);
  const wsLnSigma = Math.sqrt(Math.log(1 + s.wind_speed_rel_sigma ** 2));
  const wsLnMu = -0.5 * wsLnSigma * wsLnSigma;
  const r0LnMu = -0.5 * s.r0_lognormal_sigma ** 2;
  for (let i = 0; i < total; i++) {
    let wsMult = 1, dirOff = 0, r0Mult = 1, mNoise = 1;
    if (p.runs > 0) {
      wsMult = R.lognormal(wsLnMu, wsLnSigma);
      dirOff = R.normal(0, s.wind_dir_sigma_deg);
      r0Mult = R.lognormal(r0LnMu, s.r0_lognormal_sigma);
      mNoise = Math.min(Math.max(R.normal(1, s.moisture_noise_sigma), 0.4), 1.4);
    }
    const ws = w.ws.map((x) => f32(x * wsMult));
    const wdr = Array.from(w.wd, (x) => ((((x + dirOff) % 360) + 360) % 360) * Math.PI / 180);
    arrivals.push(runMtt({ grid: g, ignition: p.ignition, ws, wsin: Float32Array.from(wdr, Math.sin), wcos: Float32Array.from(wdr, Math.cos),
      mm: w.mm.map((x) => f32(x * mNoise)), mBase, maxTimeMin: p.maxHours * 60, maxLb: s.max_lb_ratio, r0Mult }));
    p.progress?.(i + 1, total);
    if (p.cancelled && await p.cancelled()) return null;
  }
  const out = new Float32Array(n);
  const col = new Float32Array(total);
  for (let c = 0; c < n; c++) {
    for (let i = 0; i < total; i++) col[i] = arrivals[i][c];
    col.sort();
    out[c] = col[k - 1];
  }
  return out;
}
