"""Tram routing graph built from the cached OpenStreetMap extract.

Pure standard library. Edges are weighted by length x a "tram-friendliness"
multiplier, so routes prefer main roads and old rail corridors and avoid
back streets. One-way restrictions are ignored (trams run both ways).
"""
import heapq
import json
import math
from collections import defaultdict

# Lower = more attractive for a tram corridor.
HIGHWAY_COST = {
    "busway": 0.9,
    "primary": 1.0, "primary_link": 1.1,
    "secondary": 1.0, "secondary_link": 1.1,
    "tertiary": 1.1, "tertiary_link": 1.2,
    "trunk": 1.2, "trunk_link": 1.4,
    "road": 1.6,
    "unclassified": 1.5,
    "residential": 2.5,
    "pedestrian": 3.0,
    "living_street": 4.0,
    "service": 5.0,
}
RAILWAY_COST = {
    "disused": 0.8, "abandoned": 0.8,      # old corridors: great for light rail
    "light_rail": 0.8, "tram": 0.8,
    "rail": 8.0,                      # active heavy rail: last resort only
    "preserved": 1.0, "narrow_gauge": 1.0,
}
# When naming a stop, prefer the main road over a nearby lane.
NAME_RANK = {"primary": 1.0, "secondary": 1.0, "trunk": 1.0, "tertiary": 1.2,
             "busway": 1.2, "unclassified": 1.6, "residential": 1.6,
             "pedestrian": 1.6, "living_street": 2.5, "service": 3.5}
MIN_COST = 0.8                 # keeps the A* heuristic admissible
CONNECTOR_PENALTY_M = 300      # cost of hopping between rail corridor and road
CELL = 0.004                   # spatial index cell size, degrees (~400 m)
R_EARTH = 6371008.8


def haversine(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * R_EARTH * math.asin(math.sqrt(h))


def smooth(pts, max_straight=35, ratio=1.4):
    """Straighten small zigzags (traffic islands, slip lanes, split carriageways):
    wherever the path wanders far more than the straight line over a short
    distance, the tram goes straight across."""
    out, i = [pts[0]], 0
    while i < len(pts) - 1:
        nxt, along = i + 1, 0.0
        for j in range(i + 1, len(pts)):
            along += haversine(pts[j - 1], pts[j])
            if along > max_straight * 3:
                break
            straight = haversine(pts[i], pts[j])
            if j > i + 1 and straight <= max_straight and along > ratio * straight:
                nxt = j
        out.append(pts[nxt])
        i = nxt
    return out


def despike(pts, max_turn=110, max_leg=30):
    """Remove points where the path doubles back on itself over a short distance
    (spikes from joining the road at a stop, or a lone point shifted to a median).
    The first and last points (the stops) are kept."""
    pts = list(pts)
    changed = True
    while changed and len(pts) > 2:
        changed = False
        for i in range(1, len(pts) - 1):
            a, p, b = pts[i - 1], pts[i], pts[i + 1]
            la, lb = haversine(a, p), haversine(p, b)
            if la < 0.3 or lb < 0.3:
                del pts[i]; changed = True; break          # duplicate-ish point
            kx = math.cos(math.radians(p[0]))
            v1 = ((p[1] - a[1]) * kx, p[0] - a[0]); v2 = ((b[1] - p[1]) * kx, b[0] - p[0])
            cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (math.hypot(*v1) * math.hypot(*v2))
            if cos < math.cos(math.radians(max_turn)) and min(la, lb) < max_leg:
                del pts[i]; changed = True; break
            if cos < math.cos(math.radians(45)) and min(la, lb) < 2.5:
                del pts[i]; changed = True; break          # tiny zigzag step
    return pts


def _resample(pts, step):
    """Points every `step` metres along the polyline (first and last kept)."""
    out, carry = [pts[0]], 0.0
    for a, b in zip(pts, pts[1:]):
        L = haversine(a, b)
        if L == 0:
            continue
        d = step - carry
        while d <= L:
            t = d / L
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            d += step
        carry = L - (d - step)
    if haversine(out[-1], pts[-1]) > 0.01:
        out.append(pts[-1])
    return out


def _simplify(pts, tol):
    """Douglas-Peucker in metres (iterative)."""
    if len(pts) < 3:
        return pts
    lat0 = pts[0][0]
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110574
    xy = [((p[1] - pts[0][1]) * kx, (p[0] - lat0) * ky) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = xy[i], xy[j]
        dx, dy = x2 - x1, y2 - y1
        L = math.hypot(dx, dy)
        best, bi = 0.0, None
        for k in range(i + 1, j):
            x, y = xy[k]
            d = abs(dy * (x - x1) - dx * (y - y1)) / L if L else math.hypot(x - x1, y - y1)
            if d > best:
                best, bi = d, k
        if bi is not None and best > tol:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [p for p, k in zip(pts, keep) if k]


def centre_smooth(pts, window=25.0, step=4.0, tol=0.3):
    """Smooth the track like a real alignment: resample every `step` m, take a
    weighted moving average over +/- `window` m (shrinking towards the ends so
    the stops stay exact), then drop redundant points. Removes squiggles smaller
    than a tram curve; long curves and straights are unchanged."""
    r = _resample(pts, step)
    n, k = len(r), max(1, int(window / step))
    out = [r[0]]
    for i in range(1, n - 1):
        kk = min(k, i, n - 1 - i)
        wsum = la = lo = 0.0
        for j in range(-kk, kk + 1):
            w = kk + 1 - abs(j)
            la += r[i + j][0] * w; lo += r[i + j][1] * w; wsum += w
        out.append((la / wsum, lo / wsum))
    out.append(r[-1])
    return _simplify(out, tol)


def round_corners(pts, passes=((15, 0.4), (6, 0.25))):
    """Round sharp bends into tram-sized curves: each corner is cut back up to
    `max_m` metres (and at most `frac` of either adjoining segment), twice."""
    for max_m, frac in passes:
        if len(pts) < 3:
            return pts
        out = [pts[0]]
        for i in range(1, len(pts) - 1):
            a, p, b = pts[i - 1], pts[i], pts[i + 1]
            la, lb = haversine(a, p), haversine(p, b)
            if la < 0.5 or lb < 0.5:
                out.append(p); continue
            # skip near-straight vertices
            kx = math.cos(math.radians(p[0]))
            v1 = ((p[1] - a[1]) * kx, p[0] - a[0]); v2 = ((b[1] - p[1]) * kx, b[0] - p[0])
            cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (math.hypot(*v1) * math.hypot(*v2) or 1)
            if cos > 0.9995:
                out.append(p); continue
            ca, cb = min(max_m, frac * la) / la, min(max_m, frac * lb) / lb
            out.append((p[0] + (a[0] - p[0]) * ca, p[1] + (a[1] - p[1]) * ca))
            out.append((p[0] + (b[0] - p[0]) * cb, p[1] + (b[1] - p[1]) * cb))
        out.append(pts[-1])
        pts = out
    return pts


class Graph:
    def __init__(self, path):
        with open(path) as f:
            data = json.load(f)
        self.coords = {int(k): tuple(v) for k, v in data["nodes"].items()}
        self.stations = data.get("stations", [])
        self.adj = defaultdict(list)       # node -> [(nbr, cost, length)]
        self.node_name = {}                # node -> street name (for stop naming)
        self.rail_ways = []                # for the map overlay
        road_edges = []                    # (a, b, mult, name, name_rank) for snapping
        rings = []                         # node lists of roundabout ways
        rail_nodes = set()

        for w in data["ways"]:
            hw, rw = w.get("highway"), w.get("railway")
            mult = HIGHWAY_COST.get(hw) if hw else None
            if mult is None and rw:
                mult = RAILWAY_COST.get(rw)
            if mult is None:
                continue
            nodes = [n for n in w["nodes"] if n in self.coords]
            if rw and not hw:
                self.rail_ways.append({"type": rw, "name": w.get("name"),
                                       "coords": [self.coords[n] for n in nodes]})
                rail_nodes.update(nodes)
            name = w.get("name")
            if w.get("junction") in ("roundabout", "circular") and hw:
                rings.append(nodes)
            for a, b in zip(nodes, nodes[1:]):
                length = haversine(self.coords[a], self.coords[b])
                cost = length * mult
                self.adj[a].append((b, cost, length))
                self.adj[b].append((a, cost, length))
                if hw:
                    road_edges.append((a, b, mult, name, NAME_RANK.get(hw, 2.0)))
            if name and hw:
                rank = NAME_RANK.get(hw, 2.0)
                for n in nodes:
                    if n not in self.node_name or rank < self.node_name[n][1]:
                        self.node_name[n] = (name, rank)

        self._straighten_roundabouts(rings)
        self._build_index()
        self._connect_rail(rail_nodes)
        self._keep_main_component()
        self._build_edge_index(road_edges)

    def _straighten_roundabouts(self, rings, max_diameter=120):
        """Trams run straight across a roundabout's central island: add a centre
        node linked straight to every entry/exit, and make circling the ring
        expensive so routes go through the middle."""
        # roundabouts are often split into several ways: merge ways sharing nodes
        groups = []
        for ring in rings:
            ring = set(ring)
            merged = [g for g in groups if g & ring]
            for g in merged:
                groups.remove(g)
                ring |= g
            groups.append(ring)
        self.roundabouts = 0
        for k, ring in enumerate(groups):
            pts = [self.coords[n] for n in ring]
            c = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
            if max(haversine(c, p) for p in pts) * 2 > max_diameter:
                continue
            vid = 10 ** 15 + k
            self.coords[vid] = c
            for u in ring:
                self.adj[u] = [(v, cost * 3 if v in ring else cost, ln) for v, cost, ln in self.adj[u]]
            # Link the centre straight to each entry, and to points up to ~45 m back
            # along the approach roads, so trams cut across splitter islands too.
            reach = {}                                    # node -> path distance from ring
            frontier = [(0.0, u) for u in ring if any(v not in ring for v, _, _ in self.adj[u])]
            heapq.heapify(frontier)
            while frontier:
                dist, u = heapq.heappop(frontier)
                if u in reach:
                    continue
                reach[u] = dist
                for v, _, ln in self.adj[u]:
                    if v not in ring and v not in reach and dist + ln <= 45:
                        heapq.heappush(frontier, (dist + ln, v))
            for u in reach:
                d = haversine(self.coords[u], c)
                self.adj[u].append((vid, d, d))
                self.adj[vid].append((u, d, d))
            self.roundabouts += 1

    # ---- spatial index -------------------------------------------------
    def _cell(self, lat, lon):
        return (int(math.floor(lat / CELL)), int(math.floor(lon / CELL)))

    def _build_index(self, nodes=None):
        self.grid = defaultdict(list)
        for n in (nodes if nodes is not None else self.adj):
            lat, lon = self.coords[n]
            self.grid[self._cell(lat, lon)].append(n)

    def nearest(self, lat, lon, max_rings=6, pred=None):
        ci, cj = self._cell(lat, lon)
        best, best_d = None, float("inf")
        for r in range(max_rings + 1):
            for i in range(ci - r, ci + r + 1):
                for j in range(cj - r, cj + r + 1):
                    if max(abs(i - ci), abs(j - cj)) != r:
                        continue
                    for n in self.grid.get((i, j), ()):
                        if pred and not pred(n):
                            continue
                        d = haversine((lat, lon), self.coords[n])
                        if d < best_d:
                            best, best_d = n, d
            # anything in a further ring is at least r*CELL away
            if best is not None and best_d < r * CELL * 90000:
                break
        return best, best_d

    def _connect_rail(self, rail_nodes):
        """Rail lines rarely share nodes with roads; link them at their nodes
        to the nearest road node (if close) with a fixed penalty."""
        road = set(n for n in self.adj if n not in rail_nodes)
        for n in rail_nodes:
            if any(m in road for m, _, _ in self.adj[n]):
                continue
            lat, lon = self.coords[n]
            m, d = self.nearest(lat, lon, max_rings=1, pred=lambda x: x in road)
            if m is not None and d < 40:
                c = d * 1.5 + CONNECTOR_PENALTY_M
                self.adj[n].append((m, c, d))
                self.adj[m].append((n, c, d))

    def _keep_main_component(self):
        seen, best = set(), set()
        for start in self.adj:
            if start in seen:
                continue
            comp, stack = {start}, [start]
            seen.add(start)
            while stack:
                u = stack.pop()
                for v, _, _ in self.adj[u]:
                    if v not in seen:
                        seen.add(v)
                        comp.add(v)
                        stack.append(v)
            if len(comp) > len(best):
                best = comp
        self.main = best
        self._build_index(best)

    def _build_edge_index(self, edges):
        self.edge_name, self.edge_mult = {}, {}
        for a, b, mult, name, rank in edges:
            self.edge_mult[(a, b)] = self.edge_mult[(b, a)] = mult
            if name:
                self.edge_name[(a, b)] = self.edge_name[(b, a)] = name
        self.edge_grid = defaultdict(list)
        for e in edges:
            if e[0] not in self.main:
                continue
            cells = {self._cell(*self.coords[e[0]]), self._cell(*self.coords[e[1]])}
            for c in cells:
                self.edge_grid[c].append(e)

    def snap(self, lat, lon, max_m=150, median=False):
        """Nearest point on a road (preferring main roads); with median=True a
        point on a divided road goes onto its median (where the tram runs).
        Returns dict(a, b, t, lat, lon, dist, name) or None."""
        ci, cj = self._cell(lat, lon)
        kx = 111320 * math.cos(math.radians(lat))   # metres per degree lon
        ky = 110574
        best, best_score = None, float("inf")
        seen = set()
        for i in range(ci - 1, ci + 2):
            for j in range(cj - 1, cj + 2):
                for e in self.edge_grid.get((i, j), ()):
                    if id(e) in seen:
                        continue
                    seen.add(id(e))
                    a, b, mult, name, rank = e
                    (la1, lo1), (la2, lo2) = self.coords[a], self.coords[b]
                    x1, y1 = (lo1 - lon) * kx, (la1 - lat) * ky
                    x2, y2 = (lo2 - lon) * kx, (la2 - lat) * ky
                    dx, dy = x2 - x1, y2 - y1
                    L2 = dx * dx + dy * dy
                    t = 0.0 if L2 == 0 else max(0.0, min(1.0, -(x1 * dx + y1 * dy) / L2))
                    px, py = x1 + t * dx, y1 + t * dy
                    d = math.hypot(px, py)
                    if d > max_m:
                        continue
                    score = (d + 8) * mult ** 2     # strongly prefer main roads
                    if score < best_score:
                        best_score = score
                        best = {"a": a, "b": b, "t": t, "dist": d, "name": name,
                                "lat": lat + py / ky, "lon": lon + px / kx}
        if best and median:
            (la1, lo1), (la2, lo2) = self.coords[best["a"]], self.coords[best["b"]]
            ux, uy = (lo2 - lo1) * kx, (la2 - la1) * ky
            L = math.hypot(ux, uy)
            if L:
                q = self._twin_shift((best["lat"], best["lon"]), ux / L, uy / L, best["name"],
                                     self.edge_mult.get((best["a"], best["b"])), {best["a"], best["b"]})
                if q:
                    best["lat"], best["lon"] = q
        return best

    # ---- queries ---------------------------------------------------------
    def street_name(self, lat, lon):
        """Name of the most important street near (lat, lon)."""
        ci, cj = self._cell(lat, lon)
        best, best_score = None, 250.0
        for i in range(ci - 1, ci + 2):
            for j in range(cj - 1, cj + 2):
                for n in self.grid.get((i, j), ()):
                    if n not in self.node_name:
                        continue
                    name, rank = self.node_name[n]
                    score = (haversine((lat, lon), self.coords[n]) + 15) * rank
                    if score < best_score:
                        best, best_score = name, score
        return best

    def astar(self, s, t, extra=None, coords=None):
        extra = extra or {}
        crd = coords or {}
        cget = lambda n: crd[n] if n in crd else self.coords[n]
        goal = cget(t)
        h = lambda n: haversine(cget(n), goal) * MIN_COST
        dist = {s: 0.0}
        prev = {}
        pq = [(h(s), 0.0, s)]
        while pq:
            _, g, u = heapq.heappop(pq)
            if u == t:
                break
            if g > dist.get(u, float("inf")):
                continue
            for v, c, _ in self.adj.get(u, []) + extra.get(u, []):
                ng = g + c
                if ng < dist.get(v, float("inf")):
                    dist[v] = ng
                    prev[v] = u
                    heapq.heappush(pq, (ng + h(v), ng, v))
        if t not in dist:
            return None
        path = [t]
        while path[-1] != s:
            path.append(prev[path[-1]])
        return path[::-1]

    def _twin_shift(self, p, ux, uy, name, mult, exclude):
        """If p lies on one carriageway of a divided road (direction ux, uy), return
        the point halfway to the other carriageway (the median), else None."""
        major = mult is not None and mult <= 1.2
        kx, ky = 111320 * math.cos(math.radians(p[0])), 110574
        ci, cj = self._cell(*p)
        best = None
        for ii in range(ci - 1, ci + 2):
            for jj in range(cj - 1, cj + 2):
                for e in self.edge_grid.get((ii, jj), ()):
                    ea, eb, emult, ename, _ = e
                    if emult > 2.5 or {ea, eb} & exclude:
                        continue
                    # the other carriageway: same name, or (concurrent routes are
                    # often named differently) another main road close alongside
                    twin = (name and ename == name) or (major and emult <= 1.2)
                    if not twin:
                        continue
                    (la1, lo1), (la2, lo2) = self.coords[ea], self.coords[eb]
                    x1, y1 = (lo1 - p[1]) * kx, (la1 - p[0]) * ky
                    dx, dy = (lo2 - lo1) * kx, (la2 - la1) * ky
                    L2 = dx * dx + dy * dy
                    if L2 == 0 or abs(ux * dx + uy * dy) / math.sqrt(L2) < 0.94:
                        continue                       # not parallel
                    t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / L2))
                    px, py = x1 + t * dx, y1 + t * dy
                    d = math.hypot(px, py)
                    if 6 <= d <= (40 if ename == name else 30) and (best is None or d < best[0]):
                        best = (d, px, py)
        if not best:
            return None
        return (p[0] + best[2] / ky / 2, p[1] + best[1] / kx / 2)

    def _median(self, path, pts):
        """Divided roads are mapped as two one-way carriageways. Where the route
        runs along one of them, move it to halfway between the pair, i.e. onto
        today's median strip, where the tram would actually run."""
        out = list(pts)
        for i, n in enumerate(path):
            if n not in self.coords or n < 0 or n >= 10 ** 15:
                continue
            prev = path[i - 1] if i > 0 else None
            nxt = path[i + 1] if i + 1 < len(path) else None
            name = self.edge_name.get((prev, n)) or self.edge_name.get((n, nxt))
            mult = self.edge_mult.get((prev, n)) or self.edge_mult.get((n, nxt))
            if not name and not mult:
                continue
            p = pts[i]
            a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
            kx, ky = 111320 * math.cos(math.radians(p[0])), 110574
            ux, uy = (b[1] - a[1]) * kx, (b[0] - a[0]) * ky
            L = math.hypot(ux, uy)
            if L == 0:
                continue
            ux, uy = ux / L, uy / L
            q = self._twin_shift(p, ux, uy, name, mult, {n, prev, nxt})
            if q:
                out[i] = q
        return out

    def _virtual(self, vid, p, extra, crd):
        """Attach point p to the road network at its projection on the nearest
        road edge (virtual node vid). Falls back to the nearest node."""
        sn = self.snap(p[0], p[1], max_m=500, median=True)
        if sn is None:
            n, d = self.nearest(*p)
            return n if n is not None and d < 500 else None
        a, b = sn["a"], sn["b"]
        crd[vid] = (sn["lat"], sn["lon"])
        L = haversine(self.coords[a], self.coords[b])
        mult = next((c / l for v, c, l in self.adj[a] if v == b and l > 0), 1.0)
        for n, frac in ((a, sn["t"]), (b, 1 - sn["t"])):
            ln = L * frac
            extra.setdefault(vid, []).append((n, ln * mult, ln))
            extra.setdefault(n, []).append((vid, ln * mult, ln))
        return vid

    def route(self, points):
        """points: [(lat, lon), ...] (stop, optional via points, stop).
        Each point joins the road where it projects onto the nearest road, so
        stops on a road get no spur. Returns {"coords", "length_m", "routed"}."""
        out, routed = [], True
        for a, b in zip(points, points[1:]):
            extra, crd = {}, {}
            na = self._virtual(-1, a, extra, crd)
            nb = self._virtual(-2, b, extra, crd)
            path = None
            if na is not None and nb is not None:
                if na == -1 and nb == -2:        # both on the same edge: direct link
                    ea = {n for n, _, _ in extra[-1]}
                    eb = {n for n, _, _ in extra[-2]}
                    if ea == eb:
                        d = haversine(crd[-1], crd[-2])
                        extra[-1].append((-2, d, d))
                path = self.astar(na, nb, extra, crd)
            if path:
                pts = smooth(self._median(path, [crd.get(n) or self.coords[n] for n in path]))
                pts = despike([tuple(a)] + pts + [tuple(b)])[1:-1]
                leg = [list(a)] + [list(q) for q in pts] + [list(b)]
                # drop zero-length joins (stop exactly on the road)
                leg = [q for k, q in enumerate(leg) if k == 0 or haversine(q, leg[k - 1]) > 0.3]
                if len(leg) == 1:
                    leg.append(list(b))
            else:
                routed = False
                leg = [list(a), list(b)]
            if out:
                leg = leg[1:]
            out.extend(leg)
        # clean up across bend points too, then round the corners
        out = [list(q) for q in centre_smooth(despike([tuple(q) for q in out]))]
        length = sum(haversine(p, q) for p, q in zip(out, out[1:]))
        return {"coords": [[round(x, 6), round(y, 6)] for x, y in out],
                "length_m": round(length, 1), "routed": routed}

    def rail_geojson(self):
        feats = [{"type": "Feature",
                  "properties": {"railway": w["type"], "name": w["name"]},
                  "geometry": {"type": "LineString",
                               "coordinates": [[lon, lat] for lat, lon in w["coords"]]}}
                 for w in self.rail_ways if len(w["coords"]) > 1]
        feats += [{"type": "Feature",
                   "properties": {"station": s["name"]},
                   "geometry": {"type": "Point", "coordinates": [s["lon"], s["lat"]]}}
                  for s in self.stations]
        return {"type": "FeatureCollection", "features": feats}
