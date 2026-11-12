/**
 * Crew routing on the street graph of the scenario.
 *
 * The graph is the same OpenStreetMap network the fire tool's road-closure calculation ran on:
 * every StreetAccess feature is an edge between junction nodes `u` and `v`. A route avoids every
 * street that is `blocked` at the current scenario time.
 *
 * Assumptions (shown in the UI as "drive time, free-flow"):
 * - speeds per road class as in the fire repo's `evacuation.default_speeds_kmh`; `service` (20 km/h)
 *   and `track` (15 km/h) are our own values for a fire engine on minor and forest roads;
 * - one-way restrictions are ignored (emergency vehicle);
 * - no turn-out time and no congestion.
 */
import { statusAt } from './data';
import type { CallerReport, Responder, StreetFeature } from './types';

export const SPEED_KMH: Record<string, number> = {
  motorway: 90, motorway_link: 60, trunk: 70, trunk_link: 50, primary: 60, primary_link: 45,
  secondary: 50, secondary_link: 40, tertiary: 40, tertiary_link: 30, residential: 30,
  living_street: 15, unclassified: 30, service: 20, track: 15,
};
const DEFAULT_SPEED_KMH = 25;

interface Arc { to: number; edge: number; minutes: number }

export interface Graph {
  streets: StreetFeature[];
  adjacency: Map<number, Arc[]>;
  nodeXY: Map<number, [number, number]>;
}

export interface RoutePlan {
  responderId: string;
  responderName: string;
  edgeIds: string[];
  minutes: number;
  km: number;
  /** Scenario time (epoch ms) the route was computed for. */
  computedAt: number;
  /** The caller's own street is blocked: the crew stops at its nearest reachable end. */
  lastStretchBlocked: boolean;
  /** Metres from the end of the route to the caller (walked when the last stretch is blocked). */
  lastStretchM: number;
}

function lengthM(coords: number[][]): number {
  let m = 0;
  for (let i = 1; i < coords.length; i++) {
    const k = Math.cos((((coords[i][1] + coords[i - 1][1]) / 2) * Math.PI) / 180);
    m += Math.hypot((coords[i][0] - coords[i - 1][0]) * k, coords[i][1] - coords[i - 1][1]) * 111195;
  }
  return m;
}

export function buildGraph(streets: StreetFeature[]): Graph {
  const adjacency = new Map<number, Arc[]>();
  const nodeXY = new Map<number, [number, number]>();
  streets.forEach((s, edge) => {
    const p = s.properties;
    if (p.u == null || p.v == null || s.geometry.type !== 'LineString') return;
    const coords = s.geometry.coordinates;
    const metres = p.length_m ?? lengthM(coords);
    const minutes = (metres / 1000 / (SPEED_KMH[p.highway ?? ''] ?? DEFAULT_SPEED_KMH)) * 60;
    nodeXY.set(p.u, coords[0] as [number, number]);
    nodeXY.set(p.v, coords[coords.length - 1] as [number, number]);
    for (const [a, b] of [[p.u, p.v], [p.v, p.u]]) {
      if (!adjacency.has(a)) adjacency.set(a, []);
      adjacency.get(a)!.push({ to: b, edge, minutes });
    }
  });
  return { streets, adjacency, nodeXY };
}

function metresBetween(a: [number, number], b: [number, number]): number {
  const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111195;
}

/** Index of the street nearest to a point (by vertex distance), optionally only among passable streets. */
function nearestEdge(g: Graph, p: [number, number], usable?: (edge: number) => boolean): number {
  let best = -1, bestD = Infinity;
  g.streets.forEach((s, i) => {
    if (s.geometry.type !== 'LineString' || s.properties.u == null) return;
    if (usable && !usable(i)) return;
    for (const c of s.geometry.coordinates) {
      const d = metresBetween(p, c as [number, number]);
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  return best;
}

/** Minimal binary heap of [cost, node]. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(x: [number, number]) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a; const top = a[0]; const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Fastest crew to a caller at scenario time `now`, avoiding blocked streets.
 * Returns null when no responder can reach the caller's street by road.
 */
export function planRoute(g: Graph, caller: CallerReport, responders: Responder[], now: number): RoutePlan | null {
  const blocked = (edge: number) => statusAt(g.streets[edge].properties, now) === 'blocked';
  const callerXY: [number, number] = [caller.place.lon, caller.place.lat];
  const target = nearestEdge(g, callerXY);
  if (target < 0) return null;
  const tp = g.streets[target].properties;
  const lastStretchBlocked = blocked(target);

  // Dijkstra outwards from both ends of the caller's street (the network is treated as undirected).
  const dist = new Map<number, number>();
  const via = new Map<number, Arc & { from: number }>();
  const heap = new Heap();
  for (const n of [tp.u!, tp.v!]) { dist.set(n, 0); heap.push([0, n]); }
  while (heap.size) {
    const [d, n] = heap.pop();
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const arc of g.adjacency.get(n) ?? []) {
      if (blocked(arc.edge)) continue;
      const nd = d + arc.minutes;
      if (nd < (dist.get(arc.to) ?? Infinity)) {
        dist.set(arc.to, nd);
        via.set(arc.to, { ...arc, from: n });
        heap.push([nd, arc.to]);
      }
    }
  }

  let best: RoutePlan | null = null;
  for (const r of responders) {
    // A station leaves by the nearest street that is passable now.
    const startEdge = nearestEdge(g, [r.place.lon, r.place.lat], (e) => !blocked(e));
    if (startEdge < 0) continue;
    const sp = g.streets[startEdge].properties;
    const start = [sp.u!, sp.v!].filter((n) => dist.has(n)).sort((a, b) => dist.get(a)! - dist.get(b)!)[0];
    if (start == null) continue;
    const minutes = dist.get(start)!;
    if (best && minutes >= best.minutes) continue;
    const edgeIds: string[] = [];
    let km = 0;
    for (let n = start; via.has(n); n = via.get(n)!.from) {
      const s = g.streets[via.get(n)!.edge].properties;
      edgeIds.push(s.id);
      km += (s.length_m ?? 0) / 1000;
    }
    let lastStretchM = metresBetween(g.nodeXY.get(lastNode(via, start)) ?? callerXY, callerXY);
    let total = minutes;
    if (!lastStretchBlocked) {
      // Drive the final stretch along the caller's own street.
      edgeIds.push(tp.id);
      km += lastStretchM / 1000;
      total += (lastStretchM / 1000 / (SPEED_KMH[tp.highway ?? ''] ?? DEFAULT_SPEED_KMH)) * 60;
      lastStretchM = 0;
    }
    best = { responderId: r.id, responderName: r.name, edgeIds, minutes: total, km, computedAt: now,
      lastStretchBlocked, lastStretchM };
  }
  return best;
}

function lastNode(via: Map<number, Arc & { from: number }>, start: number): number {
  let n = start;
  while (via.has(n)) n = via.get(n)!.from;
  return n;
}

/** Streets of a route that are blocked at `now` (empty = the route is still passable). */
export function cutStreets(route: RoutePlan, now: number, byId: Map<string, StreetFeature>): StreetFeature[] {
  const out: StreetFeature[] = [];
  for (const id of route.edgeIds) {
    const s = byId.get(id);
    if (s && statusAt(s.properties, now) === 'blocked') out.push(s);
  }
  return out;
}
