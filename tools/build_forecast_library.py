"""Precomputed forecasts for the screen's "Update forecast" button (Marmaris 2022).

Run with the fire repo's environment, after build_marmaris_scenario.py:

    <fire repo>/fireproj/.venv/bin/python tools/build_forecast_library.py <fire repo>/fireproj

A static site cannot run the spread model, so every forecast the operator can ask for is computed here:

- one at ignition (from the ignition point),
- one at every new VIIRS or Sentinel-2 burned-area observation (from the union of everything they have seen
  so far; passes less than SAME_PASS_MIN apart are one update), and
- one every STEP_MIN minutes in between (same perimeter, new start time and weather: "Re-run with current
  weather").

Each forecast only uses observations acquired by its issue time and the weather from then on (the archived
Open-Meteo historical forecast, as everywhere in this scenario). For each one the file also lists when its
P >= 50 % contour reaches each street (the fire repo's road-closure calculation, 150 m safety buffer), so the
screen can compute forecast closures from the forecasts the operator actually loaded.

Output: public/scenarios/marmaris_2022/forecast_library.json. A live model server (see docs/forecast_api.md)
would answer the same request with the same record.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import mapping

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_marmaris_scenario as B  # noqa: E402

STEP_MIN = 30
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
    """Hours after the issue time at which the contour first reaches each street (NaN: not within 12 h)."""
    from fireproj.road_closure import evaluate_road_closures

    out, _ = evaluate_road_closures(edges, None, contours, None, grid, cfg,
                                    selected_horizon_hours=max(B.UPDATE_STEP_H), selected_prob_threshold=0.5)
    return out["earliest_horizon_hours"].to_numpy(dtype=float)


def forecast_record(u: dict, trigger: str, reach: np.ndarray, index: dict[int, int], key: str = "") -> dict:
    """One library entry: issue, what it started from, the shown contours and its street reach."""
    utm = u["contours"].estimate_utm_crs()
    areas = u["contours"].to_crs(utm).area / 1e6
    contours = []
    for (_, c), km2 in zip(u["contours"].iterrows(), areas):
        h = float(c["horizon_hours"])
        if h not in B.UPDATE_SHOWN_H or c.geometry.is_empty:
            continue
        contours.append({"horizon_hours": h, "valid_at": B._iso(u["issued"] + timedelta(hours=h)),
                         "area_km2": round(float(km2), 3),
                         "geometry": mapping(shapely.set_precision(c.geometry, 1e-5))})
    start_km2 = 0.0 if u["perimeter"] is None else u["perimeter"].area / 1e6
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
    last = B.last_issue_time(r["wx_end"])
    issues = library_issue_times(r["fine"], r["t0"], last)
    edges, ids = street_edges()
    runs = []
    reached: set[int] = set()
    for issued, trigger in issues:
        u = r["run"](issued)
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
            "reach_horizons_hours": B.UPDATE_STEP_H, "probability": 0.5,
            "first_issue_at": B._iso(issues[0][0]), "last_issue_at": B._iso(last),
            "note": "Forecasts the operator can load with 'Update forecast'. Each one starts from the VIIRS and "
                    "Sentinel-2 burned-area observations acquired by its issue time (the ignition point before "
                    "the first) and uses the weather from then on (archived Open-Meteo historical forecast). "
                    "No forecast can be issued after last_issue_at: the cached weather ends 12 h later.",
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
