# Central Coast Light Rail

A community proposal for a 21st-century light rail network on the Central Coast of New South Wales, Australia.

The Central Coast is a string of towns around lakes, bays and beaches, joined today mostly by car. This proposal links them with three interlocking light rail **rings**. Trams run both ways around each ring. Where rings meet they share track, with island platforms so changing to the next ring, in either direction, is a walk across the platform.

- 🔴 **Central Ring** (51 km): Gosford Waterfront, a pedestrianised **Mann Street transit mall**, Five Ways, North Gosford, Niagara Park, Lisarow, Ourimbah, **Tuggerah**, Berkeley Vale, Tumbi Umbi, Killarney, **The Entrance**, Long Jetty, Bateau Bay, Wamberal, **Erina Fair**, East Gosford, **Point Frederick**.
- 🟢 **Northern Ring** (43 km): **Tuggerah**, Wyong, Watanobbi, Toukley, Wilfred Barrett Drive, **The Entrance**, then back to Tuggerah on track shared with the Central Ring.
- 🔵 **Southern Ring** (48 km): **Gosford Waterfront**, **Point Frederick**, Wells Street, **Erina Fair**, Terrigal Beach, the Scenic Highway, Kincumber, Empire Bay, the Rip Bridge, Ettalong Beach, Umina Beach, Woy Woy, Brisbane Water Drive (Koolewong, Tascott and Point Clare stations), West Gosford, and over the bridge beside the stadium back to the waterfront. A short branch serves Gosford Station and Gosford Hospital.
- **Depot:** West Gosford industrial area (placeholder).

Interchanges (shared track, island platforms) are in **bold**.

## Run it

```sh
python3 tools/fetch_osm.py regions/central-coast-nsw
python3 server/app.py regions/central-coast-nsw
```

Then open http://localhost:8000.

Design shared under the ODbL, © OpenStreetMap contributors.
