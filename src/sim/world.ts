import { boundsIntersect, expandBounds, mercPerMeter, type MercBounds } from './geo';
import { CAR_COLORS, CAR_MODELS, CAR_PURPOSES, FIRST_NAMES, LAST_NAMES, PERSON_ACTIVITIES, PLACE_KINDS } from './names';
import { Rng, seedFrom } from './rng';
import { buildPath, classSpeed, metersToMerc, RoadNetwork, type RoadClass } from './roads';
import type { Agent, Car, Cell, Path, Person } from './types';

/**
 * Zoom level of the spawn grid. z=17 gives ~305 m cells at the equator, which
 * is close to the "~200 m per cell" target once mercator distortion at typical
 * city latitudes is taken into account.
 */
export const CELL_Z = 17;
const CELL_COUNT = 1 << CELL_Z;
const CELL_SIZE = 1 / CELL_COUNT;

/**
 * How far outside the viewport we keep simulating, as a fraction of each axis'
 * span. Padding per-axis rather than by the larger span matters: at a 16:9
 * viewport a uniform pad more than doubles the simulated area for no visible
 * benefit.
 */
const SIM_BUFFER = 0.3;
/** Cells beyond this (larger) margin are dropped entirely. */
const RETAIN_BUFFER = 1.0;

/**
 * Population targets for the whole simulated area (viewport plus buffer) at
 * full street-level density in a fully built-up cell. Roughly 60% of these end
 * up on screen at a 16:9 viewport.
 */
const TARGET_PEOPLE = 1600;
const TARGET_CARS = 520;
/** Hard ceiling so a pathological viewport can never melt the frame budget. */
const MAX_AGENTS = 4000;
/** Most cells we will populate at once; extra cells are sub-sampled. */
const MAX_CELLS = 600;
/** Above this the spawn scan itself is skipped (only reachable below z12). */
const MAX_ITERATED_CELLS = 30000;
const MAX_PER_CELL_PEOPLE = 90;
const MAX_PER_CELL_CARS = 32;

const PERSON_COLORS = ['#f2c14e', '#78c091', '#e8825d', '#7fb3ff', '#d78ce0', '#f0f0f0'];

export interface ViewState {
  bounds: MercBounds;
  zoom: number;
  /** True when the camera is not mid-pan/zoom/flyTo. */
  settled: boolean;
}

/** 0 when zoomed out to country level, 1 at street level. */
export function densityForZoom(zoom: number): number {
  const t = (zoom - 11.5) / 4;
  return Math.max(0, Math.min(1, t)) ** 1.4;
}

export function cellKeyFor(x: number, y: number): string {
  return `${Math.floor(x * CELL_COUNT)}/${Math.floor(y * CELL_COUNT)}`;
}

export class World {
  readonly cells = new Map<string, Cell>();
  net: RoadNetwork | null = null;
  netVersion = 0;
  peopleCount = 0;
  carCount = 0;
  /** Agents whose position is inside the current sim bounds. */
  activeAgents: Agent[] = [];

  private simBounds: MercBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  private nextId = 1;
  /**
   * Signature of the population budget a cell's agents were sized against.
   * A cell's headcount is decided once, at spawn, from the budget then in
   * force; when the zoom changes that budget, existing cells have to be
   * rebuilt or their stale headcounts accumulate as you zoom out.
   */
  private budgetSig = '';

  setNetwork(net: RoadNetwork | null): void {
    this.net = net;
    this.netVersion++;
  }

  get totalAgents(): number {
    return this.peopleCount + this.carCount;
  }

  /**
   * Spawn cells that scrolled into view, drop cells that scrolled well out,
   * and refresh the active-agent list. Called at a low fixed rate (not every
   * frame) because it is by far the most expensive part of the simulation.
   */
  updateCells(view: ViewState, now: number): void {
    const { bounds, zoom, settled } = view;
    const spanX = bounds.maxX - bounds.minX;
    const spanY = bounds.maxY - bounds.minY;
    this.simBounds = expandBounds(bounds, spanX * SIM_BUFFER, spanY * SIM_BUFFER);
    const retain = expandBounds(bounds, spanX * RETAIN_BUFFER, spanY * RETAIN_BUFFER);

    const density = densityForZoom(zoom);
    if (density <= 0) {
      // Zoomed out past city scale: the world empties rather than freezing
      // whatever happened to be spawned at street level.
      this.clear();
      return;
    }

    const tx0 = Math.floor(this.simBounds.minX * CELL_COUNT);
    const tx1 = Math.floor(this.simBounds.maxX * CELL_COUNT);
    const ty0 = Math.max(0, Math.floor(this.simBounds.minY * CELL_COUNT));
    const ty1 = Math.min(CELL_COUNT - 1, Math.floor(this.simBounds.maxY * CELL_COUNT));
    const cellsWide = tx1 - tx0 + 1;
    const cellsTall = ty1 - ty0 + 1;
    const visibleCells = Math.max(1, cellsWide * cellsTall);

    // Rebuild the population when the budget meaningfully changes, but only
    // once the camera has settled — otherwise every frame of a flyTo would
    // respawn the entire world. Half-zoom-level buckets keep small nudges from
    // triggering a reshuffle.
    const sig = `${Math.round(zoom * 2)}|${cellsWide}x${cellsTall}`;
    if (settled && sig !== this.budgetSig) {
      this.budgetSig = sig;
      this.clear();
    }

    if (visibleCells <= MAX_ITERATED_CELLS) {
      // Beyond a few hundred cells we stop populating every one and instead
      // spawn a deterministic random subset, scaling each survivor's share up
      // to compensate. That keeps the headcount on budget and the per-frame
      // work bounded, and reads as a thinning crowd rather than a hard cutoff.
      const activeCells = Math.min(visibleCells, MAX_CELLS);
      const spawnChance = activeCells / visibleCells;
      const peopleBudget = (TARGET_PEOPLE * density) / activeCells;
      const carBudget = (TARGET_CARS * density) / activeCells;

      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const wrappedTx = ((tx % CELL_COUNT) + CELL_COUNT) % CELL_COUNT;
          const key = `${wrappedTx}/${ty}`;
          const existing = this.cells.get(key);
          if (existing) {
            existing.lastSeen = now;
            continue;
          }
          if (this.totalAgents >= MAX_AGENTS) continue;
          if (spawnChance < 1) {
            // Seeded on the cell, so the same cells are chosen every visit.
            const h = seedFrom(wrappedTx, ty, 0xa11ce) / 4294967296;
            if (h > spawnChance) continue;
          }
          this.cells.set(key, this.spawnCell(wrappedTx, ty, key, peopleBudget, carBudget, now));
        }
      }
    }

    for (const [key, cell] of this.cells) {
      if (!boundsIntersect(cell.bounds, retain)) {
        this.dropCell(key, cell);
      }
    }

    this.refreshActive();
  }

  /** Drop every cell and its agents. */
  clear(): void {
    this.cells.clear();
    this.peopleCount = 0;
    this.carCount = 0;
    this.activeAgents = [];
  }

  private dropCell(key: string, cell: Cell): void {
    for (const a of cell.agents) {
      if (a.kind === 'person') this.peopleCount--;
      else this.carCount--;
    }
    this.cells.delete(key);
  }

  /** Recompute the list of agents inside the simulation buffer. */
  private refreshActive(): void {
    const out: Agent[] = [];
    const b = this.simBounds;
    for (const cell of this.cells.values()) {
      if (!boundsIntersect(cell.bounds, b)) continue;
      for (const a of cell.agents) {
        if (a.x >= b.minX && a.x <= b.maxX && a.y >= b.minY && a.y <= b.maxY) out.push(a);
      }
    }
    this.activeAgents = out;
  }

  private spawnCell(
    tx: number,
    ty: number,
    key: string,
    peopleBudget: number,
    carBudget: number,
    now: number,
  ): Cell {
    const bounds: MercBounds = {
      minX: tx * CELL_SIZE,
      minY: ty * CELL_SIZE,
      maxX: (tx + 1) * CELL_SIZE,
      maxY: (ty + 1) * CELL_SIZE,
    };
    const rng = new Rng(seedFrom(tx, ty, CELL_Z, 0x5eed));

    const driveEdges = this.net?.driveEdges(key);
    const walkEdges = this.net?.walkEdges(key);
    const roadDensity = (driveEdges?.length ?? 0) + (walkEdges?.length ?? 0) * 0.5;

    // Real road density is the best available proxy for how built-up an area
    // is; procedural noise only fills in when there is no vector data.
    const urbanness = this.net
      ? Math.max(0.04, Math.min(1, roadDensity / 10)) * rng.range(0.7, 1.25)
      : rng.range(0.15, 0.85) ** 2;

    const cell: Cell = {
      key,
      tx,
      ty,
      bounds,
      agents: [],
      urbanness: Math.min(1, urbanness),
      onRoads: Boolean(driveEdges?.length || walkEdges?.length),
      lastSeen: now,
    };

    // `urbanness` scales the budget: a fully built-up cell gets its whole
    // share, farmland gets a trickle.
    const nPeople = Math.min(MAX_PER_CELL_PEOPLE, poisson(peopleBudget * cell.urbanness, rng));
    const nCars = Math.min(MAX_PER_CELL_CARS, poisson(carBudget * cell.urbanness, rng));

    for (let i = 0; i < nPeople; i++) {
      const p = this.makePerson(cell, rng, now);
      if (p) cell.agents.push(p);
    }
    for (let i = 0; i < nCars; i++) {
      const c = this.makeCar(cell, rng, now);
      if (c) cell.agents.push(c);
    }
    this.peopleCount += cell.agents.filter((a) => a.kind === 'person').length;
    this.carCount += cell.agents.filter((a) => a.kind === 'car').length;
    return cell;
  }

  // ---------------------------------------------------------------- agents

  private makePerson(cell: Cell, rng: Rng, now: number): Person | null {
    const midY = (cell.bounds.minY + cell.bounds.maxY) / 2;
    const speed = rng.range(1.05, 1.7);
    const sidewalk = metersToMerc(rng.pick([-5, 5]) * rng.range(0.6, 1.4), midY);
    const trip = this.makeTrip(cell, rng, true, rng.range(400, 2200), sidewalk);
    if (!trip) return null;

    const person: Person = {
      id: `p${this.nextId++}`,
      kind: 'person',
      cellKey: cell.key,
      x: 0,
      y: 0,
      heading: 0,
      speedMps: speed,
      speedMerc: speed * mercPerMeter(midY),
      path: trip.path,
      dist: trip.path.total * rng.next(),
      seg: 0,
      name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      age: rng.int(7, 84),
      origin: rng.pick(PLACE_KINDS),
      destination: rng.pick(PLACE_KINDS),
      status: rng.pick(PERSON_ACTIVITIES),
      startedAt: now - rng.range(0, 600) * 1000,
      color: rng.pick(PERSON_COLORS),
    };
    person.lastEdge = trip.lastEdge;
    person.exitNode = trip.exitNode;
    person.offset = sidewalk;
    person.netVersion = this.netVersion;
    resolvePosition(person);
    return person;
  }

  private makeCar(cell: Cell, rng: Rng, now: number): Car | null {
    const midY = (cell.bounds.minY + cell.bounds.maxY) / 2;
    const lane = metersToMerc(rng.range(2.0, 3.0), midY);
    const trip = this.makeTrip(cell, rng, false, rng.range(1500, 6000), lane);
    if (!trip) return null;

    const speed = trip.cls ? rng.range(...classSpeed(trip.cls)) : rng.range(8, 16);
    const car: Car = {
      id: `c${this.nextId++}`,
      kind: 'car',
      cellKey: cell.key,
      x: 0,
      y: 0,
      heading: 0,
      speedMps: speed,
      speedMerc: speed * mercPerMeter(midY),
      path: trip.path,
      dist: trip.path.total * rng.next(),
      seg: 0,
      model: rng.pick(CAR_MODELS),
      driver: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`,
      plate: plate(rng),
      passengers: rng.int(0, 4),
      origin: rng.pick(PLACE_KINDS),
      destination: rng.pick(PLACE_KINDS),
      status: rng.pick(CAR_PURPOSES),
      startedAt: now - rng.range(0, 900) * 1000,
      color: rng.pick(CAR_COLORS),
    };
    car.lastEdge = trip.lastEdge;
    car.exitNode = trip.exitNode;
    car.offset = lane;
    car.netVersion = this.netVersion;
    resolvePosition(car);
    return car;
  }

  /**
   * Build a trip either along real roads (preferred) or as a procedural
   * wander confined to the cell when no road geometry is available.
   */
  private makeTrip(
    cell: Cell,
    rng: Rng,
    onFoot: boolean,
    lengthMeters: number,
    offset: number,
    fromEdge?: number,
    fromNode?: number,
  ): { path: Path; lastEdge?: number; exitNode?: number; cls?: RoadClass } | null {
    const midY = (cell.bounds.minY + cell.bounds.maxY) / 2;
    const targetMerc = metersToMerc(lengthMeters, midY);

    if (this.net) {
      let startEdge = fromEdge;
      if (startEdge == null) {
        const pool = onFoot ? this.net.walkEdges(cell.key) : this.net.driveEdges(cell.key);
        if (pool && pool.length) startEdge = rng.pick(pool);
      }
      if (startEdge != null && this.net.edges[startEdge]) {
        const r = this.net.route(startEdge, rng, targetMerc, onFoot, offset, fromNode);
        if (r) return { path: r.path, lastEdge: r.lastEdge, exitNode: r.exitNode, cls: r.cls };
      }
    }

    const path = proceduralPath(cell, rng, targetMerc, offset);
    return path ? { path } : null;
  }

  /** Give an agent that has reached the end of its route a new one. */
  private renewTrip(a: Agent, now: number): void {
    const rng = new Rng(seedFrom(hashString(a.id), Math.floor(now), this.netVersion));
    const cellKey = cellKeyFor(a.x, a.y);
    const cell = this.cells.get(cellKey) ?? this.cells.get(a.cellKey);
    if (!cell) return;

    const onFoot = a.kind === 'person';
    const chainable = a.netVersion === this.netVersion && a.lastEdge != null;
    const lengthMeters = onFoot ? rng.range(400, 2200) : rng.range(1500, 6000);

    const trip = this.makeTrip(
      cell,
      rng,
      onFoot,
      lengthMeters,
      a.offset ?? 0,
      chainable ? a.lastEdge : undefined,
      chainable ? a.exitNode : undefined,
    );
    if (!trip) {
      // Nowhere to go: turn around and retrace, which is cheap and never
      // teleports the agent.
      a.path = reversePath(a.path);
      a.dist = 0;
      a.seg = 0;
      return;
    }

    a.path = trip.path;
    a.dist = 0;
    a.seg = 0;
    a.lastEdge = trip.lastEdge;
    a.exitNode = trip.exitNode;
    a.netVersion = this.netVersion;
    a.startedAt = now;
    a.origin = a.destination;
    a.destination = rng.pick(PLACE_KINDS);
    a.status = onFoot ? rng.pick(PERSON_ACTIVITIES) : rng.pick(CAR_PURPOSES);
    resolvePosition(a);
  }

  /** Advance every active agent by `dt` seconds. */
  tick(dt: number, now: number): void {
    const agents = this.activeAgents;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.dist += a.speedMerc * dt;
      if (a.dist >= a.path.total) {
        this.renewTrip(a, now);
        continue;
      }
      resolvePosition(a);
    }
  }

  /** Nearest agent to a mercator point within `radius`, or null. */
  hitTest(x: number, y: number, radius: number): Agent | null {
    let best: Agent | null = null;
    let bestD = radius * radius;
    for (const a of this.activeAgents) {
      const dx = a.x - x;
      const dy = a.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }
}

// ------------------------------------------------------------------ helpers

/** Interpolate an agent's position and heading from its path cursor. */
export function resolvePosition(a: Agent): void {
  const { pts, cum } = a.path;
  const n = cum.length;
  let seg = a.seg;
  if (seg >= n - 1) seg = n - 2;
  while (seg < n - 2 && cum[seg + 1] < a.dist) seg++;
  while (seg > 0 && cum[seg] > a.dist) seg--;
  a.seg = seg;

  const x0 = pts[seg * 2];
  const y0 = pts[seg * 2 + 1];
  const x1 = pts[(seg + 1) * 2];
  const y1 = pts[(seg + 1) * 2 + 1];
  const segLen = cum[seg + 1] - cum[seg];
  const t = segLen > 0 ? (a.dist - cum[seg]) / segLen : 0;
  a.x = x0 + (x1 - x0) * t;
  a.y = y0 + (y1 - y0) * t;
  a.heading = Math.atan2(y1 - y0, x1 - x0);
}

function reversePath(p: Path): Path {
  const n = p.cum.length;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    xs.push(p.pts[i * 2]);
    ys.push(p.pts[i * 2 + 1]);
  }
  return buildPath(xs, ys) ?? p;
}

/**
 * Fallback route for cells with no road geometry: a smooth wander through a
 * handful of random waypoints inside (and slightly beyond) the cell.
 */
function proceduralPath(cell: Cell, rng: Rng, targetMerc: number, offset: number): Path | null {
  const cx = (cell.bounds.minX + cell.bounds.maxX) / 2;
  const cy = (cell.bounds.minY + cell.bounds.maxY) / 2;
  const spread = CELL_SIZE * 0.9;
  const hops = Math.max(3, Math.min(10, Math.round(targetMerc / (CELL_SIZE * 0.5))));

  const xs: number[] = [];
  const ys: number[] = [];
  let x = cx + rng.range(-spread, spread) / 2;
  let y = cy + rng.range(-spread, spread) / 2;
  let angle = rng.range(0, Math.PI * 2);
  const step = targetMerc / hops;
  for (let i = 0; i <= hops; i++) {
    xs.push(x + offset * 0.2);
    ys.push(y);
    angle += rng.range(-0.9, 0.9);
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    // Keep the wander loosely tethered to its cell.
    x += (cx - x) * 0.18;
    y += (cy - y) * 0.18;
  }
  return buildPath(xs, ys);
}

/** Knuth's Poisson sampler — gives natural clumping rather than a flat count. */
function poisson(mean: number, rng: Rng): number {
  if (mean <= 0) return 0;
  if (mean > 30) return Math.round(mean);
  const l = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > l && k < 200);
  return k - 1;
}

function plate(rng: Rng): string {
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 2; i++) s += letters[rng.int(0, letters.length - 1)];
  s += `-${rng.int(100, 999)}-`;
  for (let i = 0; i < 2; i++) s += letters[rng.int(0, letters.length - 1)];
  return s;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
