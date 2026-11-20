# Ufuk wildfire model integration

The operator screen's **Update forecast** trigger uses the private
`naturalsh/wildfire_model` FastAPI service when the page is opened with
`?forecast_api=http://localhost:8011`. The integrated and tested model revision is
`d624a57241c018c64d81832b3f643f4517928c23` (`main`, 19 November 2026).

Start the model beside this repository:

```sh
cd ../wildfire_model
uvicorn wildfire.api:app --port 8011

cd ../natural-shield-operator
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
  Returned positive `road_risks[].first_horizon_h` values become the site's reach times. A null
  road-risk result is rejected as missing data; missing data is never treated as zero risk.
- `area_ha` is divided by 100 for the site's km² fields. Zone GeoJSON is passed to MapLibre.
  Ensemble `confidence` is displayed directly; null is shown as “not available”, never derived
  from fire area.
- `issued_at`, `observed_at`, `valid_at` and horizon hours are checked for consistency before a
  response reaches the map.

A configured live flow never substitutes the browser or precomputed model. Service/network errors
and 422 responses (including an ignition outside the configured landscape grid) are shown in the
forecast panel.

## Checks

```sh
npm test
WILDFIRE_API=http://127.0.0.1:8011 npx tsx tests/ufukE2E.test.ts
```

The first command includes the deterministic contract regression. The optional second command
runs the site's real adapter against a running Ufuk service, verifies map contours, positive
near-road risks and confidence, then verifies that an outside ignition returns a visible
validation error.
