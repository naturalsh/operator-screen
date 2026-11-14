"""CONCEPT DEMO: synthetic "fire reported" calls derived from later satellite passes (Marmaris 2022, first night).

Run with the fire repo's environment, after build_forecast_library.py:

    <fire repo>/fireproj/.venv/bin/python tools/build_concept_reports.py <fire repo>/fireproj

What it shows: on the first night the satellites only gave coarse pixels for six hours and the model, started from
the ignition point, stayed far too small. Calls saying "I see flames here" could have started a better forecast
hours earlier. To show this honestly, the calls are NOT made from the model:

1. Reports: every VIIRS pass of the first night sees fire on new ground (outside everything VIIRS had seen
   before). For each such place, 1-3 callers report it before the pass: at the time the fire got there (an
   assumed 30-150 min before the pass), 300-800 m away from where the satellite saw it. 20-30 % of reports are
   false (no fire there, ever), some of them in pairs, so that false candidates appear too. Fixed seed.
2. Clustering and confidence: in time order, a report joins a cluster when it is within CLUSTER_M of it and
   within CLUSTER_MIN of its latest report; confidence is a noisy-OR of the report weights
   (statement x location quality x observer distance x independence). One source never counts more than 0.5;
   a cluster becomes a candidate ("REPORTED (unconfirmed)") with two independent sources and P >= 0.5.
3. "With reports" forecasts: for every library issue time of the night and every set of candidates known by
   then, the model is run again starting from the perimeter plus a disc for each candidate (radius = location
   uncertainty, at least 150 m). The screen loads the one matching what the operator confirmed.
4. Score: without reports, with the true candidates only and with every candidate (false ones included), each
   against the next VIIRS pass.

This is an upper bound: callers do not report with satellite precision. Nothing here enters the overlap table.
Output: public/scenarios/marmaris_2022/concept_reports.json, docs/concept_reports.md.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
from shapely.geometry import Point
from shapely.ops import unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_marmaris_scenario as B  # noqa: E402
import build_forecast_library as L  # noqa: E402

LABEL = "CONCEPT DEMO · synthetic reports derived from later satellite passes"
OUT_FILE = B.OUT / "concept_reports.json"
DOC = B.OUT.parent.parent.parent / "docs" / "concept_reports.md"
SEED = 20220621
NIGHT_END = datetime(2022, 6, 22, 1, 30, tzinfo=timezone.utc)     # the last pass used is 01:02
ARRIVAL_BEFORE_PASS_MIN = (30, 150)                                # when the fire got there, before the pass
REPORT_SPREAD_MIN = 25                                             # callers of one place, within this
POSITION_ERROR_M = (300, 800)
FALSE_SHARE = 0.25
CLUSTER_M = 1000.0
CLUSTER_MIN = 30.0
SINGLE_SOURCE_CAP = 0.5
CANDIDATE_P = 0.5
MIN_DISC_M = 150.0

# Weights of the noisy-OR (docs/concept_reports.md).
STATEMENT = {"flames_seen": 0.6, "fire_near": 0.4, "smoke": 0.15, "hearsay": 0.05}
LOCATION = {"gps": 1.0, "address": 0.7, "near_place": 0.4}
LOCATION_UNCERTAINTY_M = {"gps": 150, "address": 400, "near_place": 1000}
DISTANCE = {"on_site": 1.0, "within_500m": 0.8, "far": 0.4}
TRUE_STATEMENTS = (["flames_seen", "fire_near", "smoke", "hearsay"], [0.45, 0.3, 0.2, 0.05])
FALSE_STATEMENTS = (["flames_seen", "fire_near", "smoke", "hearsay"], [0.3, 0.3, 0.3, 0.1])
LANGUAGES = (["tr", "en", "de", "el"], [0.6, 0.2, 0.1, 0.1])
CHANNELS = (["voice", "sms", "whatsapp"], [0.6, 0.2, 0.2])


def _pick(rng, choices):
    names, p = choices
    return names[int(rng.choice(len(names), p=np.array(p) / sum(p)))]


def _offset(lon, lat, metres, bearing):
    k = 111320 * math.cos(math.radians(lat))
    return lon + metres * math.sin(bearing) / k, lat + metres * math.cos(bearing) / 110540


def _m(a, b):
    k = 111320 * math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((a[0] - b[0]) * k, (a[1] - b[1]) * 110540)


def _grid_box(grid):
    """The model grid's area, 1.5 km inside its edge, in the local UTM zone (where make_reports works)."""
    from shapely.geometry import box

    h, w = grid.shape
    tr = grid.transform
    xs = [tr.c, tr.c + tr.a * w]
    ys = [tr.f, tr.f + tr.e * h]
    g = gpd.GeoSeries([box(min(xs), min(ys), max(xs), max(ys))], crs=grid.crs).to_crs("EPSG:4326")
    return g.to_crs(g.estimate_utm_crs()).iloc[0].buffer(-1500)


def weight(r: dict) -> float:
    return STATEMENT[r["statement_class"]] * LOCATION[r["location_quality"]] * DISTANCE[r["observer_distance"]]


def make_reports(fire_root: Path, cfg: dict, t0: datetime, places: dict, streets_lonlat: np.ndarray, grid_box):
    """Synthetic reports: true ones at new ground of each first-night VIIRS pass, and false ones."""
    from fireproj.data.firms_timeline import load_timeline

    rng = np.random.default_rng(SEED)
    det, _ = load_timeline(cfg, B.EVENT)
    det = det[det["instrument"].astype(str).str.upper().str.contains("VIIRS")].copy()
    det["_t"] = pd.to_datetime(det["acq_datetime"], utc=True)
    utm = det.estimate_utm_crs()
    det_m = det.to_crs(utm)
    passes = sorted(t for t in det["_t"].unique() if t.to_pydatetime() <= NIGHT_END)
    reports, truth_places = [], []
    seen = None
    for tp in passes:
        cur = det_m[det_m["_t"] == tp]
        fresh = cur if seen is None else cur[~cur.geometry.within(seen)]
        seen = unary_union([g for g in ([seen] if seen is not None else []) + list(cur.geometry.buffer(400))])
        if fresh.empty:
            continue
        # Places: groups of new detections within 1 km of each other.
        blobs = unary_union(list(fresh.geometry.buffer(500)))
        blobs = list(getattr(blobs, "geoms", [blobs]))
        for blob in blobs:
            pts = fresh[fresh.geometry.within(blob)]
            c = gpd.GeoSeries([pts.geometry.union_all().centroid], crs=utm).to_crs("EPSG:4326").iloc[0]
            arrival = tp.to_pydatetime() - timedelta(minutes=float(rng.uniform(*ARRIVAL_BEFORE_PASS_MIN)))
            arrival = max(arrival, t0 + timedelta(minutes=40))
            n = 1 + int(len(pts) >= 3) + int(len(pts) >= 8)
            truth_places.append({"lon": c.x, "lat": c.y, "pass": tp.to_pydatetime(), "detections": len(pts)})
            for _ in range(n):
                reports.append(_report(rng, c.x, c.y, arrival + timedelta(minutes=float(rng.uniform(0, REPORT_SPREAD_MIN))),
                                       TRUE_STATEMENTS, "fire", places, error=True))
    n_true = len(reports)
    # False reports: on streets inside the model grid but never near any fire of the whole event, at random
    # times of the night.
    all_fine = unary_union(list(det_m.geometry.buffer(3000)))
    pts_m = gpd.GeoSeries([Point(x, y) for x, y in streets_lonlat], crs="EPSG:4326").to_crs(utm)
    inside = grid_box
    far = np.array([(not all_fine.contains(p)) and inside.contains(p) for p in pts_m])
    pool = streets_lonlat[far]
    n_false = max(3, round(FALSE_SHARE / (1 - FALSE_SHARE) * n_true))
    made = 0
    while made < n_false:
        x, y = pool[int(rng.integers(len(pool)))]
        # The first false alarm is a convincing one (two independent callers see flames at the same spot, e.g. a
        # burning skip) before the first VIIRS pass, so a false candidate exists; the others are random.
        convincing = made == 0
        when = (datetime(2022, 6, 21, 21, 40, tzinfo=timezone.utc) + timedelta(minutes=float(rng.uniform(0, 50))) if convincing
                else t0 + timedelta(minutes=float(rng.uniform(90, (NIGHT_END - t0).total_seconds() / 60 - 30))))
        pair = convincing or (made + 2 <= n_false and rng.random() < 0.5)
        for k in range(2 if pair else 1):
            r = _report(rng, x, y, when + timedelta(minutes=float(rng.uniform(5, 20)) * k),
                        (["flames_seen", "fire_near"], [0.7, 0.3]) if convincing else FALSE_STATEMENTS,
                        "false_report", places, error=False)
            if convincing:
                r["location_quality"], r["observer_distance"] = "gps", "on_site"
                r["place"]["uncertainty_m"] = LOCATION_UNCERTAINTY_M["gps"]
            reports.append(r)
            made += 1
    # A few repeat calls from the same number (not independent).
    for r in [r for r in reports if rng.random() < 0.12]:
        rep = dict(r)
        rep["observed_at"] = B._iso(datetime.fromisoformat(r["observed_at"].replace("Z", "+00:00"))
                                    + timedelta(minutes=float(rng.uniform(8, 20))))
        rep["repeat_of_number"] = True
        reports.append(rep)
    reports.sort(key=lambda r: r["observed_at"])
    for i, r in enumerate(reports):
        r["id"] = f"concept-report-{i + 1:03d}"
        r["confidence"] = round(weight(r) * (0.0 if r.get("repeat_of_number") else 1.0), 4)
    return reports, truth_places, n_true, made


def _report(rng, lon, lat, when, statements, truth, places, error: bool) -> dict:
    loc = _pick(rng, (["gps", "address", "near_place"], [0.35, 0.35, 0.3]))
    dist = _pick(rng, (["on_site", "within_500m", "far"], [0.4, 0.4, 0.2]))
    if error:
        lon, lat = _offset(lon, lat, float(rng.uniform(*POSITION_ERROR_M)), float(rng.uniform(0, 2 * math.pi)))
    else:
        lon, lat = _offset(lon, lat, float(rng.uniform(0, 150)), float(rng.uniform(0, 2 * math.pi)))
    near, km = B.nearest_place(Point(lon, lat), places)
    number = hashlib.sha256(f"{SEED}-{rng.random()}".encode()).hexdigest()[:12]
    return {
        "kind": "caller", "observed_at": B._iso(when.replace(second=0, microsecond=0)),
        "place": {"lon": round(lon, 5), "lat": round(lat, 5), "uncertainty_m": LOCATION_UNCERTAINTY_M[loc],
                  "label": f"{km:.1f} km from {near}"},
        "statement_class": _pick(rng, statements), "location_quality": loc, "observer_distance": dist,
        "source_ref": f"sha256:{number}", "language": _pick(rng, LANGUAGES), "channel": _pick(rng, CHANNELS),
        "synthetic": True, "_truth": truth,
    }


def cluster(reports: list[dict]) -> list[dict]:
    """Causal clustering: in time order, join the nearest cluster within CLUSTER_M whose latest report is at
    most CLUSTER_MIN old, else start one. A cluster is a candidate from the first report after which it has two
    independent sources and P >= CANDIDATE_P; its disc is fixed then."""
    clusters: list[dict] = []
    for r in reports:
        t = datetime.fromisoformat(r["observed_at"].replace("Z", "+00:00"))
        pt = (r["place"]["lon"], r["place"]["lat"])
        best = None
        for c in clusters:
            if (t - c["_last"]).total_seconds() > CLUSTER_MIN * 60:
                continue
            d = _m(pt, c["_centre"])
            if d <= CLUSTER_M and (best is None or d < best[0]):
                best = (d, c)
        if best is None:
            c = {"id": f"concept-cluster-{len(clusters) + 1:02d}", "reports": [], "_w": []}
            clusters.append(c)
        else:
            c = best[1]
        c["reports"].append(r["id"])
        w = max(r["confidence"], 1e-6)
        c["_w"].append((pt, w, r))
        tw = sum(x[1] for x in c["_w"])
        c["_centre"] = (sum(x[0][0] * x[1] for x in c["_w"]) / tw, sum(x[0][1] * x[1] for x in c["_w"]) / tw)
        c["_last"] = t
        r["cluster"] = c["id"]
        p, sources = confidence([x[2] for x in c["_w"]])
        if "candidate_at" not in c and sources >= 2 and p >= CANDIDATE_P:
            unc = sum(x[2]["place"]["uncertainty_m"] for x in c["_w"]) / len(c["_w"]) / math.sqrt(sources)
            c.update({"candidate_at": r["observed_at"], "lon": round(c["_centre"][0], 5), "lat": round(c["_centre"][1], 5),
                      "radius_m": round(max(MIN_DISC_M, unc)), "p_at_candidate": round(p, 3)})
    for c in clusters:
        rs = [x[2] for x in c["_w"]]
        c["_truth"] = "fire" if any(r["_truth"] == "fire" for r in rs) else "false_report"
        c.setdefault("lon", round(c["_centre"][0], 5))
        c.setdefault("lat", round(c["_centre"][1], 5))
        for k in ("_w", "_centre", "_last"):
            c.pop(k)
    return clusters


def confidence(reports: list[dict]) -> tuple[float, int]:
    """Noisy-OR over the reports, one weight per independent source (its strongest), each capped."""
    by_source: dict[str, float] = {}
    for r in reports:
        by_source[r["source_ref"]] = max(by_source.get(r["source_ref"], 0.0), r["confidence"])
    p = 1.0 - math.prod(1.0 - w for w in by_source.values())
    n = sum(1 for w in by_source.values() if w > 0)
    return (min(p, SINGLE_SOURCE_CAP) if n < 2 else p), n


def main() -> int:
    from fireproj.config import load_config

    fire_root = Path(sys.argv[1]).resolve()
    cfg = load_config(fire_root / "config.yaml")
    edges, places, *_ = B.load_osm()
    r = B.forecast_runner(fire_root, cfg)
    t0 = r["t0"]
    places["Bördübet"] = (r["spec"].ignition_lon, r["spec"].ignition_lat)
    mids = np.array([[g.interpolate(0.5, normalized=True).x, g.interpolate(0.5, normalized=True).y] for g in edges.geometry])
    grid_box = _grid_box(r["grid"])
    reports, truth_places, n_true, n_false = make_reports(fire_root, cfg, t0, places, mids, grid_box)
    clusters = cluster(reports)
    cands = [c for c in clusters if "candidate_at" in c]
    print(f"reports: {len(reports)} ({n_true} true, {n_false} false, {len(reports) - n_true - n_false} repeats); "
          f"clusters {len(clusters)}, candidates {len(cands)} "
          f"({sum(c['_truth'] == 'fire' for c in cands)} true, {sum(c['_truth'] != 'fire' for c in cands)} false)")

    # "With reports" forecasts: every library issue time of the night x every set of candidates known by then.
    lib = json.loads(L.LIBRARY.read_text(encoding="utf-8"))
    street_index = {sid: i for i, sid in enumerate(lib["streets"])}
    sedges, ids = L.street_edges()
    grid_crs = r["grid"].crs
    iso = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    disc = {c["id"]: gpd.GeoSeries([Point(c["lon"], c["lat"])], crs="EPSG:4326").to_crs(grid_crs).iloc[0].buffer(c["radius_m"])
            for c in cands}
    issues = [(iso(f["issued_at"]), f["trigger"], f["id"]) for f in lib["forecasts"] if iso(f["issued_at"]) <= NIGHT_END]
    variants, runs = [], {}
    for issued, trigger, base_id in issues:
        known = [c["id"] for c in cands if iso(c["candidate_at"]) <= issued]
        for k in range(1, len(known) + 1):
            for subset in itertools.combinations(known, k):
                u = r["run"](issued, extra_starts=[disc[c] for c in subset])
                reach = L.reach_hours(sedges, u["contours"], r["grid"], r["run_cfg"])
                # Street indexes of the library; streets this run reaches that the library never does are added.
                for i, h in enumerate(reach):
                    if np.isfinite(h) and ids[i] not in street_index:
                        street_index[ids[i]] = len(lib["streets"])
                        lib["streets"].append(ids[i])
                index = {i: street_index[ids[i]] for i, h in enumerate(reach) if np.isfinite(h)}
                rec = L.forecast_record(u, trigger, reach, index, key="-r" + "+".join(c[-2:] for c in subset))
                rec["reports"] = list(subset)
                rec["initialised_from"] = u["source"] + f" + {len(subset)} confirmed report{'s' if len(subset) > 1 else ''}"
                rec["base_forecast"] = base_id
                variants.append(rec)
                runs[(issued, subset)] = u
    print(f"with-report forecasts: {len(variants)}")

    # Score against the next VIIRS pass: share of its new-ground detections inside the forecast, and share of the
    # forecast's added area that VIIRS / Sentinel-2 ever saw burning.
    from fireproj.data.firms_timeline import load_timeline

    det, _ = load_timeline(cfg, B.EVENT)
    det = det[det["instrument"].astype(str).str.upper().str.contains("VIIRS")].to_crs(grid_crs)
    det["_t"] = pd.to_datetime(det["acq_datetime"], utc=True)
    ff = gpd.read_file(fire_root / "exports" / f"{B.EVENT}_firefront.geojson").to_crs(grid_crs)
    fine = ff[(ff["kind"] == "observed") & ((ff["instrument"] == "VIIRS") | ff["observation_type"].isin(["burned_area", "flame_front"]))]
    ever = unary_union(list(fine.geometry))
    pass_times = sorted(t.to_pydatetime() for t in det["_t"].unique())
    true_ids = {c["id"] for c in cands if c["_truth"] == "fire"}
    scores = []
    for issued, trigger, base_id in issues:
        known = tuple(c["id"] for c in cands if iso(c["candidate_at"]) <= issued)
        if not known:
            continue
        nxt = next((t for t in pass_times if t > issued), None)
        if nxt is None:
            continue
        gap_h = (nxt - issued).total_seconds() / 3600
        h = next((x for x in B.UPDATE_STEP_H if x >= gap_h), None)
        if h is None:
            continue
        base = r["run"](issued)
        start = base["perimeter"]
        pts = det[det["_t"] == pd.Timestamp(nxt)]
        new_pts = pts if start is None else pts[~pts.within(start)]
        options = [("without reports", ())]
        true_known = tuple(c for c in known if c in true_ids)
        if true_known:
            options.append(("with the true reports", true_known))
        if set(known) != set(true_known):
            options.append(("with every candidate (false ones too)", known))
        for name, subset in options:
            u = base if not subset else runs[(issued, subset)]
            con = u["contours"].to_crs(grid_crs)
            geom = con[np.isclose(con["horizon_hours"], h)].geometry.iloc[0]
            added = geom if start is None else geom.difference(start)
            scores.append({
                "issued_at": B._iso(issued), "next_pass_at": B._iso(nxt), "horizon_hours": h, "variant": name,
                "reports": list(subset), "false_reports": sum(1 for c in subset if c not in true_ids),
                "new_detections": int(len(new_pts)),
                "new_detections_inside_pct": round(100 * float(new_pts.within(geom).sum()) / len(new_pts), 1) if len(new_pts) else None,
                "forecast_km2": round(geom.area / 1e6, 2),
                "added_seen_burning_pct": round(100 * added.intersection(ever).area / added.area, 1) if added.area > 0 else None,
            })

    out = {
        "metadata": {
            "record": "FireReport", "schema_version": B.SCHEMA_VERSION, "synthetic": True, "concept_demo": True,
            "label": LABEL, "generated_at": B.GENERATED_AT, "seed": SEED,
            "note": "Synthetic reports derived from later VIIRS passes (an upper bound: real callers are less precise). "
                    "Excluded from the overlap table. `_truth` is never shown on the screen; it only drives the score "
                    "table and the mock answers of 'Is the fire still there?'.",
            "noise": {"position_error_m": list(POSITION_ERROR_M), "arrival_before_pass_min": list(ARRIVAL_BEFORE_PASS_MIN),
                      "false_share": FALSE_SHARE},
            "weights": {"statement": STATEMENT, "location_quality": LOCATION, "observer_distance": DISTANCE,
                        "repeat_same_number": 0},
            "clustering": {"radius_m": CLUSTER_M, "window_min": CLUSTER_MIN, "single_source_cap": SINGLE_SOURCE_CAP,
                           "candidate_min_sources": 2, "candidate_min_p": CANDIDATE_P, "min_disc_m": MIN_DISC_M},
            "window_end": B._iso(NIGHT_END),
        },
        "records": reports,
        "clusters": clusters,
        "streets": lib["streets"],
        "forecasts": variants,
        "scores": scores,
    }
    OUT_FILE.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{OUT_FILE.name}: {OUT_FILE.stat().st_size / 1024:.0f} kB")
    df = pd.DataFrame(scores)
    if not df.empty:
        print(df[["issued_at", "next_pass_at", "variant", "false_reports", "new_detections", "new_detections_inside_pct",
                  "forecast_km2", "added_seen_burning_pct"]].to_string())
    write_doc(out, df)
    return 0


def write_doc(out: dict, df: pd.DataFrame) -> None:
    m = out["metadata"]
    lines = [
        f"# {LABEL}", "",
        "Written by `tools/build_concept_reports.py`. **Synthetic.** These reports are derived from VIIRS passes "
        "the model had not seen yet, so they are an upper bound of what callers could add. They are excluded from "
        "the overlap table in the README.", "",
        f"- Reports: {len(out['records'])}, of them {sum(r['_truth'] == 'false_report' for r in out['records'])} false "
        f"and {sum(1 for r in out['records'] if r.get('repeat_of_number'))} repeat calls from the same number; seed {m['seed']}.",
        f"- Noise: position error {m['noise']['position_error_m'][0]}-{m['noise']['position_error_m'][1]} m, fire arrival "
        f"{m['noise']['arrival_before_pass_min'][0]}-{m['noise']['arrival_before_pass_min'][1]} min before the pass, "
        f"{round(100 * m['noise']['false_share'])} % false reports.",
        f"- Clusters: {len(out['clusters'])}; candidates (2 independent sources, P >= {CANDIDATE_P}): "
        f"{sum('candidate_at' in c for c in out['clusters'])}.",
        "- Confidence: noisy-OR `P = 1 - prod(1 - w_i)`, w = statement x location quality x observer distance x "
        "independence; one source at most 0.5.", "",
        "## Score against the next VIIRS pass", "",
        "Each row is a forecast issued at `issued`, compared with the next VIIRS pass: the share of that pass's "
        "detections on new ground (outside the area the forecast started from) that lie inside the forecast contour "
        "for that time, and the share of the area the forecast adds that VIIRS or Sentinel-2 ever saw burning.", "",
    ]
    if not df.empty:
        tab = df.assign(issued=df["issued_at"].str[8:16].str.replace("T", " "), next_pass=df["next_pass_at"].str[11:16])[
            ["issued", "next_pass", "variant", "false_reports", "new_detections", "new_detections_inside_pct",
             "forecast_km2", "added_seen_burning_pct"]]
        lines.append(B._markdown(tab))
    lines += ["", "**Caveats.** " + B.SKILL_NOTE + " The reports are synthetic and placed where a later satellite "
              "pass saw fire, with noise; real reports would be fewer, later and less precise.", ""]
    DOC.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
