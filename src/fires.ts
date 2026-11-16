/**
 * Operator-confirmed fires: a fire the operator adds from a crew, a drone, a caller or another source. It goes into
 * the next forecast (computed in the browser) and is drawn apart from the model and the satellites. Like everything
 * on the screen it follows the clock: shown from the scenario time it was added, at its position for the time
 * shown (it can be moved), and gone from the time it was deleted.
 */
import type { Polygon } from 'geojson';
import { circle } from './reports';

export type FireSource = 'crew' | 'drone' | 'caller' | 'other';
export type FireSize = 'point' | '100m' | '500m' | 'drawn';

export const SOURCE_LABEL: Record<FireSource, string> = { crew: 'field crew', drone: 'drone', caller: 'caller', other: 'other' };
/** Sizes are diameters (across the fire): a disc of 60 m (one model cell), 100 m or 500 m. */
export const SIZE_LABEL: Record<FireSize, string> = { point: 'point (~60 m)', '100m': 'about 100 m', '500m': 'about 500 m', drawn: 'drawn area' };
/** Radius of the disc for each size: half the diameter in SIZE_LABEL (a point is one model cell, 60 m across). */
const RADIUS_M: Record<Exclude<FireSize, 'drawn'>, number> = { point: 30, '100m': 50, '500m': 250 };
/** How far back the observation time may be set. */
export const MAX_OBSERVED_AGO_MIN = 120;

export interface OperatorFire {
  id: string;
  source: FireSource;
  size: FireSize;
  note: string;
  /** When the fire was seen (at most 2 h before it was added) and when the operator confirmed it (scenario time). */
  observedAt: number;
  addedAt: number;
  /** Position over time: the geometry from each time on (moves add a version). */
  versions: { at: number; geometry: Polygon }[];
  deletedAt?: number;
}

/** Half width of the strip drawn from two clicks (a fire line one model cell wide). */
const STRIP_HALF_M = 30;
/** Clicks needed for each kind of drawn area: two give a strip (a fire line), three or more the polygon. */
export const MIN_DRAWN_POINTS = 2;

/** Centre of the clicked points (vertex average). */
export function clickCentre(vertices: [number, number][]): [number, number] {
  return [vertices.reduce((a, v) => a + v[0], 0) / vertices.length, vertices.reduce((a, v) => a + v[1], 0) / vertices.length];
}

const KX = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180), KY = 110574;

/** True when two edges of the closed ring through `v` cross (a bow-tie: the corners were tapped out of order). */
export function selfCrossing(v: [number, number][]): boolean {
  const n = v.length;
  if (n < 4) return false;
  const o = (a: number[], b: number[], c: number[]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;                 // neighbours share a corner
    const [a, b, c, d] = [v[i], v[(i + 1) % n], v[j], v[(j + 1) % n]];
    if (o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)) return true;
  }
  return false;
}

/**
 * The corners of a drawn area in an order that makes a plain polygon: as tapped when its edges do not cross;
 * otherwise sorted by direction around their middle (the same corners, no bow-tie). `reordered` says which.
 */
export function untangle(v: [number, number][]): { vertices: [number, number][]; reordered: boolean } {
  if (!selfCrossing(v)) return { vertices: v, reordered: false };
  const [cx, cy] = clickCentre(v), kx = KX(cy);
  const sorted = [...v].sort((p, q) => Math.atan2((p[1] - cy) * KY, (p[0] - cx) * kx) - Math.atan2((q[1] - cy) * KY, (q[0] - cx) * kx));
  return { vertices: sorted, reordered: true };
}

/**
 * The area of a new fire. Drawn: the polygon through the tapped corners (three or more; put in order when its edges
 * would cross), or a 60 m wide strip between two corners. Point / 100 m / 500 m: one disc at the centre of the clicks.
 */
export function fireGeometry(vertices: [number, number][], size: FireSize): Polygon {
  if (size === 'drawn' && vertices.length >= 3) { const v = untangle(vertices).vertices; return { type: 'Polygon', coordinates: [[...v, v[0]]] }; }
  if (size === 'drawn' && vertices.length === 2) {
    const [[x0, y0], [x1, y1]] = vertices;
    const kx = KX((y0 + y1) / 2), ky = KY;
    const dx = (x1 - x0) * kx, dy = (y1 - y0) * ky, len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * STRIP_HALF_M / kx, ny = (dx / len) * STRIP_HALF_M / ky;
    return { type: 'Polygon', coordinates: [[[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny], [x0 + nx, y0 + ny]]] };
  }
  const [lon, lat] = clickCentre(vertices);
  return circle(lon, lat, RADIUS_M[size === 'drawn' ? 'point' : size], 32);
}

/** The fires on the map at `t`, each with its geometry at `t`. */
export function firesAt(fires: OperatorFire[], t: number): (OperatorFire & { geometry: Polygon })[] {
  return fires.filter((f) => f.addedAt <= t && !(f.deletedAt != null && f.deletedAt <= t))
    .map((f) => ({ ...f, geometry: [...f.versions].reverse().find((v) => v.at <= t)!.geometry }));
}

/** Fires after an operator action at `t`: anything done later on the timeline is dropped (the operator went back). */
export function rewriteFires(fires: OperatorFire[], t: number): OperatorFire[] {
  return fires.filter((f) => f.addedAt <= t).map((f) => ({
    ...f, versions: f.versions.filter((v) => v.at <= t), deletedAt: f.deletedAt != null && f.deletedAt > t ? undefined : f.deletedAt,
  }));
}

/** Moves a polygon by (dLon, dLat). */
export function translate(g: Polygon, dLon: number, dLat: number): Polygon {
  return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(([x, y]) => [x + dLon, y + dLat])) };
}

/** Centre of a polygon's outer ring (vertex average), for the label and the drag handle. */
export function centre(g: Polygon): [number, number] {
  const r = g.coordinates[0].slice(0, -1);
  return [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
}

/** The version of a fire in force at `t` ("id@time"): a forecast made from it is out of date once the fire moves. */
export function fireKey(f: OperatorFire, t: number): string {
  return `${f.id}@${[...f.versions].reverse().find((v) => v.at <= t)?.at ?? f.addedAt}`;
}

/** True when the point is inside a (multi)polygon (even-odd over all rings, so holes count as outside). */
export function pointIn(geom: GeoJSON.Geometry | null | undefined, [x, y]: [number, number] | number[]): boolean {
  const polys = geom?.type === 'Polygon' ? [geom.coordinates] : geom?.type === 'MultiPolygon' ? geom.coordinates : [];
  let ins = false;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
  }
  return ins;
}

/** Where a fire lies against the fire model's area: all of it inside, part of it, or none (then it cannot be spread). */
export function fireInModel(g: Polygon, modelArea: Polygon | null): 'inside' | 'partly' | 'outside' | 'unknown' {
  if (!modelArea) return 'unknown';
  const pts = [centre(g), ...g.coordinates[0]];
  const n = pts.filter((p) => pointIn(modelArea, p)).length;
  return n === pts.length ? 'inside' : n === 0 ? 'outside' : 'partly';
}

/** Roads are closed this close to an operator-confirmed fire (the forecast's safety buffer). */
export const FIRE_CLOSURE_BUFFER_M = 150;

/**
 * Streets closed by operator-confirmed fires themselves, whatever the model says: every street inside a fire or within
 * FIRE_CLOSURE_BUFFER_M of it, from the time the fire was added (or moved there). Fires the operator deleted close
 * nothing. Returns street id -> { at, fire }.
 */
export function fireClosures(fires: OperatorFire[], streets: { properties: { id: string }; geometry: GeoJSON.LineString | GeoJSON.MultiLineString }[]):
  Map<string, { at: number; fireId: string }> {
  const out = new Map<string, { at: number; fireId: string }>();
  for (const f of fires) {
    if (f.deletedAt != null) continue;
    for (const v of f.versions) {
      const ring = v.geometry.coordinates[0];
      const lat0 = ring[0][1], kx = KX(lat0);
      const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
      const pad = FIRE_CLOSURE_BUFFER_M;
      const box = [Math.min(...xs) - pad / kx, Math.min(...ys) - pad / KY, Math.max(...xs) + pad / kx, Math.max(...ys) + pad / KY];
      const near = ([x, y]: number[]) => {
        if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) return false;
        if (pointIn(v.geometry, [x, y])) return true;
        for (let i = 1; i < ring.length; i++) {
          const ax = (ring[i - 1][0] - x) * kx, ay = (ring[i - 1][1] - y) * KY, bx = (ring[i][0] - x) * kx, by = (ring[i][1] - y) * KY;
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
          const t = L ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / L)) : 0;
          if (Math.hypot(ax + t * dx, ay + t * dy) <= pad) return true;
        }
        return false;
      };
      for (const s of streets) {
        const have = out.get(s.properties.id);
        if (have && have.at <= v.at) continue;
        const lines = s.geometry.type === 'LineString' ? [s.geometry.coordinates] : s.geometry.coordinates;
        let hit = false;
        for (const line of lines) {
          for (let i = 0; i < line.length && !hit; i++) {
            if (near(line[i])) { hit = true; break; }
            if (i === 0) continue;
            // Long segments: sampled every 40 m, so a road crossing the fire between two vertices is found.
            const len = Math.hypot((line[i][0] - line[i - 1][0]) * kx, (line[i][1] - line[i - 1][1]) * KY);
            for (let k = 1; k < Math.floor(len / 40) && !hit; k++) {
              const t = (k * 40) / len;
              if (near([line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])])) hit = true;
            }
          }
          if (hit) break;
        }
        if (hit) out.set(s.properties.id, { at: v.at, fireId: f.id });
      }
    }
  }
  return out;
}
