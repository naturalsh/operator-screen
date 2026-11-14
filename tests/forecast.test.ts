/**
 * Precomputed forecasts and forecast closures (src/forecast.ts), on the Marmaris library:
 * - every forecast the button can load only uses observations acquired by its issue time;
 * - closures at time T never depend on forecasts loaded after T;
 * - closures do depend on which forecasts the operator loaded.
 *
 *   npx tsx tests/forecast.test.ts
 */
import { readFileSync } from 'node:fs';
import { PrecomputedForecasts, applyForecastClosures, forecastClosures, forecastInForce, loadAt, type ForecastLoad } from '../src/forecast';
import { NEVER, prepareStreets } from '../src/data';
import type { ConceptReports, ForecastLibrary, StreetFeature } from '../src/types';
import { clustersAt } from '../src/reports';

const dir = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const lib = JSON.parse(readFileSync(new URL('forecast_library.json', dir), 'utf8')) as ForecastLibrary;
const pre = new PrecomputedForecasts(lib);
let failures = 0;
const fail = (msg: string) => { failures++; console.log('FAIL', msg); };

// 1. What "Update forecast" can load at any time was issued by then, from observations acquired by then.
for (let at = pre.first!.issuedAt; at <= pre.lastIssueAt + 6 * 3600e3; at += 7 * 60e3) {
  const r = pre.latest(at);
  if (!r) { fail(`no forecast at ${new Date(at).toISOString()}`); continue; }
  if (r.issuedAt > at || (r.lastObsAt ?? 0) > r.issuedAt) fail(`${r.id} at ${new Date(at).toISOString()}`);
  for (const t of r.reach.values()) if (t <= r.issuedAt) fail(`${r.id} reaches a street at or before its issue time`);
}

// 2. Causality: random load sequences; closures up to T are the same without the loads after T.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const span = [pre.first!.issuedAt, pre.lastIssueAt + 12 * 3600e3];
const sequences: ForecastLoad[][] = [];
for (let k = 0; k < 40; k++) {
  let loads: ForecastLoad[] = [];
  const n = 1 + Math.floor(rnd() * 8);
  for (let i = 0; i < n; i++) {
    const at = span[0] + rnd() * (span[1] - span[0]);
    const run = pre.latest(at)!;
    loads = loadAt(loads, { seq: i + 1, at, run, kind: 'update' });
  }
  sequences.push(loads);
}
let compared = 0;
for (const loads of sequences) {
  const full = forecastClosures(loads, pre.first);
  for (let j = 0; j < 6; j++) {
    const T = span[0] + rnd() * (span[1] - span[0]);
    const part = forecastClosures(loads.filter((l) => l.at <= T), pre.first);
    const ids = new Set([...full.keys(), ...part.keys()]);
    for (const id of ids) {
      const a = full.get(id), b = part.get(id);
      const ta = a && a.at <= T ? a.at : null, tb = b && b.at <= T ? b.at : null;
      if (ta !== tb) { fail(`closure of ${id} at ${new Date(T).toISOString()} depends on a later load`); break; }
    }
    compared++;
    // The forecast in force at T is a load made by T.
    const f = forecastInForce(loads, pre.first, T);
    if (f && f.at > T) fail('forecast in force loaded after the time shown');
  }
}

// 3. Which forecasts are loaded matters: never updating vs updating at every new pass.
const at = (s: string) => Date.parse(s);
const noUpdate: ForecastLoad[] = [{ seq: 1, at: at('2022-06-22T02:30:00Z'), run: pre.latest(at('2022-06-22T02:30:00Z'))!, kind: 'opening' }];
const updated = pre.runs.filter((r) => r.trigger === 'observation' && r.issuedAt >= noUpdate[0].at)
  .reduce((ls, r, i) => loadAt(ls, { seq: i + 2, at: r.issuedAt, run: r, kind: 'update' }), noUpdate);
const count = (m: ReturnType<typeof forecastClosures>, T: number) => [...m.values()].filter((c) => c.at <= T).length;
const T1 = at('2022-06-23T08:40:00Z');
const a = count(forecastClosures(noUpdate, pre.first), T1), b = count(forecastClosures(updated, pre.first), T1);
if (!(b > a)) fail(`updating at every pass should close more streets by 23 Jun 08:40 (${a} vs ${b})`);

// 4. Applied to the street records: status, closure time and source.
const streets = prepareStreets((JSON.parse(readFileSync(new URL('street_access.geojson', dir), 'utf8')) as { features: StreetFeature[] }).features);
const closures = forecastClosures(updated, pre.first);
applyForecastClosures(streets, closures, (x) => new Date(x).toISOString());
for (const s of streets) {
  const p = s.properties, c = closures.get(p.id);
  const first = Math.min(c?.at ?? NEVER, p.ts ?? NEVER);
  if (first < NEVER ? p.status !== 'blocked' || p.t !== first : p.status === 'blocked') { fail(`street ${p.id}: status ${p.status} t ${p.t}`); break; }
}

// 5. CONCEPT DEMO: the screen's noisy-OR gives the build script's candidate times, and before a cluster's
// candidate time it is never a candidate on screen.
const concept = JSON.parse(readFileSync(new URL('concept_reports.json', dir), 'utf8')) as ConceptReports;
let conceptChecked = 0;
for (const r of concept.records) {
  const T = Date.parse(r.observed_at);
  for (const st of clustersAt(concept, T, new Map())) {
    const c = st.cluster;
    const should = c.candidate_at != null && Date.parse(c.candidate_at) <= T;
    if (st.candidate !== should) fail(`${c.id} at ${r.observed_at}: screen says candidate=${st.candidate}`);
    conceptChecked++;
  }
}
const before = (c: { candidate_at?: string }) => Date.parse(c.candidate_at!) - 60e3;
for (const c of concept.clusters.filter((x) => x.candidate_at)) {
  const st = clustersAt(concept, before(c), new Map()).find((x) => x.cluster.id === c.id);
  if (st?.candidate) fail(`${c.id} is a candidate before its candidate time`);
}

console.log(`forecast: ${pre.runs.length} forecasts checked; ${compared} causality comparisons; closures by 23 Jun 08:40: `
  + `${a} without updates, ${b} updating at every pass; ${conceptChecked} concept cluster states; ${failures} failures`);
process.exit(failures ? 1 : 0);
