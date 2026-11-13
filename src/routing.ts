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
  /** Part of the route on forest tracks (slow, and not every vehicle can use them). */
  trackKm: number;
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
    if (p.u == null || p.v == null || s.geometry.type !== 'LineString' || s.geometry.coordinates.length < 2) return;
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

/** Dijkstra outwards from `sources` over passable streets (the network is treated as undirected). */
function reach(g: Graph, sources: number[], blocked: (edge: number) => boolean) {
  const dist = new Map<number, number>();
  const via = new Map<number, Arc & { from: number }>();
  const heap = new Heap();
  for (const n of sources) { dist.set(n, 0); heap.push([0, n]); }
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
  return { dist, via };
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

  const { dist, via } = reach(g, [tp.u!, tp.v!], blocked);
  const options = stationOptions(g, responders, dist, via, blocked);
  if (!options.length) return null;
  // Every option ends with the same final stretch, so the fastest drive to the street is the fastest overall.
  const o = options.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  let { minutes, km } = o;
  const edgeIds = [...o.edgeIds];
  let lastStretchM = metresBetween(g.nodeXY.get(o.endNode) ?? callerXY, callerXY);
  if (!lastStretchBlocked) {
    // Drive the final stretch along the caller's own street.
    edgeIds.push(tp.id);
    km += lastStretchM / 1000;
    minutes += (lastStretchM / 1000 / (SPEED_KMH[tp.highway ?? ''] ?? DEFAULT_SPEED_KMH)) * 60;
    if (tp.highway === 'track') o.trackKm += lastStretchM / 1000;
    lastStretchM = 0;
  }
  return { responderId: o.responder.id, responderName: o.responder.name, edgeIds, minutes, km, trackKm: o.trackKm,
    computedAt: now, lastStretchBlocked, lastStretchM };
}

interface StationOption { responder: Responder; minutes: number; km: number; trackKm: number; edgeIds: string[]; endNode: number }

/** Drive from every response point to the caller's street (to its nearer reachable end), blocked streets avoided. */
function stationOptions(g: Graph, responders: Responder[], dist: Map<number, number>,
  via: Map<number, Arc & { from: number }>, blocked: (edge: number) => boolean): StationOption[] {
  const out: StationOption[] = [];
  for (const r of responders) {
    // A station leaves by the nearest street that is passable now and connected to the caller.
    const startEdge = nearestEdge(g, [r.place.lon, r.place.lat],
      (e) => !blocked(e) && (dist.has(g.streets[e].properties.u!) || dist.has(g.streets[e].properties.v!)));
    if (startEdge < 0) continue;
    const sp = g.streets[startEdge].properties;
    const start = [sp.u!, sp.v!].filter((n) => dist.has(n)).sort((a, b) => dist.get(a)! - dist.get(b)!)[0];
    if (start == null) continue;
    const edgeIds: string[] = [];
    let km = 0, trackKm = 0;
    for (let n = start; via.has(n); n = via.get(n)!.from) {
      const s = g.streets[via.get(n)!.edge].properties;
      edgeIds.push(s.id);
      km += (s.length_m ?? 0) / 1000;
      if (s.highway === 'track') trackKm += (s.length_m ?? 0) / 1000;
    }
    out.push({ responder: r, minutes: dist.get(start)!, km, trackKm, edgeIds, endNode: lastNode(via, start) });
  }
  return out;
}

/**
 * Drive time (minutes) from every response point to a caller's street at `now`; null = no access by road.
 * The final stretch along the caller's own street is not included. Used for the station/caller table.
 */
export function stationTimes(g: Graph, caller: CallerReport, responders: Responder[], now: number):
  { name: string; minutes: number | null; km: number | null; trackKm: number | null }[] {
  const blocked = (edge: number) => statusAt(g.streets[edge].properties, now) === 'blocked';
  const target = nearestEdge(g, [caller.place.lon, caller.place.lat]);
  const tp = g.streets[target].properties;
  const { dist, via } = reach(g, [tp.u!, tp.v!], blocked);
  const options = stationOptions(g, responders, dist, via, blocked);
  return responders.map((r) => {
    const o = options.find((x) => x.responder.id === r.id);
    return { name: r.name, minutes: o ? o.minutes : null, km: o ? o.km : null, trackKm: o ? o.trackKm : null };
  });
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

// ---------------------------------------------------------------------------------------------------
// Crew legs: a drive from any position (a station, or a junction a vehicle has reached) to a target,
// with the polyline and timing needed to move a vehicle along it.

/** Where a leg starts: a place (station) or a junction node a vehicle is at. */
export interface Origin { id: string; name: string; place?: [number, number]; node?: number }

export interface Leg {
  /** Polyline driven, in order, and the minutes since the start of the leg at each vertex. */
  path: [number, number][];
  cum: number[];
  /** Streets used, in order, each with the minutes at which the vehicle enters and leaves it. */
  spans: { edgeId: string; from: number; to: number }[];
  /** Junction nodes passed, in order, with the minutes at each. */
  nodes: number[];
  nodeMin: number[];
  minutes: number;
  km: number;
  trackKm: number;
  /** Scenario time (epoch ms) the leg starts. */
  startAt: number;
}

export interface LegPlan {
  origin: Origin;
  leg: Leg;
  /** The target's own street is blocked: the leg ends at its nearest reachable end. */
  lastStretchBlocked: boolean;
  lastStretchM: number;
}

/**
 * Legs from each origin to `target` at scenario time `now`, blocked streets avoided, fastest first.
 * Origins that cannot reach the target are left out. With `targetMustBeOpen` the target is approached by
 * the nearest passable street (a station to return to); otherwise by its nearest street, blocked or not (a caller).
 */
export function planLegs(g: Graph, target: [number, number], origins: Origin[], now: number, targetMustBeOpen = false): LegPlan[] {
  const blocked = (edge: number) => statusAt(g.streets[edge].properties, now) === 'blocked';
  const tEdge = nearestEdge(g, target, targetMustBeOpen ? (e) => !blocked(e) : undefined);
  if (tEdge < 0) return [];
  const tp = g.streets[tEdge].properties;
  const lastStretchBlocked = blocked(tEdge);
  const { dist, via } = reach(g, [tp.u!, tp.v!], blocked);
  const out: LegPlan[] = [];
  for (const origin of origins) {
    let start = origin.node;
    if (start == null) {
      if (!origin.place) continue;
      const e = nearestEdge(g, origin.place,
        (i) => !blocked(i) && (dist.has(g.streets[i].properties.u!) || dist.has(g.streets[i].properties.v!)));
      if (e < 0) continue;
      const sp = g.streets[e].properties;
      start = [sp.u!, sp.v!].filter((n) => dist.has(n)).sort((a, b) => dist.get(a)! - dist.get(b)!)[0];
    }
    if (start == null || !dist.has(start)) continue;

    const path: [number, number][] = [];
    const cum: number[] = [];
    const spans: Leg['spans'] = [];
    const nodes = [start];
    const nodeMin = [0];
    let minutes = 0, km = 0, trackKm = 0;
    const startXY = g.nodeXY.get(start);
    if (origin.place) { path.push(origin.place); cum.push(0); }
    if (startXY) { path.push(startXY); cum.push(0); }
    for (let n = start; via.has(n);) {
      const arc = via.get(n)!;
      const s = g.streets[arc.edge];
      const p = s.properties;
      const coords = (p.u === n ? s.geometry.coordinates : [...s.geometry.coordinates].reverse()) as [number, number][];
      // Spread the street's drive time along its geometry by length.
      const seg = coords.map((c, i) => (i ? metresBetween(coords[i - 1], c) : 0));
      const total = seg.reduce((a, b) => a + b, 0) || 1;
      let done = 0;
      for (let i = 1; i < coords.length; i++) {
        done += seg[i];
        path.push(coords[i]);
        cum.push(minutes + (arc.minutes * done) / total);
      }
      spans.push({ edgeId: p.id, from: minutes, to: minutes + arc.minutes });
      minutes += arc.minutes;
      km += (p.length_m ?? total) / 1000;
      if (p.highway === 'track') trackKm += (p.length_m ?? total) / 1000;
      n = arc.from;
      nodes.push(n);
      nodeMin.push(minutes);
    }
    const end = g.nodeXY.get(nodes[nodes.length - 1]) ?? target;
    let lastStretchM = metresBetween(end, target);
    if (!lastStretchBlocked) {
      // Drive the final stretch along the target's own street.
      const extra = (lastStretchM / 1000 / (SPEED_KMH[tp.highway ?? ''] ?? DEFAULT_SPEED_KMH)) * 60;
      spans.push({ edgeId: tp.id, from: minutes, to: minutes + extra });
      minutes += extra;
      km += lastStretchM / 1000;
      if (tp.highway === 'track') trackKm += lastStretchM / 1000;
      path.push(target);
      cum.push(minutes);
      lastStretchM = 0;
    }
    out.push({ origin, leg: { path, cum, spans, nodes, nodeMin, minutes, km, trackKm, startAt: now }, lastStretchBlocked, lastStretchM });
  }
  return out.sort((a, b) => a.leg.minutes - b.leg.minutes);
}

/** Position on a leg `minutes` after its start (clamped to the leg). */
export function positionOnLeg(leg: Leg, minutes: number): [number, number] {
  const { path, cum } = leg;
  if (!path.length) return [0, 0];
  if (minutes <= 0) return path[0];
  if (minutes >= cum[cum.length - 1]) return path[path.length - 1];
  let i = 1;
  while (i < cum.length && cum[i] < minutes) i++;
  const span = cum[i] - cum[i - 1];
  const f = span > 0 ? (minutes - cum[i - 1]) / span : 0;
  return [path[i - 1][0] + f * (path[i][0] - path[i - 1][0]), path[i - 1][1] + f * (path[i][1] - path[i - 1][1])];
}

/** The last junction passed on a leg `minutes` after its start: where a vehicle re-routes from. */
export function nodeOnLeg(leg: Leg, minutes: number): number {
  let i = 0;
  while (i + 1 < leg.nodes.length && leg.nodeMin[i + 1] <= minutes) i++;
  return leg.nodes[i];
}
