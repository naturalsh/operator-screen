"""Build the sample data of the `marmaris_2022` scenario.

Run with the fire repo's environment (needs geopandas + osmnx and its road cache):

    <fire repo>/fireproj/.venv/bin/python tools/build_marmaris_scenario.py <fire repo>/fireproj

What is real and what is not:

- firefront.geojson      REAL. Copied from the fire tool's export
                         (`python -m fireproj.export_firefront`).
- street_access.geojson  SYNTHETIC statuses on REAL OpenStreetMap street geometry
                         (© OpenStreetMap contributors, ODbL). Widths, classes,
                         imagery dates and confidences are invented.
- caller_reports.json    SYNTHETIC. Invented reports at real place names.

Replace the two synthetic files with the Road Check and Voice intake exports
when they arrive; nothing else has to change.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from pathlib import Path

import geopandas as gpd
import osmnx as ox
from shapely.geometry import box, mapping

OUT = Path(__file__).resolve().parents[1] / "public" / "scenarios" / "marmaris_2022"
SCHEMA_VERSION = "0.1.0"
GENERATED_AT = "2026-11-12T15:00:00Z"
ROAD_GRAPH = "data/cache/roads/75752c8178809b84bd21b3bb.graphml"
VIEW = box(28.03, 36.79, 28.235, 36.93)
#: Assumed carriageway width per OSM class (metres) before the invented obstruction.
BASE_WIDTH_M = {"trunk": 7.5, "secondary": 6.5, "tertiary": 5.5, "residential": 4.5,
                "unclassified": 4.0, "service": 3.5}


def _unit(key: str) -> float:
    """Deterministic pseudo-random number in [0, 1) from a string."""
    return int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) / 0x100000000


def classify(free_width_m: float) -> str:
    """Road Check classes from the pitch deck."""
    if free_width_m >= 3.0:
        return "open"
    return "special_access" if free_width_m >= 2.0 else "blocked"


def build_street_access(fire_root: Path) -> dict:
    graph = ox.load_graphml(fire_root / ROAD_GRAPH)
    edges = ox.graph_to_gdfs(graph, nodes=False).reset_index()
    edges["highway"] = edges["highway"].apply(lambda h: h[0] if isinstance(h, list) else h)
    edges = edges[edges["highway"].isin(BASE_WIDTH_M) & edges.intersects(VIEW)]
    edges["_uv"] = edges.apply(lambda r: tuple(sorted((int(r["u"]), int(r["v"])))), axis=1)
    edges = edges.drop_duplicates("_uv").sort_values("_uv")

    feats = []
    for _, r in edges.iterrows():
        way = r["osmid"][0] if isinstance(r["osmid"], list) else r["osmid"]
        u, v = r["_uv"]
        edge_id = f"{int(way)}-{u}-{v}"
        base = BASE_WIDTH_M[r["highway"]]
        roll = _unit(edge_id)
        # 70 % clear, 18 % partly obstructed, 12 % mostly obstructed (invented).
        obstruction = 0.0 if roll < 0.70 else base - (2.0 + _unit(edge_id + "w")) if roll < 0.88 \
            else base - 2.0 * _unit(edge_id + "w")
        free = round(max(base - obstruction, 0.0), 1)
        name = r.get("name")
        feats.append({
            "type": "Feature",
            "geometry": mapping(r.geometry.simplify(0.00002)),
            "properties": {
                "schema_version": SCHEMA_VERSION,
                "id": f"synthetic-street-{edge_id}",
                "osm_way_id": int(way),
                "edge_id": edge_id,
                "name": name[0] if isinstance(name, list) else (name if isinstance(name, str) else None),
                "highway": r["highway"],
                "status": classify(free),
                "free_width_m": free,
                "confidence": round(0.55 + 0.4 * _unit(edge_id + "c"), 2),
                "imagery_date": "2022-06-20",
                "imagery_source": "SYNTHETIC (no drone or aerial image was analysed)",
                "confirmed_by_operator": _unit(edge_id + "o") < 0.3,
                "synthetic": True,
                "source": "nature-shield-operator synthetic sample",
                "source_url": f"https://www.openstreetmap.org/way/{int(way)}",
                "license": "geometry: ODbL-1.0 (© OpenStreetMap contributors); attributes: CC0-1.0 (synthetic)",
                "fetched_at": GENERATED_AT,
                "observed_at": "2022-06-20T09:00:00Z",
                "received_at": "2022-06-20T10:00:00Z",
            },
        })
    return {
        "type": "FeatureCollection",
        "name": "marmaris_2022_street_access",
        "metadata": {"record": "StreetAccess", "schema_version": SCHEMA_VERSION, "synthetic": True,
                     "note": "SYNTHETIC statuses on real OpenStreetMap geometry. Not a road survey."},
        "features": feats,
    }


# (reported_at UTC, lon, lat, label, language, urgency, hazard, people, channel, confirmed, reasons, summary, summary_en)
REPORTS = [
    ("2022-06-21T17:09:00Z", 28.0655, 36.8672, "Bördübet yolu", "tr", "urgent", "fire", 0, "voice", True,
     ["flames visible", "close to forest"],
     "Bördübet yolunda yol kenarında alev var, rüzgâr ormana doğru esiyor.",
     "Flames at the roadside on the Bördübet road; wind is blowing towards the forest."),
    ("2022-06-21T17:31:00Z", 28.0780, 36.8640, "Bördübet, camping area", "en", "life_threat", "fire", 6, "voice", True,
     ["people at risk", "fire approaching", "no vehicle"],
     "We are six people at the campsite, the fire is coming down the hill and we have no car.",
     "Six people at a campsite, fire approaching, no vehicle."),
    ("2022-06-21T18:02:00Z", 28.1045, 36.8041, "Hisarönü Jandarma Karakolu", "tr", "routine", "fire", 0, "sms", True,
     ["smoke only"],
     "Karakoldan kuzeyde yoğun duman görünüyor, alev görmüyoruz.",
     "Heavy smoke visible to the north of the gendarmerie post, no flames seen."),
    ("2022-06-21T19:40:00Z", 28.1210, 36.8455, "Marmaris–Datça yolu (D400)", "tr", "urgent", "fire", 3, "voice", False,
     ["road cut by fire", "vehicles stopped"],
     "Datça yolunda ilerleyemiyoruz, alev yolun iki yanında. Üç araç bekliyor.",
     "Cannot proceed on the Datça road, flames on both sides. Three cars waiting."),
    ("2022-06-21T20:15:00Z", 28.1419, 36.8319, "Değirmenyanı", "tr", "life_threat", "fire", 2, "voice", True,
     ["elderly", "cannot walk", "fire approaching"],
     "Annem yatalak, evden çıkaramıyorum. Alevler tepenin arkasında.",
     "Bedridden mother cannot be moved; flames behind the hill."),
    ("2022-06-21T21:05:00Z", 28.1380, 36.8290, "Değirmenyanı", "el", "urgent", "fire", 4, "whatsapp", False,
     ["tourists", "language barrier"],
     "Είμαστε τέσσερις τουρίστες σε ένα σπίτι στο Değirmenyanı, βλέπουμε φωτιά και δεν ξέρουμε προς τα πού να φύγουμε.",
     "Four tourists in a house in Değirmenyanı see fire and do not know which way to leave."),
    ("2022-06-21T23:30:00Z", 28.1452, 36.8001, "Hisarönü", "fr", "routine", "fire", 0, "sms", False,
     ["information request"],
     "La route vers Marmaris est-elle ouverte ? Nous sommes à Hisarönü avec deux enfants.",
     "Asks whether the road to Marmaris is open; at Hisarönü with two children."),
    ("2022-06-22T02:20:00Z", 28.1660, 36.8380, "Marmaris–Datça yolu, Çetibeli yönü", "tr", "urgent", "fire", 1, "voice", True,
     ["breathing difficulty", "smoke"],
     "Dumandan nefes alamıyorum, arabanın içindeyim, yol kenarında duruyorum.",
     "Breathing difficulty from smoke, stopped in a car at the roadside."),
    ("2022-06-22T06:45:00Z", 28.1900, 36.8520, "Çetibeli çevresi", "tr", "life_threat", "fire", 5, "voice", False,
     ["people at risk", "livestock", "fire at property edge"],
     "Ateş bahçenin sınırına geldi, beş kişiyiz, hayvanlar da var.",
     "Fire at the garden boundary; five people and livestock."),
    ("2022-06-22T10:10:00Z", 28.2000, 36.8300, "Marmaris yolu", "en", "routine", "fire", 0, "whatsapp", True,
     ["fallen tree on road"],
     "A burnt tree has fallen across the side road, one lane is blocked.",
     "Burnt tree across a side road, one lane blocked."),
    ("2022-06-22T14:35:00Z", 28.2050, 36.8700, "Çetibeli kuzeyi", "tr", "urgent", "fire", 2, "voice", False,
     ["fire approaching", "no vehicle"],
     "Alev sırtı aştı, köyün üst tarafına iniyor. Aracımız yok.",
     "Flames crossed the ridge towards the upper village; no vehicle."),
    ("2022-06-23T07:50:00Z", 28.2150, 36.8600, "Marmaris yolu, kuzeydoğu", "el", "urgent", "fire", 0, "voice", False,
     ["flames visible", "near road"],
     "Βλέπω φλόγες κοντά στον δρόμο προς το Μαρμαρίς, ο καπνός είναι πολύ πυκνός.",
     "Flames near the road towards Marmaris, very dense smoke."),
]


def build_caller_reports() -> dict:
    records = []
    for i, (at, lon, lat, label, lang, urgency, hazard, people, channel, confirmed, reasons, text, text_en) in enumerate(
            REPORTS, start=1):
        records.append({
            "schema_version": SCHEMA_VERSION,
            "id": f"synthetic-call-{i:03d}",
            "reported_at": at,
            "place": {"lon": lon, "lat": lat, "label": label},
            "language": lang,
            "urgency": urgency,
            "urgency_reasons": reasons,
            "hazard": hazard,
            "people_at_risk": people,
            "channel": channel,
            "summary": text,
            "summary_en": text_en,
            "confirmed_by_operator": confirmed,
            "synthetic": True,
            "source": "nature-shield-operator synthetic sample",
            "source_url": "https://example.org/synthetic",
            "license": "CC0-1.0 (synthetic)",
            "fetched_at": GENERATED_AT,
            "observed_at": at,
            "received_at": at,
        })
    return {"metadata": {"record": "CallerReport", "schema_version": SCHEMA_VERSION, "synthetic": True,
                         "note": "SYNTHETIC reports written for the demo. No real caller data."},
            "records": records}


def main() -> int:
    fire_root = Path(sys.argv[1]).resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fire_root / "exports" / "marmaris_2022_firefront.geojson", OUT / "firefront.geojson")
    for name, data in (("street_access.geojson", build_street_access(fire_root)),
                       ("caller_reports.json", build_caller_reports())):
        (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    for p in sorted(OUT.iterdir()):
        print(f"{p.name}: {p.stat().st_size / 1024:.0f} kB")
    streets = gpd.read_file(OUT / "street_access.geojson")
    print(streets["status"].value_counts().to_dict())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
