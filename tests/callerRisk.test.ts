/** Callers checked against Ufuk's live forecast: what is sent, what is read back, and what a card says. */
import assert from 'node:assert/strict';
import { LiveForecasts, callerRisks } from '../src/forecast';
import { fireRiskText } from '../src/components/CallerList';
import type { CallerReport, StreetFeature } from '../src/types';

const square = { type: 'Polygon' as const, coordinates: [[[28.04, 36.85], [28.06, 36.85], [28.06, 36.87], [28.04, 36.87], [28.04, 36.85]]] };
const street = { type: 'Feature', properties: { id: 'near' },
  geometry: { type: 'LineString', coordinates: [[28.04, 36.851], [28.06, 36.851]] } } as unknown as StreetFeature;
const weather = { weather: { time: ['2022-06-22T12:00:00Z', '2022-06-22T13:00:00Z'], wind_speed_10m: [20, 18],
  wind_direction_10m: [225, 240], temperature_2m: [30, 29], relative_humidity_2m: [30, 35] } };
const at = Date.parse('2022-06-22T12:00:00Z');
const caller = (id: string, reported: string, extra: Partial<CallerReport> = {}) => ({
  id, reported_at: reported, place: { lon: 28.07, lat: 36.86, label: 'Invented street 1' }, language: 'tr', urgency: 'urgent',
  urgency_reasons: ['invented'], hazard: 'fire', people_at_risk: 2, summary: 'Invented caller words', confirmed_by_operator: false,
  ...extra }) as unknown as CallerReport;

const exposure = (id: string, extra: Record<string, unknown> = {}) => ({
  id, status: 'in_path', first_horizon_h: 2, reached_at: '2022-06-22T14:00:00Z', worst_case_horizon_h: 1,
  worst_case_at: '2022-06-22T13:00:00Z', window_min: 60, suggested_action: 'evacuate', escalate_to: 'life_threat',
  fire_outside_forecast: false, reasons: ['Worst case: the fire may reach it by 22 Jun 13:00 UTC.'], ...extra });
const response = (caller_exposures?: unknown) => ({
  id: 'wf-live', fire_id: 'marmaris', issued_at: '2022-06-22T12:00:00Z', observed_at: '2022-06-22T12:00:00Z',
  model: 'rothermel-ellipse-mtt-ensemble/1.2', members: 32, perimeter: square, perimeter_area_ha: 100, warnings: [],
  zones: [{ horizon_h: 1, valid_at: '2022-06-22T13:00:00Z', area_ha: 130, confidence: 0.7, confidence_label: 'medium', geometry: square, envelope: square }],
  road_risks: [], ...(caller_exposures === undefined ? {} : { caller_exposures }) });

const originalFetch = globalThis.fetch;
let failures = 0;
try {
  let sent: any = null;
  const serve = (answer: unknown) => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith('spread_model.json')) sent = JSON.parse(String(init!.body));
      return new Response(JSON.stringify(url.endsWith('spread_model.json') ? weather : answer), { status: 200 });
    }) as typeof fetch;
  };
  const callers = [caller('before', '2022-06-22T11:50:00Z'), caller('after', '2022-06-22T12:10:00Z')];
  const req = { scenario: 'marmaris_2022', at, kind: 'rerun' as const, perimeter: square };

  serve(response([exposure('before'), { id: 'broken', status: 'somewhere', suggested_action: 'evacuate' }, null]));
  const run = await new LiveForecasts('http://localhost:8011', [street], '/spread_model.json', 120000, callers).run(req);
  assert.deepEqual(sent.callers.map((c: { id: string }) => c.id), ['before'], 'only callers known at the request time are sent');
  assert.deepEqual(Object.keys(sent.callers[0]).sort(), ['hazard', 'id', 'people_at_risk', 'place', 'reported_at', 'urgency']);
  assert.ok(!JSON.stringify(sent.callers).includes('Invented'), "the callers' words and place names are not sent");
  const risk = run!.callerRisks!.get('before')!;
  assert.equal(risk.action, 'evacuate');
  assert.equal(risk.worstAt, Date.parse('2022-06-22T13:00:00Z'));
  assert.equal(risk.reachAt, Date.parse('2022-06-22T14:00:00Z'));
  assert.equal(run!.callerRisks!.has('broken'), false, 'an entry that does not read is left out');
  assert.equal(run!.callerRisks!.size, 1);

  serve(response());  // a service from before callers support: no caller_exposures
  const old = await new LiveForecasts('http://localhost:8011', [street], '/spread_model.json', 120000, callers).run(req);
  assert.ok(old && old.callerRisks === undefined, 'not evaluated is not the same as no risk');
  assert.equal(callerRisks(null), undefined);

  serve(response([]));
  const none = await new LiveForecasts('http://localhost:8011', [street], '/spread_model.json').run(req);
  assert.deepEqual(sent.callers, [], 'no callers: an empty list, so the service still checks and answers');
  assert.equal(none!.callerRisks!.size, 0);

  // The card: the time left follows the clock; a raise only above the call's urgency now.
  const tz = 'UTC';
  const text = (r: ReturnType<typeof callerRisks> extends Map<string, infer V> | undefined ? V : never, urgency: 'routine' | 'urgent' | 'life_threat', now: number) =>
    fireRiskText(r, urgency, now, tz);
  assert.match(text(risk, 'urgent', at)!.text, /by .*13:00 \(in ~1 h\) · model suggests LIFE THREAT/);
  assert.match(text(risk, 'urgent', at + 30 * 60000)!.text, /in ~30 min/);
  assert.equal(text(risk, 'life_threat', at)!.text.includes('suggests'), false, 'already as high: no raise');
  assert.match(text(risk, 'urgent', at + 2 * 3600000)!.text, /may be here already/);
  const rescue = callerRisks([exposure('r', { status: 'inside_fire', reached_at: null, worst_case_at: null, suggested_action: 'rescue' })])!.get('r')!;
  assert.deepEqual(text(rescue, 'life_threat', at), { label: 'Rescue', text: 'inside the fire area' });
  const clear = callerRisks([exposure('c', { status: 'clear', reached_at: null, worst_case_at: null, suggested_action: 'none', escalate_to: null })])!.get('c')!;
  assert.equal(text(clear, 'routine', at), null, 'nothing to say for a caller the fire does not reach');
  const seen = callerRisks([exposure('s', { status: 'clear', reached_at: null, worst_case_at: null, suggested_action: 'none',
    escalate_to: null, fire_outside_forecast: true })])!.get('s')!;
  assert.match(text(seen, 'routine', at)!.text, /spot fire or new fire/);
  const near = callerRisks([exposure('n', { status: 'near', reached_at: null, worst_case_at: null, suggested_action: 'monitor', escalate_to: null })])!.get('n')!;
  assert.deepEqual(text(near, 'routine', at), { label: 'Monitor', text: 'within 1 km of where the worst case reaches' });
} catch (e) {
  failures++;
  console.error('FAIL', e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  globalThis.fetch = originalFetch;
}
console.log(`Caller fire risk: sent callers, read exposures, older service, card text; ${failures} failures`);
process.exit(failures ? 1 : 0);
