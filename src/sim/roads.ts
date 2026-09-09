import { lngLatToMerc, mercPerMeter } from './geo';
import type { Rng } from './rng';
import type { Path } from './types';

/**
 * Road network extracted from the basemap's vector tiles.
 *
 * MapLibre already downloads OpenMapTiles `transportation` geometry to draw the
 * map, so we harvest it with `querySourceFeatures` instead of shipping our own
 * road data. Endpoints are snapped to a ~1.2 m lattice to recover an adjacency
 * graph, which lets agents drive through junctions along real streets. When no
 * vector data is available (zoomed out, raster fallback, tiles still loading)
 * the world falls back to procedural paths.
 */

export type RoadClass = 'major' | 'street' | 'service' | 'foot';

/** A generated route plus the graph state needed to continue it later. */
export interface RouteResult {
  path: Path;
  lastEdge: number;
  exitNode: number;
  cls: RoadClass;
}

/** Node quantisation: 2^25 subdivisions of the mercator world ~= 1.2 m. */
const NODE_GRID = 1 << 25;

/** Upper bound on graph hops per route, a guard against pathological graphs. */
const MAX_ROUTE_HOPS = 600;

/**
 * Vector tiles clip road geometry at their buffered edge, so a street that
 * continues into the next tile simply stops. Rather than let every trip dead-end
 * at a tile seam, routes may hop to another node within this many metres.
 */
const SNAP_RADIUS_M = 14;
/** Bucket size for the dead-end lookup grid: 2^21 of the world, ~19 m. */
const SNAP_GRID = 1 << 21;

export interface RoadEdge {
  cls: RoadClass;
  /** Interleaved x,y in normalized mercator. */
  pts: Float64Array;
  /** Length in mercator units. */
  len: number;
  aNode: number;
  bNode: number;
  midX: number;
  midY: number;
  name: string | null;
}

function classify(cls: unknown, subclass: unknown): RoadClass | null {
  switch (cls) {
    case 'motorway':
    case 'trunk':
    case 'primary':
      return 'major';
    case 'secondary':
    case 'tertiary':
    case 'minor':
    case 'street':
      return 'street';
    case 'service':
    case 'track':
      return 'service';
    case 'path':
    case 'pedestrian':
      // steps make for teleport-looking movement; skip them.
      return subclass === 'steps' ? null : 'foot';
    default:
      return null;
  }
}

function nodeKey(x: number, y: number): number {
  const qx = Math.round(x * NODE_GRID);
  const qy = Math.round(y * NODE_GRID);
  return qx * NODE_GRID + qy;
}

function snapBucket(x: number, y: number): number {
  return Math.floor(x * SNAP_GRID) * SNAP_GRID + Math.floor(y * SNAP_GRID);
}

/** Typical free-flow speed per class, in m/s. */
export function classSpeed(cls: RoadClass): [number, number] {
  switch (cls) {
    case 'major':
      return [18, 31];
    case 'street':
      return [9, 15];
    case 'service':
      return [4, 8];
    case 'foot':
      return [1.0, 1.7];
  }
}

export class RoadNetwork {
  edges: RoadEdge[] = [];
  /** node key -> indices into `edges`. */
  private nodeEdges = new Map<number, number[]>();
  /** node key -> its mercator position, for dead-end snapping. */
  private nodePos = new Map<number, [number, number]>();
  /** coarse spatial bucket -> node keys, for dead-end snapping. */
  private snapGrid = new Map<number, number[]>();
  /** cell key -> drivable edge indices whose midpoint falls in that cell. */
  driveByCell = new Map<string, number[]>();
  /** cell key -> walkable edge indices (footways plus quiet streets). */
  walkByCell = new Map<string, number[]>();

  get size(): number {
    return this.edges.length;
  }

  /**
   * Rebuild from raw GeoJSON line features.
   *
   * Vector tiles ship *merged* linestrings — a single feature can run through
   * many junctions — so adjacency taken from feature endpoints alone yields an
   * almost totally disconnected graph, and agents get 50 m trips. We therefore
   * do two passes: count how many times each quantised vertex appears across
   * all lines, then split every line at the vertices it shares with another.
   * The result is a proper edge/node graph that routes through junctions.
   *
   * @param cellKeyOf maps a mercator point to the owning cell key.
   */
  static build(
    features: GeoJSON.Feature[],
    cellKeyOf: (x: number, y: number) => string,
    maxEdges: number,
  ): RoadNetwork {
    const net = new RoadNetwork();
    const seen = new Set<string>();
    const lines: Array<{ cls: RoadClass; name: string | null; xs: Float64Array }> = [];
    const vertexCount = new Map<number, number>();

    // --- pass 1: project, de-duplicate, and tally vertex usage -------------
    for (const f of features) {
      const props = f.properties ?? {};
      const cls = classify(props.class, props.subclass);
      if (!cls) continue;
      const name = typeof props.name === 'string' ? props.name : null;

      const raw: GeoJSON.Position[][] =
        f.geometry.type === 'LineString'
          ? [f.geometry.coordinates]
          : f.geometry.type === 'MultiLineString'
            ? f.geometry.coordinates
            : [];

      for (const line of raw) {
        if (line.length < 2) continue;
        // Tiles overlap, so the same way arrives several times; key on the
        // rounded endpoints to drop the duplicates cheaply.
        const last = line.length - 1;
        const dedupe = `${cls}|${line[0][0].toFixed(6)},${line[0][1].toFixed(6)}|${line[last][0].toFixed(6)},${line[last][1].toFixed(6)}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);

        const xs = new Float64Array(line.length * 2);
        for (let i = 0; i < line.length; i++) {
          const m = lngLatToMerc(line[i][0], line[i][1]);
          xs[i * 2] = m.x;
          xs[i * 2 + 1] = m.y;
          const k = nodeKey(m.x, m.y);
          vertexCount.set(k, (vertexCount.get(k) ?? 0) + 1);
        }
        lines.push({ cls, name, xs });
      }
    }

    // --- pass 2: split at shared vertices and index the result -------------
    outer: for (const line of lines) {
      const n = line.xs.length / 2;
      let start = 0;
      for (let i = 1; i < n; i++) {
        const shared = i < n - 1 && (vertexCount.get(nodeKey(line.xs[i * 2], line.xs[i * 2 + 1])) ?? 0) > 1;
        if (!shared && i < n - 1) continue;
        net.addEdge(line, start, i, cellKeyOf);
        if (net.edges.length >= maxEdges) break outer;
        start = i;
      }
    }
    return net;
  }

  /** Index one edge spanning vertices [from, to] of a source line. */
  private addEdge(
    line: { cls: RoadClass; name: string | null; xs: Float64Array },
    from: number,
    to: number,
    cellKeyOf: (x: number, y: number) => string,
  ): void {
    const count = to - from + 1;
    if (count < 2) return;
    const pts = line.xs.slice(from * 2, (to + 1) * 2);

    let len = 0;
    for (let i = 1; i < count; i++) {
      len += Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
    }
    if (len <= 0) return;

    const idx = this.edges.length;
    const mid = Math.floor(count / 2);
    const edge: RoadEdge = {
      cls: line.cls,
      pts,
      len,
      aNode: nodeKey(pts[0], pts[1]),
      bNode: nodeKey(pts[(count - 1) * 2], pts[(count - 1) * 2 + 1]),
      midX: pts[mid * 2],
      midY: pts[mid * 2 + 1],
      name: line.name,
    };
    this.edges.push(edge);
    this.link(edge.aNode, idx, pts[0], pts[1]);
    if (edge.bNode !== edge.aNode) {
      this.link(edge.bNode, idx, pts[(count - 1) * 2], pts[(count - 1) * 2 + 1]);
    }

    const key = cellKeyOf(edge.midX, edge.midY);
    if (edge.cls !== 'foot') push(this.driveByCell, key, idx);
    if (edge.cls === 'foot' || edge.cls === 'street' || edge.cls === 'service') {
      push(this.walkByCell, key, idx);
    }
  }

  private link(node: number, edgeIdx: number, x: number, y: number): void {
    const list = this.nodeEdges.get(node);
    if (list) {
      list.push(edgeIdx);
      return;
    }
    this.nodeEdges.set(node, [edgeIdx]);
    this.nodePos.set(node, [x, y]);
    push2(this.snapGrid, snapBucket(x, y), node);
  }

  /**
   * Find somewhere to continue from a dead end.
   *
   * Tile clipping leaves streets truncated mid-block, so without this a large
   * share of trips would end after a couple of hundred metres. We look for
   * another node within {@link SNAP_RADIUS_M} and resume from there; the gap is
   * a few metres at most, well under one pixel at street zoom.
   */
  private bridge(
    node: number,
    fromIdx: number,
    allowFoot: boolean,
    visited: Set<number>,
  ): { edge: number; forward: boolean } | null {
    const p = this.nodePos.get(node);
    if (!p) return null;

    const radius = SNAP_RADIUS_M * mercPerMeter(p[1]);
    let bestD = radius * radius;
    let bestEdge = -1;
    let bestNode = 0;

    const bx = Math.floor(p[0] * SNAP_GRID);
    const by = Math.floor(p[1] * SNAP_GRID);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.snapGrid.get((bx + dx) * SNAP_GRID + (by + dy));
        if (!bucket) continue;
        for (const nk of bucket) {
          if (nk === node) continue;
          const q = this.nodePos.get(nk)!;
          const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
          if (d >= bestD) continue;
          for (const ei of this.nodeEdges.get(nk)!) {
            if (ei === fromIdx || visited.has(ei)) continue;
            if (!allowFoot && this.edges[ei].cls === 'foot') continue;
            bestD = d;
            bestEdge = ei;
            bestNode = nk;
            break;
          }
        }
      }
    }

    if (bestEdge < 0) return null;
    return { edge: bestEdge, forward: this.edges[bestEdge].aNode === bestNode };
  }

  /**
   * Random-walk a route through the graph starting from `startEdge`, preferring
   * the straightest continuation at each junction so trips read as journeys
   * rather than as aimless zig-zags.
   */
  route(
    startEdge: number,
    rng: Rng,
    targetLenMerc: number,
    allowFoot: boolean,
    lateralOffset = 0,
    startNode?: number,
  ): RouteResult | null {
    const first = this.edges[startEdge];
    if (!first) return null;

    const xs: number[] = [];
    const ys: number[] = [];
    let edgeIdx = startEdge;
    // Chained trips must leave from the node the previous trip arrived at,
    // otherwise the agent would jump to the far end of the edge.
    let forward = startNode != null ? first.aNode === startNode : rng.bool();
    let total = 0;
    const visited = new Set<number>();
    let exitNode = forward ? first.bNode : first.aNode;

    // Edges are short once split at junctions, so a trip of a few kilometres
    // needs a generous hop budget; the length target is the real terminator.
    for (let hop = 0; hop < MAX_ROUTE_HOPS && total < targetLenMerc; hop++) {
      const e = this.edges[edgeIdx];
      visited.add(edgeIdx);
      appendEdge(xs, ys, e, forward);
      total += e.len;
      exitNode = forward ? e.bNode : e.aNode;

      const next = this.pickNext(edgeIdx, exitNode, rng, allowFoot, visited);
      if (next != null) {
        edgeIdx = next;
        forward = this.edges[edgeIdx].aNode === exitNode;
        continue;
      }
      // True dead end in this tile's data — try to step across the seam.
      const bridged = this.bridge(exitNode, edgeIdx, allowFoot, visited);
      if (!bridged) break;
      edgeIdx = bridged.edge;
      forward = bridged.forward;
    }

    const path = buildPath(xs, ys, lateralOffset);
    if (!path) return null;
    return { path, lastEdge: edgeIdx, exitNode, cls: this.edges[edgeIdx].cls };
  }

  private pickNext(
    fromIdx: number,
    node: number,
    rng: Rng,
    allowFoot: boolean,
    visited: Set<number>,
  ): number | null {
    const candidates = this.nodeEdges.get(node);
    if (!candidates || candidates.length < 2) return null;

    const from = this.edges[fromIdx];
    const inHeading = headingAtNode(from, node, true);

    const bestPool: number[] = [];
    const weights: number[] = [];
    let sum = 0;
    for (const idx of candidates) {
      if (idx === fromIdx) continue;
      const e = this.edges[idx];
      if (!allowFoot && e.cls === 'foot') continue;
      const outHeading = headingAtNode(e, node, false);
      let turn = Math.abs(angleDiff(inHeading, outHeading));
      // Discourage immediate U-turns and revisiting.
      if (turn > 2.6) turn = 3.4;
      let w = 1 / (0.25 + turn);
      if (visited.has(idx)) w *= 0.15;
      if (e.cls === from.cls) w *= 1.6;
      bestPool.push(idx);
      weights.push(w);
      sum += w;
    }
    if (!bestPool.length) return null;

    let r = rng.next() * sum;
    for (let i = 0; i < bestPool.length; i++) {
      r -= weights[i];
      if (r <= 0) return bestPool[i];
    }
    return bestPool[bestPool.length - 1];
  }

  /** Drivable edges whose midpoint sits in the given cell. */
  driveEdges(cellKey: string): number[] | undefined {
    return this.driveByCell.get(cellKey);
  }

  walkEdges(cellKey: string): number[] | undefined {
    return this.walkByCell.get(cellKey);
  }
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function push2(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function appendEdge(xs: number[], ys: number[], e: RoadEdge, forward: boolean): void {
  const n = e.pts.length / 2;
  if (forward) {
    for (let i = 0; i < n; i++) {
      if (xs.length && xs[xs.length - 1] === e.pts[i * 2] && ys[ys.length - 1] === e.pts[i * 2 + 1]) continue;
      xs.push(e.pts[i * 2]);
      ys.push(e.pts[i * 2 + 1]);
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      if (xs.length && xs[xs.length - 1] === e.pts[i * 2] && ys[ys.length - 1] === e.pts[i * 2 + 1]) continue;
      xs.push(e.pts[i * 2]);
      ys.push(e.pts[i * 2 + 1]);
    }
  }
}

/** Heading of an edge at one of its endpoints. */
function headingAtNode(e: RoadEdge, node: number, incoming: boolean): number {
  const n = e.pts.length / 2;
  const atA = e.aNode === node && !(e.bNode === node && incoming);
  let x0: number, y0: number, x1: number, y1: number;
  if (atA) {
    x0 = e.pts[2];
    y0 = e.pts[3];
    x1 = e.pts[0];
    y1 = e.pts[1];
  } else {
    x0 = e.pts[(n - 2) * 2];
    y0 = e.pts[(n - 2) * 2 + 1];
    x1 = e.pts[(n - 1) * 2];
    y1 = e.pts[(n - 1) * 2 + 1];
  }
  return incoming ? Math.atan2(y1 - y0, x1 - x0) : Math.atan2(y0 - y1, x0 - x1);
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Turn a coordinate list into a {@link Path}, optionally shifted sideways by
 * `offset` mercator units (used to put pedestrians on a sidewalk rather than
 * down the centreline, and cars in the right-hand lane).
 */
export function buildPath(xs: number[], ys: number[], offset = 0): Path | null {
  const n = xs.length;
  if (n < 2) return null;
  const pts = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    let ox = 0;
    let oy = 0;
    if (offset !== 0) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(n - 1, i + 1);
      const dx = xs[i1] - xs[i0];
      const dy = ys[i1] - ys[i0];
      const l = Math.hypot(dx, dy) || 1;
      ox = (-dy / l) * offset;
      oy = (dx / l) * offset;
    }
    pts[i * 2] = xs[i] + ox;
    pts[i * 2 + 1] = ys[i] + oy;
  }

  const cum = new Float64Array(n);
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
    cum[i] = total;
  }
  if (total <= 0) return null;
  return { pts, cum, total };
}

/** Metres -> mercator units at the latitude of `mercY`. */
export function metersToMerc(meters: number, mercY: number): number {
  return meters * mercPerMeter(mercY);
}
