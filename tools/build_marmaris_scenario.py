"""Build the data of the `marmaris_2022` scenario from the fire repository.

Run with the fire repo's environment (offline; it reads that repo's caches and tools/osm/):

    python tools/fetch_osm.py                                  # once: OpenStreetMap extract (needs network)
    <fire repo>/fireproj/.venv/bin/python tools/build_marmaris_scenario.py <fire repo>/fireproj

What each file is:

- firefront.geojson      REAL. The fire tool's export (`python -m fireproj.export_firefront`):
                         model contours + satellite observations.
- street_access.geojson  MODEL + SATELLITE. Real OpenStreetMap streets (© OpenStreetMap contributors,
                         ODbL). A street becomes `blocked` at `valid_at` when either
                         (a) the modelled fire reaches it: the fire repo's own road-closure calculation
                             (`fireproj.road_closure.evaluate_road_closures`, 150 m safety buffer) against
                             the modelled P >= 50 % contour every two hours, or
                         (b) a satellite saw fire on it: a VIIRS 375 m pixel footprint crosses it, or the
                             Sentinel-2 flame front / burned area lies within 150 m.
                         A single MODIS or SLSTR (1 km) pixel does not close a street; it sets
                         `fire_nearby_at`. Two separate overpasses with such a pixel over the street do.
                         It is not a road survey: no width was measured.
- responders.json        REAL locations of two fire stations and a gendarmerie post from OpenStreetMap.
                         That a crew is available there is an assumption of the demo.
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
import pandas as pd
import shapely
import numpy as np
from shapely.geometry import LineString, Point, mapping
from shapely.ops import unary_union

OUT = Path(__file__).resolve().parents[1] / "public" / "scenarios" / "marmaris_2022"
SCHEMA_VERSION = "0.2.0"
GENERATED_AT = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
EVENT = "marmaris_2022"
HORIZONS_H = [float(h) for h in range(2, 41, 2)]     # modelled contour every 2 h up to 40 h
FIRE_REPO_URL = "https://github.com/ismailefe45-m/GreekTurkeyHackhatonFire"
OSM_EXTRACT = Path(__file__).resolve().parent / "osm" / "marmaris_osm.json"
#: OSM elements used as response points (two fire stations, one gendarmerie post).
RESPONDERS = {("node", 6622303971): "fire_station", ("node", 12349466130): "fire_station",
              ("way", 1518696480): "gendarmerie"}
FAR_FROM_FIRE_KM = 3.0
#: Two coarse (1 km) detections count as separate overpasses when they are at least this far apart in time.
REPEAT_GAP_MIN = 30
#: ... and at most this far apart (otherwise they are not taken as the same fire).
REPEAT_MAX_GAP_H = 6.0
#: A repeated coarse detection closes a street only if a VIIRS / Sentinel-2 detection is this close to it.
REPEAT_FINE_WITHIN_M = 1000.0


def load_osm():
    """``(edges_gdf, places, responders, fetched_at)`` from the cached Overpass extract.

    Ways are split at every node shared with another way (and at their ends), so each edge runs
    between two junction nodes ``u`` and ``v``: the same segmentation OSMnx produces.
    """
    data = json.loads(OSM_EXTRACT.read_text(encoding="utf-8"))
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in data["elements"] if e["type"] == "node"}
    ways = [e for e in data["elements"] if e["type"] == "way" and "highway" in e.get("tags", {})]
    uses: dict[int, int] = {}
    for w in ways:
        for i, n in enumerate(w["nodes"]):
            uses[n] = uses.get(n, 0) + (2 if i in (0, len(w["nodes"]) - 1) else 1)
    rows = []
    for w in ways:
        ids = [n for n in w["nodes"] if n in nodes]
        start = 0
        for i in range(1, len(ids)):
            if uses[ids[i]] > 1 or i == len(ids) - 1:
                seg = ids[start:i + 1]
                if len(seg) >= 2 and seg[0] != seg[-1]:
                    rows.append({"u": seg[0], "v": seg[-1], "osmid": w["id"], "name": w["tags"].get("name", ""),
                                 "highway": w["tags"]["highway"], "geometry": LineString([nodes[n] for n in seg])})
                start = i
    edges = gpd.GeoDataFrame(rows, geometry="geometry", crs="EPSG:4326")
    places = {e["tags"]["name"]: (e["lon"], e["lat"]) for e in data["elements"]
              if e["type"] == "node" and e.get("tags", {}).get("place") and e["tags"].get("name")}
    responders = []
    for e in data["elements"]:
        kind = RESPONDERS.get((e["type"], e["id"]))
        if kind:
            c = e.get("center", e)
            responders.append({"osm": f"{e['type']}/{e['id']}", "kind": kind, "name": e["tags"]["name"],
                               "lon": round(c["lon"], 5), "lat": round(c["lat"], 5)})
    return edges, places, responders, data["nature_shield"]["fetched_at"]


def nearest_place(pt: Point, places: dict) -> tuple[str, float]:
    """Name of the nearest OSM place and the distance to it in km."""
    k = float(np.cos(np.radians(pt.y)))
    return min(((n, float(np.hypot((pt.x - x) * k, pt.y - y)) * 111.2) for n, (x, y) in places.items()),
               key=lambda item: item[1])


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _compact(line: LineString) -> LineString:
    """Simplified geometry at ~1 m precision; very short segments are kept as they are."""
    out = shapely.set_precision(line.simplify(0.00002), 1e-5)
    return out if not out.is_empty and len(out.coords) >= 2 else line


def _markdown(df: pd.DataFrame) -> str:
    """A DataFrame as a Markdown table (no extra dependency)."""
    rows = [[("" if pd.isna(v) else f"{v:g}" if isinstance(v, float) else str(v)) for v in r] for r in df.itertuples(index=False)]
    head = "| " + " | ".join(map(str, df.columns)) + " |"
    return "\n".join([head, "|" + "---|" * len(df.columns)] + ["| " + " | ".join(r) + " |" for r in rows])


def _unit(key: str) -> float:
    """Deterministic pseudo-random number in [0, 1) from a string."""
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0x100000000


# --------------------------------------------------------------------------- forecast updates
UPDATE_STEP_H = [2.0, 4.0, 6.0, 8.0, 10.0, 12.0]     # contours computed per update (street closures use all)
UPDATE_SHOWN_H = (4.0, 8.0, 12.0)                    # contours written to firefront.geojson
MAX_GAP_H = 6.0                                      # re-issue at least this often when no satellite passes
SAME_PASS_MIN = 20                                   # observations closer than this are one update


SAT_NAME = {"N": "S-NPP", "N20": "N20", "N21": "N21"}


def obs_label(row) -> str:
    """Short name of an observation: "VIIRS N20", "Sentinel-2 burned area"."""
    if row["observation_type"] in ("burned_area", "flame_front"):
        return f"Sentinel-2 {row['observation_type'].replace('_', ' ')}"
    return f"{row['instrument']} {SAT_NAME.get(row['satellite'], row['satellite'])}"


def forecast_runner(fire_root: Path, cfg: dict) -> dict:
    """The fire repo's Monte Carlo spread model, set up once, as a function of the issue time.

    ``run(issued, extra_starts=())`` returns one forecast: it starts from the union of every VIIRS and
    Sentinel-2 burned-area observation acquired by ``issued`` (the ignition point before the first one), plus
    ``extra_starts`` (metric geometries, e.g. confirmed fire reports), with the weather from ``issued`` on.
    Same grid, fuel, terrain, weather and settings as the fire repo's reconstruction.
    """
    from rasterio.features import rasterize

    from fireproj.data.dem import fetch_dem
    from fireproj.data.grid import make_grid
    from fireproj.data.landcover import fetch_landcover
    from fireproj.data.weather import fetch_weather
    from fireproj.fuel import map_landcover_to_fuel
    from fireproj.reconstruction import ReconstructionSpec
    from fireproj.spread.montecarlo import run_monte_carlo
    from pyproj import Transformer

    spec = ReconstructionSpec.from_config(cfg, EVENT)
    t0 = spec.ignition_utc
    img_grid = make_grid(spec.view_bbox, spec.image_resolution_m, buffer_km=0.0)
    grid = make_grid(spec.view_bbox, spec.model_resolution_m, buffer_km=0.0, crs=img_grid.crs)
    # Same model settings as fireproj.reconstruction.run_reconstruction.
    run_cfg = copy.deepcopy(cfg)
    run_cfg["spread"]["time_horizons_hours"] = UPDATE_STEP_H
    run_cfg["spread"]["probability_thresholds"] = [0.5]
    run_cfg["spread"]["wind_dir_sigma_deg"] = float(spec.wind_dir_sigma_deg)
    run_cfg["spread"]["use_gust_fraction"] = float(spec.use_gust_fraction)
    run_cfg["spread"]["max_lb_ratio"] = float(spec.max_lb_ratio)
    for fc in run_cfg["fuel"]["classes"].values():
        if float(fc.get("R0_m_per_min", 0.0)) > 0.0:
            fc["R0_m_per_min"] = round(float(fc["R0_m_per_min"]) * float(spec.r0_multiplier), 4)
    dem = fetch_dem(cfg, grid)
    fuel = map_landcover_to_fuel(fetch_landcover(cfg, grid), run_cfg)
    wx = fetch_weather(cfg, spec.view_bbox, t0.date(), (t0 + timedelta(hours=max(spec.horizons_hours) + 2)).date())
    wx_end = pd.Timestamp(wx["time"].max()).to_pydatetime()

    ff = gpd.read_file(fire_root / "exports" / f"{EVENT}_firefront.geojson").to_crs(grid.crs)
    ff["_t"] = pd.to_datetime(ff["valid_at"], utc=True)
    fine = ff[(ff["kind"] == "observed") & ((ff["instrument"] == "VIIRS") | (ff["observation_type"] == "burned_area"))]
    fine = fine.sort_values("_t")
    ign_x, ign_y = Transformer.from_crs("EPSG:4326", grid.crs, always_xy=True).transform(spec.ignition_lon, spec.ignition_lat)

    def run(issued: datetime, extra_starts=()) -> dict:
        seen = fine[fine["_t"] <= pd.Timestamp(issued)]
        if seen.empty:
            perimeter, start, source = None, Point(ign_x, ign_y).buffer(spec.ignition_radius_m), "ignition point"
        else:
            perimeter = start = unary_union(list(seen.geometry))
            has_s2 = (seen["observation_type"] == "burned_area").any()
            source = "VIIRS + Sentinel-2 perimeter" if has_s2 else "VIIRS perimeter"
        if extra_starts:
            start = unary_union([start, *extra_starts])
        mask = rasterize([(start, 1)], out_shape=grid.shape, transform=grid.transform, fill=0, all_touched=True,
                         dtype=np.uint8).astype(bool)
        mc = run_monte_carlo(mask, fuel, dem["slope_deg"], dem["aspect_deg"], grid, run_cfg, weather_df=wx,
                             t0_utc=issued, n_runs=int(spec.mc_runs), seed=int(cfg["spread"]["seed"]))
        contours = mc.contours_gdf.sort_values("horizon_hours").reset_index(drop=True)
        contours["geometry"] = contours.to_crs(grid.crs).geometry.buffer(60).buffer(-60).simplify(30).to_crs("EPSG:4326")
        last = None if seen.empty else seen.iloc[-1]
        return {"issued": issued, "source": source, "perimeter": perimeter, "start": start, "contours": contours,
                "last_obs": None if last is None else last["_t"].to_pydatetime(),
                "last_obs_label": None if last is None else obs_label(last)}

    return {"run": run, "fine": fine, "t0": t0, "wx_end": wx_end, "run_cfg": run_cfg, "grid": grid, "spec": spec}


def standing_issue_times(fine: pd.DataFrame, t0: datetime, end: datetime, wx_end: datetime) -> list[tuple[datetime, bool]]:
    """Issue times of the standing sequence: ignition, each new fine-resolution observation, and fills so that no
    gap exceeds MAX_GAP_H. ``(time, new_observation)`` pairs."""
    obs_times = [t.to_pydatetime() for t in fine["_t"] if t0 < t.to_pydatetime() <= end]
    issues: list[tuple[datetime, bool]] = [(t0, True)]
    for t in obs_times:
        if (t - issues[-1][0]).total_seconds() < SAME_PASS_MIN * 60 and issues[-1][1] and issues[-1][0] != t0:
            issues[-1] = (t, True)
            continue
        while (t - issues[-1][0]).total_seconds() > MAX_GAP_H * 3600:
            issues.append((issues[-1][0] + timedelta(hours=MAX_GAP_H), False))
        issues.append((t, True))
    while (end - issues[-1][0]).total_seconds() > MAX_GAP_H * 3600:
        issues.append((issues[-1][0] + timedelta(hours=MAX_GAP_H), False))
    # The cached weather ends with the reconstruction window; later updates would run on repeated last hours.
    return [i for i in issues if i[0] <= last_issue_time(wx_end)]


def last_issue_time(wx_end: datetime) -> datetime:
    """Latest issue time whose longest horizon still has weather data."""
    return wx_end - timedelta(hours=max(UPDATE_STEP_H) - 1)


def build_forecast_updates(fire_root: Path, cfg: dict, end: datetime):
    """Forecasts re-initialised from the latest observed fire area, with the fire repo's own model.

    An update is issued at ignition (from the ignition point), at every new VIIRS overpass or Sentinel-2
    image (from the union of everything VIIRS and Sentinel-2 have seen so far), and at least every
    MAX_GAP_H hours in between (same perimeter, new start time and weather). This standing sequence is what
    the street closures, the synthetic calls and the overlap table are computed from; the screen's
    "Update forecast" button uses the precomputed library (tools/build_forecast_library.py) instead.

    Returns ``(updates, grid, t0, run_cfg)``; each update is a dict with ``issued``, ``source``, ``perimeter``
    (metric geometry or None), ``contours`` (GeoDataFrame, EPSG:4326, one row per UPDATE_STEP_H) and ``next``.
    """
    r = forecast_runner(fire_root, cfg)
    issues = standing_issue_times(r["fine"], r["t0"], end, r["wx_end"])
    updates = []
    for k, (issued, new_obs) in enumerate(issues):
        u = r["run"](issued)
        if u["perimeter"] is not None and not new_obs:
            u["source"] += " (no new pass)"
        u.update({"next": issues[k + 1][0] if k + 1 < len(issues) else end, "new_obs": new_obs})
        updates.append(u)
    return updates, r["grid"], r["t0"], r["run_cfg"]


def forecast_features(updates: list[dict]) -> list[dict]:
    """FireFront features (kind forecast, forecast_set update) for the contours shown on the screen."""
    feats = []
    for u in updates:
        utm = u["contours"].estimate_utm_crs()
        areas = u["contours"].to_crs(utm).area / 1e6
        for (_, c), km2 in zip(u["contours"].iterrows(), areas):
            h = float(c["horizon_hours"])
            if h not in UPDATE_SHOWN_H or c.geometry.is_empty:
                continue
            valid = u["issued"] + timedelta(hours=h)
            feats.append({
                "type": "Feature",
                "geometry": mapping(shapely.set_precision(c.geometry, 1e-5)),
                "properties": {
                    "schema_version": SCHEMA_VERSION,
                    "id": f"{EVENT}-forecast-{u['issued']:%Y%m%dT%H%MZ}-h{h:g}",
                    "kind": "forecast", "forecast_set": "update",
                    "issued_at": _iso(u["issued"]), "model_run_at": _iso(u["issued"]),
                    "initialised_from": u["source"],
                    **({"last_observation_at": _iso(u["last_obs"])} if u["last_obs"] else {}),
                    "valid_at": _iso(valid), "horizon_hours": h, "probability": 0.5, "area_km2": round(float(km2), 3),
                    "source": "nature-shield-fire model, re-initialised from the latest observed fire area",
                    "source_url": FIRE_REPO_URL, "license": "MIT",
                    "fetched_at": GENERATED_AT, "observed_at": _iso(valid), "received_at": _iso(u["issued"]),
                },
            })
    return feats


SKILL_NOTE = ("In-sample parameters (r0_multiplier, gust fraction, wind-direction spread and length-to-breadth cap "
              "were set on this same fire), hindcast weather (archived Open-Meteo historical forecast, not the forecast "
              "available at the time) and zero satellite latency (each update is issued at the overpass minute; real "
              "near-real-time data arrive hours later). This is a replay of one fire, not a validation.")


def forecast_skill(fire_root: Path, cfg: dict, updates: list[dict], initial: gpd.GeoDataFrame, t0: datetime) -> pd.DataFrame:
    """How well forecasts match later satellite data: updated forecasts vs. the single forecast at ignition.

    For every update and horizon h, the hotspots (FIRMS VIIRS and MODIS centres, low confidence dropped)
    acquired between the issue time and issue + h are counted. A hotspot falls in several overlapping updates,
    so the detection counts are larger than the number of distinct hotspots, which is given too.
    "New ground" are hotspots outside the area the update started from. The one-shot forecast is the ignition
    run's contour for the same clock time.

    Recall alone rewards large forecasts, so the over-prediction side is reported as well: of the area the
    forecast adds beyond its starting area, the share that any VIIRS or Sentinel-2 observation of the whole
    event ever saw burning.

    Rows: all updates, the updates started from the ignition point, and those started from a satellite perimeter.
    """
    from fireproj.data.firms_timeline import load_timeline

    det, _ = load_timeline(cfg, EVENT)
    utm = initial.estimate_utm_crs()
    det = det.to_crs(utm).reset_index(drop=True)
    det["_id"] = np.arange(len(det))
    init = initial.to_crs(utm).sort_values("horizon_hours")
    ff = gpd.read_file(fire_root / "exports" / f"{EVENT}_firefront.geojson").to_crs(utm)
    fine = ff[(ff["kind"] == "observed") & ((ff["instrument"] == "VIIRS") | ff["observation_type"].isin(["burned_area", "flame_front"]))]
    ever_burned = unary_union(list(fine.geometry))
    rows = []
    for u in updates:
        con = u["contours"].to_crs(utm)
        perim = None if u["perimeter"] is None else gpd.GeoSeries([u["perimeter"]], crs=u["contours"].estimate_utm_crs()).to_crs(utm).iloc[0]
        start = "ignition point" if perim is None else "satellite perimeter"
        for h in UPDATE_SHOWN_H:
            valid = u["issued"] + timedelta(hours=h)
            new_geom = con[np.isclose(con["horizon_hours"], h)].geometry.iloc[0]
            old = init[init["horizon_hours"] <= (valid - t0).total_seconds() / 3600.0]
            old_geom = old.geometry.iloc[-1] if len(old) else None
            pts = det[(det["acq_datetime"] > pd.Timestamp(u["issued"])) & (det["acq_datetime"] <= pd.Timestamp(valid))]
            fresh = pts if perim is None else pts[~pts.within(perim)]
            added = new_geom if perim is None else new_geom.difference(perim)
            added_old = (old_geom if perim is None else old_geom.difference(perim)) if old_geom is not None else None
            rows.append({
                "start": start, "horizon": h, "hotspots": len(pts), "ids": set(pts["_id"]), "new_ids": set(fresh["_id"]),
                "in_updated": int(pts.within(new_geom).sum()) if len(pts) else 0,
                "in_one_shot": int(pts.within(old_geom).sum()) if len(pts) and old_geom is not None else 0,
                "new_ground": len(fresh),
                "new_in_updated": int(fresh.within(new_geom).sum()) if len(fresh) else 0,
                "new_in_one_shot": int(fresh.within(old_geom).sum()) if len(fresh) and old_geom is not None else 0,
                "added_km2": added.area / 1e6, "added_burned_km2": added.intersection(ever_burned).area / 1e6,
                "added_old_km2": added_old.area / 1e6 if added_old is not None else 0.0,
                "added_old_burned_km2": added_old.intersection(ever_burned).area / 1e6 if added_old is not None else 0.0,
                "update": u["issued"],
            })
    raw = pd.DataFrame(rows)
    pct = lambda a, b: round(100.0 * a / b, 1) if b > 0 else float("nan")
    out = []
    for label, sel in (("all updates", raw), ("started from ignition point", raw[raw["start"] == "ignition point"]),
                       ("started from satellite perimeter", raw[raw["start"] == "satellite perimeter"])):
        for h in UPDATE_SHOWN_H:
            g = sel[sel["horizon"] == h]
            if g.empty:
                continue
            out.append({
                "updates": label, "horizon": f"+{h:g} h", "n updates": g["update"].nunique(),
                "hotspot detections (counted per update)": int(g["hotspots"].sum()),
                "distinct hotspots": len(set().union(*g["ids"])),
                "inside updated %": pct(g["in_updated"].sum(), g["hotspots"].sum()),
                "inside one-shot %": pct(g["in_one_shot"].sum(), g["hotspots"].sum()),
                "new-ground detections": int(g["new_ground"].sum()),
                "distinct new-ground hotspots": len(set().union(*g["new_ids"])),
                "new ground inside updated %": pct(g["new_in_updated"].sum(), g["new_ground"].sum()),
                "new ground inside one-shot %": pct(g["new_in_one_shot"].sum(), g["new_ground"].sum()),
                "forecast new area km2 (summed)": round(float(g["added_km2"].sum()), 1),
                "of it seen burning, updated %": pct(g["added_burned_km2"].sum(), g["added_km2"].sum()),
                "of it seen burning, one-shot %": pct(g["added_old_burned_km2"].sum(), g["added_old_km2"].sum()),
            })
    return pd.DataFrame(out)


# --------------------------------------------------------------------------- street access (model output)
def closure_inputs(fire_root: Path, updates: list[dict], updates_cfg: dict) -> dict:
    """Everything the street closures are computed from: streets, per-forecast reach, satellite observations.

    Nothing here looks past the time it describes: each forecast's reach comes from that forecast alone, and
    observations keep their acquisition time. ``compute_closures`` then combines them up to a cut-off time.
    """
    from fireproj.config import load_config
    from fireproj.reconstruction import run_reconstruction
    from fireproj.road_closure import evaluate_road_closures

    cfg = load_config(fire_root / "config.yaml")
    run_cfg = copy.deepcopy(cfg)
    run_cfg["events"][EVENT]["reconstruction"]["horizons_hours"] = HORIZONS_H
    run_cfg["spread"]["time_horizons_hours"] = HORIZONS_H
    res = run_reconstruction(run_cfg, EVENT)
    t0 = res.spec.ignition_utc
    buffer_m = float(cfg["road_closure"]["safety_buffer_m"])

    edges, places, responders, osm_fetched_at = load_osm()
    # The ignition locality is not a named place in OSM; the fire repo's config gives its position.
    places["Bördübet"] = (res.spec.ignition_lon, res.spec.ignition_lat)
    edges["_uv"] = [tuple(sorted((int(u), int(v)))) for u, v in zip(edges["u"], edges["v"])]
    edges = edges.drop_duplicates(["_uv", "osmid"]).reset_index(drop=True)
    utm = res.model_grid.crs
    geom_utm = edges.to_crs(utm).geometry

    # For each forecast: hours after ignition at which its contour reaches each street (fire repo's
    # road-closure calculation, P >= 50 %, safety buffer), from that forecast alone.
    upd_cfg = copy.deepcopy(updates_cfg)
    reach_list = []
    near_list = []
    for u in updates:
        out, _ = evaluate_road_closures(
            edges, None, u["contours"], None, res.model_grid, upd_cfg,
            selected_horizon_hours=max(UPDATE_STEP_H), selected_prob_threshold=0.5,
        )
        hours = out["earliest_horizon_hours"].to_numpy(dtype=float)
        reach_list.append(np.array([(u["issued"] + timedelta(hours=float(h)) - t0).total_seconds() / 3600.0
                                    if np.isfinite(h) else np.nan for h in hours]))
        # Area of interest known at issue time: the forecast's outermost contour (and where it started from).
        area = unary_union([g for g in u["contours"].to_crs(utm).geometry] + ([u["perimeter"]] if u["perimeter"] is not None else []))
        near_list.append((geom_utm.distance(area) <= FAR_FROM_FIRE_KM * 1000).to_numpy())

    ff = gpd.read_file(fire_root / "exports" / f"{EVENT}_firefront.geojson").to_crs(utm)
    obs = ff[ff["kind"] == "observed"].copy()
    obs["_t"] = [pd.Timestamp(v).tz_convert("UTC").to_pydatetime() for v in obs["valid_at"]]
    obs = obs.sort_values("_t")
    return {"res": res, "t0": t0, "buffer_m": buffer_m, "edges": edges, "geom_utm": geom_utm, "places": places,
            "responders": responders, "osm_fetched_at": osm_fetched_at, "issues": [u["issued"] for u in updates],
            "end": updates[-1]["next"], "reach_list": reach_list, "near_list": near_list, "obs": obs}


def compute_closures(ci: dict, cutoff: datetime | None = None) -> dict:
    """Closure times per street from the information available at ``cutoff`` (all of it when None).

    - Model: the forecast in force when its contour reaches a street (a forecast stops being in force when the
      next one is issued; with a cut-off, forecasts issued after it do not exist yet).
    - Satellite: a VIIRS 375 m pixel crossing the street, or the Sentinel-2 flame front / burned area within the
      safety buffer, at the acquisition time. MODIS / SLSTR 1 km pixels: see ``_repeated_coarse``.
    - ``near_from``: first issue time at which the street lies within FAR_FROM_FIRE_KM of a forecast.
    Returned lists hold datetimes or None, one per street.
    """
    t0, n = ci["t0"], len(ci["edges"])
    keep = [k for k, t in enumerate(ci["issues"]) if cutoff is None or t <= cutoff]
    model_h = np.full(n, np.nan)
    model_issue = np.full(n, None, dtype=object)
    near_from = np.full(n, None, dtype=object)
    for pos, k in enumerate(keep):
        nxt = ci["issues"][keep[pos + 1]] if pos + 1 < len(keep) else ci["end"]
        reach = ci["reach_list"][k]
        current = reach <= (nxt - t0).total_seconds() / 3600.0 + 1e-9
        better = np.isfinite(reach) & current & (np.isnan(model_h) | (reach < model_h))
        model_h[better] = reach[better]
        model_issue[better] = ci["issues"][k]
        first_near = ci["near_list"][k] & np.array([x is None for x in near_from])
        near_from[first_near] = ci["issues"][k]
    model_at = [t0 + timedelta(hours=float(h)) if np.isfinite(h) else None for h in model_h]

    obs = ci["obs"] if cutoff is None else ci["obs"][ci["obs"]["_t"] <= cutoff]
    geom_utm, buffer_m = ci["geom_utm"], ci["buffer_m"]
    sat_at, sat_src = np.full(n, None, dtype=object), np.full(n, None, dtype=object)
    near_at, near_src = np.full(n, None, dtype=object), np.full(n, None, dtype=object)
    sat_name = {"N": "S-NPP", "N20": "N20", "N21": "N21"}
    coarse: list[list[tuple[datetime, str]]] = [[] for _ in range(n)]
    fine_seen: list[tuple[datetime, object]] = []
    for _, f in obs.iterrows():
        when = f["_t"]
        kind, inst = f["observation_type"], str(f["instrument"])
        if kind == "hotspots" and inst == "VIIRS":
            hits, label, at, src = geom_utm.intersects(f.geometry).to_numpy(), f"VIIRS {sat_name.get(f['satellite'], f['satellite'])}", sat_at, sat_src
            fine_seen.append((when, f.geometry))
        elif kind in ("burned_area", "flame_front"):
            hits = geom_utm.intersects(f.geometry.buffer(buffer_m)).to_numpy()
            label, at, src = f"Sentinel-2 {kind.replace('_', ' ')}", sat_at, sat_src
            fine_seen.append((when, f.geometry))
        else:
            hits, label, at, src = geom_utm.intersects(f.geometry).to_numpy(), f"{inst} {f['satellite']}", near_at, near_src
            for i in np.flatnonzero(hits):
                coarse[i].append((when, label))
        new = hits & np.array([a is None for a in at])
        at[new], src[new] = when, label
    _repeated_coarse(coarse, sat_at, sat_src, geom_utm, fine_seen)
    return {"model_at": model_at, "model_issue": list(model_issue), "sat_at": list(sat_at), "sat_src": list(sat_src),
            "near_at": list(near_at), "near_src": list(near_src), "near_from": list(near_from)}


def _repeated_coarse(coarse, sat_at, sat_src, geom_utm, fine_seen, max_gap_h: float | None = REPEAT_MAX_GAP_H,
                     fine_within_m: float | None = REPEAT_FINE_WITHIN_M) -> None:
    """Close a street from the second of two separate coarse (MODIS / SLSTR) overpasses with fire over it.

    The two overpasses must be at least REPEAT_GAP_MIN minutes apart (separate passes) and at most
    ``max_gap_h`` hours apart (the same fire, not two unrelated events a day apart). With ``fine_within_m``,
    a fine-resolution detection (VIIRS 375 m or Sentinel-2) acquired by the second overpass must lie within
    that distance of the street, so a 1-3 km pixel alone never closes a road the fine sensors never saw near.
    """
    for i, seen in enumerate(coarse):
        hit = None
        for a in range(len(seen)):
            for b in range(a + 1, len(seen)):
                gap = (seen[b][0] - seen[a][0]).total_seconds()
                if gap < REPEAT_GAP_MIN * 60 or (max_gap_h is not None and gap > max_gap_h * 3600):
                    continue
                if fine_within_m is not None and not any(
                        t <= seen[b][0] and geom_utm.iloc[i].distance(g) <= fine_within_m for t, g in fine_seen):
                    continue
                if hit is None or seen[b][0] < hit[0]:
                    hit = (seen[b][0], seen[a][1], seen[b][1])
                break
        if hit and (sat_at[i] is None or hit[0] < sat_at[i]):
            sat_at[i] = hit[0]
            sat_src[i] = f"repeated MODIS/SLSTR: {hit[1]} + {hit[2]}"


def build_street_access(fire_root: Path, updates: list[dict], updates_cfg: dict):
    ci = closure_inputs(fire_root, updates, updates_cfg)
    res, t0, buffer_m, places = ci["res"], ci["t0"], ci["buffer_m"], ci["places"]
    responders, osm_fetched_at = ci["responders"], ci["osm_fetched_at"]
    status_gdf = ci["edges"].copy()
    status_gdf["_len_m"] = ci["geom_utm"].length.round(0).to_numpy()
    cl = compute_closures(ci)
    # First closure by either source; used for the status and for timing the synthetic calls.
    first_all = [min([a for a in (m, s_) if a is not None], default=None) for m, s_ in zip(cl["model_at"], cl["sat_at"])]
    status_gdf["closure_hours"] = [np.nan if a is None else (a - t0).total_seconds() / 3600.0 for a in first_all]
    # Kept as plain lists: a DataFrame column would turn None into NaT / NaN.
    closures = list(zip(cl["model_at"], cl["sat_at"], cl["sat_src"], cl["near_at"], cl["near_src"], first_all,
                        cl["model_issue"], cl["near_from"]))

    feats = []
    for (_, r), (model_at, sat, sat_source, nearby_at, nearby_source, first, model_issue, near_from) in zip(
            status_gdf.iterrows(), closures):
        way = r["osmid"]
        u, v = r["_uv"]
        edge_id = f"{int(way)}-{u}-{v}"
        # Geometry runs from node u to node v (u < v), so the router can read node positions from it.
        line = r.geometry if int(r["u"]) == u else LineString(list(r.geometry.coords)[::-1])
        mid = line.interpolate(0.5, normalized=True)
        near, near_km = nearest_place(mid, places)
        reached = first is not None
        valid = first if reached else t0
        by = "both" if model_at and sat else "model" if model_at else "satellite" if sat else None
        first_by = None if not reached else "satellite" if sat and (not model_at or sat <= model_at) else "model"
        model_reason = (f"forecast issued {model_issue:%d %b %H:%M} UTC (P ≥ 50 %, {buffer_m:.0f} m safety buffer) "
                        f"reaches this street") if model_at else None
        sat_reason = None
        if sat:
            sat_reason = (f"two separate overpasses saw fire in 1 km pixels over this street ({sat_source[22:]})"
                          if sat_source.startswith("repeated") else f"{sat_source} saw fire on this street"
                          + (f" (within {buffer_m:.0f} m)" if sat_source.startswith("Sentinel-2") else " (375 m pixel)"))
        reasons = [x for x in (model_reason, sat_reason) if x]
        feats.append({
            "type": "Feature",
            "geometry": mapping(_compact(line)),
            "properties": {
                "schema_version": SCHEMA_VERSION,
                "id": f"{EVENT}-street-{edge_id}",
                "osm_way_id": int(way),
                "edge_id": edge_id,
                "name": r["name"] or None,
                "highway": str(r["highway"]),
                "u": u,
                "v": v,
                "length_m": float(r["_len_m"]),
                "near_place": near,
                "near_place_km": round(near_km, 1),
                "label_point": [round(mid.x, 5), round(mid.y, 5)],
                # First time a forecast in force came within FAR_FROM_FIRE_KM: the screen fades streets until then.
                **({"near_fire_from": _iso(near_from)} if near_from else {}),
                "status": "blocked" if reached else "open",
                **({"status_before": "open"} if reached else {}),
                "valid_at": _iso(valid),
                "basis": {"model": "fire_model", "satellite": "satellite", "both": "fire_model_and_satellite"}.get(
                    by, "fire_model_and_satellite"),
                **({"blocked_by": by, "first_blocked_by": first_by, "reason": "; ".join(reasons)} if reached else {}),
                **({"model_blocked_at": _iso(model_at), "model_forecast_issued_at": _iso(model_issue),
                    "model_reason": model_reason} if model_at else {}),
                **({"satellite_reason": sat_reason} if sat else {}),
                **({"satellite_blocked_at": _iso(sat), "satellite_source": sat_source} if sat else {}),
                **({"fire_nearby_at": _iso(nearby_at), "fire_nearby_source": nearby_source} if nearby_at else {}),
                "confirmed_by_operator": False,
                "source": "fire model + satellite detections (nature-shield-fire)",
                "source_url": FIRE_REPO_URL,
                "license": "ODbL-1.0 (OSM geometry); MIT (model status); NASA FIRMS / Copernicus open data (detections)",
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
            "basis": "fire_model_and_satellite",
            "label": "MODEL + SATELLITE",
            "note": "MODEL + SATELLITE: a street is blocked from the time the modelled fire reaches it or a "
                    "satellite sees fire on it (VIIRS 375 m pixel, Sentinel-2 flame front or burned area, or "
                    "MODIS/SLSTR 1 km pixels in two separate overpasses). A single MODIS/SLSTR detection only "
                    "raises a 'fire nearby' warning. Not a road survey.",
            "model_run_at": _iso(t0), "contour_step_hours": 2, "safety_buffer_m": buffer_m,
            "model_source": "latest forecast update (re-initialised from the observed fire area)",
            "far_from_fire_km": FAR_FROM_FIRE_KM, "osm_fetched_at": osm_fetched_at,
            "no_hindsight": "Every time in this file only uses information available at that time "
                            "(tools/test_no_hindsight.py).",
        },
        "features": feats,
    }
    resp = {
        "metadata": {"record": "Responder", "schema_version": SCHEMA_VERSION, "synthetic": False,
                     "note": "Real station locations from OpenStreetMap. That a crew is available at each "
                             "station is an assumption of the demo."},
        "records": [{
            "schema_version": SCHEMA_VERSION, "id": f"osm-{r['osm'].replace('/', '-')}", "name": r["name"],
            "kind": r["kind"], "place": {"lon": r["lon"], "lat": r["lat"]},
            "source": "OpenStreetMap", "source_url": f"https://www.openstreetmap.org/{r['osm']}",
            "license": "ODbL-1.0 (© OpenStreetMap contributors)", "fetched_at": osm_fetched_at,
            "observed_at": osm_fetched_at, "received_at": osm_fetched_at,
        } for r in sorted(responders, key=lambda r: r["name"])],
    }
    return fc, status_gdf, t0, places, resp, res


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


def _place_label(pt: Point, name: str | None, places: dict) -> tuple[str, str]:
    """``(label, spoken)``: the label names the street (or says it is unnamed), the nearest OSM place
    and the coordinate; ``spoken`` is the short form a caller would use in a sentence."""
    near, dist_km = nearest_place(pt, places)
    where = near if dist_km < 0.5 else f"{dist_km:.1f} km from {near}"
    spoken = name or (near if dist_km < 0.5 else f"{near} ({dist_km:.0f} km)")
    return f"{name or 'Unnamed road'}, {where} ({pt.y:.4f}° N, {pt.x:.4f}° E)", spoken


def build_caller_reports(status_gdf: gpd.GeoDataFrame, t0: datetime, places: dict) -> dict:
    """Reports on streets the modelled fire reaches, timed around its arrival there."""
    reached = status_gdf[status_gdf["closure_hours"].notna()].copy()
    # Streets closed by either source, grouped in 2-hour steps of their first closure.
    reached["earliest_horizon_hours"] = (np.ceil(reached["closure_hours"] / 2.0) * 2.0).clip(lower=2.0)
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
            if any(pt.distance(p) < 0.012 for p in used):      # keep calls ~1.2 km apart
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
            label, spoken = _place_label(pt, r["name"] or None, places)
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
                "summary": text.format(place=spoken, n=people),
                "summary_en": text_en.format(place=spoken, n=people),
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
    from fireproj.config import load_config

    cfg = load_config(fire_root / "config.yaml")
    index = json.loads((OUT.parent / "index.json").read_text(encoding="utf-8"))
    end = datetime.fromisoformat(next(s for s in index["scenarios"] if s["id"] == EVENT)["end"].replace("Z", "+00:00"))
    updates, _, _, updates_cfg = build_forecast_updates(fire_root, cfg, end)
    streets, status_gdf, t0, places, responders, res = build_street_access(fire_root, updates, updates_cfg)

    # FireFront = the fire tool's export (observations + the single forecast made at ignition, kept as the
    # "initial" set) + the forecast updates computed here with the same model.
    firefront = json.loads((fire_root / "exports" / f"{EVENT}_firefront.geojson").read_text(encoding="utf-8"))
    for f in firefront["features"]:
        if f["properties"]["kind"] == "forecast":
            f["properties"].update({"forecast_set": "initial", "issued_at": f["properties"]["model_run_at"],
                                    "initialised_from": "ignition point"})
    firefront["features"] += forecast_features(updates)
    firefront["features"].sort(key=lambda f: (f["properties"]["valid_at"], f["properties"]["kind"], f["properties"]["id"]))
    firefront["metadata"]["forecast_updates"] = {
        "count": len(updates), "horizons_hours": list(UPDATE_SHOWN_H), "max_gap_hours": MAX_GAP_H,
        "note": "Forecast updates are re-initialised from the union of VIIRS and Sentinel-2 observations so far, "
                "computed by tools/build_marmaris_scenario.py with the fire repository's model on its "
                "reconstruction grid (forecasts end at that grid's edge).",
    }
    (OUT / "firefront.geojson").write_text(json.dumps(firefront, ensure_ascii=False, separators=(",", ":")) + "\n",
                                           encoding="utf-8")
    skill = forecast_skill(fire_root, cfg, updates, res.modelled_gdf, t0)
    print("forecast updates:", len(updates), [f"{u['issued']:%d %H:%M}{'' if u['new_obs'] else '*'}" for u in updates])
    print(skill.to_string())
    (OUT.parent.parent.parent / "docs" / "forecast_skill.md").write_text(
        "# Forecast overlap with later satellite data (Marmaris 2022)\n\n"
        "Written by `tools/build_marmaris_scenario.py`. For every forecast update and horizon, the FIRMS hotspots "
        "(VIIRS and MODIS, low confidence dropped) acquired between the issue time and issue + horizon are "
        "counted; a hotspot falls in several overlapping updates, so 'detections' count it once per update and "
        "'distinct hotspots' once. 'New ground' = outside the area the update started from. The share of hotspots "
        "inside a forecast is a recall: larger forecasts score higher. The last three columns give the other "
        "side: of the area each forecast adds beyond its starting area, the share that any VIIRS or Sentinel-2 "
        "observation of the whole event saw burning.\n\n"
        + _markdown(skill) + "\n\n**Caveats.** " + SKILL_NOTE + "\n", encoding="utf-8")
    callers = build_caller_reports(status_gdf, t0, places)
    for name, data in (("street_access.geojson", streets), ("caller_reports.json", callers),
                       ("responders.json", responders)):
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
