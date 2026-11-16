# Central Coast Light Rail

A community proposal for a 21st-century light rail network on the Central Coast of New South Wales, Australia.

The Central Coast is a string of towns around lakes, bays and beaches, joined today mostly by car. This proposal links them with frequent light rail:

- **Line 1:** The Entrance, Long Jetty, Bateau Bay, Wamberal, Erina Fair and East Gosford, then through a pedestrianised **Mann Street transit mall** in central Gosford, and north via North Gosford, Lisarow and Ourimbah to Tuggerah and Wyong.
- **Woy Woy – Terrigal:** a **balloon loop** around the Woy Woy peninsula (Woy Woy, Ettalong Beach, Umina Beach), along Brisbane Water Drive with stops at Point Clare, Tascott and Koolewong stations, over the bridge beside the stadium to the Gosford waterfront, then via Wells Street and Erina Fair to **Terrigal Beach**. A short branch serves Gosford Station and Gosford Hospital.
- **Ettalong – Terrigal via Empire Bay** (proposal): over the Rip Bridge and along Empire Bay Drive to Kincumber and the Scenic Highway, closing a southern ring.
- **Depot:** West Gosford industrial area (placeholder).

Work in progress: the next step is reorganising the network into three interlocking rings (southern, central and northern), each run in both directions.

## Run it

```sh
python3 tools/fetch_osm.py regions/central-coast-nsw
python3 server/app.py regions/central-coast-nsw
```

Then open http://localhost:8000.

Design shared under the ODbL, © OpenStreetMap contributors.
