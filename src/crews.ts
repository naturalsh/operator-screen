/**
 * Crews, their missions and where each crew is at a given scenario time.
 *
 * Everything here is a pure function of the missions the operator has created and the clock, so the
 * time slider can be moved freely: a crew's status and position are recomputed for the time shown.
 *
 * Assumptions (stated on screen): each response point has CREWS_PER_STATION crews; a crew stays on scene
 * for a set time (default 45 minutes) and then drives back to its station.
 */
import { NEVER } from './data';
import { nodeOnLeg, planLegs, positionOnLeg, type Graph, type Leg, type Origin } from './routing';
import type { Responder, StreetFeature } from './types';

export const CREWS_PER_STATION = 2;
export const DEFAULT_ON_SCENE_MIN = 45;

export interface Crew { id: string; name: string; stationId: string; stationName: string; home: [number, number] }

export type CrewStatus = 'available' | 'en_route' | 'holding' | 'on_scene' | 'returning';

export const CREW_STATUS_LABEL: Record<CrewStatus, string> = {
  available: 'Available', en_route: 'En route', holding: 'Route cut', on_scene: 'On scene', returning: 'Returning',
};
export const CREW_STATUS_COLOUR: Record<CrewStatus, string> = {
  available: '#22d3ee', en_route: '#facc15', holding: '#fb923c', on_scene: '#f43f5e', returning: '#a5b4fc',
};

export interface Mission {
  id: number;
  crewId: string;
  reportId: string;
  /** Scenario time the crew was sent. */
  createdAt: number;
  /** Outbound legs: the first from where the crew was, a new one for each accepted re-route. */
  legs: Leg[];
  target: [number, number];
  lastStretchBlocked: boolean;
  lastStretchM: number;
  /** Metres from the station to its road and from the caller to theirs (warned above SNAP_WARN_M). */
  originSnapM?: number;
  targetSnapM?: number;
  onSceneMin: number;
  /** Drive back to the station, planned for the time the crew leaves the scene (null: none found, or not arrived). */
  back: Leg | null;
  /** Set when the crew is redirected to another incident before it is done. */
  cancelledAt?: number;
}

export function makeCrews(responders: Responder[]): Crew[] {
  return responders.flatMap((r) => {
    const short = r.name.split(/\s+/)[0];
    return Array.from({ length: CREWS_PER_STATION }, (_, i) => ({
      id: `${r.id}-crew-${i + 1}`, name: `${short}-${i + 1}`, stationId: r.id, stationName: r.name,
      home: [r.place.lon, r.place.lat] as [number, number],
    }));
  });
}

/** Scenario time a street becomes blocked (NEVER if it does not). */
function closesAt(byId: Map<string, StreetFeature>, edgeId: string): number {
  const p = byId.get(edgeId)?.properties;
  return p && p.status === 'blocked' ? p.t ?? NEVER : NEVER;
}

/**
 * When a leg is cut: the first time a street the vehicle has not left yet becomes blocked after the leg
 * started (null = the leg can be driven to its end). The vehicle stops where it is at that moment.
 */
export function holdTime(leg: Leg, byId: Map<string, StreetFeature>): number | null {
  let hold: number | null = null;
  for (const s of leg.spans) {
    const c = closesAt(byId, s.edgeId);
    if (c > leg.startAt && c < leg.startAt + s.to * 60000 && (hold == null || c < hold)) hold = c;
  }
  return hold;
}

export interface MissionTimes { holdFrom: number | null; arriveAt: number | null; leaveAt: number | null; backAt: number | null }

export function missionTimes(m: Mission, byId: Map<string, StreetFeature>): MissionTimes {
  const last = m.legs[m.legs.length - 1];
  const holdFrom = holdTime(last, byId);
  if (holdFrom != null) return { holdFrom, arriveAt: null, leaveAt: null, backAt: null };
  const arriveAt = last.startAt + last.minutes * 60000;
  const leaveAt = arriveAt + m.onSceneMin * 60000;
  return { holdFrom: null, arriveAt, leaveAt, backAt: m.back ? m.back.startAt + m.back.minutes * 60000 : null };
}

/** Plans the drive back to the station for the moment the crew leaves the scene. */
export function withReturn(g: Graph, m: Mission, crew: Crew, byId: Map<string, StreetFeature>): Mission {
  const t = missionTimes({ ...m, back: null }, byId);
  if (t.leaveAt == null) return { ...m, back: null };
  const last = m.legs[m.legs.length - 1];
  const from: Origin = { id: crew.id, name: crew.name, node: last.nodes[last.nodes.length - 1] };
  const plan = planLegs(g, crew.home, [from], t.leaveAt, true)[0];
  return { ...m, back: plan ? plan.leg : null };
}

export interface CrewState {
  crew: Crew;
  status: CrewStatus;
  position: [number, number];
  mission: Mission | null;
  times: MissionTimes | null;
  /** Minutes until arrival (en route) or until back at the station (returning). */
  etaMin: number | null;
  /** Junction the crew would start a new drive from; null = from its station. */
  node: number | null;
  /** On scene with no road back to the station. */
  cutOff: boolean;
}

/** Status and position of a crew at scenario time `now`. */
export function crewStateAt(crew: Crew, missions: Mission[], now: number, byId: Map<string, StreetFeature>): CrewState {
  const idle: CrewState = { crew, status: 'available', position: crew.home, mission: null, times: null, etaMin: null, node: null, cutOff: false };
  const mine = missions.filter((m) => m.crewId === crew.id && m.createdAt <= now && !(m.cancelledAt != null && m.cancelledAt <= now));
  const m = mine[mine.length - 1];
  if (!m) return idle;
  // The leg in force at `now`: the last one already started.
  let li = 0;
  while (li + 1 < m.legs.length && m.legs[li + 1].startAt <= now) li++;
  const leg = m.legs[li];
  const isLast = li === m.legs.length - 1;
  const hold = holdTime(leg, byId);
  const legEnd = leg.startAt + leg.minutes * 60000;
  const base = { crew, mission: m, cutOff: false };
  if (!isLast || (hold != null && now >= hold)) {
    // Stopped by a cut route (an earlier leg is always one that was cut).
    const at = ((hold ?? legEnd) - leg.startAt) / 60000;
    const times = missionTimes(m, byId);
    return { ...base, status: 'holding', position: positionOnLeg(leg, at), times, etaMin: null, node: nodeOnLeg(leg, at) };
  }
  const times = missionTimes(m, byId);
  if (now < legEnd) {
    const at = (now - leg.startAt) / 60000;
    return { ...base, status: 'en_route', position: positionOnLeg(leg, at), times, etaMin: (legEnd - now) / 60000, node: nodeOnLeg(leg, at) };
  }
  const scene = leg.path[leg.path.length - 1];
  const sceneNode = leg.nodes[leg.nodes.length - 1];
  if (times.leaveAt != null && now < times.leaveAt) {
    return { ...base, status: 'on_scene', position: scene, times, etaMin: (times.leaveAt - now) / 60000, node: sceneNode };
  }
  if (!m.back) return { ...base, status: 'on_scene', position: scene, times, etaMin: null, node: sceneNode, cutOff: true };
  if (times.backAt != null && now < times.backAt) {
    const at = (now - m.back.startAt) / 60000;
    return { ...base, status: 'returning', position: positionOnLeg(m.back, at), times, etaMin: (times.backAt - now) / 60000, node: nodeOnLeg(m.back, at) };
  }
  return idle;
}

export interface Candidate {
  crew: Crew;
  state: CrewState;
  leg: Leg;
  minutes: number;
  lastStretchBlocked: boolean;
  lastStretchM: number;
  originSnapM: number;
  targetSnapM: number;
  /** The crew is on its way to another incident: sending it here needs the operator's explicit choice. */
  needsApproval: boolean;
}

/**
 * Crews that can drive to `target` now, fastest first. Available and returning crews are offered freely;
 * crews en route elsewhere are listed but flagged; crews on scene are not offered.
 */
export function candidatesFor(g: Graph, target: [number, number], states: CrewState[], now: number, excludeReport?: string): Candidate[] {
  const usable = states.filter((s) => s.status !== 'on_scene' && !(excludeReport != null && s.mission?.reportId === excludeReport));
  const origins: Origin[] = usable.map((s) => (s.node != null && s.status !== 'available'
    ? { id: s.crew.id, name: s.crew.name, node: s.node } : { id: s.crew.id, name: s.crew.name, place: s.crew.home }));
  return planLegs(g, target, origins, now).map((p) => {
    const state = usable.find((s) => s.crew.id === p.origin.id)!;
    return { crew: state.crew, state, leg: p.leg, minutes: p.leg.minutes, lastStretchBlocked: p.lastStretchBlocked,
      lastStretchM: p.lastStretchM, originSnapM: p.originSnapM, targetSnapM: p.targetSnapM, needsApproval: state.status === 'en_route' || state.status === 'holding' };
  });
}
