"""Reference cases for the browser spread model (tests/spread.test.ts), computed with the fire repo's Python model.

    <fire repo>/fireproj/.venv/bin/python tools/compare_spread.py <fire repo>/fireproj

For each case: the starting mask, the arrival times of one run without perturbation (run_mtt) and the P >= 50 %
masks of the Monte Carlo ensemble (run_monte_carlo, the precomputed forecasts' settings and seed) at
0.5 / 1 / 2 / 3 / 6 / 12 h. Written to tests/fixtures/spread_cases.json.gz.
"""

from __future__ import annotations

import base64
import gzip
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_marmaris_scenario as B  # noqa: E402

HORIZONS = [0.5, 1.0, 2.0, 3.0, 6.0, 12.0]
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "spread_cases.json.gz"


def bits(mask: np.ndarray) -> str:
    return base64.b64encode(np.packbits(mask.astype(np.uint8).ravel(), bitorder="little").tobytes()).decode()


def main() -> int:
    import geopandas as gpd
    import pandas as pd
    from rasterio.features import rasterize
    from shapely.geometry import Point
    from shapely.ops import unary_union

    from fireproj.config import load_config
    from fireproj.spread.montecarlo import extract_hourly_weather_series, run_monte_carlo
    from fireproj.spread.mtt import prepare_terrain_and_moisture_arrays, run_mtt

    fire_root = Path(sys.argv[1]).resolve()
    cfg = load_config(fire_root / "config.yaml")
    r = B.forecast_runner(fire_root, cfg)
    grid, run_cfg, spec, fine, wx, fuel, dem = r["grid"], r["run_cfg"], r["spec"], r["fine"], r["wx"], r["fuel"], r["dem"]
    import copy
    cfg_h = copy.deepcopy(run_cfg)
    cfg_h["spread"]["time_horizons_hours"] = HORIZONS
    burn = lambda geoms: rasterize([(g, 1) for g in geoms], out_shape=grid.shape, transform=grid.transform, fill=0,
                                   all_touched=True, dtype=np.uint8).astype(bool)
    utc = lambda s: datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
    seen = lambda t: unary_union(list(fine[fine["_t"] <= pd.Timestamp(t)].geometry))

    # A chained re-run (library trigger "scheduled"): its start is the 01:02 forecast's P >= 50 % area at 06:00.
    starts: dict = {}
    list(B.chained_runs(r, [(utc("2022-06-22T01:02:00"), "observation"), (utc("2022-06-22T06:00:00"), "scheduled")], starts=starts))
    chained = starts[utc("2022-06-22T06:00:00")][0] | burn([seen(utc("2022-06-22T06:00:00"))])
    from pyproj import Transformer
    to_utm = Transformer.from_crs("EPSG:4326", grid.crs, always_xy=True)
    op = Point(*to_utm.transform(28.165, 36.835)).buffer(250)       # a 500 m operator-confirmed fire south of the fire
    ign = Point(*to_utm.transform(spec.ignition_lon, spec.ignition_lat)).buffer(spec.ignition_radius_m)
    cases = [
        ("ignition (ignition point)", utc("2022-06-21T17:02:00"), burn([ign])),
        ("observation 21 Jun 23:22 (library)", utc("2022-06-21T23:22:00"), burn([seen(utc("2022-06-21T23:22:00"))])),
        ("observation 22 Jun 01:02 (library)", utc("2022-06-22T01:02:00"), burn([seen(utc("2022-06-22T01:02:00"))])),
        ("re-run 22 Jun 06:00, chained (library)", utc("2022-06-22T06:00:00"), chained),
        ("observation 22 Jun 10:43 (library)", utc("2022-06-22T10:43:00"), burn([seen(utc("2022-06-22T10:43:00"))])),
        ("observation 23 Jun 08:46 (library)", utc("2022-06-23T08:46:11"), burn([seen(utc("2022-06-23T08:46:11"))])),
        ("23 Jun 09:00, perimeter + 500 m operator fire", utc("2022-06-23T09:00:00"), burn([seen(utc("2022-06-23T09:00:00")), op])),
    ]
    out = {"horizons_hours": HORIZONS, "width": int(grid.width), "height": int(grid.height), "cases": []}
    for label, issued, mask in cases:
        t = time.perf_counter()
        mc = run_monte_carlo(mask, fuel, dem["slope_deg"], dem["aspect_deg"], grid, cfg_h, weather_df=wx, t0_utc=issued,
                             n_runs=int(spec.mc_runs), seed=int(cfg["spread"]["seed"]))
        mc_s = time.perf_counter() - t
        mc2 = run_monte_carlo(mask, fuel, dem["slope_deg"], dem["aspect_deg"], grid, cfg_h, weather_df=wx, t0_utc=issued,
                              n_runs=int(spec.mc_runs), seed=int(cfg["spread"]["seed"]) + 1)
        ws, wd, mm, rh, tc = extract_hourly_weather_series(wx, issued, max_hours=13, gust_fraction=float(run_cfg["spread"]["use_gust_fraction"]))
        pre = prepare_terrain_and_moisture_arrays(fuel, dem["slope_deg"], dem["aspect_deg"], ref_rh_pct=rh, ref_temp_c=tc,
                                                  max_slope_deg=float(run_cfg["spread"].get("max_slope_deg", 55.0)))
        det = run_mtt(mask, fuel, dem["slope_deg"], dem["aspect_deg"], grid.resolution_m, ws, wd, max_time_min=720.0,
                      max_lb_ratio=float(run_cfg["spread"]["max_lb_ratio"]), moisture_mult_hourly=mm, precomputed_terrain=pre)
        # Two cases also with 400 runs: with less sampling noise the browser and Python ensembles must converge.
        big = None
        if label.startswith(("ignition", "observation 23 Jun")):
            mc400 = run_monte_carlo(mask, fuel, dem["slope_deg"], dem["aspect_deg"], grid, cfg_h, weather_df=wx, t0_utc=issued,
                                    n_runs=400, seed=int(cfg["spread"]["seed"]))
            big = {str(h): bits(mc400.prob_rasters[h] >= 0.5) for h in (6.0, 12.0)}
        out["cases"].append({
            "label": label, "issued_at": issued.strftime("%Y-%m-%dT%H:%M:%SZ"), "start": bits(mask),
            "det_arrival": base64.b64encode(det.astype("<f4").tobytes()).decode(),
            "p50": {str(h): bits(mc.prob_rasters[h] >= 0.5) for h in HORIZONS}, "python_mc_s": round(mc_s, 2),
            # The same ensemble with another seed: how much 40 runs differ from 40 other runs (sampling noise).
            "p50_other_seed": {str(h): bits(mc2.prob_rasters[h] >= 0.5) for h in HORIZONS},
            **({"p50_400": big} if big else {}),
        })
        print(f"{label}: start {int(mask.sum())} cells, P50 12 h {int((mc.prob_rasters[12.0] >= 0.5).sum())} cells, MC {mc_s:.1f} s")
    OUT.write_bytes(gzip.compress(json.dumps(out).encode(), 9, mtime=0))
    print(f"{OUT.name}: {OUT.stat().st_size / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
