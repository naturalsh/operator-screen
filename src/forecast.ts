/**
 * Forecasts the operator loads with "Update forecast".
 *
 * The forecast in force no longer changes by itself: it is the last one the operator loaded. Where a
 * forecast comes from is a `ForecastSource`:
 * - `PrecomputedForecasts`: the scenario's forecast library (tools/build_forecast_library.py), one forecast
 *   at ignition, at every new VIIRS / Sentinel-2 observation and every 30 minutes; works on a static site.
 * - `LiveForecasts`: a model server (FastAPI on localhost, docs/forecast_api.md). Not set up yet; used only
 *   with `?forecast_api=<url>`, and it falls back to the precomputed forecast when the server does not answer.
 */
import type { Geometry } from 'geojson';
import type { ConceptReports, FireFront, ForecastLibrary, LibraryForecast, StreetFeature } from './types';
import { NEVER } from './data';

export type ForecastTrigger = 'ignition' | 'observation' | 'scheduled' | 'live';

/** A forecast the screen holds: its contours (as FireFront features) and when it reaches each street. */
export interface ForecastRun {
  id: string;
  issuedAt: number;
  trigger: ForecastTrigger;
  from: string;
  lastObsAt: number | null;
  lastObsLabel: string | null;
  startAreaKm2: number;
  contours: { horizon: number; validAt: number; areaKm2: number }[];
  /** Street id -> time (epoch ms) at which the P >= 50 % contour reaches it, within 12 h. */
  reach: Map<string, number>;
  source: 'precomputed' | 'live';
  /** E.g. why the live model was not used. */
  sourceNote?: string;
  /** FireFront features of the shown contours (+4 / +8 / +12 h). */
  features: GeoJSON.Feature<Geometry, FireFront & { t: number }>[];
  /** CONCEPT DEMO: confirmed report clusters the forecast was started with (empty: none). */
  reports: string[];
}

/** What the operator asks for: the newest forecast that can be issued at `at`. */
export interface ForecastRequest {
  scenario: string;
  /** Scenario time of the request (epoch ms). */
  at: number;
  /** 'update': start from the latest observations; 'rerun': same perimeter, new start time and weather. */
  kind: 'update' | 'rerun';
  /** CONCEPT DEMO: report clusters the operator confirmed (a live server gets their discs). */
  reports?: string[];
}

export interface ForecastSource {
  readonly kind: 'precomputed' | 'live';
  run(req: ForecastRequest): Promise<ForecastRun | null>;
}

/** One library entry (or a live server's answer, which has the same shape) as a ForecastRun. */
export function toRun(f: LibraryForecast, streetIds: (i: number | string) => string, source: ForecastRun['source']): ForecastRun {
  const issuedAt = Date.parse(f.issued_at);
  const features = f.contours.map((c, rank) => ({
    type: 'Feature' as const,
    geometry: c.geometry as Geometry,
    properties: {
      id: `${f.id}-h${c.horizon_hours}`, kind: 'forecast', forecast_set: 'update', set: 'update',
      issued_at: f.issued_at, model_run_at: f.issued_at, valid_at: c.valid_at, horizon_hours: c.horizon_hours,
      probability: 0.5, area_km2: c.area_km2, initialised_from: f.initialised_from,
      last_observation_at: f.last_observation_at, source: source === 'live' ? 'live model' : 'precomputed forecast',
      t: Date.parse(c.valid_at), issue_t: issuedAt, rank: Math.min(rank, 2), run_id: f.id,
    } as unknown as FireFront & { t: number },
  }));
  return {
    id: f.id, issuedAt, trigger: f.trigger, from: f.initialised_from,
    lastObsAt: f.last_observation_at ? Date.parse(f.last_observation_at) : null,
    lastObsLabel: f.last_observation_label ?? null, startAreaKm2: f.start_area_km2,
    contours: f.contours.map((c) => ({ horizon: c.horizon_hours, validAt: Date.parse(c.valid_at), areaKm2: c.area_km2 })),
    reach: new Map(f.reach.map(([i, h]) => [streetIds(i), issuedAt + h * 3600000])),
    source, features, reports: (f as { reports?: string[] }).reports ?? [],
  };
}

export class PrecomputedForecasts implements ForecastSource {
  readonly kind = 'precomputed' as const;
  readonly runs: ForecastRun[];
  readonly lastIssueAt: number;
  /** CONCEPT DEMO: forecasts started with confirmed reports, by `${base id}|${sorted cluster ids}`. */
  private readonly withReports = new Map<string, LibraryForecast>();
  private readonly candidateAt = new Map<string, number>();
  readonly reportsUntil: number;
  constructor(readonly library: ForecastLibrary, readonly concept?: ConceptReports) {
    this.runs = library.forecasts.map((f) => toRun(f, (i) => library.streets[i as number], 'precomputed'))
      .sort((a, b) => a.issuedAt - b.issuedAt);
    this.lastIssueAt = Date.parse(library.metadata.last_issue_at);
    for (const f of concept?.forecasts ?? []) this.withReports.set(`${f.base_forecast}|${[...f.reports].sort().join(',')}`, f);
    for (const c of concept?.clusters ?? []) if (c.candidate_at) this.candidateAt.set(c.id, Date.parse(c.candidate_at));
    this.reportsUntil = concept ? Date.parse(concept.metadata.window_end) : -Infinity;
  }
  /** Confirmed clusters a forecast issued at `issuedAt` can start from (candidates by then, first night only). */
  usableReports(issuedAt: number, confirmed: string[]): string[] {
    if (issuedAt > this.reportsUntil) return [];
    return confirmed.filter((id) => (this.candidateAt.get(id) ?? Infinity) <= issuedAt).sort();
  }
  /** The base forecast, or the one started with these reports when that one was computed. */
  withConfirmed(base: ForecastRun, confirmed: string[]): ForecastRun {
    const use = this.usableReports(base.issuedAt, confirmed);
    if (!use.length) return base;
    const f = this.withReports.get(`${base.id}|${use.join(',')}`);
    if (!f) return { ...base, sourceNote: 'this set of confirmed reports was not precomputed; forecast without them' };
    return toRun(f, (i) => this.concept!.streets[i as number], 'precomputed');
  }
  /** The newest forecast issued by `at` (it only uses observations acquired by then). */
  latest(at: number): ForecastRun | null {
    let best: ForecastRun | null = null;
    for (const r of this.runs) if (r.issuedAt <= at) best = r;
    return best;
  }
  get first(): ForecastRun | null { return this.runs[0] ?? null; }
  async run(req: ForecastRequest): Promise<ForecastRun | null> {
    const base = this.latest(req.at);
    return base && req.reports?.length ? this.withConfirmed(base, req.reports) : base;
  }
}

/**
 * A live model server. POST `${url}/forecast` with the ForecastRequest; the answer is one library entry
 * with street ids instead of indexes in `reach` (docs/forecast_api.md). Anything else, or no answer within
 * `timeoutMs`, falls back to the precomputed forecast, and the result says so.
 */
export class LiveForecasts implements ForecastSource {
  readonly kind = 'live' as const;
  constructor(readonly url: string, readonly fallback: PrecomputedForecasts, readonly timeoutMs = 3000) {}
  async run(req: ForecastRequest): Promise<ForecastRun | null> {
    try {
      const res = await fetch(`${this.url.replace(/\/$/, '')}/forecast`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const f = (await res.json()) as LibraryForecast;
      if (Date.parse(f.issued_at) > req.at) throw new Error('forecast issued after the request time');
      return toRun(f, (id) => String(id), 'live');
    } catch (e) {
      const r = await this.fallback.run(req);
      return r && { ...r, sourceNote: `live model did not answer (${e instanceof Error ? e.message : e}); precomputed` };
    }
  }
}

/** A forecast the operator loaded, at scenario time `at`. */
export interface ForecastLoad {
  seq: number;
  at: number;
  run: ForecastRun;
  kind: 'history' | 'opening' | 'update' | 'rerun' | 'demo';
  /** E.g. "same perimeter, new weather". */
  label?: string;
}

/** The forecast in force at `now`: the last one loaded by then, or the forecast made at ignition. */
export function forecastInForce(loads: ForecastLoad[], ignition: ForecastRun | null, now: number): ForecastLoad | null {
  let best: ForecastLoad | null = null;
  for (const l of loads) if (l.at <= now && (!best || l.at > best.at || (l.at === best.at && l.seq > best.seq))) best = l;
  if (best) return best;
  return ignition && ignition.issuedAt <= now ? { seq: 0, at: ignition.issuedAt, run: ignition, kind: 'opening' } : null;
}

/**
 * What happened before the screen opened at `until` (another operator's shift): the forecast was updated at
 * every new satellite pass. From the opening time on, only the operator's own loads count.
 */
export function historyLoads(pre: PrecomputedForecasts, until: number, firstSeq = 1): ForecastLoad[] {
  return pre.runs.filter((r) => r.trigger === 'observation' && r.issuedAt <= until)
    .map((run, i) => ({ seq: firstSeq + i, at: run.issuedAt, run, kind: 'history' as const }));
}

/** Loads after a new one at `now`: later loads are dropped (the operator went back and decided again). */
export function loadAt(loads: ForecastLoad[], load: ForecastLoad): ForecastLoad[] {
  return [...loads.filter((l) => l.at <= load.at), load];
}

export interface ForecastClosure { at: number; runId: string; issuedAt: number; loadedAt: number }

/**
 * When each street is closed by a forecast, from the forecasts in force over time: a forecast is in force
 * from when it was loaded until the next load, and closes the streets its contour reaches in that time (a
 * street it reached before it was loaded closes when it is loaded). A closure stays once made.
 * Nothing at time T depends on loads after T.
 */
export function forecastClosures(loads: ForecastLoad[], ignition: ForecastRun | null): Map<string, ForecastClosure> {
  const seq = [...(ignition ? [{ seq: 0, at: ignition.issuedAt, run: ignition, kind: 'opening' as const }] : []),
    ...[...loads].sort((a, b) => a.at - b.at || a.seq - b.seq)];
  const out = new Map<string, ForecastClosure>();
  seq.forEach((l, i) => {
    const until = seq[i + 1]?.at ?? Infinity;
    for (const [id, reachAt] of l.run.reach) {
      const at = Math.max(reachAt, l.at);
      if (at >= until) continue;
      const old = out.get(id);
      if (!old || at < old.at) out.set(id, { at, runId: l.run.id, issuedAt: l.run.issuedAt, loadedAt: l.at });
    }
  });
  return out;
}

/**
 * Puts the forecast closures into the street records: `tm` (forecast) next to `ts` (satellite), and the
 * combined `status` / `t` that routing and the map read.
 */
export function applyForecastClosures(streets: StreetFeature[], closures: Map<string, ForecastClosure>,
  fmt: (t: number) => string): void {
  for (const f of streets) {
    const p = f.properties;
    p.status0 ??= p.status === 'blocked' ? (p.status_before ?? 'open') : p.status;
    const c = closures.get(p.id);
    p.tm = c ? c.at : NEVER;
    p.model_reason = c ? `forecast issued ${fmt(c.issuedAt)}, loaded ${fmt(c.loadedAt)} (P ≥ 50 %, 150 m safety buffer), reaches this street` : undefined;
    p.model_forecast_issued_at = c ? new Date(c.issuedAt).toISOString() : undefined;
    const first = Math.min(p.tm, p.ts ?? NEVER);
    if (first < NEVER) {
      p.status = 'blocked';
      p.before = p.status0;
      p.t = first;
    } else {
      p.status = p.status0;
      p.before = p.status0;
      p.t = 0;
    }
  }
}

/** A satellite pass the forecast in force has not used: fine-resolution observations acquired after it. */
export interface NewObservation { at: number; label: string }

/** VIIRS and Sentinel-2 burned-area passes acquired after the forecast's last observation, up to `now`. */
export function newObservations(fire: (FireFront & { t: number })[], run: ForecastRun | null, now: number): NewObservation[] {
  const since = run ? Math.max(run.lastObsAt ?? -Infinity, run.trigger === 'ignition' ? run.issuedAt : -Infinity) : -Infinity;
  const passes = new Map<number, string>();
  for (const p of fire) {
    if (p.kind !== 'observed' || p.t <= since || p.t > now) continue;
    if (!(p.instrument === 'VIIRS' || p.observation_type === 'burned_area')) continue;
    passes.set(p.t, obsLabel(p));
  }
  return [...passes].sort((a, b) => a[0] - b[0]).map(([at, label]) => ({ at, label }));
}

const SAT_NAME: Record<string, string> = { N: 'S-NPP', N20: 'N20', N21: 'N21' };
export function obsLabel(p: FireFront): string {
  if (p.observation_type === 'burned_area' || p.observation_type === 'flame_front') return `Sentinel-2 ${p.observation_type.replace('_', ' ')}`;
  return `${p.instrument} ${SAT_NAME[p.satellite ?? ''] ?? p.satellite ?? ''}`.trim();
}
