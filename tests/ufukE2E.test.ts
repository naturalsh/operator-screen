/**
 * Optional local end-to-end check against a running Ufuk service:
 *   WILDFIRE_API=http://127.0.0.1:8011 npx tsx tests/ufukE2E.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveForecasts, ModelValidationError, PrecomputedForecasts } from '../src/forecast';
import type { ForecastLibrary, StreetFeature } from '../src/types';

const api = process.env.WILDFIRE_API;
if (!api) throw new Error('WILDFIRE_API is required');
const dir = new URL('../public/scenarios/marmaris_2022/', import.meta.url);
const library = JSON.parse(readFileSync(new URL('forecast_library.json', dir), 'utf8')) as ForecastLibrary;
const streets = JSON.parse(readFileSync(new URL('street_access.geojson', dir), 'utf8')).features as StreetFeature[];
const source = new LiveForecasts(api, streets,
  'http://127.0.0.1:5173/scenarios/marmaris_2022/spread_model.json', 120000);

const at = Date.parse('2022-06-22T12:00:00Z');
const base = new PrecomputedForecasts(library).latest(at)!;
const perimeter = [...base.steps].reverse().find((s) => s.validAt <= at)!.geometry;
const run = await source.run({ scenario: 'marmaris_2022', at, kind: 'rerun', perimeter });
assert.ok(run && run.source === 'live' && run.features.length > 0, 'live zones reach the map contract');
assert.ok(run!.features.every((f) => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));
assert.ok(run!.confidence == null || run!.confidence >= 0);
assert.ok(run!.reach.size > 0, 'evaluated near roads have positive model reach/risk');
assert.ok([...run!.reach.values()].every((t) => t > at), 'road risk becomes a positive future reach time');

const outside = { type: 'Polygon' as const, coordinates: [[[29, 38], [29.01, 38], [29.01, 38.01], [29, 38.01], [29, 38]]] };
await assert.rejects(() => source.run({ scenario: 'outside', at, kind: 'rerun', perimeter: outside }),
  (e) => e instanceof ModelValidationError && /not inside the landscape grid/.test(e.message));

console.log(`Ufuk E2E: ${run!.features.length} map contours, ${run!.reach.size} positive road risks, confidence ${run!.confidence ?? 'unavailable'}; outside ignition rejected`);
// Node's fetch dispatcher can retain an idle keep-alive socket after the assertions have finished.
process.exit(0);
