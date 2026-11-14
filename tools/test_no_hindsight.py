"""No street status uses information from the future.

For a series of cut-off times T, the street closures are recomputed from only what was available at T
(forecasts issued by T, satellite observations acquired by T) and compared with the closures computed from
the whole scenario, restricted to times up to T. Any difference means some status at time T depends on
something that happened later.

    <fire repo>/fireproj/.venv/bin/python tools/test_no_hindsight.py <fire repo>/fireproj
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_marmaris_scenario import EVENT, build_forecast_updates, closure_inputs, compute_closures  # noqa: E402


def upto(values: list, cutoff: datetime) -> list:
    return [v if v is not None and v <= cutoff else None for v in values]


def main() -> int:
    import json

    from fireproj.config import load_config

    fire_root = Path(sys.argv[1]).resolve()
    cfg = load_config(fire_root / "config.yaml")
    index = json.loads((Path(__file__).resolve().parents[1] / "public" / "scenarios" / "index.json").read_text())
    end = datetime.fromisoformat(next(s for s in index["scenarios"] if s["id"] == EVENT)["end"].replace("Z", "+00:00"))
    updates, _, t0, updates_cfg = build_forecast_updates(fire_root, cfg, end)
    ci = closure_inputs(fire_root, updates, updates_cfg)
    full = compute_closures(ci)
    # Every forecast issue time and every observation time, a minute before and after, and a few round hours.
    cutoffs = sorted({t + d for t in ci["issues"] + list(ci["obs"]["_t"]) for d in (timedelta(minutes=-1), timedelta(minutes=1))}
                     | {t0 + timedelta(hours=h) for h in range(1, 56, 3)})
    failures = 0
    for cut in cutoffs:
        part = compute_closures(ci, cutoff=cut)
        for key in ("model_at", "sat_at", "near_at", "near_from"):
            a, b = upto(full[key], cut), upto(part[key], cut)
            diff = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
            if diff:
                failures += 1
                print(f"FAIL {key} at {cut:%d %b %H:%M}Z: {len(diff)} streets differ, e.g. street {diff[0]}: "
                      f"full {a[diff[0]]} vs known-at-cutoff {b[diff[0]]}")
        # Sources shown for closures that have happened must not change either.
        for key, at in (("sat_src", "sat_at"), ("near_src", "near_at")):
            a = [s if t is not None and t <= cut else None for s, t in zip(full[key], full[at])]
            b = [s if t is not None and t <= cut else None for s, t in zip(part[key], part[at])]
            if a != b:
                failures += 1
                print(f"FAIL {key} at {cut:%d %b %H:%M}Z")
    print(f"no-hindsight: {len(cutoffs)} cut-off times x {len(ci['edges'])} streets, {failures} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
