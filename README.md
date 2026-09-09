# World Sim

A pannable, zoomable world map where any street-level location fills with a
simulated living scene: hundreds of pedestrians and a hundred-plus cars moving
along the **real road network**, clickable for a detail panel and a drawn trip
path.

No backend, no API keys, everything simulated client-side.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## How it works

**Basemap** — MapLibre GL JS against [OpenFreeMap](https://openfreemap.org)'s
Liberty style (OpenMapTiles vector tiles, free, no key). If that host is
unreachable the app falls back to raster OSM tiles automatically.

**Agents ride the real streets.** MapLibre has already downloaded and parsed
road geometry to draw the map, so the simulation harvests it with
`querySourceFeatures` rather than shipping its own road data. Two wrinkles make
this work in practice, both handled in `src/sim/roads.ts`:

- Vector tiles ship *merged* linestrings that run straight through junctions, so
  adjacency from feature endpoints alone gives an almost totally disconnected
  graph. Every line is therefore split at vertices it shares with another line,
  which recovers a real edge/node graph.
- Tiles clip geometry at their buffered edge, so streets stop mid-block at tile
  seams. Routes that hit a dead end snap to another node within 14 m and carry
  on.

Where there is no road data (zoomed out, raster fallback, tiles still loading)
agents fall back to procedural wander paths inside their cell.

**Chunked spawning.** The world is divided into a z17 tile grid (~300 m cells).
Each cell is seeded deterministically from its tile coordinates, so revisiting an
area regenerates the same population. Cells spawn as they enter the viewport plus
a 30% buffer and are dropped once well outside it.

**Coordinates.** All simulation state lives in normalized Web Mercator (x, y in
[0,1]) — zoom-independent, so agents never need re-deriving on zoom. Each frame
the mercator→pixel affine transform is derived by projecting two reference points
through MapLibre's own `project()`, rather than reimplementing its camera maths.
That is what keeps agents pinned to the ground with no drift through pan, zoom
and flyTo. (Map rotation and pitch are disabled; the transform assumes north-up.)

**Search** uses Nominatim with a 450 ms debounce, a 3-character minimum, and
abort-on-retype, per its usage policy. Selecting a result flies to it at street
zoom so the simulation populates on arrival.

### Layout

```
src/sim/     rng, geo/mercator maths, road graph, agent model, World
src/render/  Engine — canvas overlay, animation loop, map sync, hit-testing
src/components/  SearchBar, DetailPanel, Hud
```

## Performance

Three clocks run at different rates on purpose:

| work | rate |
| --- | --- |
| render + position integration | every animation frame |
| cell spawn / despawn / culling | 4 Hz |
| road-network extraction | on map idle (and retried while missing) |

Rendering is plain Canvas 2D with **one batched path per colour** — every agent
of a given colour is appended as a subpath and filled in a single call, so draw
calls stay in the low tens no matter how many agents are on screen. A dark
silhouette pass underneath keeps them legible over busy tiles. Agents outside the
viewport (plus a 40 px margin) are skipped entirely.

Measured in Chrome at 1280×720, Shibuya at z16.2:

- **Shipped density:** ~570 people + ~180 cars visible, ~1,450 simulated,
  **45–60 fps** including MapLibre's own WebGL render.
- **Overlay cost alone:** 0.61 ms/frame at 1,050 agents; **1.9 ms/frame at 3,008
  simulated / 1,118 visible** — roughly 0.6 µs per agent, scaling linearly.

The overlay is not the bottleneck; MapLibre's basemap render is. The agent layer
has room for several times the shipped density.

## Attribution

Basemap © OpenFreeMap, data © OpenStreetMap contributors, search by Nominatim.
Shown in-app via MapLibre's attribution control.
