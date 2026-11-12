"""Download the OpenStreetMap extract the Marmaris scenario is built from (roads, stations, place names).

    python tools/fetch_osm.py            # writes tools/osm/marmaris_osm.json (cached; --refresh re-downloads)

© OpenStreetMap contributors, ODbL-1.0. Fetched from the Overpass API.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent / "osm" / "marmaris_osm.json"
BBOX = (36.76, 28.03, 36.93, 28.30)                     # south, west, north, east
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
             "https://overpass.private.coffee/api/interpreter"]
# Same classes as the fire repo's drivable network (OSMnx "drive") plus forest tracks and service roads.
HIGHWAYS = ("motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|"
            "tertiary_link|unclassified|residential|living_street|service|track")
QUERY = f"""[out:json][timeout:180];
(
  way["highway"~"^({HIGHWAYS})$"]["area"!="yes"]["access"!="private"]({{b}});
  nwr["amenity"~"^(fire_station|police)$"]({{b}});
  node["place"~"^(city|town|village|hamlet|suburb|neighbourhood|quarter|locality)$"]["name"]({{b}});
);
out body center qt;
>;
out skel qt;
""".replace("{b}", ",".join(str(v) for v in BBOX))


def main() -> int:
    if OUT.exists() and "--refresh" not in sys.argv:
        print(f"cached: {OUT} ({OUT.stat().st_size / 1e6:.1f} MB); use --refresh to download again")
        return 0
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    data, used = None, ""
    for attempt, url in enumerate(ENDPOINTS * 2):
        try:
            req = urllib.request.Request(url, data=body,
                                         headers={"User-Agent": "nature-shield-operator/0.1 (hackathon demo)"})
            with urllib.request.urlopen(req, timeout=240) as res:
                data = json.loads(res.read().decode("utf-8"))
            used = url
            break
        except Exception as exc:  # noqa: BLE001 - try the next mirror
            print(f"{url}: {exc}")
            time.sleep(5 * (attempt + 1))
    if data is None:
        print("all Overpass endpoints failed")
        return 1
    data["nature_shield"] = {"query": QUERY, "endpoint": used, "bbox_swne": BBOX,
                             "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                             "license": "ODbL-1.0, © OpenStreetMap contributors"}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    kinds: dict[str, int] = {}
    for el in data["elements"]:
        kinds[el["type"]] = kinds.get(el["type"], 0) + 1
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB): {kinds}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
