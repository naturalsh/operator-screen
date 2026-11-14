/**
 * Route safety: will the fire forecast in force reach a street of the route around the time the crew drives it?
 *
 * For each street of a leg the crew enters it at `leg.startAt + span.from` minutes. The forecast in force says when
 * its P >= 50 % contour reaches that street (with the 150 m safety buffer, to the half hour: `ForecastRun.reach`).
 * A street is at risk when the fire may reach it before the crew passes, or within RISK_WINDOW_H hours after (the
 * +1 / +2 h zones at that time): the route may be cut, or the crew may be caught on the way back. Only the forecast
 * in force at the time shown is used.
 */
import { planLegs, type Graph, type Leg, type Origin } from './routing';
import type { StreetFeature } from './types';

/** Hours after the crew passes in which the forecast reaching a street still counts as a risk (+1 / +2 h). */
export const RISK_WINDOW_H = 2;
/** A safer route must bring the crew about as close to the caller as the route it replaces (metres more at most). */
const SAFER_MAX_EXTRA_WALK_M = 100;

export interface RouteRisk {
  streetId: string;
  street: string;
  /** When the crew drives onto the street, and when the forecast says the fire may reach it (epoch ms). */
  passAt: number;
  reachAt: number;
  /** Minutes from now until the fire may reach it. */
  inMin: number;
  /** 'before': before the crew gets there; 'h1' / 'h2': within 1 or 2 hours after the crew passes. */
  zone: 'before' | 'h1' | 'h2';
  /** Streets of the route at risk in all. */
  count: number;
}

/**
 * The first street (by the time the fire may reach it) of the part of `leg` not driven yet at `now` that the
 * forecast reaches before, or within RISK_WINDOW_H hours after, the crew passes. Null: none.
 */
export function routeRisk(leg: Leg, reach: Map<string, number>, now: number, name: (id: string) => string): RouteRisk | null {
  const at: RouteRisk[] = [];
  for (const s of leg.spans) {
    const leaveAt = leg.startAt + s.to * 60000;
    if (leaveAt <= now) continue;                                   // already driven
    const passAt = Math.max(now, leg.startAt + s.from * 60000);
    const reachAt = reach.get(s.edgeId);
    if (reachAt == null || reachAt <= now || reachAt > passAt + RISK_WINDOW_H * 3600000) continue;
    const zone = reachAt <= passAt ? 'before' : reachAt <= passAt + 3600000 ? 'h1' : 'h2';
    at.push({ streetId: s.edgeId, street: name(s.edgeId), passAt, reachAt, inMin: (reachAt - now) / 60000, zone, count: 0 });
  }
  if (!at.length) return null;
  const first = at.reduce((a, b) => (b.reachAt < a.reachAt ? b : a));
  return { ...first, count: new Set(at.map((r) => r.streetId)).size };
}

export interface SaferRoute { leg: Leg; lastStretchBlocked: boolean; lastStretchM: number; risk: RouteRisk | null; extraMin: number }

/**
 * A route for the same crew that avoids every street the forecast reaches within the drive time plus
 * RISK_WINDOW_H hours, if one exists, is safer (no risk, or the first risk later than on `leg`) and still brings
 * the crew as close to the caller (`lastStretchM`: how far short of the caller the current route stops).
 */
export function saferRoute(g: Graph, target: [number, number], origin: Origin, leg: Leg, risk: RouteRisk,
  reach: Map<string, number>, now: number, name: (id: string) => string, lastStretchM = 0): SaferRoute | null {
  const horizon = now + (leg.minutes * 60000) + RISK_WINDOW_H * 3600000;
  const avoid = (id: string) => { const r = reach.get(id); return r != null && r > now && r <= horizon; };
  const plan = planLegs(g, target, [origin], now, false, avoid)[0];
  if (!plan || plan.lastStretchM > lastStretchM + SAFER_MAX_EXTRA_WALK_M) return null;
  const r = routeRisk(plan.leg, reach, now, name);
  if (r && r.reachAt <= risk.reachAt) return null;
  return { leg: plan.leg, lastStretchBlocked: plan.lastStretchBlocked, lastStretchM: plan.lastStretchM, risk: r,
    extraMin: plan.leg.minutes - leg.minutes };
}

/** "Unnamed road, 1.2 km from Armutalan" for a street id. */
export function streetNamer(byId: Map<string, StreetFeature>, label: (p: StreetFeature['properties']) => string) {
  return (id: string) => { const s = byId.get(id); return s ? label(s.properties).split(' (')[0] : id; };
}
