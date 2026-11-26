# Ufuk wildfire model integration

The operator screen's **Update forecast** trigger uses the private
`naturalsh/wildfire_model` FastAPI service when the page is opened with
`?forecast_api=http://localhost:8011`. The integrated and tested model revision is
`42e5cb868480bf6e52600fe92bd1e74c7fc4af86` (`main`, 26 November 2026), model
`rothermel-ellipse-mtt-ensemble/1.2`, which includes the dashboard API contract (`roads`,
`road_risks`, `issued_at`, nullable confidence) and the caller check (`callers`,
`caller_exposures`). A revision before it ignores `callers` and the cards show no fire line.

Start the model beside this repository. The service needs the real Marmaris landscape; build it
once as described in the wildfire_model README (`demo-data/marmaris_2022_real.npz`, not committed):

```sh
cd ../wildfire_model
WILDFIRE_LANDSCAPE="$PWD/demo-data/marmaris_2022_real.npz" uvicorn wildfire.api:app --port 8011
curl http://localhost:8011/health   # {"ok":true,"landscape":"Marmaris, June 2022",...}

cd ../operator-screen
npm run dev
# open http://localhost:5173/?forecast_api=http://localhost:8011
```

## Contract adapter

`LiveForecasts` in `src/forecast.ts` adapts the current operator contract to Ufuk's
`POST /wildfire/forecast` contract:

- The current fire estimate is GeoJSON EPSG:4326. Coordinates remain `[longitude, latitude]`.
  Ufuk's `FireObservation` accepts one outer perimeter; a MultiPolygon is represented by the
  convex outer ring containing all current parts.
- The scenario's hourly weather becomes `WeatherStep`: wind remains km/h and meteorological
  `wind_from_deg`; relative humidity and Celsius temperature become dead-fuel moisture percent.
- Forecast horizons are 0.5-hour steps through 12 hours. The request omits `r0_scale`, so the
  service's tested default `0.4` is exercised. The service still accepts an explicit scale.
- Real street LineString/MultiLineString geometries and stable street ids are sent in `roads`.
  Returned positive `road_risks[].first_horizon_h` values become the site's risk/reach times. An
  exact contour intersection with `recommended_action: close` can enter the closure timeline.
  `relationship: safety_buffer` is shown as “Yangına yakın / risk altında” and never closes a
  road by itself. A null road-risk result is rejected as missing data; missing data is never
  treated as zero risk.
- `area_ha` is divided by 100 for the site's km² fields. Zone GeoJSON is passed to MapLibre.
  Ensemble `confidence` is displayed directly; null is shown as “Hesaplanamadı”, never derived
  from fire area. No growth and a single member return null; genuine multi-member agreement may
  return 1.0.
- `issued_at`, `observed_at`, `valid_at` and horizon hours are checked for consistency before a
  response reaches the map.
- **Callers in the fire's path.** The caller reports received by the request time are sent in
  `callers`, with only what the check needs (id, time, place, urgency, people at risk, hazard;
  never the caller's words or a place name). The returned `caller_exposures` say for each caller
  whether the forecast reaches the place, when (the worst case: one run in ten), and suggest
  rescue, evacuate or monitor, and a higher urgency when the fire makes it more pressing. The card
  shows one line, "🔥 Evacuate · worst case: fire may reach here by 16:00 (in ~1 h) · model suggests
  URGENT", counting the time left from the clock shown; its hover holds the model's reasons (times
  in UTC) as of the forecast's issue. A caller who reports a fire where the forecast does not reach
  is shown as a possible spot fire or new fire. Only suggestions: the dispatcher decides, and the
  screen never changes an urgency itself. A caller reported after the forecast in force has no
  line until the next forecast. A model service without callers support leaves
  `caller_exposures` out; the cards then show nothing, rather than "no risk". An entry that does
  not read is left out. Replay mode (no `forecast_api`) is unchanged.

A configured live flow never substitutes the browser or precomputed model. Service/network errors
and 422 responses (including any starting perimeter that crosses the configured landscape grid)
are shown in the forecast panel.

## Checks

```sh
npm test
WILDFIRE_API=http://127.0.0.1:8011 npx tsx tests/ufukE2E.test.ts
```

The first command includes the deterministic contract regression (`tests/ufukModel.test.ts`) and
the caller check (`tests/callerRisk.test.ts`: which callers are sent, how the answer is read, an
older service, the card's text as the clock moves). The optional second command
runs the site's real adapter against a running Ufuk service, verifies map contours, positive
near-road risks and confidence, then verifies that an outside ignition returns a visible
validation error.
