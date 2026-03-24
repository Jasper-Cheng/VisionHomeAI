#!/usr/bin/env python3
"""One-off: floorplans + design projects mm → cm (÷10). Skip version/areaM2/bools/strings."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP = frozenset({"areaM2", "version", "schemaVersion"})


def convert_value(o):
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k == "unit" and v == "mm":
                out[k] = "cm"
            elif k in SKIP:
                out[k] = v
            elif isinstance(v, str):
                out[k] = v
            elif isinstance(v, bool):
                out[k] = v
            elif isinstance(v, (int, float)):
                out[k] = v / 10.0
            else:
                out[k] = convert_value(v)
        return out
    if isinstance(o, list):
        if o and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in o):
            return [x / 10.0 for x in o]
        return [convert_value(x) for x in o]
    return o


def convert_floorplan(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("project", {}).get("unit") != "mm":
        print(f"skip floorplan (not mm): {path.name}")
        return
    path.write_text(json.dumps(convert_value(data), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"floorplan: {path.name}")


def convert_design(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    changed = False
    for fi in data.get("furnitureInstances") or []:
        if "positionMm" in fi:
            pm = fi.pop("positionMm")
            fi["positionCm"] = [pm[0] / 10.0, pm[1] / 10.0]
            changed = True
    se = data.get("svgEditor")
    if isinstance(se, dict):
        for f in se.get("furniture") or []:
            if isinstance(f, dict):
                if "x" in f and isinstance(f["x"], (int, float)):
                    f["x"] = f["x"] / 10.0
                    changed = True
                if "y" in f and isinstance(f["y"], (int, float)):
                    f["y"] = f["y"] / 10.0
                    changed = True
    if changed:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"design: {path.name}")
    else:
        print(f"skip design: {path.name}")


def main():
    fp_dir = ROOT / "data" / "floorplans"
    for p in sorted(fp_dir.glob("*.json")):
        if p.name == "manifest.json":
            continue
        convert_floorplan(p)

    ddir = ROOT / "data" / "design"
    for p in sorted(ddir.glob("project_*.json")):
        convert_design(p)


if __name__ == "__main__":
    main()
