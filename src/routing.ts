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
  /** Metres from a station to its road, and from the target to its road (warned on the card above SNAP_WARN_M). */
  originSnapM: number;
  targetSnapM: number;
}

/** Above this distance from the nearest mapped road a station or caller gets a warning on the card. */
export const SNAP_WARN_M = 300;
/** Speed for the straight connector between a station and the road it is next to (not in the map data). */
const CONNECTOR_KMH = 20;

/** Nearest point on a polyline: the point, its distance from `p` and the distance along the line to it. */
function projectOnLine(coords: [number, number][], p: [number, number]) {
  const k = Math.cos((p[1] * Math.PI) / 180);
  let best = { point: coords[0], dist: Infinity, along: 0, seg: 0 };
  let along = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const point: [number, number] = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
    const d = metresBetween(p, point);
    const segM = metresBetween(a, b);
    if (d < best.dist) best = { point, dist: d, along: along + u * segM, seg: i - 1 };
    along += segM;
  }
  return { ...best, total: along };
}

/** The street nearest to a point (projected onto its geometry), optionally only among some streets. */
function snapToStreet(g: Graph, p: [number, number], usable?: (edge: number) => boolean) {
  let best: { edge: number; proj: ReturnType<typeof projectOnLine> } | null = null;
  g.streets.forEach((s, i) => {
    if (s.geometry.type !== 'LineString' || s.properties.u == null || s.geometry.coordinates.length < 2) return;
    if (usable && !usable(i)) return;
    const proj = projectOnLine(s.geometry.coordinates as [number, number][], p);
    if (!best || proj.dist < best.proj.dist) best = { edge: i, proj };
  });
  return best as { edge: number; proj: ReturnType<typeof projectOnLine> } | null;
}

/**
 * Legs from each origin to `target` at scenario time `now`, blocked streets avoided, fastest first.
 *
 * Reachability is decided from the target: a search over passable streets from the target's street. An origin
 * whose own street is not reached cannot get there ("No access by road"); an origin is never moved to some other
 * street that happens to be connected to the target.
 * - A station is attached to the nearest point of its nearest street; the straight connector (CONNECTOR_KMH) and
 *   the drive along that street to its junction are part of the leg. If that street is blocked, the station is out.
 * - A vehicle (origin with a junction node) starts from that node.
 * - With `targetMustBeOpen` the target is approached by its nearest passable street (a station to return to);
 *   otherwise by its nearest street, blocked or not (a caller); the last stretch is then walked if blocked.
 */
export function planLegs(g: Graph, target: [number, number], origins: Origin[], now: number, targetMustBeOpen = false): LegPlan[] {
  const blocked = (edge: number) => statusAt(g.streets[edge].properties, now) === 'blocked';
  const tSnap = snapToStreet(g, target, targetMustBeOpen ? (e) => !blocked(e) : undefined);
  if (!tSnap) return [];
  const tEdge = tSnap.edge;
  const tp = g.streets[tEdge].properties;
  const lastStretchBlocked = blocked(tEdge);
  const { dist, via } = reach(g, [tp.u!, tp.v!], blocked);
  const speedOf = (e: number) => SPEED_KMH[g.streets[e].properties.highway ?? ''] ?? DEFAULT_SPEED_KMH;
  const out: LegPlan[] = [];
  for (const origin of origins) {
    const path: [number, number][] = [];
    const cum: number[] = [];
    const spans: Leg['spans'] = [];
    let minutes = 0, km = 0, trackKm = 0, originSnapM = 0;
    let start = origin.node;
    if (start == null) {
      if (!origin.place) continue;
      const sSnap = snapToStreet(g, origin.place);
      if (!sSnap || blocked(sSnap.edge)) continue;               // the station's own road is closed
      const sp = g.streets[sSnap.edge].properties;
      // Leave by whichever end of the street is the quicker way to the target.
      const ends = [
        { node: sp.u!, along: sSnap.proj.along },
        { node: sp.v!, along: sSnap.proj.total - sSnap.proj.along },
      ].filter((x) => dist.has(x.node));
      if (!ends.length) continue;                                 // not connected to the target: no access
      const speed = speedOf(sSnap.edge);
      const cost = (x: { node: number; along: number }) => (x.along / 1000 / speed) * 60 + dist.get(x.node)!;
      const end = ends.reduce((a, b) => (cost(b) < cost(a) ? b : a));
      originSnapM = sSnap.proj.dist;
      const connector = (originSnapM / 1000 / CONNECTOR_KMH) * 60;
      const coords = g.streets[sSnap.edge].geometry.coordinates as [number, number][];
      const partial = end.node === sp.u
        ? [sSnap.proj.point, ...coords.slice(0, sSnap.proj.seg + 1).reverse()]
        : [sSnap.proj.point, ...coords.slice(sSnap.proj.seg + 1)];
      const partialMin = (end.along / 1000 / speed) * 60;
      path.push(origin.place); cum.push(0);
      minutes = connector;
      path.push(sSnap.proj.point); cum.push(minutes);
      let done = 0;
      for (let i = 1; i < partial.length; i++) {
        done += metresBetween(partial[i - 1], partial[i]);
        path.push(partial[i]);
        cum.push(minutes + (end.along > 0 ? (partialMin * Math.min(done, end.along)) / end.along : 0));
      }
      spans.push({ edgeId: sp.id, from: minutes, to: minutes + partialMin });
      minutes += partialMin;
      km += (originSnapM + end.along) / 1000;
      if (sp.highway === 'track') trackKm += end.along / 1000;
      start = end.node;
    } else {
      if (!dist.has(start)) continue;
      const startXY = g.nodeXY.get(start);
      if (startXY) { path.push(startXY); cum.push(0); }
    }
    const nodes = [start];
    const nodeMin = [minutes];
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
      const extra = (lastStretchM / 1000 / speedOf(tEdge)) * 60;
      spans.push({ edgeId: tp.id, from: minutes, to: minutes + extra });
      minutes += extra;
      km += lastStretchM / 1000;
      if (tp.highway === 'track') trackKm += lastStretchM / 1000;
      path.push(target);
      cum.push(minutes);
      lastStretchM = 0;
    }
    out.push({ origin, leg: { path, cum, spans, nodes, nodeMin, minutes, km, trackKm, startAt: now }, lastStretchBlocked, lastStretchM,
      originSnapM, targetSnapM: tSnap.proj.dist });
  }
  return out.sort((a, b) => a.leg.minutes - b.leg.minutes);
}

/** Fastest crew from a station to a caller (used by the route table script). */
export function planRoute(g: Graph, caller: CallerReport, responders: Responder[], now: number): RoutePlan | null {
  const plans = planLegs(g, [caller.place.lon, caller.place.lat],
    responders.map((r) => ({ id: r.id, name: r.name, place: [r.place.lon, r.place.lat] as [number, number] })), now);
  const p = plans[0];
  if (!p) return null;
  return { responderId: p.origin.id, responderName: p.origin.name, edgeIds: p.leg.spans.map((x) => x.edgeId), minutes: p.leg.minutes,
    km: p.leg.km, trackKm: p.leg.trackKm, computedAt: now, lastStretchBlocked: p.lastStretchBlocked, lastStretchM: p.lastStretchM };
}

/** Drive time from every station to a caller at `now` (null = no access by road). */
export function stationTimes(g: Graph, caller: CallerReport, responders: Responder[], now: number):
  { name: string; minutes: number | null; km: number | null; trackKm: number | null }[] {
  const plans = planLegs(g, [caller.place.lon, caller.place.lat],
    responders.map((r) => ({ id: r.id, name: r.name, place: [r.place.lon, r.place.lat] as [number, number] })), now);
  return responders.map((r) => {
    const p = plans.find((x) => x.origin.id === r.id);
    return { name: r.name, minutes: p ? p.leg.minutes : null, km: p ? p.leg.km : null, trackKm: p ? p.leg.trackKm : null };
  });
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
