/**
 * The in-browser fire model (worker.ts) as a forecast source: starts from the fire estimated now (the forecast in
 * force) plus operator-confirmed fires, with the scenario's weather from then on, and answers with a ForecastRun like
 * the precomputed ones. One request at a time matters: a newer request cancels the older one (LatestRequest).
 */
import type { Geometry } from 'geojson';
import { toRun, type ForecastRun } from '../forecast';
import type { LibraryForecast, StreetFeature } from '../types';

export interface BrowserRunRequest {
  /** Issue time (epoch ms). */
  t0: number;
  /** When the estimated fire in `modelStarts` is valid (the model starts then; default t0). */
  modelAt?: number;
  /** Drawn or reported areas (rasterized with every touched cell), and when each was seen. */
  starts: Geometry[];
  startsAt?: number[];
  /** When the model areas start burning (default modelAt): an automatic update starts the new satellite edge at the pass. */
  modelStartsAt?: number;
  /** Model areas (the estimated fire now; cell centres). */
  modelStarts: Geometry[];
  runs: number;
  seed: number;
  maxHours: number;
}

export interface BrowserRunResult {
  steps: { horizon: number; areaKm2: number; geometry: Geometry | null }[];
  reach: [string, number][];
  ms: number;
  startCells: number;
}

const SHOWN = [0.5, 1, 2, 3, 6];

export class BrowserModel {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve: (r: BrowserRunResult) => void; reject: (e: Error) => void; progress?: (d: number, t: number) => void }>();
  readonly ready: Promise<number>;

  constructor(base: string, streets: StreetFeature[]) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let onReady: (ms: number) => void, onFail: (e: Error) => void;
    this.ready = new Promise((res, rej) => { onReady = res; onFail = rej; });
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') this.worker.postMessage({ type: 'streets', streets: streets.map((s) => [s.properties.id,
        s.geometry.type === 'LineString' ? s.geometry.coordinates : s.geometry.coordinates.flat()]) });
      else if (m.type === 'streets-ready') onReady(m.count);
      else if (m.type === 'progress') this.pending.get(m.id)?.progress?.(m.done, m.total);
      else if (m.type === 'result') { this.pending.get(m.id)?.resolve(m); this.pending.delete(m.id); }
      else if (m.type === 'cancelled') { this.pending.get(m.id)?.reject(new Error('cancelled')); this.pending.delete(m.id); }
      else if (m.type === 'error') {
        if (m.id == null) onFail(new Error(m.message));
        else { this.pending.get(m.id)?.reject(new Error(m.message)); this.pending.delete(m.id); }
      }
    };
    this.worker.onerror = (e) => onFail(new Error(e.message));
    this.worker.postMessage({ type: 'init', base });
  }

  /** Runs the model; rejects with "cancelled" when `signal` aborts (the worker drops the run between ensemble runs). */
  async run(req: BrowserRunRequest, signal?: AbortSignal, progress?: (done: number, total: number) => void): Promise<BrowserRunResult> {
    await this.ready;
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress });
      signal?.addEventListener('abort', () => { this.worker.postMessage({ type: 'cancel', id }); }, { once: true });
      this.worker.postMessage({ type: 'run', id, ...req });
    });
  }

  dispose(): void { this.worker.terminate(); }
}

/**
 * What a browser run adds to a ForecastRun: the operator-confirmed fires it started from (ids, and "id@version"
 * keys, so a run made before a fire moved or was deleted is never used as the start of the next one), and why it
 * was made when that is not obvious ("operator-confirmed fire deleted").
 */
export interface BrowserRunExtra { operatorFires: string[]; fireKeys: string[]; browserNote?: string; computeMs: number }

/** A browser result as a ForecastRun (same shape as a library entry; street ids instead of indexes in `reach`). */
export function browserRun(r: BrowserRunResult, meta: { t0: number; from: string; lastObsAt: number | null; lastObsLabel: string | null;
  operatorFires: string[]; fireKeys: string[]; note?: string }, seq: number): ForecastRun & BrowserRunExtra {
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const f: LibraryForecast = {
    id: `browser-${iso(meta.t0)}-${seq}`, issued_at: iso(meta.t0), trigger: 'live', initialised_from: meta.from,
    ...(meta.lastObsAt != null ? { last_observation_at: iso(meta.lastObsAt), last_observation_label: meta.lastObsLabel ?? undefined } : {}),
    start_area_km2: r.steps[0]?.areaKm2 ?? 0,
    contours: r.steps.filter((s) => s.geometry).map((s) => ({ horizon_hours: s.horizon, valid_at: iso(meta.t0 + s.horizon * 3600000),
      area_km2: Math.round(s.areaKm2 * 1000) / 1000, ...(SHOWN.includes(s.horizon) ? { shown: true } : {}), geometry: s.geometry })),
    reach: r.reach,
  };
  return { ...toRun(f, (id) => String(id), 'browser'), operatorFires: meta.operatorFires, fireKeys: meta.fireKeys, browserNote: meta.note, computeMs: r.ms };
}
