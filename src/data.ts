import type { CallerReport, FileMeta, FireMeta, ScenarioData, ScenarioEntry, StreetAccess, StreetFeature, StreetStatus, Urgency } from './types';

const BASE = `${import.meta.env.BASE_URL}scenarios/`;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function loadIndex(): Promise<ScenarioEntry[]> {
  return (await getJson<{ scenarios: ScenarioEntry[] }>('index.json')).scenarios;
}

export async function loadScenario(entry: ScenarioEntry): Promise<ScenarioData> {
  const [fire, streets, callers] = await Promise.all([
    getJson<ScenarioData['fire'] & { metadata?: FireMeta }>(entry.files.fire_front),
    getJson<ScenarioData['streets'] & { metadata?: FileMeta }>(entry.files.street_access),
    getJson<{ metadata?: FileMeta; records: CallerReport[] }>(entry.files.caller_reports),
  ]);
  // MapLibre filters compare numbers, so each fire feature gets its time as epoch ms.
  for (const f of fire.features) f.properties.t = Date.parse(f.properties.valid_at);
  for (const f of streets.features) {
    f.properties.t = f.properties.valid_at ? Date.parse(f.properties.valid_at) : 0;
    f.properties.before = f.properties.status_before ?? (f.properties.valid_at ? 'open' : f.properties.status);
  }
  return {
    entry,
    fire,
    fireMeta: fire.metadata ?? {},
    streets,
    streetsMeta: streets.metadata ?? {},
    callers: callers.records,
    callersMeta: callers.metadata ?? {},
  };
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
  return meta.synthetic === true ? 'synthetic' : meta.basis === 'fire_model' ? 'model' : 'real';
}

/** Reports received up to `now`, most urgent first, then newest first. */
export function visibleCallers(callers: CallerReport[], now: number): CallerReport[] {
  return callers
    .filter((c) => Date.parse(c.reported_at) <= now)
    .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]
      || Date.parse(b.reported_at) - Date.parse(a.reported_at));
}

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
