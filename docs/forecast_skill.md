# Forecast overlap with later satellite data (Marmaris 2022)

Written by `tools/build_marmaris_scenario.py`. For every forecast update and horizon, the FIRMS hotspots (VIIRS and MODIS, low confidence dropped) acquired between the issue time and issue + horizon are counted; a hotspot falls in several overlapping updates, so 'detections' count it once per update and 'distinct hotspots' once. 'New ground' = outside the area the update started from. The share of hotspots inside a forecast is a recall: larger forecasts score higher. The last three columns give the other side: of the area each forecast adds beyond its starting area, the share that any VIIRS or Sentinel-2 observation of the whole event saw burning.

| updates | horizon | n updates | hotspot detections (counted per update) | distinct hotspots | inside updated % | inside one-shot % | new-ground detections | distinct new-ground hotspots | new ground inside updated % | new ground inside one-shot % | forecast new area km2 (summed) | of it seen burning, updated % | of it seen burning, one-shot % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all updates | +4 h | 20 | 818 | 489 | 74.4 | 8.8 | 335 | 262 | 37.6 | 3.3 | 236.6 | 40.7 | 27.7 |
| all updates | +8 h | 20 | 1298 | 559 | 63.1 | 11.2 | 726 | 436 | 34 | 6.2 | 412.6 | 32.8 | 32.2 |
| all updates | +12 h | 20 | 1787 | 559 | 71.9 | 13 | 1007 | 464 | 50.1 | 7.6 | 601.5 | 27.9 | 36.2 |
| started from ignition point | +4 h | 2 | 167 | 167 | 1.8 | 3 | 167 | 167 | 1.8 | 3 | 1.2 | 100 | 99.1 |
| started from ignition point | +8 h | 2 | 323 | 167 | 3.4 | 5.6 | 323 | 167 | 3.4 | 5.6 | 3.2 | 95.4 | 95.2 |
| started from ignition point | +12 h | 2 | 351 | 195 | 6.8 | 9.1 | 351 | 195 | 6.8 | 9.1 | 6.3 | 93.5 | 92.7 |
| started from satellite perimeter | +4 h | 18 | 651 | 434 | 93.1 | 10.3 | 168 | 125 | 73.2 | 3.6 | 235.4 | 40.4 | 25.7 |
| started from satellite perimeter | +8 h | 18 | 975 | 504 | 82.9 | 13 | 403 | 299 | 58.6 | 6.7 | 409.3 | 32.3 | 29.1 |
| started from satellite perimeter | +12 h | 18 | 1436 | 504 | 87.8 | 14 | 656 | 312 | 73.3 | 6.9 | 595.2 | 27.2 | 32.1 |

**Caveats.** In-sample parameters (r0_multiplier, gust fraction, wind-direction spread and length-to-breadth cap were set on this same fire), hindcast weather (archived Open-Meteo historical forecast, not the forecast available at the time) and zero satellite latency (each update is issued at the overpass minute; real near-real-time data arrive hours later). This is a replay of one fire, not a validation.
