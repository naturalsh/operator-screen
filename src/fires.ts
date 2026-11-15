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
export const SIZE_LABEL: Record<FireSize, string> = { point: 'point', '100m': 'about 100 m', '500m': 'about 500 m', drawn: 'drawn area' };
/** Radius of the disc for each size (a point is one model cell, 60 m). */
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

/** The area of a new fire: a disc for a point / 100 m / 500 m, or the drawn polygon (three clicks or more). */
export function fireGeometry(vertices: [number, number][], size: FireSize): Polygon {
  if (size === 'drawn' && vertices.length >= 3) return { type: 'Polygon', coordinates: [[...vertices, vertices[0]]] };
  const [lon, lat] = vertices.length >= 3
    ? [vertices.reduce((a, v) => a + v[0], 0) / vertices.length, vertices.reduce((a, v) => a + v[1], 0) / vertices.length]
    : vertices[0];
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
