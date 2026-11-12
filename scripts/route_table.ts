// Drive time from every response point to every caller, at the time of the call (+5 min), with the
// streets blocked at that moment avoided. Uses the same routing code as the screen.
// Usage: npm run routes [scenario id]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStreets } from '../src/data';
import { buildGraph, planRoute, stationTimes } from '../src/routing';
import type { CallerReport, Responder, ScenarioEntry, StreetFeature } from '../src/types';

const base = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'scenarios');
const read = <T>(p: string) => JSON.parse(readFileSync(join(base, p), 'utf8')) as T;

const scenarios = read<{ scenarios: ScenarioEntry[] }>('index.json').scenarios;
const entry = scenarios.find((s) => s.id === process.argv[2]) ?? scenarios[0];
if (!entry.files.responders) throw new Error(`scenario ${entry.id} has no responders file`);
const streets = prepareStreets(read<{ features: StreetFeature[] }>(entry.files.street_access).features);
const callers = read<{ records: CallerReport[] }>(entry.files.caller_reports).records;
const responders = read<{ records: Responder[] }>(entry.files.responders).records;
const graph = buildGraph(streets);

const cell = (t: { minutes: number | null; km: number | null; trackKm: number | null }) => (t.minutes == null ? 'no access'
  : `${Math.round(t.minutes)} min / ${t.km!.toFixed(0)} km${t.trackKm! >= 0.5 ? ` (${t.trackKm!.toFixed(0)} km track)` : ''}`);

console.log(`scenario ${entry.id}: drive time to the caller's street, blocked streets avoided, at call time + 5 min\n`);
console.log(['call', 'time (UTC)', ...responders.map((r) => r.name), 'dispatched'].join(' | '));
for (const c of callers) {
  const now = Date.parse(c.reported_at) + 5 * 60000;
  const times = stationTimes(graph, c, responders, now);
  const plan = planRoute(graph, c, responders, now);
  console.log([c.id.replace('synthetic-call-', '#'), c.reported_at.slice(5, 16).replace('T', ' '), ...times.map(cell),
    plan ? `${plan.responderName}, ${Math.round(plan.minutes)} min` : 'no access'].join(' | '));
}
