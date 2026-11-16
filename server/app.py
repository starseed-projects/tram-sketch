#!/usr/bin/env python3
"""tram-sketch — local server.

    python3 server/app.py regions/central-coast-nsw     # then open http://localhost:8000

Serves the web app, routes tram track between stops, and saves the network
to <region>/network.geojson (human-readable, hand-editable).
"""
import json
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from graph import Graph  # noqa: E402

WEB = os.path.join(ROOT, "web")
PORT = int(os.environ.get("PORT", 8000))
# set from the command line in main()
REGION_DIR = NETWORK = OSM = None
REGION = {}

GRAPH = None
LOCK = threading.Lock()
EMPTY = {"type": "FeatureCollection", "features": []}


def dump_network(fc):
    """Readable, diff-friendly JSON: one property per line, short lists inline,
    each track segment's coordinates on a single line."""
    compact = lambda o: json.dumps(o, separators=(",", ":"), ensure_ascii=False)

    def props_txt(p):
        rows = []
        for k, v in p.items():
            if isinstance(v, dict):   # e.g. via: {"a>b": [[lat,lon],...]}
                inner = ",\n".join(f"      {compact(k2)}: {compact(v2)}" for k2, v2 in v.items())
                rows.append(f"    {compact(k)}: {{\n{inner}\n    }}" if v else f"    {compact(k)}: {{}}")
            else:
                rows.append(f"    {compact(k)}: {json.dumps(v, ensure_ascii=False)}")
        return "{\n" + ",\n".join(rows) + "\n  }"

    def geom_txt(g):
        if not g:
            return "null"
        if g.get("type") == "MultiLineString":
            parts = ",\n".join("      " + compact(c) for c in g["coordinates"])
            return ('{"type":"MultiLineString","coordinates":[\n' + parts + "\n    ]}")
        return compact(g)

    feats = []
    for f in fc.get("features", []):
        feats.append('  {"type": "Feature",\n  "properties": ' + props_txt(f.get("properties", {}))
                     + ',\n  "geometry": ' + geom_txt(f.get("geometry")) + "}")
    body = ",\n".join(feats)
    return ('{\n"type": "FeatureCollection",\n"features": [\n'
            + body + ("\n" if feats else "") + "]\n}\n")


def read_network():
    if not os.path.exists(NETWORK):
        return EMPTY
    with open(NETWORK) as f:
        return json.load(f)


def app_build():
    """Changes whenever the web app's code changes, so open pages can reload
    themselves instead of saving with outdated code."""
    return max(os.path.getmtime(os.path.join(WEB, f)) for f in os.listdir(WEB))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/api/version" not in msg:
            sys.stderr.write(msg + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"null")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/api/network":
            with LOCK:
                return self.send_json({"network": read_network(),
                                       "version": self.version()})
        if u.path == "/api/region":
            return self.send_json(REGION)
        if u.path == "/api/version":
            return self.send_json({"version": self.version(), "app": app_build()})
        if u.path == "/api/rail":
            return self.send_json(GRAPH.rail_geojson() if GRAPH else EMPTY)
        if u.path == "/api/snap":
            lat, lon = float(q["lat"][0]), float(q["lon"][0])
            sn = GRAPH.snap(lat, lon, median=True) if GRAPH else None
            if not sn:
                return self.send_json({"lat": lat, "lon": lon, "snapped": False,
                                       "name": GRAPH.street_name(lat, lon) if GRAPH else None})
            return self.send_json({"lat": sn["lat"], "lon": sn["lon"], "snapped": True,
                                   "name": sn["name"] or GRAPH.street_name(lat, lon)})
        if u.path == "/api/name":
            name = GRAPH.street_name(float(q["lat"][0]), float(q["lon"][0])) if GRAPH else None
            return self.send_json({"name": name})
        if u.path == "/network.geojson":
            with LOCK:
                body = dump_network(read_network()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/geo+json")
            self.send_header("Content-Disposition", 'attachment; filename="network.geojson"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        return super().do_GET()

    def do_PUT(self):
        if urlparse(self.path).path != "/api/network":
            return self.send_error(HTTPStatus.NOT_FOUND)
        fc = self.read_body()
        if not isinstance(fc, dict) or fc.get("type") != "FeatureCollection":
            return self.send_json({"error": "expected a FeatureCollection"}, 400)
        with LOCK:
            tmp = NETWORK + ".tmp"
            with open(tmp, "w") as f:
                f.write(dump_network(fc))
            os.replace(tmp, NETWORK)
            v = self.version()
        self.send_json({"version": v})

    def do_POST(self):
        if urlparse(self.path).path != "/api/route":
            return self.send_error(HTTPStatus.NOT_FOUND)
        req = self.read_body()
        pts = [tuple(p) for p in req["points"]]
        if GRAPH is None:
            from graph import haversine
            length = sum(haversine(a, b) for a, b in zip(pts, pts[1:]))
            return self.send_json({"coords": [list(p) for p in pts],
                                   "length_m": length, "routed": False})
        self.send_json(GRAPH.route(pts))

    @staticmethod
    def version():
        return os.path.getmtime(NETWORK) if os.path.exists(NETWORK) else 0


def main():
    global GRAPH, REGION_DIR, NETWORK, OSM, REGION
    regions = os.path.join(ROOT, "regions")
    if len(sys.argv) > 1:
        REGION_DIR = os.path.abspath(sys.argv[1])
    else:
        found = sorted(d for d in os.listdir(regions) if os.path.isfile(os.path.join(regions, d, "region.json")))
        if len(found) != 1:
            raise SystemExit("Usage: python3 server/app.py regions/<region>\nRegions: " + ", ".join(found))
        REGION_DIR = os.path.join(regions, found[0])
    region_file = os.path.join(REGION_DIR, "region.json")
    if not os.path.exists(region_file):
        raise SystemExit(f"{region_file} not found. Create a region with tools/fetch_osm.py first.")
    with open(region_file) as f:
        REGION = json.load(f)
    NETWORK = os.path.join(REGION_DIR, "network.geojson")
    OSM = os.path.join(REGION_DIR, "data", "osm.json")
    if os.path.exists(OSM):
        t = time.time()
        print("Loading road graph ...", flush=True)
        GRAPH = Graph(OSM)
        print(f"  {len(GRAPH.main)} nodes in {time.time() - t:.1f}s", flush=True)
    else:
        print("No OpenStreetMap data yet — routes will be straight lines.\n"
              f"Run `python3 tools/fetch_osm.py {os.path.relpath(REGION_DIR)}` once to enable road routing.")
    if not os.path.exists(NETWORK):
        with open(NETWORK, "w") as f:
            f.write(dump_network(EMPTY))
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"tram-sketch — {REGION.get('name', 'region')}: http://localhost:{PORT}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
