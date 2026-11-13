import type { CallerReport, FileMeta, FireFront, FireMeta, Responder, ScenarioData, ScenarioEntry, StreetAccess, StreetFeature, StreetStatus, Urgency } from './types';

const BASE = `${import.meta.env?.BASE_URL ?? '/'}scenarios/`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadIndex(): Promise<ScenarioEntry[]> {
  return (await getJson<{ scenarios: ScenarioEntry[] }>('index.json')).scenarios;
}

export async function loadScenario(entry: ScenarioEntry): Promise<ScenarioData> {
  const [fire, streets, callers, responders] = await Promise.all([
    getJson<ScenarioData['fire'] & { metadata?: FireMeta }>(entry.files.fire_front),
    getJson<ScenarioData['streets'] & { metadata?: FileMeta }>(entry.files.street_access),
    getJson<{ metadata?: FileMeta; records: CallerReport[] }>(entry.files.caller_reports),
    entry.files.responders
      ? getJson<{ metadata?: FileMeta; records: Responder[] }>(entry.files.responders)
      : Promise.resolve({ metadata: {} as FileMeta, records: [] as Responder[] }),
  ]);
  // MapLibre filters compare numbers, so each fire feature gets its time as epoch ms.
  prepareFire(fire.features.map((f) => f.properties));
  prepareStreets(streets.features);
  return {
    entry,
    fire,
    fireMeta: fire.metadata ?? {},
    streets,
    streetsMeta: streets.metadata ?? {},
    callers: callers.records,
    callersMeta: callers.metadata ?? {},
    responders: responders.records,
    respondersMeta: responders.metadata ?? {},
  };
}

/** "Never" as a number MapLibre filters can compare (Infinity does not survive GeoJSON). */
export const NEVER = 9e15;

export interface Closure {
  by: 'model' | 'satellite' | 'both';
  /** Source and time of the first closure. */
  firstBy: 'model' | 'satellite';
  since: number;
}

/** Who has closed a street by `now` (null = not blocked by the fire model or a satellite). */
export function closureAt(p: StreetAccess, now: number): Closure | null {
  const m = (p.tm ?? NEVER) <= now, s = (p.ts ?? NEVER) <= now;
  if (!m && !s) return null;
  const firstBy = s && (!m || p.ts! <= p.tm!) ? 'satellite' : 'model';
  return { by: m && s ? 'both' : m ? 'model' : 'satellite', firstBy, since: Math.min(m ? p.tm! : NEVER, s ? p.ts! : NEVER) };
}

/** "satellite (VIIRS N20)", "model", "model and satellite (VIIRS N20)". */
export function closureSource(p: StreetAccess, c: Closure): string {
  const sat = `satellite${p.satellite_source ? ` (${p.satellite_source})` : ''}`;
  return c.by === 'both' ? `model and ${sat}` : c.by === 'model' ? 'model' : sat;
}

/** A 1 km satellite pixel with fire covers the street at `now` and the street is not blocked. */
export function fireNearby(p: StreetAccess, now: number): boolean {
  return (p.tn ?? NEVER) <= now && statusAt(p, now) !== 'blocked';
}

/** Adds the derived fields of fire-front records: times as epoch ms, the forecast set and horizon rank. */
export function prepareFire(props: (FireFront & { t: number })[]): void {
  const byIssue = new Map<string, FireFront[]>();
  for (const p of props) {
    p.t = Date.parse(p.valid_at);
    if (p.kind !== 'forecast') continue;
    p.set = p.forecast_set ?? 'initial';
    p.issue_t = Date.parse(p.issued_at ?? p.model_run_at ?? p.valid_at);
    const key = `${p.set}|${p.issue_t}`;
    byIssue.set(key, [...(byIssue.get(key) ?? []), p]);
  }
  for (const group of byIssue.values()) {
    group.sort((a, b) => (a.horizon_hours ?? 0) - (b.horizon_hours ?? 0)).forEach((p, i) => { p.rank = Math.min(i, 2); });
  }
}

export interface CurrentForecast { issuedAt: number; from: string; set: 'initial' | 'update'; index: number; count: number;
  contours: (FireFront & { t: number })[] }

/**
 * The forecast in force at `now`: the latest update issued so far. A scenario without updates falls back
 * to its initial forecast.
 */
export function currentForecast(props: (FireFront & { t: number })[], now: number): CurrentForecast | null {
  const forecasts = props.filter((p) => p.kind === 'forecast');
  const set = forecasts.some((p) => p.set === 'update') ? 'update' : 'initial';
  const issues = [...new Set(forecasts.filter((p) => p.set === set).map((p) => p.issue_t!))].sort((a, b) => a - b);
  const past = issues.filter((t) => t <= now);
  if (!past.length) return null;
  const issuedAt = past[past.length - 1];
  const contours = forecasts.filter((p) => p.set === set && p.issue_t === issuedAt)
    .sort((a, b) => (a.horizon_hours ?? 0) - (b.horizon_hours ?? 0));
  return { issuedAt, from: contours[0]?.initialised_from ?? 'ignition point', set, index: past.length, count: issues.length, contours };
}

export const HORIZON_COLOURS = ['#fde047', '#fb923c', '#f97316'] as const;
export const INITIAL_FORECAST_COLOUR = '#93c5fd';

/** Adds the derived fields the screen works with: `t` (valid_at as epoch ms) and `before`. */
export function prepareStreets(features: StreetFeature[]): StreetFeature[] {
  for (const f of features) {
    f.properties.t = f.properties.valid_at ? Date.parse(f.properties.valid_at) : 0;
    f.properties.before = f.properties.status_before ?? (f.properties.valid_at ? 'open' : f.properties.status);
    const p = f.properties;
    const sat = p.satellite_blocked_at ? Date.parse(p.satellite_blocked_at) : NEVER;
    // Without per-source times a blocked street counts as one closure of its own basis.
    const model = p.model_blocked_at ? Date.parse(p.model_blocked_at)
      : p.status === 'blocked' && !p.satellite_blocked_at && p.basis !== 'satellite' ? p.t! : NEVER;
    p.tm = model;
    p.ts = sat === NEVER && p.status === 'blocked' && p.basis === 'satellite' ? p.t! : sat;
    p.tn = p.fire_nearby_at ? Date.parse(p.fire_nearby_at) : NEVER;
  }
  return features;
}

export const URGENCY_ORDER: Record<Urgency, number> = { life_threat: 0, urgent: 1, routine: 2 };
export const URGENCY_LABEL: Record<Urgency, string> = { life_threat: 'LIFE THREAT', urgent: 'URGENT', routine: 'ROUTINE' };
export const URGENCY_COLOUR: Record<Urgency, string> = { life_threat: '#f43f5e', urgent: '#fb923c', routine: '#60a5fa' };
export const STATUS_COLOUR = { open: '#22c55e', special_access: '#f59e0b', blocked: '#ef4444' } as const;
export const STATUS_SHORT = { open: 'Open', special_access: 'Special access', blocked: 'Blocked' } as const;
export const STATUS_LABEL = { open: 'Open (≥ 3 m)', special_access: 'Special access (2–3 m)', blocked: 'Blocked (< 2 m)' } as const;

/** Status of a street at `now`: `status` from `valid_at` on, `status_before` until then. */
export function statusAt(p: StreetAccess, now: number): StreetStatus {
  return (p.t ?? 0) <= now ? p.status : p.before ?? 'open';
}

/** Label of a data file: invented sample, model output or real data. */
export function fileKind(meta: FileMeta): 'synthetic' | 'model' | 'real' {
  return meta.synthetic === true ? 'synthetic' : meta.basis?.startsWith('fire_model') ? 'model' : 'real';
}

/** Tag text of a model-derived file: "MODEL + SATELLITE" when satellite detections are part of it. */
export function modelLabel(meta: FileMeta): string {
  return meta.label ?? (meta.basis?.includes('satellite') ? 'MODEL + SATELLITE' : 'MODEL OUTPUT');
}

/** Reports received up to `now`, most urgent first (operator-confirmed urgency wins), then newest first. */
export function visibleCallers(callers: CallerReport[], now: number, urgencyOf?: (c: CallerReport) => Urgency): CallerReport[] {
  const u = urgencyOf ?? ((c: CallerReport) => c.urgency);
  return callers
    .filter((c) => Date.parse(c.reported_at) <= now)
    .sort((a, b) => URGENCY_ORDER[u(a)] - URGENCY_ORDER[u(b)]
      || Date.parse(b.reported_at) - Date.parse(a.reported_at));
}

/** Name of a street; unnamed ones are described by the nearest place and a coordinate. */
export function streetLabel(p: StreetAccess): string {
  if (p.name) return p.name;
  const kind = p.highway === 'track' ? 'Forest track' : 'Unnamed road';
  const where = p.near_place
    ? ` ${(p.near_place_km ?? 0) < 0.5 ? 'at' : `${p.near_place_km} km from`} ${p.near_place}` : '';
  const at = p.label_point ? ` (${p.label_point[1].toFixed(4)}° N, ${p.label_point[0].toFixed(4)}° E)` : ` (way ${p.osm_way_id})`;
  return kind + where + at;
}

export const STAGE_LABEL = { new: 'NEW', taken: 'TAKEN', confirmed: 'CONFIRMED', dispatched: 'DISPATCHED' } as const;
export const STAGE_COLOUR = { new: '#8a9bb3', taken: '#e2e8f0', confirmed: '#a7f3d0', dispatched: '#22d3ee' } as const;

function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const k = Math.PI / 180;
  const x = (lon2 - lon1) * k * Math.cos(((lat1 + lat2) / 2) * k);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y) * 6371000;
}

/** Distance from a point to a polyline segment, in metres (local flat approximation). */
function segmentDistance(p: [number, number], a: number[], b: number[]): number {
  const k = Math.cos((p[1] * Math.PI) / 180);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return metres(0, 0, (ax + u * dx) / k, ay + u * dy);
}

/** Streets with any part within `radiusM` of the caller, nearest first. */
export function streetsNear(streets: StreetFeature[], caller: CallerReport, radiusM: number): { street: StreetFeature; dist: number }[] {
  const p: [number, number] = [caller.place.lon, caller.place.lat];
  const out: { street: StreetFeature; dist: number }[] = [];
  for (const s of streets) {
    const lines = s.geometry.type === 'LineString' ? [s.geometry.coordinates] : s.geometry.coordinates;
    let best = Infinity;
    for (const line of lines) for (let i = 1; i < line.length; i++) best = Math.min(best, segmentDistance(p, line[i - 1], line[i]));
    if (best <= radiusM) out.push({ street: s, dist: best });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

export function fmtTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
}

export function fmtAge(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} d`;
}
