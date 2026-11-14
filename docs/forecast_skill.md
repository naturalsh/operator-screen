# Forecast overlap with later satellite data (Marmaris 2022)

Written by `tools/build_marmaris_scenario.py`. For every forecast update and horizon, the FIRMS hotspots (VIIRS and MODIS, low confidence dropped) acquired between the issue time and issue + horizon are counted; a hotspot falls in several overlapping updates, so 'detections' count it once per update and 'distinct hotspots' once. 'New ground' = outside the area the update started from. The share of hotspots inside a forecast is a recall: larger forecasts score higher. The last three columns give the other side: of the area each forecast adds beyond its starting area, the share that any VIIRS or Sentinel-2 observation of the whole event saw burning.

| updates | horizon | n updates | hotspot detections (counted per update) | distinct hotspots | inside updated % | inside one-shot % | new-ground detections | distinct new-ground hotspots | new ground inside updated % | new ground inside one-shot % | forecast new area km2 (summed) | of it seen burning, updated % | of it seen burning, one-shot % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all updates | +4 h | 16 | 807 | 478 | 74.5 | 8.9 | 331 | 258 | 37.8 | 3.3 | 179.7 | 52.7 | 39.5 |
| all updates | +8 h | 16 | 1267 | 536 | 63 | 11.4 | 706 | 417 | 33.6 | 6.4 | 302.1 | 43.8 | 42.5 |
| all updates | +12 h | 16 | 1741 | 539 | 71.6 | 13.4 | 974 | 448 | 49.3 | 7.9 | 445.5 | 36.8 | 45.6 |
| started from ignition point | +4 h | 2 | 167 | 167 | 1.8 | 3 | 167 | 167 | 1.8 | 3 | 1.2 | 100 | 99.1 |
| started from ignition point | +8 h | 2 | 323 | 167 | 3.4 | 5.6 | 323 | 167 | 3.4 | 5.6 | 3.2 | 95.4 | 95.2 |
| started from ignition point | +12 h | 2 | 351 | 195 | 6.8 | 9.1 | 351 | 195 | 6.8 | 9.1 | 6.3 | 93.5 | 92.7 |
| started from satellite perimeter | +4 h | 14 | 640 | 423 | 93.4 | 10.5 | 164 | 121 | 74.4 | 3.7 | 178.5 | 52.4 | 37.1 |
| started from satellite perimeter | +8 h | 14 | 944 | 481 | 83.4 | 13.5 | 383 | 280 | 59 | 7 | 298.9 | 43.2 | 39 |
| started from satellite perimeter | +12 h | 14 | 1390 | 484 | 88 | 14.5 | 623 | 296 | 73.2 | 7.2 | 439.2 | 36 | 41.3 |

**Caveats.** In-sample parameters (r0_multiplier, gust fraction, wind-direction spread and length-to-breadth cap were set on this same fire), hindcast weather (archived Open-Meteo historical forecast, not the forecast available at the time) and zero satellite latency (each update is issued at the overpass minute; real near-real-time data arrive hours later). This is a replay of one fire, not a validation.
