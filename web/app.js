// tram-sketch — tram / light rail network designer
'use strict';

const PALETTE = ['#E4002B', '#0072CE', '#00A651', '#F7A800', '#8E44AD', '#00B5E2', '#F15A22', '#E6007E'];
// average speeds incl. stops: street-running light rail ~22 km/h; detachable gondola
// cable cars run ~6 m/s (21.6 km/h) and slow through stations, so ~20 km/h
const SPEED_KMH = { tram: 22, cablecar: 20, depot: 15 };
const LINE_WEIGHT = 5;
const SNAP_PX = 14;           // clicking this close to a stop reuses it

// ---------------------------------------------------------------- state
// stops: {id: {id, name, lat, lon}}
// lines: [{id, name, colour, hidden, stops: [stopId], via: {"a>b": [[lat,lon]]},
//          structures: {"a>b": ["road"|"bridge"|"tunnel", ...]}   one per leg between
//                      stop/bend points; only stored when a segment has a non-road leg
//          segs: {"a>b": {sig, coords: [[lat,lon]], length_m, routed,
//                         parts: [{mode, start, end, length_m}]}}}]   (non-road stretches)
let state = { stops: {}, lines: [] };
let activeId = null;
let version = null;
let undoStack = [], redoStack = [];
let saveTimer = null, saving = false;
let appBuild = null;
const pendingRoutes = new Map();   // sig -> Promise

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomControl: true }).setView([-33.40, 151.40], 11);
// Vector street map: labels are drawn live, so the "Map text" buttons can enlarge them.
const vectorBase = L.maplibreGL({
  style: 'https://tiles.openfreemap.org/styles/liberty',
  attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> &copy; OpenMapTiles &copy; OpenStreetMap contributors',
});
const bases = {
  'Street map (OpenFreeMap, adjustable text)': vectorBase,
  'Street map (OSM classic)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }),
  'Clean grey (Esri)': L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16, maxZoom: 19, attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors' }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16, maxZoom: 19 }),
  ]),
  'Satellite (Esri)': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }),
};
vectorBase.addTo(map);

const railLayer = L.layerGroup();
const trackLayer = L.layerGroup().addTo(map);
const viaLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
L.control.layers(bases, { 'Existing railway & stations': railLayer }, { collapsed: true }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
railLayer.addTo(map);

fetch('/api/rail').then(r => r.json()).then(fc => {
  L.geoJSON(fc, {
    style: f => {
      const active = ['rail', 'light_rail', 'tram'].includes(f.properties.railway);
      return { color: active ? '#4a4a4a' : '#8a8a8a', weight: active ? 2.5 : 2,
               dashArray: active ? '8 4' : '2 5', opacity: 0.8, interactive: false };
    },
    pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 5, color: '#4a4a4a', weight: 2,
      fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(f.properties.station + ' Station', { direction: 'top', className: 'station-label' }),
  }).addTo(railLayer);
});

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const uid = p => p + Math.random().toString(36).slice(2, 7);
const activeLine = () => state.lines.find(l => l.id === activeId) || null;
const pairKey = (a, b) => a + '>' + b;
const fmtKm = m => (m / 1000).toFixed(1) + ' km';
const fmtMin = (m, mode) => Math.round(m / 1000 / SPEED_KMH[mode || 'tram'] * 60) + ' min';

function haversine(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function segPoints(line, a, b) {
  const sa = state.stops[a], sb = state.stops[b];
  return [[sa.lat, sa.lon], ...(line.via[pairKey(a, b)] || []), [sb.lat, sb.lon]];
}
const sigOf = pts => pts.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join(';');
const sigFor = (pts, entries) => sigOf(pts) + '|' + JSON.stringify(entries);

// Structure type of each leg (stop → bend point → … → stop) in a segment.
const MODES = { road: 'Road', mall: 'Transit mall (no cars)', corridor: 'Own corridor', bridge: 'Bridge', tunnel: 'Tunnel' };
const ROUTED = m => m === 'road' || m === 'mall';    // these follow the streets
const MODE_LABEL = { mall: 'transit mall', corridor: 'own corridor', bridge: 'bridge', tunnel: 'tunnel' };
// A leg entry is a mode string, or {mode, h1, h2} when its curve handles were
// adjusted by hand (h1/h2 = handle offsets in degrees from the leg's start/end).
const modeOf = e => (typeof e === 'string' ? e : e && e.mode) || 'road';
function legEntries(line, k, n) {
  if (line.mode === 'cablecar') return Array(n).fill('cable');   // straight spans, no roads
  const m = (line.structures || {})[k] || [];
  return Array.from({ length: n }, (_, i) => m[i] && MODES[modeOf(m[i])] ? m[i] : 'road');
}
function setLegModes(line, k, entries) {
  line.structures = line.structures || {};
  if (entries.every(e => modeOf(e) === 'road')) delete line.structures[k];
  else line.structures[k] = entries;
}
function segSig(line, a, b) {
  const pts = segPoints(line, a, b);
  return sigFor(pts, legEntries(line, pairKey(a, b), pts.length - 1));
}

// ---- local planar geometry (metres) for curve construction
const M_LAT = 110574;
const mLon = lat => 111320 * Math.cos(lat * Math.PI / 180);
function dirOf(from, to) {                 // unit vector [east, north]
  const x = (to[1] - from[1]) * mLon(from[0]), y = (to[0] - from[0]) * M_LAT;
  const n = Math.hypot(x, y) || 1;
  return [x / n, y / n];
}
const offsetPt = (p, d, m) => [p[0] + d[1] * m / M_LAT, p[1] + d[0] * m / mLon(p[0])];
function bezier(p0, c1, c2, p3, n = 24) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push([a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
              a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]]);
  }
  return out;
}
// nearest point on a polyline [[lat,lon]...] → {d: metres, q: [lat,lon]}
function projectOnto(coords, p) {
  const kx = mLon(p[0]);
  let best = { d: Infinity, q: p };
  for (let i = 1; i < coords.length; i++) {
    const [a1, o1] = coords[i - 1], [a2, o2] = coords[i];
    const x1 = (o1 - p[1]) * kx, y1 = (a1 - p[0]) * M_LAT;
    const dx = (o2 - o1) * kx, dy = (a2 - a1) * M_LAT;
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / L2)) : 0;
    const px = x1 + t * dx, py = y1 + t * dy, d = Math.hypot(px, py);
    if (d < best.d) best = { d, q: [p[0] + py / M_LAT, p[1] + px / kx] };
  }
  return best;
}

// a point at least `m` metres along a polyline from its start
function pointAlong(coords, m = 30) {
  for (let i = 1; i < coords.length; i++) if (haversine(coords[0], coords[i]) >= m) return coords[i];
  return coords[coords.length - 1];
}
const sameCoords = (a, b) => a.length === b.length &&
  a.every((p, i) => Math.abs(p[0] - b[i][0]) < 2e-6 && Math.abs(p[1] - b[i][1]) < 2e-6);
const pathLen = c => c.reduce((m, p, i) => i ? m + haversine(c[i - 1], p) : 0, 0);

// which leg of a segment a clicked point is on (smallest detour between control points)
function nearestLeg(pts, p) {
  let best = 0, bestCost = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const c = haversine(pts[i], p) + haversine(p, pts[i + 1]) - haversine(pts[i], pts[i + 1]);
    if (c < bestCost) { best = i; bestCost = c; }
  }
  return best;
}

function structureLength(line) {
  const out = {};
  for (let i = 0; i + 1 < line.stops.length; i++) {
    const s = line.segs[pairKey(line.stops[i], line.stops[i + 1])];
    for (const p of (s && s.parts) || []) out[p.mode] = (out[p.mode] || 0) + p.length_m;
  }
  return out;
}

function lineLength(line) {
  let m = 0;
  for (let i = 0; i + 1 < line.stops.length; i++) {
    const a = line.stops[i], b = line.stops[i + 1];
    const s = line.segs[pairKey(a, b)];
    m += s ? s.length_m : haversine(...segPoints(line, a, b).slice(0, 2));
  }
  return m;
}

// Branches: a line with `branchOf` is part of its parent line (same colour, same line).
const parentOf = l => l.branchOf ? state.lines.find(x => x.id === l.branchOf && !x.branchOf) || null : null;
const familyOf = l => (parentOf(l) || l).id;
function syncBranches() {
  for (const l of state.lines) {
    const p = parentOf(l);
    if (p) { l.colour = p.colour; l.mode = 'tram'; } else if (l.branchOf) delete l.branchOf;
  }
}

// Segments a line runs in one direction only: everything between two visits to
// the same stop (a loop, e.g. a balloon loop at the end of the line).
// A line that ends where it started is a ring: trams run both ways round it.
const isRing = line => line.stops.length > 2 && line.stops[0] === line.stops[line.stops.length - 1];

// Segments a line runs in one direction only: everything between two visits to
// the same stop (a balloon loop) -- except the closing of a ring, which is two-way.
function oneWaySegments(line) {
  const set = new Set(), last = {};
  const n = line.stops.length;
  line.stops.forEach((id, i) => {
    const ringClose = isRing(line) && i === n - 1 && last[id] === 0;
    if (id in last && !ringClose) for (let j = last[id]; j < i; j++) set.add(j);
    last[id] = i;
  });
  return set;
}

function linesServing(stopId) {
  return state.lines.filter(l => l.stops.includes(stopId));
}

// ---------------------------------------------------------------- history & saving
function snapshot() { return JSON.stringify({ stops: state.stops, lines: state.lines }); }

function commit() {             // call BEFORE mutating
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}
function changed() {            // call AFTER mutating
  gcStops();
  syncBranches();
  render();
  ensureRoutes();
  scheduleSave();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  state = JSON.parse(undoStack.pop());
  render(); ensureRoutes(); scheduleSave();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  state = JSON.parse(redoStack.pop());
  render(); ensureRoutes(); scheduleSave();
}

function gcStops() {
  const used = new Set(state.lines.flatMap(l => l.stops));
  for (const id of Object.keys(state.stops)) if (!used.has(id)) delete state.stops[id];
  for (const l of state.lines) {          // drop stale segments / bend points
    const keys = new Set(l.stops.slice(1).map((b, i) => pairKey(l.stops[i], b)));
    for (const k of Object.keys(l.segs)) if (!keys.has(k)) delete l.segs[k];
    for (const k of Object.keys(l.via)) if (!keys.has(k)) delete l.via[k];
    l.structures = l.structures || {};
    for (const k of Object.keys(l.structures)) if (!keys.has(k)) delete l.structures[k];
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setStatus('Unsaved changes…');
  saveTimer = setTimeout(save, 600);
}

async function save() {
  saveTimer = null;
  saving = true;
  try {
    const r = await fetch('/api/network', { method: 'PUT', body: JSON.stringify(toGeoJSON()) });
    version = (await r.json()).version;
    setStatus('Saved to network.geojson · ' + new Date().toLocaleTimeString());
  } catch (e) {
    setStatus('⚠ Save failed — is the server running?');
  } finally { saving = false; }
}

function setStatus(t) { $('#status').textContent = t; }

// ---------------------------------------------------------------- GeoJSON (de)serialisation
function toGeoJSON() {
  const features = [];
  for (const s of Object.values(state.stops)) {
    features.push({ type: 'Feature',
      properties: { kind: 'stop', id: s.id, name: s.name },
      geometry: { type: 'Point', coordinates: [+s.lon.toFixed(6), +s.lat.toFixed(6)] } });
  }
  for (const l of state.lines) {
    const segs = [];
    let complete = true;
    for (let i = 0; i + 1 < l.stops.length; i++) {
      const s = l.segs[pairKey(l.stops[i], l.stops[i + 1])];
      if (!s) { complete = false; break; }
      segs.push(s.coords.map(([la, lo]) => [lo, la]));
    }
    const props = { kind: 'line', id: l.id, name: l.name, colour: l.colour,
                    stops: l.stops, length_km: +(lineLength(l) / 1000).toFixed(2) };
    if (Object.keys(l.via).length) props.via = l.via;
    if (Object.keys(l.structures || {}).length) props.structures = l.structures;
    if (l.hidden) props.hidden = true;
    if (l.branchOf) props.branch_of = l.branchOf;
    if (l.mode && l.mode !== 'tram') props.mode = l.mode;
    features.push({ type: 'Feature', properties: props,
      geometry: complete && segs.length ? { type: 'MultiLineString', coordinates: segs } : null });
  }
  return { type: 'FeatureCollection', features };
}

function fromGeoJSON(fc) {
  const st = { stops: {}, lines: [] };
  for (const f of fc.features || []) {
    const p = f.properties || {};
    if (p.kind === 'stop' && f.geometry) {
      const [lon, lat] = f.geometry.coordinates;
      st.stops[p.id] = { id: p.id, name: p.name || 'Stop', lat, lon };
    }
  }
  for (const f of fc.features || []) {
    const p = f.properties || {};
    if (p.kind !== 'line') continue;
    const line = { id: p.id || uid('l'), name: p.name || 'Line', colour: p.colour || PALETTE[0],
                   hidden: !!p.hidden, branchOf: p.branch_of || undefined, mode: ['cablecar', 'depot'].includes(p.mode) ? p.mode : 'tram', stops: (p.stops || []).filter(id => st.stops[id]),
                   via: p.via || {}, structures: p.structures || {}, segs: {} };
    // Reuse saved geometry only where it still starts/ends at the right stops.
    const geo = f.geometry && f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
    for (let i = 0; i + 1 < line.stops.length && i < geo.length; i++) {
      const a = line.stops[i], b = line.stops[i + 1];
      const coords = geo[i].map(([lo, la]) => [la, lo]);
      const sa = st.stops[a], sb = st.stops[b];
      if (coords.length < 2 || haversine(coords[0], [sa.lat, sa.lon]) > 1 ||
          haversine(coords[coords.length - 1], [sb.lat, sb.lon]) > 1) continue;
      let len = 0;
      for (let j = 1; j < coords.length; j++) len += haversine(coords[j - 1], coords[j]);
      if (line.mode === 'cablecar' || line.structures[pairKey(a, b)]) {
        // curves / cable spans are rebuilt (cheap) to recover their handles; show the
        // saved track meanwhile, and only re-save if the rebuild comes out different
        line.segs[pairKey(a, b)] = { sig: null, provisional: true, coords, length_m: len, routed: true, parts: [] };
        continue;
      }
      const pts = [[sa.lat, sa.lon], ...(line.via[pairKey(a, b)] || []), [sb.lat, sb.lon]];
      line.segs[pairKey(a, b)] = { sig: sigFor(pts, pts.slice(1).map(() => 'road')),
                                   coords, length_m: len, routed: true, parts: [] };
    }
    st.lines.push(line);
  }
  return st;
}

async function loadNetwork(fit) {
  const r = await fetch('/api/network');
  const { network, version: v } = await r.json();
  version = v;
  state = fromGeoJSON(network);
  syncBranches();
  if (activeId && !activeLine()) activeId = null;
  render();
  ensureRoutes();
  if (fit && Object.keys(state.stops).length) {
    map.fitBounds(L.latLngBounds(Object.values(state.stops).map(s => [s.lat, s.lon])).pad(0.15));
  }
  setStatus('Loaded network.geojson');
}

// Pick up edits made to network.geojson outside the app (e.g. by Claude).
setInterval(async () => {
  if (saving || saveTimer) return;
  try {
    const { version: v, app: build } = await (await fetch('/api/version')).json();
    if (appBuild === null) appBuild = build;
    else if (build !== appBuild) { location.reload(); return; }   // app code updated
    if (version !== null && v !== version) {
      undoStack.push(snapshot());
      await loadNetwork(false);
      setStatus('Reloaded — network.geojson changed on disk');
    }
  } catch (e) { /* server down; ignore */ }
}, 2000);

// ---------------------------------------------------------------- routing
function ensureRoutes() {
  for (const line of state.lines) {
    for (let i = 0; i + 1 < line.stops.length; i++) {
      const a = line.stops[i], b = line.stops[i + 1];
      const key = pairKey(a, b);
      const pts = segPoints(line, a, b);
      const modes = legEntries(line, key, pts.length - 1);
      const sig = sigFor(pts, modes);
      if (line.segs[key] && line.segs[key].sig === sig) continue;
      // Reuse an identical segment from another line if one exists.
      const twin = state.lines.map(l => l.segs[key]).find(s => s && s.sig === sig);
      if (twin) { line.segs[key] = twin; continue; }
      requestRoute(sig, pts, modes).then(res => {
        let applied = false, geomChanged = false;
        for (const l of state.lines) {
          for (let j = 0; j + 1 < l.stops.length; j++) {
            const k = pairKey(l.stops[j], l.stops[j + 1]);
            if (segSig(l, l.stops[j], l.stops[j + 1]) === sig) {
              const old = l.segs[k];
              if (!(old && old.provisional && sameCoords(old.coords, res.coords))) geomChanged = true;
              l.segs[k] = { sig, ...res };
              applied = true;
            }
          }
        }
        if (applied) { render(); if (geomChanged) scheduleSave(); }
      });
    }
  }
}

function requestRoute(sig, pts, modes) {
  if (!pendingRoutes.has(sig)) {
    const p = buildSegment(pts, modes).finally(() => pendingRoutes.delete(sig));
    pendingRoutes.set(sig, p);
  }
  return pendingRoutes.get(sig);
}

// Road legs are routed on the street network. Corridor / bridge / tunnel legs
// are smooth cubic Bézier curves that leave and join the neighbouring track
// tangentially (or follow hand-set handles); cable car spans are straight.
async function buildSegment(pts, entries) {
  const modes = entries.map(modeOf);
  const pieces = [];
  for (let i = 0; i < modes.length;) {
    if (ROUTED(modes[i])) {
      let j = i;
      while (j + 1 < modes.length && modes[j + 1] === modes[i]) j++;
      pieces.push({ mode: modes[i], i, j });
      i = j + 1;
    } else { pieces.push({ mode: modes[i], i, j: i }); i++; }
  }
  const res = await Promise.all(pieces.map(p => ROUTED(p.mode)
    ? fetch('/api/route', { method: 'POST', body: JSON.stringify({ points: pts.slice(p.i, p.j + 2) }) }).then(x => x.json())
    : null));
  let routed = true;
  pieces.forEach((p, n) => { if (res[n]) { p.coords = res[n].coords; routed = routed && res[n].routed; } });

  pieces.forEach((p, n) => {
    if (ROUTED(p.mode)) return;
    const P0 = pts[p.i], P3 = pts[p.i + 1];
    if (p.mode === 'cable') { p.coords = [P0, P3]; return; }
    const e = entries[p.i];
    let c1, c2;
    if (e && e.h1 && e.h2) {
      c1 = [P0[0] + e.h1[0], P0[1] + e.h1[1]];
      c2 = [P3[0] + e.h2[0], P3[1] + e.h2[1]];
    } else {
      const prev = pieces[n - 1], next = pieces[n + 1];
      // direction of travel arriving at P0 and leaving P3
      const tin = prev && ROUTED(prev.mode) ? dirOf(pointAlong(prev.coords.slice().reverse()), P0)
                : p.i > 0 ? dirOf(pts[p.i - 1], P3) : dirOf(P0, P3);
      const tout = next && ROUTED(next.mode) ? dirOf(P3, pointAlong(next.coords))
                 : p.i + 2 < pts.length ? dirOf(P0, pts[p.i + 2]) : dirOf(P0, P3);
      const d = haversine(P0, P3) / 3;
      c1 = offsetPt(P0, tin, d);
      c2 = offsetPt(P3, tout, -d);
    }
    p.c1 = c1; p.c2 = c2;
    p.coords = bezier(P0, c1, c2, P3);
  });

  const coords = [], parts = [];
  for (const p of pieces) {
    const start = coords.length ? coords.length - 1 : 0;
    coords.push(...(coords.length ? p.coords.slice(1) : p.coords));
    if (p.mode !== 'road') parts.push({ mode: p.mode, leg: p.i, start, end: coords.length - 1,
                                        length_m: pathLen(p.coords), c1: p.c1, c2: p.c2 });
  }
  return { coords, length_m: pathLen(coords), routed, parts };
}

// ---------------------------------------------------------------- rendering
function render() {
  renderTrack();
  renderStops();
  renderSidebar();
}

// Shared track: lines side by side, or one striped line in alternating colours.
let stripedShared = false;
try { stripedShared = localStorage.getItem('stripedShared') === '1'; } catch (e) { /* ignore */ }

// Double track is drawn from this zoom level in (street level).
const twinTracks = () => map.getZoom() >= 17;
const metresPerPixel = () => 156543.03 * Math.cos(map.getCenter().lat * Math.PI / 180) / 2 ** map.getZoom();
let lastTwin = null;
map.on('zoomend', () => { if (twinTracks() || lastTwin) renderTrack(); lastTwin = twinTracks(); });

function renderTrack() {
  trackLayer.clearLayers();
  viaLayer.clearLayers();
  // Lines sharing the same pair of stops are drawn side by side.
  const shared = {};
  for (const l of state.lines) {
    if (l.hidden) continue;
    for (let i = 0; i + 1 < l.stops.length; i++) {
      const [a, b] = [l.stops[i], l.stops[i + 1]].sort();
      const k = pairKey(a, b);
      (shared[k] = shared[k] || []).includes(familyOf(l)) || shared[k].push(familyOf(l));
    }
  }
  const active = activeLine();
  for (const l of state.lines) {
    if (l.hidden) continue;
    const isActive = l === active;
    const oneWay = oneWaySegments(l);
    for (let i = 0; i + 1 < l.stops.length; i++) {
      const a = l.stops[i], b = l.stops[i + 1];
      const seg = l.segs[pairKey(a, b)];
      let coords = seg ? seg.coords : segPoints(l, a, b);
      // canonical direction so offsets are consistent between lines
      const [ca, cb] = [a, b].sort();
      if (ca !== a) coords = coords.slice().reverse();
      const group = shared[pairKey(ca, cb)];
      const shareN = group.length, shareI = group.indexOf(familyOf(l));
      // One-way (loop) running: trams keep left, so the line uses only the left-hand
      // track for its direction of travel (the offset plugin's positive side is the right).
      const keepLeft = oneWay.has(i) && l.mode !== 'cablecar' ? (ca === a ? -1 : 1) : 0;
      // Zoomed in, lines that share track run on the SAME double track (striped);
      // zoomed out they're drawn side by side unless "striped shared track" is on.
      const striped = (stripedShared || twinTracks()) && shareN > 1 && !keepLeft;
      const slot = striped ? 0 : keepLeft ? keepLeft / 2 : shareI - (shareN - 1) / 2;
      const DASH = 14;                       // px per colour in a striped shared section
      const stripe = striped ? { dashArray: `${DASH} ${DASH * (shareN - 1)}`, dashOffset: `${-DASH * shareI}`, lineCap: 'butt' } : {};
      const w = isActive ? LINE_WEIGHT + 1 : LINE_WEIGHT;
      const opacity = active && !isActive ? 0.55 : 0.95;
      const tip = `${l.name}: ${state.stops[a].name} → ${state.stops[b].name}` +
                  (seg ? ` · ${fmtKm(seg.length_m)}` : ' · routing…');
      const draw = (c, opts, extraOffset = 0) => {
        const pl = L.polyline(c, { offset: offset + extraOffset, bubblingMouseEvents: false,
                                   lineCap: 'round', lineJoin: 'round', ...opts }).addTo(trackLayer);
        pl.bindTooltip(tip, { sticky: true });
        pl.on('click', e => onTrackClick(l, a, b, e));
        pl.on('contextmenu', e => { L.DomEvent.preventDefault(e.originalEvent); openTrackPopup(l, a, b, e.latlng); });
        return pl;
      };
      const parts = ((seg && seg.parts) || []).map(p => {
        const pc = seg.coords.slice(p.start, p.end + 1);
        return { mode: p.mode, c: ca !== a ? pc.reverse() : pc };
      });
      const partsOf = m => parts.filter(p => p.mode === m);
      let offset;
      if (l.mode === 'depot') {                  // non-revenue depot access track
        offset = 0;
        draw(coords, { color: '#5f6368', weight: 3, opacity, dashArray: '7 5' });
        continue;
      }
      if (l.mode === 'cablecar') {
        offset = slot * (LINE_WEIGHT + 1);
        draw(coords, { color: '#333', weight: 2, opacity });
        draw(coords, { color: l.colour, weight: w + 3, opacity, dashArray: '1 18' });
        continue;
      }
      if (twinTracks()) {
        // Zoomed in: draw the real double track (rails ~3.5 m apart) on its bed.
        const px = m => m / metresPerPixel();
        const half = Math.max(2.5, px(1.75));
        offset = keepLeft ? 0 : slot * (2 * half + px(3));
        for (const p of partsOf('mall')) draw(p.c, { color: '#e9c46a', weight: px(14), opacity: 0.5, lineCap: 'butt' });
        for (const p of partsOf('bridge')) {
          draw(p.c, { color: '#2b2b2b', weight: px(9) + 3, opacity, lineCap: 'butt' });
          draw(p.c, { color: '#f4f4f4', weight: px(9), opacity, lineCap: 'butt' });
        }
        draw(coords, { color: l.colour, weight: px(7), opacity: 0.18 });            // track bed
        const dash = seg ? (seg.routed ? null : '2 8') : '6 6';
        const rails = keepLeft ? [keepLeft * half] : [-half, half];     // one-way: just its own track
        for (const side of rails) draw(coords, { color: l.colour, weight: keepLeft ? 3.5 : 2.5, opacity, dashArray: dash, ...stripe }, side);
        for (const p of partsOf('tunnel')) {
          for (const side of [-half, half]) {
            draw(p.c, { color: '#fff', weight: 3.5, opacity: 1, lineCap: 'butt' }, side);
            draw(p.c, { color: l.colour, weight: 2.5, opacity: 0.6, dashArray: '6 5', lineCap: 'butt' }, side);
          }
        }
        continue;
      }
      offset = slot * (LINE_WEIGHT + 1);
      for (const p of partsOf('mall')) draw(p.c, { color: '#e9c46a', weight: w + 12, opacity: 0.5, lineCap: 'butt' });
      draw(coords, { color: l.colour, weight: w, opacity,
                     dashArray: seg ? (seg.routed ? null : '2 8') : '6 6', ...stripe });
      // bridges & tunnels drawn over the plain track
      for (const p of parts) {
        const pc = p.c;
        if (p.mode === 'bridge') {
          draw(pc, { color: '#2b2b2b', weight: w + 7, opacity, lineCap: 'butt' });
          draw(pc, { color: '#fff', weight: w + 3, opacity, lineCap: 'butt' });
          draw(pc, { color: l.colour, weight: w, opacity, lineCap: 'butt' });
        } else if (p.mode === 'corridor') {   // dedicated track at ground level
          draw(pc, { color: '#fff', weight: 1.5, opacity, dashArray: '4 6', lineCap: 'butt' });
        } else if (p.mode === 'tunnel') {
          draw(pc, { color: '#fff', weight: w + 1, opacity: 1, lineCap: 'butt' });
          draw(pc, { color: l.colour, weight: w, opacity: 0.6, dashArray: '8 6', lineCap: 'butt' });
        }
      }
    }
    if (isActive) {
      for (const [k, pts] of Object.entries(l.via)) {
        pts.forEach((p, idx) => {
          const m = L.marker(p, { draggable: true,
            icon: L.divIcon({ className: '', html: '<div class="via-icon"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }) })
            .bindTooltip('Bend point — drag to steer, right-click to remove');
          m.on('dragstart', () => commit());
          m.on('dragend', () => { l.via[k][idx] = [m.getLatLng().lat, m.getLatLng().lng]; changed(); });
          m.on('contextmenu', () => {
            commit();
            // legs idx and idx+1 meet at this point: merge them
            const modes = legEntries(l, k, l.via[k].length + 1);
            const [m1, m2] = [modeOf(modes[idx]), modeOf(modes[idx + 1])];
            const merged = m1 === m2 ? m1 : 'road';          // merged leg gets an automatic curve
            modes.splice(idx, 2, merged);
            l.via[k].splice(idx, 1);
            if (!l.via[k].length) delete l.via[k];
            if (l.mode !== 'cablecar') setLegModes(l, k, modes);
            changed();
          });
          m.addTo(viaLayer);
        });
      }
      drawCurveHandles(l);
    }
  }
  drawPlatforms();
}

// Two draggable handles per curved stretch (own corridor / bridge / tunnel).
function drawCurveHandles(l) {
  const armStyle = { color: '#1d2327', weight: 1.5, dashArray: '3 4', opacity: 0.8, interactive: false };
  const r7 = x => +x.toFixed(7);
  for (let i = 0; i + 1 < l.stops.length; i++) {
    const k = pairKey(l.stops[i], l.stops[i + 1]);
    const seg = l.segs[k];
    for (const part of (seg && seg.parts) || []) {
      if (!part.c1) continue;
      const P0 = seg.coords[part.start], P3 = seg.coords[part.end];
      const arms = [L.polyline([P0, part.c1], armStyle).addTo(viaLayer),
                    L.polyline([P3, part.c2], armStyle).addTo(viaLayer)];
      const preview = L.polyline([], { color: l.colour, weight: 3, dashArray: '6 4', interactive: false }).addTo(viaLayer);
      const cur = { c1: part.c1, c2: part.c2 };
      const setEntry = value => {
        commit();
        const entries = legEntries(l, k, (l.via[k] || []).length + 1);
        entries[part.leg] = value;
        setLegModes(l, k, entries);
        changed();
      };
      [['c1', P0, 0], ['c2', P3, 1]].forEach(([key, anchorPt, ai]) => {
        const h = L.marker(cur[key], { draggable: true, zIndexOffset: 500,
          icon: L.divIcon({ className: '', html: '<div class="curve-handle"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }) })
          .bindTooltip('Curve handle — drag to shape the curve, right-click to reset');
        h.on('drag', () => {
          const ll = h.getLatLng();
          cur[key] = [ll.lat, ll.lng];
          arms[ai].setLatLngs([anchorPt, ll]);
          preview.setLatLngs(bezier(P0, cur.c1, cur.c2, P3));
        });
        h.on('dragend', () => setEntry({ mode: part.mode,
          h1: [r7(cur.c1[0] - P0[0]), r7(cur.c1[1] - P0[1])],
          h2: [r7(cur.c2[0] - P3[0]), r7(cur.c2[1] - P3[1])] }));
        h.on('contextmenu', () => setEntry(part.mode));   // back to the automatic curve
        h.addTo(viaLayer);
      });
    }
  }
}

// Street level: an island platform between the two tracks at every tram stop,
// so changing to another line (either direction) is a walk across the platform.
function drawPlatforms() {
  if (!twinTracks()) return;
  const px = m => m / metresPerPixel();
  const half = Math.max(2.5, px(1.75));
  // how many different lines use each piece of track (by stop pair)
  const fams = {};
  for (const l of state.lines) {
    if (l.hidden || l.mode === 'cablecar' || l.mode === 'depot') continue;
    for (let i = 0; i + 1 < l.stops.length; i++) {
      const k = [l.stops[i], l.stops[i + 1]].sort().join('>');
      (fams[k] = fams[k] || new Set()).add(familyOf(l));
    }
  }
  // per stop, line the platform up with its most-shared adjoining track
  const best = {};
  for (const l of state.lines) {
    if (l.hidden || l.mode === 'cablecar' || l.mode === 'depot') continue;
    for (let i = 0; i + 1 < l.stops.length; i++) {
      const a = l.stops[i], b = l.stops[i + 1];
      const seg = l.segs[pairKey(a, b)];
      if (!seg || seg.coords.length < 2) continue;
      const n = fams[[a, b].sort().join('>')].size;
      for (const [sid, c] of [[a, seg.coords], [b, seg.coords.slice().reverse()]]) {
        if (!best[sid] || n > best[sid].n) best[sid] = { n, c };
      }
    }
  }
  for (const [sid, { c }] of Object.entries(best)) {
    // ~35 m platform along the track, centred on the stop
    const s = state.stops[sid], p0 = [s.lat, s.lon];
    const d = dirOf(p0, pointAlong(c, 17.5));
    L.polyline([offsetPt(p0, d, -17.5), offsetPt(p0, d, 17.5)],
               { color: '#8a9096', weight: Math.max(3, 2 * half - 3.5), opacity: 0.9,
                 lineCap: 'butt', interactive: false }).addTo(trackLayer);
  }
}

function renderStops() {
  stopLayer.clearLayers();
  const active = activeLine();
  for (const s of Object.values(state.stops)) {
    const serving = linesServing(s.id).filter(l => !l.hidden);
    if (!serving.length) continue;
    const revenue = serving.filter(l => l.mode !== 'depot');
    const isDepot = !revenue.length;
    const inter = new Set(revenue.map(familyOf)).size > 1;
    const colour = isDepot ? '#5f6368' : inter ? '#1d2327' : revenue[0].colour;
    const m = L.marker([s.lat, s.lon], {
      draggable: true, riseOnHover: true,
      icon: L.divIcon({ className: '', iconSize: isDepot ? [20, 20] : inter ? [18, 18] : [14, 14],
        iconAnchor: isDepot ? [10, 10] : inter ? [9, 9] : [7, 7],
        html: isDepot ? '<div class="depot-icon">D</div>'
                      : `<div class="stop-icon${inter ? ' interchange' : ''}" style="border-color:${colour}"></div>` }),
      opacity: active && !serving.includes(active) ? 0.7 : 1,
    });
    m.bindTooltip(escapeHtml(s.name), { permanent: true, direction: 'right', offset: [8, 0], className: 'stop-label' });
    m.on('click', e => onStopClick(s, e));
    m.on('contextmenu', () => openStopPopup(s, m));
    m.on('dragstart', () => commit());
    m.on('dragend', async () => {
      const ll = m.getLatLng();
      s.lat = ll.lat; s.lon = ll.lng;
      await snapStop(s, false);
      changed();
    });
    m.addTo(stopLayer);
  }
}

function renderSidebar() {
  const ul = $('#lines');
  ul.innerHTML = '';
  if (!state.lines.length) ul.innerHTML = '<li class="empty">No lines yet — click “+ New line”.</li>';
  const ordered = [];
  for (const l of state.lines) if (!parentOf(l)) ordered.push(l, ...state.lines.filter(b => parentOf(b) === l));
  for (const l of ordered) {
    const parent = parentOf(l);
    const li = document.createElement('li');
    li.className = (l.id === activeId ? 'active ' : '') + (l.hidden ? 'hidden-line ' : '') + (parent ? 'branch' : '');
    const len = lineLength(l);
    const struct = structureLength(l);
    const extras = ['mall', 'corridor', 'bridge', 'tunnel'].filter(m => struct[m])
      .map(m => ` · ${fmtKm(struct[m])} ${MODE_LABEL[m]}`).join('');
    li.innerHTML = `
      ${parent ? '<span class="branch-mark" title="Branch — uses the main line\'s colour">↳</span>'
               : `<input type="color" value="${l.colour}" title="Line colour">`}
      <input class="name" value="${escapeHtml(l.name)}" title="Rename line">
      <span class="tools">
        <select class="mode" title="Line type">
          <option value="tram"${!parent && l.mode !== 'cablecar' ? ' selected' : ''}>Tram</option>
          <option value="cablecar"${l.mode === 'cablecar' ? ' selected' : ''}>Cable car</option>
          <option value="depot"${l.mode === 'depot' ? ' selected' : ''}>Depot track</option>
          ${state.lines.filter(x => x !== l && !x.branchOf && !state.lines.some(b => b.branchOf === l.id)).map(x =>
            `<option value="branch:${x.id}"${parent === x ? ' selected' : ''}>Branch of ${escapeHtml(x.name)}</option>`).join('')}
        </select>
        <button class="icon vis" title="${l.hidden ? 'Show' : 'Hide'}">${l.hidden ? '◌' : '●'}</button>
        <button class="icon del" title="Delete line">✕</button>
      </span>
      <span class="stats">${l.stops.length} ${l.mode === 'cablecar' ? 'stations' : 'stops'} · ${fmtKm(len)} · ~${fmtMin(len, l.mode)} end to end${extras}</span>`;
    li.addEventListener('click', e => {
      if (e.target.closest('input, button, select')) return;
      selectLine(l.id === activeId ? null : l.id);
    });
    const colour = li.querySelector('input[type=color]');
    if (colour) {
      colour.addEventListener('focus', () => commit());
      colour.addEventListener('input', () => { l.colour = colour.value; syncBranches(); renderTrack(); renderStops(); });
      colour.addEventListener('change', () => changed());
    }
    const name = li.querySelector('.name');
    name.addEventListener('focus', () => selectLine(l.id, false));
    name.addEventListener('change', () => { commit(); l.name = name.value.trim() || l.name; changed(); });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });
    li.querySelector('.mode').addEventListener('change', e => {
      commit();
      const v = e.target.value;
      if (v.startsWith('branch:')) l.branchOf = v.slice(7);
      else { delete l.branchOf; l.mode = v; }
      changed();
    });
    li.querySelector('.vis').addEventListener('click', () => { commit(); l.hidden = !l.hidden; changed(); });
    li.querySelector('.del').addEventListener('click', () => {
      if (!confirm(`Delete ${l.name}?`)) return;
      commit();
      state.lines = state.lines.filter(x => x !== l);
      for (const b of state.lines) if (b.branchOf === l.id) delete b.branchOf;   // its branches become lines
      if (activeId === l.id) activeId = null;
      changed();
    });
    ul.appendChild(li);
  }

  const active = activeLine();
  $('#stops-section').hidden = !active;
  $('#map').classList.toggle('adding', !!active);
  if (active) {
    $('#stops-title').textContent = `${active.name} — stops`;
    const ol = $('#stops');
    ol.innerHTML = '';
    let km = 0;
    active.stops.forEach((id, i) => {
      if (i > 0) {
        const seg = active.segs[pairKey(active.stops[i - 1], id)];
        km += seg ? seg.length_m : 0;
      }
      const s = state.stops[id];
      const li = document.createElement('li');
      li.innerHTML = `${escapeHtml(s.name)}<span class="km">${(km / 1000).toFixed(1)}</span>`;
      li.addEventListener('click', () => map.panTo([s.lat, s.lon]));
      ol.appendChild(li);
    });
    if (!active.stops.length) ol.innerHTML = '<li class="empty">Click the map to add the first stop.</li>';
  }

  const revenueLines = state.lines.filter(l => l.mode !== 'depot');
  const total = revenueLines.reduce((m, l) => m + lineLength(l), 0);
  const nStops = new Set(revenueLines.flatMap(l => l.stops)).size;
  $('#totals').textContent = state.lines.length
    ? `Network: ${new Set(revenueLines.map(familyOf)).size} lines · ${nStops} stops · ${fmtKm(total)} of line`
    : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- interaction
function selectLine(id, rerender = true) {
  activeId = id;
  if (rerender) render(); else { renderTrack(); renderStops(); }
}

function newLine() {
  commit();
  const used = new Set(state.lines.map(l => l.colour.toUpperCase()));
  const colour = PALETTE.find(c => !used.has(c)) || PALETTE[state.lines.length % PALETTE.length];
  const line = { id: uid('l'), name: `Line ${state.lines.length + 1}`, colour,
                 hidden: false, mode: 'tram', stops: [], via: {}, structures: {}, segs: {} };
  state.lines.push(line);
  activeId = line.id;
  changed();
  const inputs = document.querySelectorAll('#lines .name');
  const inp = inputs[inputs.length - 1];
  inp.focus(); inp.select();
}

function addStopToLine(line, stopId, smartInsert) {
  const st = line.stops;
  if (!smartInsert || st.length < 2) {
    if (st[st.length - 1] === stopId) return false;
    st.push(stopId);
    return true;
  }
  // insert where it adds the least straight-line distance (incl. both ends)
  const P = id => [state.stops[id].lat, state.stops[id].lon];
  const p = P(stopId);
  let best = st.length, bestCost = haversine(P(st[st.length - 1]), p);
  const startCost = haversine(p, P(st[0]));
  if (startCost < bestCost) { best = 0; bestCost = startCost; }
  for (let i = 0; i + 1 < st.length; i++) {
    const c = haversine(P(st[i]), p) + haversine(p, P(st[i + 1])) - haversine(P(st[i]), P(st[i + 1]));
    if (c < bestCost) { best = i + 1; bestCost = c; }
  }
  if (st[best - 1] === stopId || st[best] === stopId) return false;
  st.splice(best, 0, stopId);
  return true;
}

const TRACK_CLICK_PX = 25;      // clicks this close to the selected line count as "on the track"

// Which segment of `line` is within `px` screen pixels of latlng (nearest), if any.
function nearTrackSeg(line, latlng, px) {
  const pt = map.latLngToContainerPoint(latlng);
  let best = null;
  for (let i = 0; i + 1 < line.stops.length; i++) {
    const a = line.stops[i], b = line.stops[i + 1];
    const seg = line.segs[pairKey(a, b)];
    const coords = seg ? seg.coords : segPoints(line, a, b);
    let prev = null;
    for (const c of coords) {
      const q = map.latLngToContainerPoint(c);
      if (prev) {
        const d = L.LineUtil.pointToSegmentDistance(pt, prev, q);
        if (d < px && (!best || d < best.d)) best = { a, b, d };
      }
      prev = q;
    }
  }
  return best;
}

// Insert a new stop exactly on the track between stops a and b, where clicked.
async function insertStopOnTrack(line, a, b, latlng) {
  commit();
  const k = pairKey(a, b);
  const seg = line.segs[k];
  const click = [latlng.lat, latlng.lng];
  const q = seg ? projectOnto(seg.coords, click).q : click;
  const s = { id: uid('s'), name: `Stop ${Object.keys(state.stops).length + 1}`, lat: q[0], lon: q[1] };
  state.stops[s.id] = s;
  // split this segment's bend points and stretch types at the new stop
  const ends = segPoints(line, a, b);
  const entries = legEntries(line, k, ends.length - 1);
  const leg = nearestLeg(ends, q);
  const via = line.via[k] || [];
  const m = modeOf(entries[leg]);
  delete line.via[k];
  if (line.structures) delete line.structures[k];
  if (via.slice(0, leg).length) line.via[pairKey(a, s.id)] = via.slice(0, leg);
  if (via.slice(leg).length) line.via[pairKey(s.id, b)] = via.slice(leg);
  if (line.mode !== 'cablecar') {
    setLegModes(line, pairKey(a, s.id), [...entries.slice(0, leg), m]);
    setLegModes(line, pairKey(s.id, b), [m, ...entries.slice(leg + 1)]);
  }
  const i = line.stops.findIndex((id, j) => id === a && line.stops[j + 1] === b);
  line.stops.splice(i + 1, 0, s.id);
  await snapStop(s, true, false);              // name it after the street; stay on the track
  changed();
  setStatus(`Added stop "${s.name}" — right-click it to rename.`);
}

function nearestStopPx(latlng) {
  const pt = map.latLngToContainerPoint(latlng);
  let best = null, bestD = SNAP_PX;
  for (const s of Object.values(state.stops)) {
    const d = pt.distanceTo(map.latLngToContainerPoint([s.lat, s.lon]));
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

map.on('click', async e => {
  const line = activeLine();
  if (!line) return;
  const existing = nearestStopPx(e.latlng);
  if (existing) return onStopClick(existing, e);
  // Click on/near this line's track: insert a stop there (Ctrl-click: bend point).
  const near = nearTrackSeg(line, e.latlng, TRACK_CLICK_PX);
  if (near) {
    if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) return addBendPoint(line, near.a, near.b, e.latlng);
    return insertStopOnTrack(line, near.a, near.b, e.latlng);
  }
  commit();
  const s = { id: uid('s'), name: `Stop ${Object.keys(state.stops).length + 1}`,
              lat: e.latlng.lat, lon: e.latlng.lng };
  state.stops[s.id] = s;
  addStopToLine(line, s.id, e.originalEvent.shiftKey);
  // Inserted between two stops? Put it exactly on the track already there.
  const idx = line.stops.indexOf(s.id);
  const old = idx > 0 && idx < line.stops.length - 1 &&
              line.segs[pairKey(line.stops[idx - 1], line.stops[idx + 1])];
  const on = old && projectOnto(old.coords, [s.lat, s.lon]);
  if (on && on.d < 150) {
    s.lat = on.q[0]; s.lon = on.q[1];
    await snapStop(s, true, false);
  } else {
    await snapStop(s, true);
  }
  changed();
});

// Put a stop on the kerb of the nearest (preferably main) road, so the tram
// stops on the line itself. Optionally name it after that road.
async function snapStop(s, rename, move = true) {
  // cable car stations can go anywhere (hilltops, parks), so only trams snap
  const cableOnly = !state.lines.some(l => l.mode === 'tram' && l.stops.includes(s.id));   // cable/depot: place freely
  if (cableOnly && !rename) return;
  try {
    const r = await (await fetch(`/api/snap?lat=${s.lat}&lon=${s.lon}`)).json();
    if (move && r.snapped && !cableOnly) { s.lat = r.lat; s.lon = r.lon; }
    if (rename && r.name && /^Stop \d+$/.test(s.name)) s.name = r.name;
  } catch (err) { /* server unreachable: leave as placed */ }
}

function onStopClick(s, e) {
  const line = activeLine();
  if (!line) { openStopPopup(s); return; }
  commit();
  if (addStopToLine(line, s.id, e.originalEvent && e.originalEvent.shiftKey)) changed();
  else undoStack.pop();
}

function onTrackClick(line, a, b, e) {
  if (line.id !== activeId) { selectLine(line.id); return; }
  if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) return addBendPoint(line, a, b, e.latlng);
  return insertStopOnTrack(line, a, b, e.latlng);
}

// add a bend point into segment a>b, ordered along the current route
function addBendPoint(line, a, b, latlng) {
  const e = { latlng };
  commit();
  const k = pairKey(a, b);
  const ends = segPoints(line, a, b);
  const modes = legEntries(line, k, ends.length - 1);
  const pts = line.via[k] = line.via[k] || [];
  const p = [e.latlng.lat, e.latlng.lng];
  const best = nearestLeg(ends, p);
  pts.splice(best, 0, p);
  const m = modeOf(modes[best]);              // both halves keep the type, automatic curves
  modes.splice(best, 1, m, m);
  if (line.mode !== 'cablecar') setLegModes(line, k, modes);
  changed();
}

// Right-click on track: choose road / bridge / tunnel for that stretch.
function openTrackPopup(line, a, b, latlng) {
  const k = pairKey(a, b);
  const pts = segPoints(line, a, b);
  const leg = nearestLeg(pts, [latlng.lat, latlng.lng]);
  const modes = legEntries(line, k, pts.length - 1);
  const div = document.createElement('div');
  div.className = 'stop-popup';
  const from = leg === 0 ? state.stops[a].name : `bend point ${leg}`;
  const to = leg === pts.length - 2 ? state.stops[b].name : `bend point ${leg + 1}`;
  if (line.mode === 'cablecar') {
    div.innerHTML = `<b>${escapeHtml(line.name)}</b><div class="lines">Cable car span — runs straight between stations and bend points (towers).</div>`;
  } else {
    div.innerHTML = `
      <b>${escapeHtml(line.name)}</b>
      <div class="lines">Stretch from ${escapeHtml(from)} to ${escapeHtml(to)}</div>
      <div class="row">${Object.entries(MODES).map(([m, label]) =>
        `<button data-mode="${m}" class="${modeOf(modes[leg]) === m ? 'primary' : ''}">${label}</button>`).join('')}</div>
      <div class="lines" style="margin-top:8px">Own corridor, bridges and tunnels are smooth curves (e.g. through a park). Ctrl-click the track to add bend points where they should start and end.</div>`;
    div.querySelectorAll('button[data-mode]').forEach(btn => btn.addEventListener('click', () => {
      commit();
      if (modeOf(modes[leg]) === btn.dataset.mode) { undoStack.pop(); map.closePopup(); return; }
      modes[leg] = btn.dataset.mode;
      setLegModes(line, k, modes);
      map.closePopup();
      changed();
    }));
  }
  L.popup().setLatLng(latlng).setContent(div).openOn(map);
}

function openStopPopup(s, marker) {
  const serving = linesServing(s.id);
  const active = activeLine();
  const div = document.createElement('div');
  div.className = 'stop-popup';
  div.innerHTML = `
    <b>Stop name</b>
    <input value="${escapeHtml(s.name)}">
    <div class="lines">Served by: ${serving.map(l => `<span style="color:${l.colour}">■</span> ${escapeHtml(l.name)}`).join(', ') || '—'}</div>
    <div class="row">
      ${active && serving.includes(active) ? `<button class="rm">Remove from ${escapeHtml(active.name)}</button>` : ''}
      <button class="del">Delete stop</button>
    </div>`;
  const inp = div.querySelector('input');
  const popup = L.popup({ offset: [0, -6] }).setLatLng([s.lat, s.lon]).setContent(div).openOn(map);
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  const rename = () => {
    const v = inp.value.trim();
    if (v && v !== s.name) { commit(); s.name = v; changed(); }
  };
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { rename(); map.closePopup(popup); } });
  inp.addEventListener('change', rename);
  const rm = div.querySelector('.rm');
  if (rm) rm.addEventListener('click', () => {
    commit();
    active.stops = dedupe(active.stops.filter(id => id !== s.id));
    map.closePopup(popup);
    changed();
  });
  div.querySelector('.del').addEventListener('click', () => {
    commit();
    for (const l of state.lines) l.stops = dedupe(l.stops.filter(id => id !== s.id));
    delete state.stops[s.id];
    map.closePopup(popup);
    changed();
  });
}

const dedupe = arr => arr.filter((id, i) => id !== arr[i - 1]);

$('#new-line').addEventListener('click', newLine);
$('#remove-last').addEventListener('click', () => {
  const l = activeLine();
  if (!l || !l.stops.length) return;
  commit(); l.stops.pop(); changed();
});
$('#reverse-line').addEventListener('click', () => {
  const l = activeLine();
  if (!l || l.stops.length < 2) return;
  commit();
  l.stops.reverse();
  const via = {};
  for (const [k, pts] of Object.entries(l.via)) {
    const [a, b] = k.split('>');
    via[pairKey(b, a)] = pts.slice().reverse();
  }
  l.via = via;
  const structures = {};
  for (const [k, m] of Object.entries(l.structures || {})) {
    const [a, b] = k.split('>');
    structures[pairKey(b, a)] = m.slice().reverse()
      .map(e => typeof e === 'string' ? e : { mode: e.mode, h1: e.h2, h2: e.h1 });
  }
  l.structures = structures;
  const segs = {};
  for (const [k, s] of Object.entries(l.segs)) {   // reuse plain road geometry, just flipped
    if (s.parts && s.parts.length) continue;         // curved stretches get rebuilt
    const [a, b] = k.split('>');
    const n = s.coords.length - 1;
    segs[pairKey(b, a)] = { ...s, sig: segSig(l, b, a), coords: s.coords.slice().reverse(),
      parts: [] };
  }
  l.segs = segs;
  changed();
});
// ---- text size (remembered in this browser)
const TEXT_SCALES = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];
let textScale = 1;
try { textScale = +localStorage.getItem('textScale') || 1; } catch (e) { /* private mode */ }
// Scale a MapLibre text-size value (number, zoom curve, or expression).
function scaledSize(v, k) {
  if (typeof v === 'number') return +(v * k).toFixed(2);
  if (Array.isArray(v) && /^interpolate/.test(v[0])) return v.map((x, i) => i >= 4 && i % 2 === 0 ? scaledSize(x, k) : x);
  if (Array.isArray(v) && v[0] === 'step') return v.map((x, i) => i >= 2 && i % 2 === 0 ? scaledSize(x, k) : x);
  if (v && v.stops) return { ...v, stops: v.stops.map(([z, s]) => [z, s * k]) };
  if (Array.isArray(v)) return ['*', k, v];
  return v;
}
const baseTextSizes = {};
function applyMapText() {
  const gl = vectorBase.getMaplibreMap && vectorBase.getMaplibreMap();
  if (!gl || !gl.isStyleLoaded()) return;
  for (const layer of gl.getStyle().layers) {
    const ts = layer.layout && layer.layout['text-size'];
    if (ts === undefined) continue;
    if (!(layer.id in baseTextSizes)) baseTextSizes[layer.id] = ts;
    gl.setLayoutProperty(layer.id, 'text-size', scaledSize(baseTextSizes[layer.id], textScale));
  }
}
vectorBase.on('add', () => {
  const gl = vectorBase.getMaplibreMap();
  if (gl.isStyleLoaded()) applyMapText(); else gl.once('load', applyMapText);
});
if (map.hasLayer(vectorBase)) vectorBase.fire('add');   // it was added before this listener
function applyTextScale() {
  document.documentElement.style.setProperty('--text-scale', textScale);
  applyMapText();
  $('#text-smaller').disabled = textScale <= TEXT_SCALES[0];
  $('#text-bigger').disabled = textScale >= TEXT_SCALES[TEXT_SCALES.length - 1];
  try { localStorage.setItem('textScale', textScale); } catch (e) { /* ignore */ }
}
function stepText(dir) {
  const i = TEXT_SCALES.findIndex(x => x >= textScale - 1e-9);
  textScale = TEXT_SCALES[Math.max(0, Math.min(TEXT_SCALES.length - 1, (i < 0 ? 1 : i) + dir))];
  applyTextScale();
}
$('#text-smaller').addEventListener('click', () => stepText(-1));
$('#text-bigger').addEventListener('click', () => stepText(1));
applyTextScale();

$('#striped-shared').checked = stripedShared;
$('#striped-shared').addEventListener('change', e => {
  stripedShared = e.target.checked;
  try { localStorage.setItem('stripedShared', stripedShared ? '1' : '0'); } catch (err) { /* ignore */ }
  renderTrack();
});
$('#show-labels').addEventListener('change', e => $('#map').classList.toggle('hide-labels', !e.target.checked));

document.addEventListener('keydown', e => {
  if (e.target.matches('input')) return;
  if (e.key === 'Escape') { map.closePopup(); selectLine(null); }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
});

// handle for the browser console / automated tests
window.app = { map, L, undo, redo, stopLayer, vectorBase, get state() { return state; } };

// Region name and map area (from <region>/region.json)
fetch('/api/region').then(r => r.json()).then(region => {
  const title = region.title || region.name;
  if (title) { $('#region-title').textContent = title; document.title = `${title} · tram-sketch`; }
  if (region.bbox && !Object.keys(state.stops).length) {
    const [s, w, n, e] = region.bbox;
    map.fitBounds([[s, w], [n, e]]);
  }
}).catch(() => {});

loadNetwork(true).catch(() => setStatus('⚠ Could not reach the server'));
