#!/usr/bin/env python3
"""Download a region's roads + railways from OpenStreetMap (Overpass API) and
save a compact cache at <region>/data/osm.json.

Existing region (reads the map area from <region>/region.json):
    python3 tools/fetch_osm.py regions/central-coast-nsw

New region (creates the folder and region.json first):
    python3 tools/fetch_osm.py regions/my-city --name "My City" --bbox SOUTH,WEST,NORTH,EAST

Takes a minute or three. Keep the area to a city or region (roughly 50 x 50 km);
very large areas are slow to download and to route on.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

HIGHWAYS = ("trunk|trunk_link|primary|primary_link|secondary|secondary_link|"
            "tertiary|tertiary_link|unclassified|residential|living_street|"
            "service|pedestrian|busway|road")
RAILWAYS = "rail|light_rail|tram|disused|abandoned|preserved|narrow_gauge"


def query(bbox):
    bb = ",".join(str(x) for x in bbox)
    return f"""
[out:json][timeout:300];
(
  way["highway"~"^({HIGHWAYS})$"]({bb});
  way["railway"~"^({RAILWAYS})$"]({bb});
  node["railway"="station"]({bb});
);
out body;
>;
out skel qt;
"""


def fetch(bbox):
    data = urllib.parse.urlencode({"data": query(bbox)}).encode()
    last = None
    for url in ENDPOINTS:
        try:
            print(f"Querying {url} ...", flush=True)
            req = urllib.request.Request(url, data=data, headers={
                "User-Agent": "central-coast-light-rail/0.1 (hobby transit map)"})
            with urllib.request.urlopen(req, timeout=400) as r:
                return json.load(r)
        except Exception as e:  # try next mirror
            print(f"  failed: {e}", flush=True)
            last = e
    raise SystemExit(f"All Overpass endpoints failed: {last}")


def load_region(args):
    region_file = os.path.join(args.region, "region.json")
    if args.bbox:
        bbox = [float(x) for x in args.bbox.split(",")]
        if len(bbox) != 4 or not (bbox[0] < bbox[2] and bbox[1] < bbox[3]):
            raise SystemExit("--bbox must be SOUTH,WEST,NORTH,EAST in degrees, e.g. -33.60,151.15,-33.12,151.66")
        region = {}
        if os.path.exists(region_file):
            with open(region_file) as f:
                region = json.load(f)
        region.update({"name": args.name or region.get("name") or os.path.basename(os.path.abspath(args.region)),
                       "bbox": bbox})
        os.makedirs(args.region, exist_ok=True)
        with open(region_file, "w") as f:
            json.dump(region, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Wrote {region_file}")
        return region
    if not os.path.exists(region_file):
        raise SystemExit(f"{region_file} not found. For a new region pass --name and --bbox.")
    with open(region_file) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("region", help="region folder, e.g. regions/central-coast-nsw")
    ap.add_argument("--name", help="region name (new regions)")
    ap.add_argument("--bbox", help="SOUTH,WEST,NORTH,EAST in degrees (new regions)")
    args = ap.parse_args()
    region = load_region(args)
    bbox = region["bbox"]
    out = os.path.join(args.region, "data", "osm.json")
    print(f"Downloading OpenStreetMap data for {region['name']} {bbox}")
    raw = fetch(bbox)
    nodes, ways, stations = {}, [], []
    for el in raw["elements"]:
        if el["type"] == "node":
            if "lat" in el:
                nodes[el["id"]] = [round(el["lat"], 7), round(el["lon"], 7)]
            tags = el.get("tags") or {}
            if tags.get("railway") == "station":
                stations.append({"name": tags.get("name", "Station"),
                                 "lat": el["lat"], "lon": el["lon"]})
        elif el["type"] == "way":
            t = el.get("tags") or {}
            ways.append({
                "id": el["id"],
                "highway": t.get("highway"),
                "railway": t.get("railway"),
                "name": t.get("name") or t.get("ref"),
                "junction": t.get("junction"),
                "nodes": el["nodes"],
            })
    used = {n for w in ways for n in w["nodes"]}
    nodes = {str(k): v for k, v in nodes.items() if k in used}
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump({"bbox": bbox, "nodes": nodes, "ways": ways,
                   "stations": stations}, f, separators=(",", ":"))
    print(f"Saved {len(ways)} ways, {len(nodes)} nodes, {len(stations)} stations "
          f"-> {out} ({os.path.getsize(out)/1e6:.1f} MB)")


if __name__ == "__main__":
    sys.exit(main())
