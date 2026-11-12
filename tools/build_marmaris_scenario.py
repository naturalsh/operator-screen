"""Build the data of the `marmaris_2022` scenario from the fire repository.

Run with the fire repo's environment (offline; it only reads that repo's caches):

    <fire repo>/fireproj/.venv/bin/python tools/build_marmaris_scenario.py <fire repo>/fireproj

What each file is:

- firefront.geojson      REAL. The fire tool's export (`python -m fireproj.export_firefront`):
                         model contours + satellite observations.
- street_access.geojson  MODEL OUTPUT. Real OpenStreetMap streets (© OpenStreetMap contributors,
                         ODbL) classified by the fire repo's own road-closure calculation
                         (`fireproj.road_closure.evaluate_road_closures`, 150 m safety buffer) against
                         the modelled P >= 50 % contour every two hours. A street the modelled fire
                         reaches becomes `blocked` at `valid_at`; before that it is `open`.
                         It is not a road survey: no image was analysed and no width was measured.
- caller_reports.json    SYNTHETIC. Invented reports, but placed on streets the modelled fire reaches
                         and timed shortly before (or just after) it gets there, so calls increase
                         as the fire grows.

Replace street_access.geojson / caller_reports.json with the Road Check and Voice intake exports
when they arrive; nothing else has to change.
"""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
from shapely.geometry import Point, mapping

OUT = Path(__file__).resolve().parents[1] / "public" / "scenarios" / "marmaris_2022"
SCHEMA_VERSION = "0.2.0"
GENERATED_AT = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
EVENT = "marmaris_2022"
HORIZONS_H = [float(h) for h in range(2, 41, 2)]     # modelled contour every 2 h up to 40 h
FIRE_REPO_URL = "https://github.com/ismailefe45-m/GreekTurkeyHackhatonFire"
#: Named places (lon, lat) from the fire repo's OSM settlement cache + the configured ignition point.
PLACES = {"Hisarönü": (28.1452, 36.8001), "Değirmenyanı": (28.1419, 36.8319),
          "Hisarönü Jandarma Karakolu": (28.1045, 36.8041), "İçmeler": (28.2314, 36.8013),
          "Bördübet": (28.060, 36.868)}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unit(key: str) -> float:
    """Deterministic pseudo-random number in [0, 1) from a string."""
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0x100000000


# --------------------------------------------------------------------------- street access (model output)
def build_street_access(fire_root: Path):
    from fireproj.config import BBox, load_config
    from fireproj.data.roads import fetch_road_network
    from fireproj.reconstruction import run_reconstruction
    from fireproj.road_closure import evaluate_road_closures

    cfg = load_config(fire_root / "config.yaml")
    run_cfg = copy.deepcopy(cfg)
    run_cfg["events"][EVENT]["reconstruction"]["horizons_hours"] = HORIZONS_H
    run_cfg["spread"]["time_horizons_hours"] = HORIZONS_H
    res = run_reconstruction(run_cfg, EVENT)
    t0 = res.spec.ignition_utc
    buffer_m = float(cfg["road_closure"]["safety_buffer_m"])

    bbox = BBox(west=28.04, south=36.80, east=28.21, north=36.90)       # the fire app's Marmaris 2022 AOI
    _, _, edges = fetch_road_network(cfg, bbox)
    status_gdf, _ = evaluate_road_closures(
        edges, None, res.modelled_gdf, None, res.model_grid, run_cfg,
        selected_horizon_hours=max(HORIZONS_H), selected_prob_threshold=0.5,
    )
    status_gdf["_uv"] = [tuple(sorted((int(u), int(v)))) for u, v in zip(status_gdf["u"], status_gdf["v"])]
    status_gdf = status_gdf.sort_values(["_uv", "earliest_horizon_hours"]).drop_duplicates("_uv")

    feats = []
    for _, r in status_gdf.iterrows():
        way = r["osmid"][0] if isinstance(r["osmid"], list) else r["osmid"]
        u, v = r["_uv"]
        edge_id = f"{int(way)}-{u}-{v}"
        reached = r["status"] == "closed" and np.isfinite(r["earliest_horizon_hours"])
        valid = t0 + timedelta(hours=float(r["earliest_horizon_hours"])) if reached else t0
        feats.append({
            "type": "Feature",
            "geometry": mapping(r.geometry.simplify(0.00002)),
            "properties": {
                "schema_version": SCHEMA_VERSION,
                "id": f"{EVENT}-street-{edge_id}",
                "osm_way_id": int(way),
                "edge_id": edge_id,
                "name": r["name"] or None,
                "highway": str(r["highway"]),
                "status": "blocked" if reached else "open",
                "status_before": "open" if reached else None,
                "valid_at": _iso(valid),
                "basis": "fire_model",
                "reason": (f"modelled fire (P ≥ 50 %, {buffer_m:.0f} m safety buffer) reaches this street "
                           f"{float(r['earliest_horizon_hours']):g} h after ignition") if reached
                          else "not reached by the modelled fire within 40 h",
                "free_width_m": None,
                "imagery_date": None,
                "confirmed_by_operator": False,
                "source": "fire model: nature-shield-fire road_closure (Rothermel + MTT + Monte Carlo)",
                "source_url": FIRE_REPO_URL,
                "license": "geometry: ODbL-1.0 (© OpenStreetMap contributors); status: MIT (fire model output)",
                "fetched_at": GENERATED_AT,
                "observed_at": _iso(valid),
                "received_at": _iso(t0),
            },
        })
    fc = {
        "type": "FeatureCollection",
        "name": f"{EVENT}_street_access",
        "metadata": {
            "record": "StreetAccess", "schema_version": SCHEMA_VERSION, "synthetic": False,
            "basis": "fire_model",
            "note": "MODEL OUTPUT: streets the modelled fire reaches are blocked from valid_at. "
                    "Not a road survey; no imagery was analysed.",
            "model_run_at": _iso(t0), "contour_step_hours": 2, "safety_buffer_m": buffer_m,
        },
        "features": feats,
    }
    return fc, status_gdf, t0


# --------------------------------------------------------------------------- caller reports (synthetic)
# (language, text, English text, urgency reasons) per situation; {place} is filled in.
TEMPLATES = {
    "approach_far": [
        ("tr", "{place} tarafında yoğun duman var, alevler sırtın arkasında görünüyor.",
         "Heavy smoke near {place}, flames visible behind the ridge.", ["smoke", "flames visible"]),
        ("en", "We can see the fire from {place}. Which way should we drive out?",
         "Fire visible from {place}; asks which way to leave.", ["flames visible", "information request"]),
        ("fr", "Nous voyons les flammes depuis {place}. La route est-elle encore ouverte ?",
         "Flames visible from {place}; asks whether the road is still open.", ["flames visible", "information request"]),
        ("el", "Βλέπουμε πυκνό καπνό κοντά στο {place}, η φωτιά πλησιάζει.",
         "Dense smoke near {place}, fire approaching.", ["smoke", "fire approaching"]),
    ],
    "approach_near": [
        ("tr", "Ateş {place} yoluna çok yaklaştı, aracımız yok, {n} kişiyiz.",
         "Fire very close to the road at {place}; no vehicle, {n} people.", ["fire approaching", "no vehicle", "people at risk"]),
        ("tr", "{place} civarında yaşlı komşumuz evden çıkamıyor, alevler birkaç yüz metre ötede.",
         "Elderly neighbour cannot leave the house near {place}; flames a few hundred metres away.",
         ["elderly", "cannot walk", "fire approaching"]),
        ("el", "Είμαστε {n} άτομα κοντά στο {place}, η φωτιά είναι πολύ κοντά και δεν έχουμε αυτοκίνητο.",
         "{n} people near {place}, fire very close, no car.", ["fire approaching", "no vehicle", "people at risk"]),
        ("en", "The flames are coming down towards the road at {place}, there are {n} of us on foot.",
         "Flames coming down to the road at {place}; {n} people on foot.", ["fire approaching", "on foot", "people at risk"]),
    ],
    "cut_off": [
        ("tr", "{place} yolunda ilerleyemiyoruz, alev yolun iki yanında. {n} kişi araçta bekliyoruz.",
         "Cannot proceed on the road at {place}, flames on both sides; {n} people waiting in a car.",
         ["road cut by fire", "vehicles stopped", "people at risk"]),
        ("en", "The road at {place} is blocked by fire and we had to turn back.",
         "Road at {place} blocked by fire; turned back.", ["road cut by fire"]),
        ("fr", "La route à {place} est coupée par le feu, nous sommes {n} dans la voiture.",
         "Road at {place} cut by fire; {n} people in the car.", ["road cut by fire", "people at risk"]),
    ],
}


def _place_label(pt: Point, name: str | None) -> str:
    near, dist_km = min(((n, pt.distance(Point(xy)) * 96.0) for n, xy in PLACES.items()), key=lambda x: x[1])
    where = near if dist_km < 0.7 else f"{near} ({dist_km:.0f} km away)"
    return f"{name}, {where}" if name else where


def build_caller_reports(status_gdf: gpd.GeoDataFrame, t0: datetime) -> dict:
    """Reports on streets the modelled fire reaches, timed around its arrival there."""
    reached = status_gdf[status_gdf["status"] == "closed"].copy()
    reached["_len"] = reached.to_crs(reached.estimate_utm_crs()).length
    reached = reached[reached["_len"] > 150].sort_values(["earliest_horizon_hours", "_uv"])
    # Named roads and inhabited classes are where people are; keep a few forest roads too.
    reached["_w"] = [3.0 if (n or h in ("residential", "service", "tertiary", "trunk")) else 1.0
                     for n, h in zip(reached["name"], reached["highway"])]
    records, used = [], []
    for horizon, grp in reached.groupby("earliest_horizon_hours"):
        # More streets reached in a step -> more calls in that step (at least one, at most four).
        n_calls = int(min(4, max(1, round(float(grp["_w"].sum()) / 9.0))))
        picks = grp.assign(_r=[_unit(f"pick{uv}") / w for uv, w in zip(grp["_uv"], grp["_w"])]).sort_values("_r")
        for _, r in picks.iterrows():
            pt = r.geometry.interpolate(0.5, normalized=True)
            if any(pt.distance(p) < 0.006 for p in used):      # keep calls ~600 m apart
                continue
            used.append(pt)
            key = str(r["_uv"])
            arrival = t0 + timedelta(hours=float(horizon))
            roll = _unit(key + "situation")
            if roll < 0.2:
                kind, lead_min = "cut_off", -(10 + 50 * _unit(key + "lead"))          # just after arrival
            elif roll < 0.65:
                kind, lead_min = "approach_near", 15 + 45 * _unit(key + "lead")       # 15..60 min before
            else:
                kind, lead_min = "approach_far", 70 + 80 * _unit(key + "lead")        # 70..150 min before
            reported = max(arrival - timedelta(minutes=lead_min), t0 + timedelta(minutes=6))
            people = 0 if kind == "approach_far" else 2 + int(4 * _unit(key + "n"))
            options = TEMPLATES[kind]
            lang, text, text_en, reasons = options[int(len(options) * _unit(key + "tpl"))]
            urgency = ("life_threat" if kind == "approach_near" and (people >= 3 or "elderly" in reasons)
                       else "routine" if kind == "approach_far" and "information request" in reasons
                       else "urgent")
            label = _place_label(pt, r["name"] or None)
            records.append({
                "schema_version": SCHEMA_VERSION,
                "reported_at": _iso(reported.replace(second=0, microsecond=0)),
                "place": {"lon": round(pt.x, 5), "lat": round(pt.y, 5), "label": label},
                "language": lang,
                "urgency": urgency,
                "urgency_reasons": reasons,
                "hazard": "fire",
                "people_at_risk": people,
                "channel": ["voice", "voice", "whatsapp", "sms"][int(4 * _unit(key + "ch"))],
                "summary": text.format(place=label, n=people),
                "summary_en": text_en.format(place=label, n=people),
                "confirmed_by_operator": _unit(key + "ok") < 0.4,
                "synthetic": True,
                "source": "nature-shield-operator synthetic sample",
                "source_url": "https://example.org/synthetic",
                "license": "CC0-1.0 (synthetic)",
                "fetched_at": GENERATED_AT,
            })
            if sum(1 for rec in records if rec.get("_h") == horizon) + 1 >= n_calls:
                records[-1]["_h"] = horizon
                break
            records[-1]["_h"] = horizon
    records.sort(key=lambda rec: rec["reported_at"])
    for i, rec in enumerate(records, start=1):
        rec.pop("_h")
        rec["id"] = f"synthetic-call-{i:03d}"
        rec["observed_at"] = rec["received_at"] = rec["reported_at"]
    return {"metadata": {"record": "CallerReport", "schema_version": SCHEMA_VERSION, "synthetic": True,
                         "note": "SYNTHETIC reports written for the demo. No real caller data. Placed on streets "
                                 "the modelled fire reaches and timed around its arrival."},
            "records": records}


def main() -> int:
    fire_root = Path(sys.argv[1]).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fire_root / "exports" / f"{EVENT}_firefront.geojson", OUT / "firefront.geojson")
    streets, status_gdf, t0 = build_street_access(fire_root)
    callers = build_caller_reports(status_gdf, t0)
    for name, data in (("street_access.geojson", streets), ("caller_reports.json", callers)):
        (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    for p in sorted(OUT.iterdir()):
        print(f"{p.name}: {p.stat().st_size / 1024:.0f} kB")
    props = [f["properties"] for f in streets["features"]]
    print("streets:", len(props), {s: sum(p["status"] == s for p in props) for s in ("open", "blocked")})
    by_hour: dict[str, int] = {}
    for rec in callers["records"]:
        by_hour[rec["reported_at"][:13]] = by_hour.get(rec["reported_at"][:13], 0) + 1
    print("callers:", len(callers["records"]), {u: sum(r["urgency"] == u for r in callers["records"])
                                                for u in ("life_threat", "urgent", "routine")})
    print("calls per 8 h:", [sum(1 for r in callers["records"]
                                 if 0 <= (datetime.fromisoformat(r["reported_at"].replace("Z", "+00:00")) - t0)
                                 .total_seconds() / 3600 - k < 8) for k in range(0, 40, 8)])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
