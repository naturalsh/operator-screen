/**
 * The forecast in force: updated automatically at every new satellite pass, and by the operator's "Update forecast".
 *
 * At each new VIIRS / Sentinel-2 observation the forecast started from it is loaded automatically (`autoLoads`);
 * in between the operator can re-run it with the current weather. Where a forecast comes from is a `ForecastSource`:
 * - `PrecomputedForecasts`: the scenario's forecast library (tools/build_forecast_library.py), one forecast
 *   at ignition, at every new VIIRS / Sentinel-2 observation and every 30 minutes; works on a static site.
 * - `LiveForecasts`: a model server (FastAPI on localhost, docs/forecast_api.md). Not set up yet; used only
 *   with `?forecast_api=<url>`, and it falls back to the precomputed forecast when the server does not answer.
 */
import type { Geometry } from 'geojson';
import type { ConceptReports, FireFront, ForecastLibrary, LibraryForecast, StreetFeature } from './types';
import { NEVER } from './data';
import { withTimeout } from './latest';

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
  /** Street id -> time (epoch ms) at which the P >= 50 % contour reaches it, to the half hour, within 12 h. */
  reach: Map<string, number>;
  /** precomputed: the library; live: a model server; browser: the in-browser model (src/spread). */
  source: 'precomputed' | 'live' | 'browser';
  /** E.g. why the live model was not used. */
  sourceNote?: string;
  /** FireFront features of the shown horizons (+30 min / +1 / +2 / +3 / +6 h). */
  features: GeoJSON.Feature<Geometry, FireFront & { t: number }>[];
  /** Every contour of the forecast, horizon 0 (the area it started from) and then every 30 minutes to 12 h. */
  steps: { horizon: number; validAt: number; areaKm2: number; geometry: Geometry }[];
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
  /** `signal`: aborted when a newer request replaces this one (see LatestRequest). */
  run(req: ForecastRequest, signal?: AbortSignal): Promise<ForecastRun | null>;
}

/** One library entry (or a live server's answer, which has the same shape) as a ForecastRun. */
export function toRun(f: LibraryForecast, streetIds: (i: number | string) => string, source: ForecastRun['source']): ForecastRun {
  const issuedAt = Date.parse(f.issued_at);
  // Library records mark the shown horizons; a record without the mark (older or live) shows all its contours > 0.
  const marked = f.contours.some((c) => c.shown);
  const shown = f.contours.filter((c) => (marked ? c.shown : c.horizon_hours > 0));
  const features = shown.map((c, rank) => ({
    type: 'Feature' as const,
    geometry: c.geometry as Geometry,
    properties: {
      id: `${f.id}-h${c.horizon_hours}`, kind: 'forecast', forecast_set: 'update', set: 'update',
      issued_at: f.issued_at, model_run_at: f.issued_at, valid_at: c.valid_at, horizon_hours: c.horizon_hours,
      probability: 0.5, area_km2: c.area_km2, initialised_from: f.initialised_from,
      last_observation_at: f.last_observation_at, source: source === 'live' ? 'live model' : 'precomputed forecast',
      t: Date.parse(c.valid_at), issue_t: issuedAt, rank: Math.min(rank, 3), run_id: f.id,
    } as unknown as FireFront & { t: number },
  }));
  return {
    id: f.id, issuedAt, trigger: f.trigger, from: f.initialised_from,
    lastObsAt: f.last_observation_at ? Date.parse(f.last_observation_at) : null,
    lastObsLabel: f.last_observation_label ?? null, startAreaKm2: f.start_area_km2,
    contours: shown.map((c) => ({ horizon: c.horizon_hours, validAt: Date.parse(c.valid_at), areaKm2: c.area_km2 })),
    steps: f.contours.map((c) => ({ horizon: c.horizon_hours, validAt: Date.parse(c.valid_at), areaKm2: c.area_km2, geometry: c.geometry as Geometry }))
      .sort((a, b) => a.horizon - b.horizon),
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
  async run(req: ForecastRequest, signal?: AbortSignal): Promise<ForecastRun | null> {
    try {
      const res = await fetch(`${this.url.replace(/\/$/, '')}/forecast`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req),
        signal: withTimeout(signal, this.timeoutMs),
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

/** A forecast loaded at scenario time `at`: automatically at a new pass (`auto`, seq 0) or by the operator. */
export interface ForecastLoad {
  seq: number;
  at: number;
  run: ForecastRun;
  kind: 'auto' | 'opening' | 'update' | 'rerun' | 'demo';
  /** E.g. "same perimeter, new weather". */
  label?: string;
  /** Said instead of the "+6 h ... km² (was ...)" comparison when that would mislead (a fire added inside it). */
  note?: string;
}

/** The forecast in force at `now`: the last one loaded by then, or the forecast made at ignition. */
export function forecastInForce(loads: ForecastLoad[], ignition: ForecastRun | null, now: number): ForecastLoad | null {
  let best: ForecastLoad | null = null;
  for (const l of loads) if (l.at <= now && (!best || l.at > best.at || (l.at === best.at && l.seq > best.seq))) best = l;
  if (best) return best;
  return ignition && ignition.issuedAt <= now ? { seq: 0, at: ignition.issuedAt, run: ignition, kind: 'opening' } : null;
}

/**
 * The automatic updates: at every new VIIRS / Sentinel-2 pass, the forecast started from it, loaded at the pass
 * time. CONCEPT DEMO: a report cluster the operator confirmed by then goes into it (`confirmations`: cluster ->
 * scenario time of the confirmation). Each load only depends on what was known at its time.
 */
export function autoLoads(pre: PrecomputedForecasts, confirmations?: Map<string, number>): ForecastLoad[] {
  return pre.runs.filter((r) => r.trigger === 'observation').map((run) => {
    const confirmed = [...(confirmations ?? new Map<string, number>())].filter(([, at]) => at <= run.issuedAt).map(([id]) => id);
    return { seq: 0, at: run.issuedAt, run: confirmed.length ? pre.withConfirmed(run, confirmed) : run, kind: 'auto' as const };
  });
}

/** "new VIIRS pass", "new Sentinel-2 image": what triggered an automatic update. */
export function autoLabel(run: ForecastRun): string {
  return run.lastObsLabel?.startsWith('Sentinel-2') ? 'new Sentinel-2 image' : `new ${run.lastObsLabel?.split(' ')[0] ?? 'satellite'} pass`;
}

/** Operator loads after a new one at `now`: later ones are dropped (the operator went back and decided again). */
export function loadAt(loads: ForecastLoad[], load: ForecastLoad): ForecastLoad[] {
  return [...loads.filter((l) => l.at <= load.at), load];
}

export interface ForecastClosure {
  at: number; runId: string; issuedAt: number; loadedAt: number;
  /** Set for a closure that does not come from a forecast contour (an operator-confirmed fire on the street). */
  reason?: string;
}

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
    p.model_reason = c ? c.reason ?? `forecast issued ${fmt(c.issuedAt)}, loaded ${fmt(c.loadedAt)} (P ≥ 50 %, 150 m safety buffer), reaches this street` : undefined;
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

/** Look-ahead horizons (hours from the time shown): one is drawn at a time, chosen with the "Look ahead" switch. */
export const NOWCAST_HORIZONS = [0.5, 1, 2, 3, 6] as const;
/** Parts of the estimated fire smaller than this, apart from the main fire, are drawn as small marks, not a front. */
export const SMALL_PART_KM2 = 0.3;

export interface NowcastFeatureProps {
  /** 'obs': the fire edge the satellites last saw; 'now': the estimated fire now (its main parts); 'spot': a small
   * separate part of it (a point); 'h0.5' ... 'h6': the expected fire edge that many hours from now. */
  role: string;
  /** Hours from the time shown (0 for "fire now" and the observation). */
  h: number;
  /** Time the contour is for (epoch ms; for 'obs' the pass time), the forecast's issue time and its hours after it. */
  valid_t: number;
  issue_t: number;
  /** For 'now' / 'nowop' (one feature per part of the fire): that part's area and the width of its front band. */
  part_km2?: number;
  band_m?: number;
  /** The largest part of "fire now": the one that carries its label. */
  main?: boolean;
  step: number;
  area_km2: number;
  run_id: string;
}

export interface Nowcast {
  run: ForecastRun;
  /** The contour drawn as "Fire now": the forecast's last 30-minute step not after the time shown. */
  stepAt: number;
  /** Hours since the forecast was issued. */
  elapsedH: number;
  /** Horizons from the time shown that the forecast covers (it runs 12 h). */
  horizons: number[];
  /** Horizons beyond the forecast (Update forecast re-runs from the fire now). */
  beyond: number[];
  /** The latest satellite observation of the fire edge (null before the first pass). */
  observed: { at: number; label: string } | null;
  fc: GeoJSON.FeatureCollection<Geometry, NowcastFeatureProps>;
}

type Ring = number[][];
/** Area of a polygon (outer ring minus holes) in km², flat approximation at its latitude. */
function polygonKm2(rings: Ring[]): number {
  const lat = rings[0][0][1] * Math.PI / 180;
  const kx = 111.32 * Math.cos(lat), ky = 110.57;
  const ring = (r: Ring) => Math.abs(r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2 * kx * ky;
  return ring(rings[0]) - rings.slice(1).reduce((a, h) => a + ring(h), 0);
}

export const FRONT_WIDTH_M = 300;
/** The band is at most this share of the fire's equivalent radius (a small fire gets a narrow band)... */
export const FRONT_SHARE_OF_RADIUS = 0.2;
/** ...and below this width only an edge line is drawn. */
export const FRONT_MIN_M = 25;

/** Width of the front band for a fire of `areaKm2`: 20 % of the equivalent radius, at most 300 m; 0 = edge only. */
export function frontWidthM(areaKm2: number): number {
  const w = Math.min(FRONT_WIDTH_M, FRONT_SHARE_OF_RADIUS * Math.sqrt((areaKm2 * 1e6) / Math.PI));
  return w >= FRONT_MIN_M ? w : 0;
}

const inRing = (r: Ring, [x, y]: number[]) => {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
};

/**
 * The main parts of a fire area, and the small separate parts (< SMALL_PART_KM2): as points, except those that hold
 * one of the `keep` points (operator-confirmed fires), which stay areas (`kept`) however small. A point for such a
 * part hid its growth and wandered as the part grew.
 */
export function splitParts(g: Geometry, keep: number[][] = []): { main: Geometry | null; kept: Geometry | null; spots: [number, number][] } {
  const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []) as Ring[][];
  if (!polys.length) return { main: null, kept: null, spots: [] };
  const sized = polys.map((p) => ({ p, km2: polygonKm2(p) }));
  const largest = sized.reduce((a, b) => (b.km2 > a.km2 ? b : a));
  const main = sized.filter((x) => x.km2 >= SMALL_PART_KM2 || x === largest).map((x) => x.p);
  const small = sized.filter((x) => !main.includes(x.p)).map((x) => x.p);
  const kept = small.filter((p) => keep.some((k) => inRing(p[0], k)));
  const spots = small.filter((p) => !kept.includes(p)).map((p) => {
    const r = p[0];
    return [r.reduce((a, c) => a + c[0], 0) / r.length, r.reduce((a, c) => a + c[1], 0) / r.length] as [number, number];
  });
  const geom = (ps: Ring[][]): Geometry | null => (!ps.length ? null : ps.length === 1 ? { type: 'Polygon', coordinates: ps[0] } : { type: 'MultiPolygon', coordinates: ps });
  return { main: geom(main), kept: geom(kept), spots };
}

/**
 * "Fire now (model estimate)": the forecast in force advanced from its issue time to `now`; the look-ahead horizons
 * from there; and `observed`, the latest observation-started forecast by `now`, whose starting area is the fire edge
 * the satellites (VIIRS + Sentinel-2) have seen. Only forecasts issued by `now` are used, so nothing here comes from
 * later than the time shown. `keep`: places of operator-confirmed fires; the parts of the forecast holding one are
 * always drawn as areas.
 */
export function nowcastAt(run: ForecastRun | null, now: number, observed?: ForecastRun | null, keep: number[][] = []): Nowcast | null {
  if (!run || run.issuedAt > now || !run.steps.length) return null;
  const elapsedH = (now - run.issuedAt) / 3600000;
  const at = (h: number) => run.steps.find((s) => Math.abs(s.horizon - h) < 1e-6);
  const max = run.steps[run.steps.length - 1].horizon;
  const k = Math.min(Math.floor(elapsedH * 2 + 1e-9) / 2, max);
  const base = at(k) ?? run.steps.filter((s) => s.horizon <= k).pop() ?? run.steps[0];
  const features: GeoJSON.Feature<Geometry, NowcastFeatureProps>[] = [];
  const horizons: number[] = [];
  const beyond: number[] = [];
  const props = (role: string, h: number, s: ForecastRun['steps'][number]) => ({
    role, h, valid_t: s.validAt, issue_t: run.issuedAt, step: s.horizon, area_km2: s.areaKm2, run_id: run.id });
  for (const h of [...NOWCAST_HORIZONS].reverse()) {
    const s = at(base.horizon + h);
    if (!s) { beyond.push(h); continue; }
    horizons.push(h);
    // The look-ahead line: the main parts, and the small parts grown from operator-confirmed fires.
    const { main, kept } = splitParts(s.geometry, keep);
    const polys = [main, kept].flatMap((x) => (!x ? [] : x.type === 'Polygon' ? [x.coordinates] : (x as GeoJSON.MultiPolygon).coordinates));
    if (polys.length) features.push({ type: 'Feature', geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }, properties: props(`h${h}`, h, s) });
  }
  const { main, kept, spots } = splitParts(base.geometry, keep);
  // One feature per part, each with its own front band (20 % of that part's radius): a small fire beside a large one
  // must not get the large one's 300 m band. The largest comes first and carries the "Fire now" label. Small parts
  // grown from operator-confirmed fires are areas too (role "nowop"), with an edge line instead of a band.
  const partsOf = (g: Geometry | null) => (!g ? [] : g.type === 'Polygon' ? [g.coordinates] : (g as GeoJSON.MultiPolygon).coordinates) as Ring[][];
  partsOf(main).map((p) => ({ p, km2: polygonKm2(p) })).sort((a, b) => b.km2 - a.km2).forEach(({ p, km2 }, i) => features.push({ type: 'Feature',
    geometry: { type: 'Polygon', coordinates: p }, properties: { ...props('now', 0, base), part_km2: km2, band_m: frontWidthM(km2), main: i === 0 } }));
  for (const p of partsOf(kept)) features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: p },
    properties: { ...props('nowop', 0, base), part_km2: polygonKm2(p), band_m: 0 } });
  for (const c of spots) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: props('spot', 0, base) });
  let seen: Nowcast['observed'] = null;
  if (observed && observed.issuedAt <= now && observed.lastObsAt != null && observed.steps[0]?.horizon === 0) {
    seen = { at: observed.lastObsAt, label: observed.lastObsLabel ?? 'satellite' };
    features.push({ type: 'Feature', geometry: observed.steps[0].geometry, properties: {
      role: 'obs', h: 0, valid_t: observed.lastObsAt, issue_t: observed.issuedAt, step: 0, area_km2: observed.steps[0].areaKm2, run_id: observed.id } });
  }
  return { run, stepAt: base.validAt, elapsedH, horizons: horizons.reverse(), beyond: beyond.reverse(), observed: seen,
    fc: { type: 'FeatureCollection', features } };
}

/** "+30 min", "+1 h". */
export function lookLabel(h: number): string {
  return h < 1 ? `+${Math.round(h * 60)} min` : `+${h} h`;
}

/** "estimate, not observed: last satellite pass at 04:02 (VIIRS N20) + model". */
export function nowcastSource(run: ForecastRun, fmt: (t: number) => string): string {
  return run.lastObsAt != null
    ? `estimate, not observed: last satellite pass at ${fmt(run.lastObsAt)} (${run.lastObsLabel}) + model`
    : 'estimate, not observed: ignition point + model (no satellite pass yet)';
}
