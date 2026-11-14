"""Precomputed forecasts for the screen's "Update forecast" button (Marmaris 2022).

Run with the fire repo's environment, after build_marmaris_scenario.py:

    <fire repo>/fireproj/.venv/bin/python tools/build_forecast_library.py <fire repo>/fireproj

A static site cannot run the spread model, so every forecast the operator can ask for is computed here:

- one at ignition (from the ignition point),
- one at every new VIIRS or Sentinel-2 burned-area observation (from the union of everything they have seen
  so far; passes less than SAME_PASS_MIN apart are one update), and
- one every STEP_MIN minutes in between ("Re-run with current weather"): started from the fire area the latest
  observation-started forecast estimates for that time (P >= 50 %), plus anything observed since, with the
  weather from then on.

Each forecast only uses observations acquired by its issue time and the weather from then on (the archived
Open-Meteo historical forecast, as everywhere in this scenario). Its contours are stored every 30 minutes up to
12 hours, plus the area it started from (horizon 0), so the screen can show the estimated fire at any time ("Fire
now") and the +1 / +2 / +3 / +6 h horizons from then. For each one the file also lists when its P >= 50 % contour
reaches each street (the fire repo's road-closure calculation, 150 m safety buffer, to the half hour), so the
screen can compute forecast closures from the forecasts actually in force.

Output: public/scenarios/marmaris_2022/forecast_library.json. A live model server (see docs/forecast_api.md)
would answer the same request with the same record.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import geopandas as gpd
import numpy as np
import shapely
from shapely.geometry import mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_marmaris_scenario as B  # noqa: E402

STEP_MIN = 30
INTERMEDIATE_SIMPLIFY_M = 40
LIBRARY = B.OUT / "forecast_library.json"


def library_issue_times(fine, t0: datetime, last: datetime) -> list[tuple[datetime, str]]:
    """``(issue time, trigger)``: ignition, each new fine observation, and every STEP_MIN minutes."""
    out: dict[datetime, str] = {t0: "ignition"}
    prev = None
    for t in sorted(x.to_pydatetime() for x in fine["_t"]):
        if t <= t0 or t > last:
            continue
        if prev is not None and (t - prev).total_seconds() < B.SAME_PASS_MIN * 60:
            out.pop(prev, None)              # one update for passes minutes apart, at the later one
        out[t] = "observation"
        prev = t
    step = t0.replace(minute=0, second=0, microsecond=0)
    while step <= last:
        if step > t0:
            out.setdefault(step, "scheduled")
        step += timedelta(minutes=STEP_MIN)
    return sorted(out.items())


def street_edges():
    """The streets of street_access.geojson, in a fixed order, with their ids."""
    edges, *_ = B.load_osm()
    edges["_uv"] = [tuple(sorted((int(u), int(v)))) for u, v in zip(edges["u"], edges["v"])]
    edges = edges.drop_duplicates(["_uv", "osmid"]).reset_index(drop=True)
    ids = [f"{B.EVENT}-street-{int(w)}-{uv[0]}-{uv[1]}" for w, uv in zip(edges["osmid"], edges["_uv"])]
    return edges, ids


def reach_hours(edges, contours, grid, cfg) -> np.ndarray:
    """Hours after the issue time at which the contour first reaches each street, to the half hour (NaN: not
    within 12 h)."""
    from fireproj.road_closure import evaluate_road_closures

    out, _ = evaluate_road_closures(edges, None, contours, None, grid, cfg,
                                    selected_horizon_hours=max(B.UPDATE_STEP_H), selected_prob_threshold=0.5)
    return out["earliest_horizon_hours"].to_numpy(dtype=float)


def forecast_record(u: dict, trigger: str, reach: np.ndarray, index: dict[int, int], key: str = "") -> dict:
    """One library entry: issue, what it started from, its contours (horizon 0 = the area it started from, then
    every 30 minutes; ``shown`` marks +1 / +2 / +3 / +6 h) and its street reach."""
    utm = u["contours"].estimate_utm_crs()
    rows = ([(0.0, u["start_contour"])] if u.get("start_contour") is not None else []) \
        + [(float(c["horizon_hours"]), c.geometry) for _, c in u["contours"].iterrows()]
    contours = []
    for h, g in rows:
        if g is None or g.is_empty:
            continue
        metric = gpd.GeoSeries([g], crs="EPSG:4326").to_crs(utm)
        km2 = float(metric.area.iloc[0]) / 1e6
        shown = h == 0.0 or h in B.UPDATE_SHOWN_H
        if not shown:
            # In-between steps (only drawn as "Fire now" and the horizons from the time shown): 40 m simplification
            # and ~10 m coordinates, which keeps the file a third smaller.
            g = metric.simplify(INTERMEDIATE_SIMPLIFY_M).to_crs("EPSG:4326").iloc[0]
        contours.append({"horizon_hours": h, "valid_at": B._iso(u["issued"] + timedelta(hours=h)),
                         "area_km2": round(km2, 3), **({"shown": True} if h in B.UPDATE_SHOWN_H else {}),
                         "geometry": mapping(shapely.set_precision(g, 1e-5 if shown else 1e-4))})
    start_km2 = u["start_area_km2"]
    return {
        "id": f"{B.EVENT}-run-{u['issued']:%Y%m%dT%H%MZ}{key}",
        "issued_at": B._iso(u["issued"]),
        "trigger": trigger,
        "initialised_from": u["source"],
        **({"last_observation_at": B._iso(u["last_obs"]), "last_observation_label": u["last_obs_label"]}
           if u["last_obs"] else {}),
        "start_area_km2": round(start_km2, 3),
        "contours": contours,
        # [street index, hours after the issue time], streets reached within 12 h only.
        "reach": [[index[i], float(h)] for i, h in enumerate(reach) if np.isfinite(h)],
    }


def main() -> int:
    from fireproj.config import load_config

    fire_root = Path(sys.argv[1]).resolve()
    cfg = load_config(fire_root / "config.yaml")
    r = B.forecast_runner(fire_root, cfg)
    index_file = json.loads((B.OUT.parent / "index.json").read_text(encoding="utf-8"))
    end = datetime.fromisoformat(next(s for s in index_file["scenarios"] if s["id"] == B.EVENT)["end"].replace("Z", "+00:00"))
    # Until the end of the scenario, as long as the weather covers the longest horizon.
    last = min(B.last_issue_time(r["wx_end"]), end)
    issues = library_issue_times(r["fine"], r["t0"], last)
    edges, ids = street_edges()
    runs = []
    reached: set[int] = set()
    for issued, trigger, u in B.chained_runs(r, issues):
        reach = reach_hours(edges, u["contours"], r["grid"], r["run_cfg"])
        reached |= {i for i, h in enumerate(reach) if np.isfinite(h)}
        runs.append((u, trigger, reach))
    order = sorted(reached)
    index = {i: k for k, i in enumerate(order)}
    lib = {
        "metadata": {
            "record": "ForecastLibrary", "schema_version": B.SCHEMA_VERSION, "synthetic": False, "basis": "fire_model",
            "label": "PRECOMPUTED",
            "event": B.EVENT, "generated_at": B.GENERATED_AT,
            "step_minutes": STEP_MIN, "horizons_hours": list(B.UPDATE_SHOWN_H),
            "contour_step_hours": 0.5, "contour_max_hours": max(B.UPDATE_STEP_H),
            "reach_horizons_hours": B.UPDATE_STEP_H, "probability": 0.5,
            "first_issue_at": B._iso(issues[0][0]), "last_issue_at": B._iso(last),
            "weather_until": B._iso(r["wx_end"]),
            "note": "Forecasts loaded automatically at each new pass (trigger 'observation': started from the VIIRS and "
                    "Sentinel-2 burned-area observations acquired by then, the ignition point before the first) and "
                    "by 'Update forecast' in between (trigger 'scheduled': started from the fire the latest "
                    "observation-started forecast estimates for that time, plus anything observed since). Each "
                    "uses the weather from its issue time on (archived Open-Meteo historical forecast). Contours "
                    "every 30 min to 12 h; horizon 0 is the area the forecast started from. "
                    "Forecasts are issued until the end of the scenario (last_issue_at); the weather data run "
                    f"until {B._iso(r['wx_end'])}.",
            "no_hindsight": "issued_at >= last_observation_at for every forecast (tools/test_no_hindsight.py).",
            "source": "nature-shield-fire model (tools/build_forecast_library.py)", "source_url": B.FIRE_REPO_URL,
        },
        "streets": [ids[i] for i in order],
        "forecasts": [forecast_record(u, trigger, reach, index) for u, trigger, reach in runs],
    }
    LIBRARY.write_text(json.dumps(lib, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    trig = {t: sum(1 for _, x in issues if x == t) for t in ("ignition", "observation", "scheduled")}
    print(f"forecast library: {len(runs)} forecasts {trig}, {len(order)} streets reached, "
          f"{LIBRARY.stat().st_size / 1024:.0f} kB, issues {issues[0][0]:%d %H:%M} .. {issues[-1][0]:%d %H:%M}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
