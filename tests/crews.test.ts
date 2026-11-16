// Crew state is a function of the time shown: a re-route accepted after a cut must not show when the clock is moved
// back before it (the vehicle is en route on its first route again), nor a dispatch before it was made. Run: npm test
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { prepareStreets } from '../src/data';
import { buildGraph, planLegs } from '../src/routing';
import { crewStateAt, holdTime, makeCrews, missionAsOf, reportMissionAt, type Mission } from '../src/crews';
import type { CallerReport, Responder, StreetFeature } from '../src/types';

const base = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const read = <T>(f: string) => JSON.parse(readFileSync(new URL(f, base), 'utf8')) as T;
const streets = prepareStreets(read<{ features: StreetFeature[] }>('street_access.geojson').features);
const callers = read<{ records: CallerReport[] }>('caller_reports.json').records;
const responders = read<{ records: Responder[] }>('responders.json').records;
const g = buildGraph(streets);
const byId = new Map(streets.map((s) => [s.properties.id, s]));
const crews = makeCrews(responders);
const MIN = 60000;
const metres = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * 89000, (a[1] - b[1]) * 111000);

let checked = 0;
for (const c of callers) {
  const t0 = Date.parse(c.reported_at) + 5 * MIN;
  const crew = crews[0];
  const plan = planLegs(g, [c.place.lon, c.place.lat], [{ id: crew.id, name: crew.name, place: crew.home }], t0)[0];
  if (!plan || plan.leg.minutes < 6 || plan.leg.spans.length < 4) continue;
  const leg1 = plan.leg;
  if (holdTime(leg1, byId) != null) continue;                    // already cut by a real closure: not a clean case
  // A street in the second half of the route that is open for the whole drive: closed by the test while the vehicle
  // is still short of it.
  const span = leg1.spans.find((s) => s.from > leg1.minutes * 0.5 && byId.get(s.edgeId)?.properties.status !== 'blocked');
  if (!span) continue;
  const street = byId.get(span.edgeId)!;
  const cutAt = t0 + Math.round(span.from * 0.6) * MIN;
  const saved = { ...street.properties };
  Object.assign(street.properties, { status: 'blocked', t: cutAt, valid_at: new Date(cutAt).toISOString() });
  try {
    const m1: Mission = { id: 1, crewId: crew.id, reportId: c.id, createdAt: t0, legs: [leg1], target: [c.place.lon, c.place.lat],
      lastStretchBlocked: false, lastStretchM: 0, onSceneMin: 45, back: null };
    // Before the dispatch: nothing.
    assert.equal(crewStateAt(crew, [m1], t0 - MIN, byId).status, 'available', 'before the dispatch the crew is available');
    assert.equal(reportMissionAt(c.id, [m1], t0 - MIN).stage, null, 'before the dispatch the report is not dispatched');
    const driving = crewStateAt(crew, [m1], cutAt - MIN, byId);
    assert.equal(driving.status, 'en_route', 'before the cut the crew is driving');
    const held = crewStateAt(crew, [m1], cutAt + 2 * MIN, byId);
    assert.equal(held.status, 'holding', 'after the cut the crew holds');
    // Re-route accepted 3 minutes after the cut, from where the vehicle stands.
    const t2 = cutAt + 3 * MIN;
    const re = planLegs(g, m1.target, [{ id: crew.id, name: crew.name, node: held.node! }], t2)[0];
    if (!re) continue;
    const m2: Mission = { ...m1, legs: [leg1, re.leg] };
    // After the re-route: driving again.
    const on2 = crewStateAt(crew, [m2], t2 + MIN, byId);
    assert.ok(on2.status === 'en_route' || on2.status === 'on_scene' || on2.status === 'holding', 'after the re-route the second leg is in force');
    // Back before the cut, with the re-route on record: the same as it was then (en route, same place, same ETA).
    const back = crewStateAt(crew, [m2], cutAt - MIN, byId);
    assert.equal(back.status, 'en_route', `${c.id}: rewound before the cut the crew is en route again, not "${back.status}"`);
    assert.ok(metres(back.position, driving.position) < 1, 'rewound before the cut: same position as it was then');
    assert.ok(Math.abs((back.etaMin ?? 0) - (driving.etaMin ?? -1)) < 1e-6, 'rewound before the cut: same ETA as it was then');
    assert.equal(back.times?.holdFrom, driving.times?.holdFrom, 'rewound before the cut: the times are those of the first route');
    // Between the cut and the re-route: holding where it stopped.
    const mid = crewStateAt(crew, [m2], cutAt + 2 * MIN, byId);
    assert.equal(mid.status, 'holding', 'rewound between the cut and the re-route: holding');
    assert.ok(metres(mid.position, held.position) < 1, 'holding where it stopped');
    // The mission as it stood: one leg before the re-route, both after.
    assert.equal(missionAsOf(m2, cutAt).legs.length, 1);
    assert.equal(missionAsOf(m2, t2).legs.length, 2);
    // Reassign: the first mission cancelled at t3 for another report; before t3 it is still in force.
    const t3 = t2 + 2 * MIN;
    const other = callers.find((x) => x.id !== c.id)!;
    const m3: Mission = { ...m1, id: 2, reportId: other.id, createdAt: t3, legs: [re.leg] };
    const all = [{ ...m2, cancelledAt: t3 }, m3];
    assert.equal(crewStateAt(crew, all, t3 + MIN, byId).mission?.id, 2, 'after the reassign the crew is on the new mission');
    assert.equal(crewStateAt(crew, all, t3 - MIN, byId).mission?.id, 1, 'rewound before the reassign the crew is on the first mission');
    assert.equal(reportMissionAt(c.id, all, t3 + MIN).stage, 'unassigned');
    assert.equal(reportMissionAt(c.id, all, t3 - MIN).stage, 'dispatched');
    assert.equal(reportMissionAt(other.id, all, t3 - MIN).stage, null);
    checked++;
  } finally {
    for (const k of Object.keys(street.properties)) delete (street.properties as Record<string, unknown>)[k];
    Object.assign(street.properties, saved);
  }
}
assert.ok(checked >= 5, `only ${checked} cut-and-re-route cases could be built`);
console.log(`crews: ${checked} dispatch / cut / re-route / reassign timelines, the same state at every time from either direction; 0 failures`);
