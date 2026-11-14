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
import type { ConceptReports, FireReport, ForecastLibrary, StreetFeature } from '../src/types';
import { HALF_LIFE_MIN, clustersAt, currentConfidence, mockAnswer, type ConfirmationAnswer, type ConfirmationAsk } from '../src/reports';

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

// 6. "Is the fire still there?": fading, yes / no / unknown answers, and the mock never answers early.
{
  const r = (src: string, w: number, at: string) => ({ source_ref: src, confidence: w, observed_at: at, kind: 'caller' }) as unknown as FireReport;
  const t0 = Date.parse('2022-06-21T22:00:00Z');
  const reps = [r('a', 0.48, '2022-06-21T22:00:00Z'), r('b', 0.4, '2022-06-21T22:00:00Z')];
  const p0 = currentConfidence(reps, [], t0);
  const p40 = currentConfidence(reps, [], t0 + HALF_LIFE_MIN.caller * 60000);
  const expect40 = 1 - (1 - 0.24) * (1 - 0.2);
  if (Math.abs(p0 - (1 - 0.52 * 0.6)) > 1e-9 || Math.abs(p40 - expect40) > 1e-9) fail(`fading: ${p0} -> ${p40}`);
  const ask = (kind: 'crew' | 'caller', ref: string) => ({ id: `ask-${kind}`, cluster_id: 'c', report_id: 'x', target: { kind, ref, name: kind, distance_m: 0 },
    channel: 'radio', language: 'tr', question_code: 'FIRE_STILL_THERE', sent_at: t0, expires_at: t0 + 15 * 60000, mock: true }) as ConfirmationAsk;
  const ans = (a: ConfirmationAsk, answer: 'yes' | 'no' | 'unknown', onSite: boolean) =>
    ({ request_id: a.id, answer, answered_at: t0 + 10 * 60000, on_site: onSite, free_text: '', mock: true }) as ConfirmationAnswer;
  const T = t0 + 10 * 60000;
  const base = currentConfidence(reps, [], T);
  const crew = ask('crew', 'crew:1');
  const yes = currentConfidence(reps, [{ ask: crew, answer: ans(crew, 'yes', true) }], T);
  const noSite = currentConfidence(reps, [{ ask: crew, answer: ans(crew, 'no', true) }], T);
  const caller = ask('caller', 'z');
  const noFar = currentConfidence(reps, [{ ask: caller, answer: ans(caller, 'no', false) }], T);
  const unknown = currentConfidence(reps, [{ ask: caller, answer: ans(caller, 'unknown', false) }], T);
  const early = currentConfidence(reps, [{ ask: crew, answer: ans(crew, 'yes', true) }], T - 60000);
  if (!(yes > base)) fail('a yes must raise the confidence');
  if (Math.abs(noSite - base * 0.2) > 1e-9 || Math.abs(noFar - base * 0.7) > 1e-9) fail('a no must scale it by 0.2 on site, 0.7 from far');
  if (Math.abs(unknown - base) > 1e-9) fail('no answer must not change it');
  if (Math.abs(early - currentConfidence(reps, [], T - 60000)) > 1e-9) fail('an answer must not count before it arrives');
  const m = mockAnswer(crew, true, true);
  if (m.answered_at <= crew.sent_at || m.answer !== 'yes' || mockAnswer(crew, false, true).answer !== 'no') fail('mock answers');
}

console.log(`forecast: ${pre.runs.length} forecasts checked; ${compared} causality comparisons; closures by 23 Jun 08:40: `
  + `${a} without updates, ${b} updating at every pass; ${conceptChecked} concept cluster states; ${failures} failures`);
process.exit(failures ? 1 : 0);
