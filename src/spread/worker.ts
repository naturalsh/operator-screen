/// <reference lib="webworker" />
/**
 * The in-browser fire model, off the main thread. Messages:
 * - init { base }: loads spread_model.json and spread_grid.bin(.gz) from the scenario folder.
 * - streets { streets: [id, [lon, lat][]][] }: cells within the safety buffer of each street (for reach times).
 * - run { id, t0, modelAt, starts, startsAt, modelStarts, modelStartsAt, runs, seed, maxHours }: an ensemble from the starting areas; replies with the
 *   contours every 30 minutes (horizon 0 = the start; outlines smoothed like the precomputed ones, areas and street
 *   reach from the cells) and when the P >= 50 % area reaches each street.
 * - cancel { id }: drops a run (checked between Monte Carlo runs); the result of a dropped run is never sent.
 *   Runs are only dropped this way: an automatic update and an operator's run can be computed side by side.
 */
import { ensemble, prepareGrid, type SpreadGrid, type SpreadModelFile } from './model';
import { rasterize, smoothOutline, toCell, type GridGeo } from './geo';
import type { Geometry } from 'geojson';

let grid: SpreadGrid | null = null;
let geo: GridGeo | null = null;
let streetCells: [string, Int32Array][] = [];
const cancelled = new Set<number>();

async function loadGrid(base: string): Promise<ArrayBuffer> {
  if ('DecompressionStream' in self) {
    try {
      const res = await fetch(`${base}spread_grid.bin.gz`);
      if (res.ok && res.body) return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } catch { /* fall back to the uncompressed copy */ }
  }
  return (await fetch(`${base}spread_grid.bin`)).arrayBuffer();
}

function cellsNear(g: GridGeo, pts: number[][], bufferM: number, res: number): Int32Array {
  const out = new Set<number>();
  const rc = bufferM / res;
  const reach = Math.ceil(rc + 1);
  for (let i = 0; i < pts.length; i++) {
    const a = toCell(g, pts[i][0], pts[i][1]);
    const b = i + 1 < pts.length ? toCell(g, pts[i + 1][0], pts[i + 1][1]) : a;
    const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 2));
    for (let s = 0; s <= steps; s++) {
      const x = a[0] + ((b[0] - a[0]) * s) / steps, y = a[1] + ((b[1] - a[1]) * s) / steps;
      const cx = Math.floor(x), cy = Math.floor(y);
      for (let dr = -reach; dr <= reach; dr++) for (let dc = -reach; dc <= reach; dc++) {
        const c = cx + dc, r = cy + dr;
        if (c < 0 || r < 0 || c >= g.width || r >= g.height) continue;
        // Distance from the point to the cell square, in cells.
        const ddx = Math.max(c - x, 0, x - (c + 1)), ddy = Math.max(r - y, 0, y - (r + 1));
        if (Math.hypot(ddx, ddy) <= rc) out.add(r * g.width + c);
      }
    }
  }
  return Int32Array.from(out);
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const t = performance.now();
      const file = (await (await fetch(`${m.base}spread_model.json`)).json()) as SpreadModelFile;
      grid = prepareGrid(file, await loadGrid(m.base));
      geo = { width: grid.width, height: grid.height, transform: file.grid.transform, zone: file.grid.utm_zone };
      postMessage({ type: 'ready', ms: Math.round(performance.now() - t) });
    } else if (m.type === 'streets' && grid && geo) {
      const buffer = grid.file.settings.safety_buffer_m;
      streetCells = (m.streets as [string, number[][]][]).map(([id, pts]) => [id, cellsNear(geo!, pts, buffer, grid!.res)] as [string, Int32Array])
        .filter(([, cells]) => cells.length > 0);
      postMessage({ type: 'streets-ready', count: streetCells.length });
    } else if (m.type === 'cancel') {
      cancelled.add(m.id);
    } else if (m.type === 'run') {
      if (!grid || !geo) throw new Error('model not loaded');
      const t = performance.now();
      // The model starts when the estimated fire it starts from is valid (`modelAt`, at most 30 min before the issue
      // time t0), with the weather from then; an operator fire starts burning when it was seen (its cells' start
      // time). Contours and reach are then read from t0: horizon h is the area reached by lead + h.
      const modelAt: number = m.modelAt ?? m.t0;
      const lead = Math.max(0, (m.t0 - modelAt) / 60000);
      const start = new Uint8Array(geo.width * geo.height);
      const startMin = new Float32Array(start.length);
      (m.starts as Geometry[]).forEach((g, k) => {                                  // observed / drawn areas
        const cells = rasterize(geo!, [g]);
        const at = Math.min(Math.max(((m.startsAt?.[k] ?? m.t0) - modelAt) / 60000, 0), lead);
        for (let i = 0; i < cells.length; i++) if (cells[i] && (!start[i] || startMin[i] > at)) { start[i] = 1; startMin[i] = at; }
      });
      const operator = start.slice();                                             // never dropped from the outlines
      const model = rasterize(geo, m.modelStarts as Geometry[], undefined, false);  // model areas (the estimated fire)
      // The model area burns from `modelStartsAt` (default: modelAt); an automatic update starts it at the pass, after
      // operator fires seen earlier.
      const modelStart = Math.min(Math.max(((m.modelStartsAt ?? modelAt) - modelAt) / 60000, 0), lead);
      for (let i = 0; i < start.length; i++) if (model[i] && (!start[i] || startMin[i] > modelStart)) { start[i] = 1; startMin[i] = modelStart; }
      const p50 = await ensemble({
        grid, ignition: start, startMin, t0: modelAt, maxHours: m.maxHours + lead / 60, runs: m.runs, seed: m.seed,
        // Let a cancel through between Monte Carlo runs (an automatic update and an operator's may run side by side).
        cancelled: async () => { await new Promise((r) => setTimeout(r, 0)); return cancelled.has(m.id); },
        progress: (done, total) => postMessage({ type: 'progress', id: m.id, done, total }),
      });
      if (!p50) { postMessage({ type: 'cancelled', id: m.id }); return; }
      const res2 = (grid.res * grid.res) / 1e6;
      const steps: { horizon: number; areaKm2: number; geometry: Geometry | null }[] = [];
      let startCells = 0;
      for (let i = 0; i < start.length; i++) startCells += start[i];
      for (const h of [0, ...grid.file.settings.horizons_hours]) {
        if (h > m.maxHours) break;
        const lim = lead + h * 60 + 1e-6;
        let n = 0;
        for (let i = 0; i < p50.length; i++) if (p50[i] <= lim) n++;
        steps.push({ horizon: h, areaKm2: n * res2, geometry: smoothOutline(geo, (i) => p50[i] <= lim, operator) });
      }
      // Reach: the first half hour after t0 at which the P >= 50 % area comes within the safety buffer of the street.
      const reach: [string, number][] = [];
      for (const [id, cells] of streetCells) {
        let best = Infinity;
        for (let k = 0; k < cells.length; k++) if (p50[cells[k]] < best) best = p50[cells[k]];
        if (best <= lead + m.maxHours * 60) reach.push([id, Math.max(0.5, Math.ceil((best - lead) / 30 - 1e-9) * 0.5)]);
      }
      postMessage({ type: 'result', id: m.id, steps, reach, ms: Math.round(performance.now() - t), startCells });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
