/**
 * Route safety (src/routeRisk.ts) on the Marmaris scenario, for the fastest crew to every call at several times:
 * - a warning only comes from the forecast in force (issued by the time shown) and names a street of the route
 *   the crew has not driven yet;
 * - "before the crew gets there" warnings come true: dispatched on that route, the crew is held at the warned time
 *   (unless a later forecast or satellite pass changes the closures first);
 * - a safer route is never riskier (no earlier first risk) and never leaves the crew further from the caller.
 *
 *   npx tsx tests/routeRisk.test.ts
 */
import { readFileSync } from 'node:fs';
import { PrecomputedForecasts, applyForecastClosures, autoLoads, forecastClosures, forecastInForce } from '../src/forecast';
import { prepareStreets, streetLabel } from '../src/data';
import { buildGraph } from '../src/routing';
import { candidatesFor, crewStateAt, holdTime, makeCrews } from '../src/crews';
import { RISK_WINDOW_H, streetNamer } from '../src/routeRisk';
import type { CallerReport, ForecastLibrary, Responder, StreetFeature } from '../src/types';

const dir = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const read = (f: string) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const pre = new PrecomputedForecasts(read('forecast_library.json') as ForecastLibrary);
const streets = prepareStreets(read('street_access.geojson').features as StreetFeature[]);
const callers = read('caller_reports.json').records as CallerReport[];
const responders = read('responders.json').records as Responder[];
const loads = autoLoads(pre);
applyForecastClosures(streets, forecastClosures(loads, pre.first), (x) => new Date(x).toISOString());
const byId = new Map(streets.map((s) => [s.properties.id, s]));
const g = buildGraph(streets);
const name = streetNamer(byId, streetLabel);
let failures = 0, plans = 0, warned = 0, before = 0, cameTrue = 0, safer = 0;
const fail = (m: string) => { failures++; console.log('FAIL', m); };
const nextLoad = (t: number) => Math.min(...loads.map((l) => l.at).filter((a) => a > t), Infinity);

for (const c of callers) {
  for (const dt of [5, 15, 30, 60, 120]) {
    const now = Date.parse(c.reported_at) + dt * 60e3;
    const inForce = forecastInForce(loads, pre.first, now)!;
    if (inForce.run.issuedAt > now) fail('forecast in force issued after the time shown');
    const states = makeCrews(responders).map((k) => crewStateAt(k, [], now, byId));
    const list = candidatesFor(g, [c.place.lon, c.place.lat], states, now, undefined, { reach: inForce.run.reach, name });
    for (const k of list) {
      plans++;
      const r = k.risk;
      if (!r) continue;
      warned++;
      const span = k.leg.spans.find((s) => s.edgeId === r.streetId);
      if (!span) fail(`${c.id}: warning names a street not on the route`);
      if (inForce.run.reach.get(r.streetId) !== r.reachAt) fail(`${c.id}: warning not from the forecast in force`);
      if (r.reachAt <= now || r.reachAt > r.passAt + RISK_WINDOW_H * 3600e3) fail(`${c.id}: warning outside its window`);
      if (r.zone === 'before') {
        before++;
        const hold = holdTime(k.leg, byId);
        // Closures can change when a new pass comes in before the warned time; otherwise the warning comes true.
        if (r.reachAt < nextLoad(now)) {
          if (hold == null || hold > r.reachAt + 60e3) fail(`${c.id} ${k.crew.name}: warned ${r.inMin.toFixed(0)} min, held at ${hold && ((hold - now) / 60e3).toFixed(0)}`);
          else cameTrue++;
        }
      }
      if (k.safer) {
        safer++;
        if (k.safer.risk && k.safer.risk.reachAt <= r.reachAt) fail(`${c.id}: safer route has an earlier risk`);
        if (k.safer.lastStretchM > k.lastStretchM + 100) fail(`${c.id}: safer route stops further from the caller`);
      }
    }
  }
}
console.log(`route risk: ${plans} plans; ${warned} warnings (${before} before the crew gets there, ${cameTrue} checked against the cut); `
  + `${safer} safer routes; ${failures} failures`);
process.exit(failures ? 1 : 0);
