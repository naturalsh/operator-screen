/// <reference lib="webworker" />
/**
 * The in-browser fire model, off the main thread. Messages:
 * - init { base }: loads spread_model.json and spread_grid.bin(.gz) from the scenario folder.
 * - streets { streets: [id, [lon, lat][]][] }: cells within the safety buffer of each street (for reach times).
 * - run { id, t0, starts, modelStarts, runs, seed, maxHours }: an ensemble from the starting areas; replies with the
 *   contours every 30 minutes (horizon 0 = the start) and when the P >= 50 % area reaches each street.
 * - cancel { id }: drops a run (checked between Monte Carlo runs); the result of a dropped run is never sent.
 */
import { ensemble, prepareGrid, type SpreadGrid, type SpreadModelFile } from './model';
import { outline, rasterize, toCell, type GridGeo } from './geo';
import type { Geometry } from 'geojson';

let grid: SpreadGrid | null = null;
let geo: GridGeo | null = null;
let streetCells: [string, Int32Array][] = [];
const cancelled = new Set<number>();
let latest = 0;

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
      latest = m.id;
      const t = performance.now();
      const start = rasterize(geo, m.starts as Geometry[]);                       // observed / drawn areas
      rasterize(geo, m.modelStarts as Geometry[], start, false);                  // model areas (the estimated fire)
      const p50 = await ensemble({
        grid, ignition: start, t0: m.t0, maxHours: m.maxHours, runs: m.runs, seed: m.seed,
        // Let a cancel (or a newer run) through between Monte Carlo runs.
        cancelled: async () => { await new Promise((r) => setTimeout(r, 0)); return cancelled.has(m.id) || latest !== m.id; },
        progress: (done, total) => postMessage({ type: 'progress', id: m.id, done, total }),
      });
      if (!p50) { postMessage({ type: 'cancelled', id: m.id }); return; }
      const res2 = (grid.res * grid.res) / 1e6;
      const steps: { horizon: number; areaKm2: number; geometry: Geometry | null }[] = [];
      let startCells = 0;
      for (let i = 0; i < start.length; i++) startCells += start[i];
      steps.push({ horizon: 0, areaKm2: startCells * res2, geometry: outline(geo, (i) => start[i] === 1) });
      for (const h of grid.file.settings.horizons_hours) {
        if (h > m.maxHours) break;
        let n = 0;
        for (let i = 0; i < p50.length; i++) if (p50[i] <= h * 60) n++;
        steps.push({ horizon: h, areaKm2: n * res2, geometry: outline(geo, (i) => p50[i] <= h * 60) });
      }
      // Reach: the first half hour at which the P >= 50 % area comes within the safety buffer of the street.
      const reach: [string, number][] = [];
      for (const [id, cells] of streetCells) {
        let best = Infinity;
        for (let k = 0; k < cells.length; k++) if (p50[cells[k]] < best) best = p50[cells[k]];
        if (best <= m.maxHours * 60) reach.push([id, Math.max(0.5, Math.ceil(best / 30 - 1e-9) * 0.5)]);
      }
      postMessage({ type: 'result', id: m.id, steps, reach, ms: Math.round(performance.now() - t), startCells });
    }
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
