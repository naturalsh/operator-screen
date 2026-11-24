/** Ufuk wildfire_model fa77f03 (model 1.2) contract -> existing operator ForecastRun/map contract. */
import assert from 'node:assert/strict';
import { LiveForecasts, ModelValidationError, applyForecastRoadRisks, modelPerimeter } from '../src/forecast';
import type { StreetFeature } from '../src/types';

const square = { type: 'Polygon' as const, coordinates: [[[28.04, 36.85], [28.06, 36.85], [28.06, 36.87], [28.04, 36.87], [28.04, 36.85]]] };
const street = (id: string, y: number) => ({ type: 'Feature', properties: { id },
  geometry: { type: 'LineString', coordinates: [[28.04, y], [28.06, y]] } }) as unknown as StreetFeature;

const weather = { weather: { time: ['2022-06-22T12:00:00Z', '2022-06-22T13:00:00Z'], wind_speed_10m: [20, 18],
  wind_direction_10m: [225, 240], temperature_2m: [30, 29], relative_humidity_2m: [30, 35] } };

const response = {
  id: 'wf-live', fire_id: 'marmaris', issued_at: '2022-06-22T12:00:00Z', observed_at: '2022-06-22T12:00:00Z',
  model: 'rothermel-ellipse-mtt-ensemble/1.2', members: 32, perimeter: square, perimeter_area_ha: 100, warnings: [],
  zones: [
    { horizon_h: 0.5, valid_at: '2022-06-22T12:30:00Z', area_ha: 130, confidence: 0.7, confidence_label: 'medium', geometry: square, envelope: square },
    { horizon_h: 6, valid_at: '2022-06-22T18:00:00Z', area_ha: 300, confidence: 0.55, confidence_label: 'low', geometry: square, envelope: square },
  ],
  road_risks: [
    { edge_id: 'near', risk: 1, first_horizon_h: 0.5, confidence: 0.7, relationship: 'intersects', recommended_action: 'close' },
    { edge_id: 'buffer', risk: 1, first_horizon_h: 0.5, confidence: 0.7, relationship: 'safety_buffer', recommended_action: 'monitor' },
  ],
};

const originalFetch = globalThis.fetch;
let failures = 0;
const fail = (message: string) => { failures++; console.error('FAIL', message); };

try {
  const hull = modelPerimeter({ type: 'MultiPolygon', coordinates: [square.coordinates, [[[28.08, 36.85], [28.09, 36.85], [28.09, 36.86], [28.08, 36.85]]]] });
  assert.ok(hull.some(([lon]) => lon === 28.09), 'adapter keeps all fire parts in one outer perimeter');

  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(url.endsWith('spread_model.json') ? weather : response), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const streets = [street('near', 36.851), street('buffer', 36.852), street('far', 37)];
  const source = new LiveForecasts('http://localhost:8011', streets, '/spread_model.json');
  const run = await source.run({ scenario: 'marmaris_2022', at: Date.parse('2022-06-22T12:00:00Z'), kind: 'rerun', perimeter: square });
  assert.ok(run && run.source === 'live');
  assert.equal(run!.reach.get('near'), Date.parse('2022-06-22T12:30:00Z'));
  assert.equal(run!.reach.get('buffer'), Date.parse('2022-06-22T12:30:00Z'));
  assert.equal(run!.closeReach?.has('near'), true, 'an intersecting road with a close recommendation can close');
  assert.equal(run!.closeReach?.has('buffer'), false, 'a 150 m buffer-only road is risk, not a closure');
  assert.equal(run!.roadRisks?.get('buffer')?.relationship, 'safety_buffer');
  assert.equal(run!.reach.has('far'), false, 'an evaluated far road stays absent; missing model data is not converted to zero risk');
  applyForecastRoadRisks(streets, run!);
  assert.equal(streets[1].properties.model_risk_relationship, 'safety_buffer');
  assert.equal(streets[1].properties.model_risk_action, 'monitor');
  assert.equal(run!.confidence, 0.55);
  assert.equal(run!.features.find((f) => f.properties.horizon_hours === 6)?.geometry.type, 'Polygon');
  const sent = calls.find((c) => c.url.endsWith('/wildfire/forecast'))!.body as any;
  assert.equal(sent.r0_scale, undefined, 'service default 0.4 is used when the operator sends no setting');
  assert.deepEqual(sent.observation.perimeter[0], { lon: 28.04, lat: 36.85 }, 'GeoJSON [lon,lat] is mapped without swapping');
  assert.equal(sent.observation.weather[0].start_h, 0);
  assert.equal(sent.roads[0].geometry.type, 'LineString');
  assert.deepEqual(sent.horizons_h.slice(0, 3), [0.5, 1, 1.5]);

  const unavailableConfidence = { ...response,
    zones: response.zones.map((z) => ({ ...z, confidence: null, confidence_label: null })),
    road_risks: response.road_risks.map((r) => ({ ...r, confidence: null })) };
  globalThis.fetch = (async (input: string | URL | Request) => new Response(JSON.stringify(
    String(input).endsWith('spread_model.json') ? weather : unavailableConfidence), { status: 200 })) as typeof fetch;
  const noConfidence = await new LiveForecasts('http://localhost:8011', streets, '/spread_model.json')
    .run({ scenario: 'marmaris_2022', at: Date.parse('2022-06-22T12:00:00Z'), kind: 'rerun', perimeter: square });
  assert.equal(noConfidence!.confidence, null, 'unavailable model confidence remains null for the dashboard');
  assert.match(noConfidence!.confidenceReason ?? '', /unavailable/);

  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('spread_model.json')
    ? new Response(JSON.stringify(weather), { status: 200 })
    : new Response(JSON.stringify({ detail: "fire perimeter is not inside the landscape grid (Marmaris)" }), { status: 422 })) as typeof fetch;
  const invalid = new LiveForecasts('http://localhost:8011', [street('near', 36.851)], '/spread_model.json');
  await assert.rejects(() => invalid.run({ scenario: 'x', at: Date.parse('2022-06-22T12:00:00Z'), kind: 'rerun', perimeter: square }),
    (e) => e instanceof ModelValidationError && /not inside the landscape grid/.test(e.message));

  globalThis.fetch = (async (input: string | URL | Request) => String(input).endsWith('spread_model.json')
    ? new Response(JSON.stringify(weather), { status: 200 })
    : new Response('', { status: 503 })) as typeof fetch;
  const unavailable = new LiveForecasts('http://localhost:8011', [street('near', 36.851)], '/spread_model.json');
  await assert.rejects(() => unavailable.run({ scenario: 'x', at: Date.parse('2022-06-22T12:00:00Z'), kind: 'rerun', perimeter: square }),
    /Ufuk wildfire model did not answer: HTTP 503/, 'a configured live flow never substitutes a precomputed/browser model');
} catch (e) {
  fail(e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`Ufuk model adapter: request units/coordinates/default, zones, confidence, road risk and validation error; ${failures} failures`);
process.exit(failures ? 1 : 0);
