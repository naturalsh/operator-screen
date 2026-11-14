# Forecast API (for a live model server, not set up yet)

The screen gets every forecast through one interface, `ForecastSource` in `src/forecast.ts`:

- `PrecomputedForecasts` (used now): reads `public/scenarios/<id>/forecast_library.json`, written by
  `tools/build_forecast_library.py`. One forecast at ignition, at every new VIIRS or Sentinel-2 burned-area
  observation, and every 30 minutes in between. Works on the static site and offline.
- `LiveForecasts`: asks a model server first and falls back to the precomputed forecast when the server does not
  answer within 3 s or answers with something else. The screen then shows "live model did not answer;
  precomputed". It is only used when the page is opened with `?forecast_api=<server url>`, e.g.
  `http://localhost:5173/?forecast_api=http://localhost:8000`.

The forecast panel shows **PRECOMPUTED** or **LIVE MODEL**, so the audience always knows which one is on screen.

## Request

`POST {forecast_api}/forecast`, `Content-Type: application/json`:

```json
{ "scenario": "marmaris_2022", "at": 1655897400000, "kind": "update" }
```

| Field | Meaning |
|---|---|
| `scenario` | Scenario id from `public/scenarios/index.json`. |
| `at` | Scenario time of the request, epoch milliseconds (UTC). |
| `kind` | `update`: start from every VIIRS / Sentinel-2 observation acquired by `at`. `rerun`: the same perimeter as the forecast in force, a later start time and the weather from then on. |

## Response

One record of `schemas/forecast_library.schema.json` (the same shape as a library entry), with
`trigger: "live"` and street **ids** (not indexes) in `reach`:

```json
{
  "id": "marmaris_2022-live-20220622T1140Z",
  "issued_at": "2022-06-22T11:40:00Z",
  "trigger": "live",
  "initialised_from": "VIIRS perimeter",
  "last_observation_at": "2022-06-22T11:33:00Z",
  "last_observation_label": "VIIRS S-NPP",
  "start_area_km2": 31.2,
  "contours": [{ "horizon_hours": 4, "valid_at": "2022-06-22T15:40:00Z", "area_km2": 38.0, "geometry": { "type": "Polygon", "coordinates": [] } }],
  "reach": [["marmaris_2022-street-1518696480-123-456", 2.0]]
}
```

Rules the server must keep (the screen rejects an answer issued after `at`):

- Use only observations acquired by `at` (the same "no hindsight" rule as `tools/test_no_hindsight.py`).
- `reach`: hours after `issued_at` at which the P ≥ 50 % contour reaches each street, using the fire repo's
  `evaluate_road_closures` with the 150 m safety buffer, horizons 2–12 h. The screen computes forecast closures
  from it.
- `contours`: the +4, +8 and +12 h P ≥ 50 % contours, GeoJSON in EPSG:4326.

A server can be a thin FastAPI wrapper around `forecast_runner(...)["run"](issued)` and `reach_hours(...)` in
`tools/build_marmaris_scenario.py` / `tools/build_forecast_library.py`. One forecast takes about 0.5 s on a
laptop. Allow the screen's origin in CORS. The server also needs the confirmed fire reports (see the concept demo)
when it runs; the request will carry them as `reports` once that exists.
