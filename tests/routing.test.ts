// Routing invariants on the sample scenario. Run: npm test
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { prepareStreets } from '../src/data';
import { SNAP_WARN_M, buildGraph, planLegs } from '../src/routing';
import type { CallerReport, Responder, StreetFeature } from '../src/types';

const base = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const read = <T>(f: string) => JSON.parse(readFileSync(new URL(f, base), 'utf8')) as T;
const streets = prepareStreets(read<{ features: StreetFeature[] }>('street_access.geojson').features);
const callers = read<{ records: CallerReport[] }>('caller_reports.json').records;
const responders = read<{ records: Responder[] }>('responders.json').records;
const g = buildGraph(streets);
const metres = (a: number[], b: number[]) => {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * k, a[1] - b[1]) * 111195;
};
const origins = responders.map((r) => ({ id: r.id, name: r.name, place: [r.place.lon, r.place.lat] as [number, number] }));

let plans = 0;
for (const c of callers) {
  for (const lead of [5, 60, 180]) {
    const now = Date.parse(c.reported_at) + lead * 60000;
    for (const p of planLegs(g, [c.place.lon, c.place.lat], origins, now)) {
      plans++;
      const straight = metres(p.origin.place!, [c.place.lon, c.place.lat]);
      // A drive can never be shorter than the straight line, minus the walked last stretch and the caller's snap.
      assert.ok(p.leg.km * 1000 + p.lastStretchM + p.targetSnapM + 50 >= straight,
        `${c.id} +${lead} min from ${p.origin.name}: ${p.leg.km.toFixed(2)} km driven but ${(straight / 1000).toFixed(2)} km away`);
      // The vehicle starts where the station is and the path has no jumps longer than the street it is on.
      assert.deepEqual(p.leg.path[0], p.origin.place, 'path starts at the station');
      assert.ok(p.originSnapM < 2000, `${p.origin.name} snapped ${Math.round(p.originSnapM)} m`);
      for (let i = 1; i < p.leg.path.length; i++) assert.ok(p.leg.cum[i] >= p.leg.cum[i - 1], 'time along the path never decreases');
      assert.ok(Math.abs(p.leg.cum[p.leg.cum.length - 1] - p.leg.minutes) < 1e-6, 'ETA equals the time at the end of the path');
    }
  }
}

// The three calls the independent review found inside a pocket cut off by closed roads (K1; positions and times
// of synthetic calls 022, 025 and 027 in the reviewed version): no access by road, never a 0-minute ETA.
for (const [label, at, lon, lat] of [
  ['review #022', '2022-06-23T16:51:00Z', 28.18414, 36.85527],
  ['review #025', '2022-06-23T20:27:00Z', 28.19345, 36.88123],
  ['review #027', '2022-06-23T23:36:00Z', 28.18748, 36.89512],
] as const) {
  const plans = planLegs(g, [lon, lat], origins, Date.parse(at));
  assert.equal(plans.length, 0, `${label}: expected no access by road, got ${plans.map((p) => `${p.origin.name} ${p.leg.minutes.toFixed(0)} min`).join(', ')}`);
}

// Stations sit next to a mapped road: no warning in the sample.
for (const r of responders) {
  const p = planLegs(g, [28.2, 36.85], [{ id: r.id, name: r.name, place: [r.place.lon, r.place.lat] }], Date.parse('2022-06-21T17:10:00Z'))[0];
  assert.ok(p && p.originSnapM <= SNAP_WARN_M, `${r.name} is ${Math.round(p?.originSnapM ?? -1)} m from its road`);
}
console.log(`routing: ${plans} plans checked, all invariants hold`);
