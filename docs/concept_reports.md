# CONCEPT DEMO · synthetic reports derived from later satellite passes

Written by `tools/build_concept_reports.py`. **Synthetic.** These reports are derived from VIIRS passes the model had not seen yet, so they are an upper bound of what callers could add. They are excluded from the overlap table in the README.

- Reports: 21, of them 6 false and 2 repeat calls from the same number; seed 20220621.
- Noise: position error 300-800 m, fire arrival 30-150 min before the pass, 25 % false reports.
- Clusters: 11; candidates (2 independent sources, P >= 0.5): 4.
- Confidence: noisy-OR `P = 1 - prod(1 - w_i)`, w = statement x location quality x observer distance x independence; one source at most 0.5.

## Score against the next VIIRS pass

Each row is a forecast issued at `issued`, compared with the next VIIRS pass: the share of that pass's detections on new ground (outside the area the forecast started from) that lie inside the forecast contour for that time, and the share of the area the forecast adds that VIIRS or Sentinel-2 ever saw burning.

| issued | next_pass | variant | false_reports | new_detections | new_detections_inside_pct | forecast_km2 | added_seen_burning_pct |
|---|---|---|---|---|---|---|---|
| 21 22:00 | 23:22 | without reports | 0 | 40 | 0 | 0.3 | 100 |
| 21 22:00 | 23:22 | with the true reports | 0 | 40 | 7.5 | 0.97 | 100 |
| 21 22:30 | 23:22 | without reports | 0 | 40 | 0 | 0.3 | 100 |
| 21 22:30 | 23:22 | with the true reports | 0 | 40 | 7.5 | 0.97 | 100 |
| 21 23:00 | 23:22 | without reports | 0 | 40 | 0 | 0.32 | 100 |
| 21 23:00 | 23:22 | with the true reports | 0 | 40 | 12.5 | 2.27 | 93.4 |
| 21 23:00 | 23:22 | with every candidate (false ones too) | 1 | 40 | 12.5 | 2.71 | 78.3 |
| 21 23:22 | 00:12 | without reports | 0 | 15 | 73.3 | 17.7 | 87 |
| 21 23:22 | 00:12 | with the true reports | 0 | 15 | 86.7 | 18.47 | 86.4 |
| 21 23:22 | 00:12 | with every candidate (false ones too) | 1 | 15 | 86.7 | 18.91 | 81.2 |
| 21 23:30 | 00:12 | without reports | 0 | 15 | 73.3 | 17.7 | 87 |
| 21 23:30 | 00:12 | with the true reports | 0 | 15 | 86.7 | 18.47 | 86.4 |
| 21 23:30 | 00:12 | with every candidate (false ones too) | 1 | 15 | 86.7 | 18.91 | 81.2 |
| 22 00:00 | 00:12 | without reports | 0 | 15 | 73.3 | 17.63 | 86.8 |
| 22 00:00 | 00:12 | with the true reports | 0 | 15 | 86.7 | 18.38 | 85.9 |
| 22 00:00 | 00:12 | with every candidate (false ones too) | 1 | 15 | 86.7 | 18.81 | 80.9 |
| 22 00:12 | 01:02 | without reports | 0 | 9 | 33.3 | 20.07 | 80.5 |
| 22 00:12 | 01:02 | with the true reports | 0 | 9 | 33.3 | 20.21 | 80.6 |
| 22 00:12 | 01:02 | with every candidate (false ones too) | 1 | 9 | 33.3 | 20.63 | 75.4 |
| 22 00:30 | 01:02 | without reports | 0 | 9 | 33.3 | 20.07 | 80.5 |
| 22 00:30 | 01:02 | with the true reports | 0 | 9 | 33.3 | 20.21 | 80.6 |
| 22 00:30 | 01:02 | with every candidate (false ones too) | 1 | 9 | 33.3 | 20.63 | 75.4 |
| 22 01:00 | 01:02 | without reports | 0 | 9 | 33.3 | 20.1 | 80.2 |
| 22 01:00 | 01:02 | with the true reports | 0 | 9 | 33.3 | 20.25 | 80.3 |
| 22 01:00 | 01:02 | with every candidate (false ones too) | 1 | 9 | 33.3 | 20.69 | 74.9 |
| 22 01:02 | 10:43 | without reports | 0 | 8 | 87.5 | 37.66 | 54.4 |
| 22 01:02 | 10:43 | with the true reports | 0 | 8 | 87.5 | 37.66 | 54.4 |
| 22 01:02 | 10:43 | with every candidate (false ones too) | 1 | 8 | 87.5 | 40.18 | 48.2 |
| 22 01:30 | 10:43 | without reports | 0 | 8 | 87.5 | 37.66 | 54.4 |
| 22 01:30 | 10:43 | with the true reports | 0 | 8 | 87.5 | 37.66 | 54.4 |
| 22 01:30 | 10:43 | with every candidate (false ones too) | 1 | 8 | 87.5 | 40.18 | 48.2 |

**Caveats.** In-sample parameters (r0_multiplier, gust fraction, wind-direction spread and length-to-breadth cap were set on this same fire), hindcast weather (archived Open-Meteo historical forecast, not the forecast available at the time) and zero satellite latency (each update is issued at the overpass minute; real near-real-time data arrive hours later). This is a replay of one fire, not a validation. The reports are synthetic and placed where a later satellite pass saw fire, with noise; real reports would be fewer, later and less precise.
