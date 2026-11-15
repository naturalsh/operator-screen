"""Inputs of the fire repo's spread model for the screen's in-browser model (Add fire, Update forecast).

    <fire repo>/fireproj/.venv/bin/python tools/export_spread_grid.py <fire repo>/fireproj

Writes, next to the scenario data:

- spread_grid.bin.gz (and spread_grid.bin): the model grid, row 0 = north, little-endian:
  uint8 WorldCover class per cell, then uint16 slope in 0.01 degrees, then uint16 aspect (downslope) in 0.01 degrees.
- spread_model.json: the grid (CRS, transform, size), the fuel parameters per class (with the reconstruction's
  R0 multiplier applied), the Monte Carlo settings and the hourly weather (Open-Meteo historical forecast, the same
  file the precomputed forecasts use).

Same grid, fuel, terrain, weather and settings as tools/build_marmaris_scenario.py's forecast_runner, so the browser
model can be compared with the precomputed forecasts (tests/spread.test.ts, tools/compare_spread.py).
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_marmaris_scenario as B  # noqa: E402


def main() -> int:
    from fireproj.config import load_config

    fire_root = Path(sys.argv[1]).resolve()
    cfg = load_config(fire_root / "config.yaml")
    r = B.forecast_runner(fire_root, cfg)
    grid, run_cfg, spec, wx = r["grid"], r["run_cfg"], r["spec"], r["wx"]
    lc = np.asarray(r["landcover"], dtype=np.uint8)
    slope = np.clip(np.round(np.asarray(r["dem"]["slope_deg"], dtype=np.float64) * 100), 0, 65535).astype("<u2")
    aspect = np.clip(np.round(np.mod(np.asarray(r["dem"]["aspect_deg"], dtype=np.float64), 360.0) * 100), 0, 65535).astype("<u2")
    raw = lc.tobytes() + slope.tobytes() + aspect.tobytes()
    (B.OUT / "spread_grid.bin").write_bytes(raw)
    (B.OUT / "spread_grid.bin.gz").write_bytes(gzip.compress(raw, 9, mtime=0))
    s = run_cfg["spread"]
    t = wx["time"].dt.strftime("%Y-%m-%dT%H:%M:%SZ").tolist()
    model = {
        "record": "SpreadModel", "event": B.EVENT, "generated_at": B.GENERATED_AT,
        "source": "nature-shield-fire model inputs (tools/export_spread_grid.py)", "source_url": B.FIRE_REPO_URL,
        "grid": {"crs": str(grid.crs), "utm_zone": int(str(grid.crs).split(":")[1]) - 32600, "width": int(grid.width),
                 "height": int(grid.height), "resolution_m": float(grid.resolution_m),
                 "transform": [float(x) for x in list(grid.transform)[:6]]},
        "classes": {str(int(k)): {"name": v.get("name", ""), "R0_m_per_min": float(v["R0_m_per_min"]), "wind_C": float(v["wind_C"]),
                                  "wind_B": float(v["wind_B"]), "waf": float(v["waf"]), "beta": float(v["beta"]), "mex": float(v["mex"])}
                    for k, v in run_cfg["fuel"]["classes"].items()},
        "settings": {"mc_runs": int(spec.mc_runs), "seed": int(cfg["spread"]["seed"]), "wind_dir_sigma_deg": float(s["wind_dir_sigma_deg"]),
                     "wind_speed_rel_sigma": float(s.get("wind_speed_rel_sigma", 0.25)), "r0_lognormal_sigma": float(s.get("r0_lognormal_sigma", 0.30)),
                     "moisture_noise_sigma": float(s.get("moisture_noise_sigma", 0.08)), "use_gust_fraction": float(s["use_gust_fraction"]),
                     "max_lb_ratio": float(s["max_lb_ratio"]), "max_slope_deg": float(s.get("max_slope_deg", 55.0)),
                     "probability": 0.5, "horizons_hours": list(B.UPDATE_STEP_H), "safety_buffer_m": float(cfg["road_closure"]["safety_buffer_m"])},
        "weather": {"time": t, "wind_speed_10m": [round(float(x), 2) for x in wx["wind_speed_10m"]],
                    "wind_gusts_10m": [round(float(x), 2) for x in wx["wind_gusts_10m"]],
                    "wind_direction_10m": [round(float(x), 1) for x in wx["wind_direction_10m"]],
                    "temperature_2m": [round(float(x), 2) for x in wx["temperature_2m"]],
                    "relative_humidity_2m": [round(float(x), 1) for x in wx["relative_humidity_2m"]]},
        "layout": "spread_grid.bin: uint8 class[h*w], uint16 slope_0.01deg[h*w], uint16 aspect_0.01deg[h*w], row 0 = north, little-endian",
    }
    (B.OUT / "spread_model.json").write_text(json.dumps(model, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"grid {grid.height}x{grid.width} @ {grid.resolution_m} m, {len(raw) / 1024:.0f} kB raw, "
          f"{(B.OUT / 'spread_grid.bin.gz').stat().st_size / 1024:.0f} kB gzip; classes {sorted(set(lc.ravel().tolist()))}; "
          f"weather {t[0]} .. {t[-1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
