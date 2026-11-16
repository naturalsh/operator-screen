// Operator-confirmed fires: a drawn area never keeps crossing lines; a fire closes the streets in and next to it; the
// part of "fire now" grown from an operator fire stays an area however small; a vehicle at its station faces the way
// its road leads. Run: npm test
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { prepareStreets } from '../src/data';
import { buildGraph, bearingOnLeg, planLegs } from '../src/routing';
import { makeCrews } from '../src/crews';
import { fireClosures, fireGeometry, fireInModel, selfCrossing, untangle, type OperatorFire } from '../src/fires';
import { frontWidthM, splitParts } from '../src/forecast';
import { circle } from '../src/reports';
import type { CallerReport, Responder, StreetFeature } from '../src/types';

const base = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const read = <T>(f: string) => JSON.parse(readFileSync(new URL(f, base), 'utf8')) as T;
const streets = prepareStreets(read<{ features: StreetFeature[] }>('street_access.geojson').features);
const metres = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * 89000, (a[1] - b[1]) * 111000);

// 1. Corners tapped in crossing order (a bow-tie): the same corners, put in order; plain polygons are left alone.
const C = [28.05, 36.849];
const bow: [number, number][] = [[C[0] - 0.002, C[1] + 0.001], [C[0] + 0.002, C[1] - 0.001], [C[0] + 0.002, C[1] + 0.001], [C[0] - 0.002, C[1] - 0.001]];
assert.ok(selfCrossing(bow), 'the bow-tie crosses itself');
const fixed = untangle(bow);
assert.ok(fixed.reordered && !selfCrossing(fixed.vertices), 'untangled: no crossing lines');
assert.deepEqual([...fixed.vertices].sort(), [...bow].sort(), 'untangled: the same corners');
const g = fireGeometry(bow, 'drawn');
assert.ok(g.coordinates[0].length === 5 && !selfCrossing(g.coordinates[0].slice(0, -1) as [number, number][]), 'the area added has no crossing lines');
const square: [number, number][] = [bow[0], bow[2], bow[1], bow[3]];
assert.ok(!untangle(square).reordered && untangle(square).vertices === square, 'a plain polygon keeps its corners as tapped');
// Random corner sets always end up without crossings.
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let k = 0; k < 300; k++) {
  const n = 4 + Math.floor(rnd() * 5);
  const v = Array.from({ length: n }, () => [C[0] + (rnd() - 0.5) * 0.01, C[1] + (rnd() - 0.5) * 0.008] as [number, number]);
  assert.ok(!selfCrossing(untangle(v).vertices), `random corners ${k}: still crossing`);
}

// 2. Streets in and next to a fire are closed from the time it was added; a deleted fire closes nothing.
const mk = (id: string, geometry: GeoJSON.Polygon, at: number, deletedAt?: number): OperatorFire => ({ id, source: 'crew', size: 'drawn', note: '', observedAt: at, addedAt: at, versions: [{ at, geometry }], deletedAt });
const T = Date.parse('2022-06-22T07:00:00Z');
const fire = mk('f1', g, T);
const closed = fireClosures([fire], streets);
assert.ok(closed.size > 0, 'a fire next to a road closes it');
for (const [id, c] of closed) {
  assert.equal(c.at, T);
  const s = streets.find((x) => x.properties.id === id)!;
  const pts = (s.geometry.type === 'LineString' ? s.geometry.coordinates : s.geometry.coordinates.flat()) as number[][];
  assert.ok(Math.min(...pts.map((p) => Math.min(...g.coordinates[0].map((q) => metres(p, q))))) < 700, `${id} is nowhere near the fire`);
}
// Every street with a vertex inside the area is among them.
const inside = streets.filter((s) => (s.geometry.type === 'LineString' ? s.geometry.coordinates : s.geometry.coordinates.flat()).some((p) => {
  const r = g.coordinates[0]; let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < ((r[j][0] - r[i][0]) * (p[1] - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
  return ins;
}));
for (const s of inside) assert.ok(closed.has(s.properties.id), `${s.properties.id} is inside the fire but not closed`);
assert.equal(fireClosures([mk('f2', g, T, T + 60000)], streets).size, 0, 'a deleted fire closes nothing');
// A fire moved later: the streets at its new place close from the move, those at the first place from the start.
const moved = { ...fire, versions: [...fire.versions, { at: T + 3600000, geometry: circle(28.14, 36.881, 100, 24) }] };
const both = fireClosures([moved], streets);
assert.ok([...both.values()].some((c) => c.at === T) && [...both.values()].some((c) => c.at === T + 3600000), 'a moved fire closes streets at both places, each from its time');

// 3. Inside / outside the model's area.
const area: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[28.0248, 36.8999], [28.2066, 36.8982], [28.2052, 36.8133], [28.0236, 36.815], [28.0248, 36.8999]]] };
assert.equal(fireInModel(circle(28.05, 36.849, 250, 24), area), 'inside');
assert.equal(fireInModel(circle(28.25, 36.86, 250, 24), area), 'outside');
assert.equal(fireInModel(circle(28.2055, 36.86, 250, 24), area), 'partly');
assert.equal(fireInModel(circle(28.05, 36.849, 250, 24), null), 'unknown');

// 4. A small part of the forecast holding an operator fire stays an area; other small parts are points.
const big = circle(28.1, 36.85, 1500, 48), small = circle(28.05, 36.849, 120, 24), other = circle(28.16, 36.88, 120, 24);
const multi: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [big.coordinates, small.coordinates, other.coordinates] };
const plain = splitParts(multi);
assert.ok(plain.spots.length === 2 && !plain.kept, 'without operator fires both small parts are points');
const kept = splitParts(multi, [[28.05, 36.849]]);
assert.ok(kept.spots.length === 1 && kept.kept?.type === 'Polygon' && metres(kept.spots[0], [28.16, 36.88]) < 30, 'the part around the operator fire is an area, the other still a point');
assert.ok(frontWidthM(0.02) === 0 && frontWidthM(0.5) > 25 && frontWidthM(0.5) < 100 && frontWidthM(50) === 300, 'front band width follows the part\'s own size');

// 5. At the station (on the connector to its road) the vehicle faces the way the first street leads.
const graph = buildGraph(streets);
const crews = makeCrews(read<{ records: Responder[] }>('responders.json').records);
const callers = read<{ records: CallerReport[] }>('caller_reports.json').records;
let legs = 0;
for (const c of callers.slice(0, 12)) for (const crew of crews) {
  const p = planLegs(graph, [c.place.lon, c.place.lat], [{ id: crew.id, name: crew.name, place: crew.home }], Date.parse(c.reported_at) + 5 * 60000)[0];
  if (!p || !p.leg.connectorMin || p.leg.path.length < 4) continue;
  const atStation = bearingOnLeg(p.leg, 0), justOnRoad = bearingOnLeg(p.leg, p.leg.connectorMin + 1e-4);
  assert.ok(atStation != null && atStation === justOnRoad, `${crew.name} -> ${c.id}: at the station ${atStation}, on its road ${justOnRoad}`);
  legs++;
}
assert.ok(legs > 20);
console.log(`fires: bow-ties untangled (300 random corner sets), ${closed.size} streets closed by one drawn fire (${inside.length} inside it), model area, kept parts, ${legs} station headings; 0 failures`);
