# tram-sketch

Sketch a light rail network for your city, town, or region on real streets. Click to place stops and tram-sketch routes the track along OpenStreetMap roads, straight through roundabouts and down the median of divided roads. Runs locally with just Python and a browser.

**tram-sketch** is a simple tool for designing tram and light rail networks on real streets.

Pick a line colour, click where the stops go, and it routes the track along OpenStreetMap roads, the way a tram would actually run: straight through roundabouts, down the median of divided roads, with smooth curves. It also handles bridges, tunnels, pedestrian transit malls, branches, balloon loops and depots, and at street level it shows the double track.

Your network is saved as a plain GeoJSON file you can share, version and compare. No accounts, no API keys: just Python 3 and a web browser.

It started as a community proposal for light rail on the Central Coast, NSW, Australia, which is included as an example in [`regions/central-coast-nsw`](regions/central-coast-nsw). Use it to sketch a better future for your own city/town/region.

## Quick start

You need Python 3.8+ (no packages to install) and a web browser.

```sh
git clone https://github.com/starseed-projects/tram-sketch.git
cd tram-sketch

# one-off: download the region's roads from OpenStreetMap (~1–3 minutes)
python3 tools/fetch_osm.py regions/central-coast-nsw

# start the designer, then open http://localhost:8000
python3 server/app.py regions/central-coast-nsw
```

## Sketch your own city

```sh
# create a region: a name and a map area (south, west, north, east in degrees)
python3 tools/fetch_osm.py regions/my-city --name "My City" --bbox -33.95,151.10,-33.80,151.30

python3 server/app.py regions/my-city
```

Find the bounding box by zooming to your area on [openstreetmap.org](https://www.openstreetmap.org) and using **Export → Manually select a different area**. Keep it to a city or region (roughly 50 × 50 km).

## Using the designer

- **+ New line**, then click the map to add stops to the end of the line.
- Click **on or near the selected line's track** to insert a stop there.
- Click an **existing stop** to add it to the selected line (an interchange).
- **Drag** stops to move them; the track re-routes automatically.
- **Ctrl-click** the track to add a bend point and drag it to steer the route.
- **Right-click the track** to make a stretch a **transit mall** (no cars), **own corridor**, **bridge** or **tunnel**. Off-road stretches are curves you can shape with handles.
- Line types: **Tram**, **Cable car**, **Depot track**, or **Branch of** another line.
- End a line at the stop where it started to make a **ring**. Trams run both ways around it.
- Make a line visit the same stop twice mid-route to create a **balloon loop**. Loop sections run one way, on the left-hand track.
- Zoom in to street level to see the **double track** and **island platforms**. Lines that share track run on the same double track, shown with striped rails.
- **Map text** buttons enlarge street names and stop labels.
- `Ctrl+Z` / `Ctrl+Y` undo and redo; `Esc` deselects.

Everything saves automatically to `regions/<region>/network.geojson`. It's readable JSON, so you can also edit it by hand (or have an assistant do it). The open map reloads when the file changes.

## How routing works

`server/graph.py` builds a road graph from OpenStreetMap and finds tram-friendly routes:

- main roads are preferred, residential streets avoided, motorways excluded, and old rail corridors favoured; active heavy-rail track is a last resort
- trams go straight across roundabouts and traffic islands
- on divided roads the track runs down the median, and stops sit on it (island platforms)
- routes are smoothed to tram-like curves (about 25 m radius) and stops snap onto the road

Tune the weights in `HIGHWAY_COST` and `RAILWAY_COST` to taste. Run times assume an average of 22 km/h including stops.

## Repository layout

```
server/              local web server (save + routing API)
web/                 the map app (Leaflet + MapLibre)
tools/fetch_osm.py   downloads OpenStreetMap data for a region
regions/<region>/
    region.json      name and map area
    network.geojson  the design
    README.md        what the proposal is and why
    data/            downloaded map data (not committed)
```

## Share your design

Proposals for any city are welcome. Add a folder under `regions/` with your `region.json`, `network.geojson` and a short `README.md` explaining the idea, then open a pull request.

## Licences

- **Code:** GNU General Public License v3.0. See [LICENSE](LICENSE).
- **Region designs** (`regions/*/network.geojson`) are routed on OpenStreetMap data and are shared under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/), © OpenStreetMap contributors.

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright). Base map by [OpenFreeMap](https://openfreemap.org) / OpenMapTiles. Built with [Leaflet](https://leafletjs.com) and [MapLibre GL](https://maplibre.org).
