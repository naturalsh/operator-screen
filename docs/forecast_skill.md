# Forecast overlap with later satellite data (Marmaris 2022)

Written by `tools/build_marmaris_scenario.py`. For every forecast update and horizon, the FIRMS hotspots (VIIRS and MODIS, low confidence dropped) acquired between the issue time and issue + horizon are counted; a hotspot falls in several overlapping updates, so 'detections' count it once per update and 'distinct hotspots' once. 'New ground' = outside the area the update started from. The share of hotspots inside a forecast is a recall: larger forecasts score higher. The last three columns give the other side: of the area each forecast adds beyond its starting area, the share that any VIIRS or Sentinel-2 observation of the whole event saw burning.

| updates | horizon | n updates | hotspot detections (counted per update) | distinct hotspots | inside updated % | inside one-shot % | new-ground detections | distinct new-ground hotspots | new ground inside updated % | new ground inside one-shot % | forecast new area km2 (summed) | of it seen burning, updated % | of it seen burning, one-shot % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all updates | +30 min | 15 | 26 | 26 | 84.6 | 0 | 6 | 6 | 33.3 | 0 | 50.7 | 39.5 | 19.8 |
| all updates | +1 h | 15 | 383 | 367 | 88 | 5.5 | 85 | 80 | 45.9 | 3.5 | 73.5 | 41.6 | 20.2 |
| all updates | +2 h | 15 | 531 | 385 | 91.1 | 7.9 | 121 | 95 | 61.2 | 4.1 | 113.4 | 42.1 | 21.6 |
| all updates | +3 h | 15 | 554 | 385 | 93.9 | 9.2 | 124 | 96 | 72.6 | 4 | 149.9 | 41.1 | 22 |
| all updates | +6 h | 15 | 589 | 396 | 96.3 | 12.7 | 144 | 107 | 84.7 | 7.6 | 250.3 | 35.1 | 25 |
| started from ignition point | +30 min | 1 | 0 | 0 |  |  | 0 | 0 |  |  | 0.1 | 100 |  |
| started from ignition point | +1 h | 1 | 0 | 0 |  |  | 0 | 0 |  |  | 0.2 | 100 |  |
| started from ignition point | +2 h | 1 | 0 | 0 |  |  | 0 | 0 |  |  | 0.3 | 100 | 100 |
| started from ignition point | +3 h | 1 | 0 | 0 |  |  | 0 | 0 |  |  | 0.4 | 100 | 100 |
| started from ignition point | +6 h | 1 | 11 | 11 | 0 | 0 | 11 | 11 | 0 | 0 | 0.9 | 100 | 100 |
| started from satellite perimeter | +30 min | 14 | 26 | 26 | 84.6 | 0 | 6 | 6 | 33.3 | 0 | 50.6 | 39.4 | 19.8 |
| started from satellite perimeter | +1 h | 14 | 383 | 367 | 88 | 5.5 | 85 | 80 | 45.9 | 3.5 | 73.4 | 41.5 | 20.2 |
| started from satellite perimeter | +2 h | 14 | 531 | 385 | 91.1 | 7.9 | 121 | 95 | 61.2 | 4.1 | 113.1 | 42 | 21.2 |
| started from satellite perimeter | +3 h | 14 | 554 | 385 | 93.9 | 9.2 | 124 | 96 | 72.6 | 4 | 149.6 | 40.9 | 21.6 |
| started from satellite perimeter | +6 h | 14 | 578 | 385 | 98.1 | 13 | 133 | 96 | 91.7 | 8.3 | 249.4 | 34.9 | 24.1 |

**Caveats.** In-sample parameters (r0_multiplier, gust fraction, wind-direction spread and length-to-breadth cap were set on this same fire), hindcast weather (archived Open-Meteo historical forecast, not the forecast available at the time) and zero satellite latency (each update is issued at the overpass minute; real near-real-time data arrive hours later). This is a replay of one fire, not a validation.
