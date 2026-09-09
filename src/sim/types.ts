import type { MercBounds } from './geo';

/**
 * A trip route in mercator space, pre-flattened for cheap traversal.
 *
 * `pts` is interleaved x,y; `cum[i]` is the distance (in mercator units) from
 * the start of the route to point i. Agents track a scalar `dist` along this
 * and advance a monotonic segment cursor, so stepping an agent is O(1).
 */
export interface Path {
  pts: Float64Array;
  cum: Float64Array;
  total: number;
}

export type AgentKind = 'person' | 'car';

interface AgentBase {
  id: string;
  kind: AgentKind;
  cellKey: string;
  /** Current position, mercator. */
  x: number;
  y: number;
  /** Heading in radians, screen-space convention (y down). */
  heading: number;
  /** Ground speed in metres per second. */
  speedMps: number;
  /** Speed converted to mercator units per second at this agent's latitude. */
  speedMerc: number;
  path: Path;
  /** Distance travelled along `path`, in mercator units. */
  dist: number;
  /** Monotonic cursor into `path` segments. */
  seg: number;
  origin: string;
  destination: string;
  status: string;
  /** Wall-clock ms when the agent started this trip. */
  startedAt: number;
  color: string;

  // --- routing bookkeeping (present only for road-following agents) ---
  /** Index of the last road edge the current route used. */
  lastEdge?: number;
  /** Graph node the current route exits from, used to chain the next trip. */
  exitNode?: number;
  /** Lateral offset from the road centreline (lane / sidewalk), mercator. */
  offset?: number;
  /** RoadNetwork version this route was built against. */
  netVersion?: number;

  /** Last projected screen position, written by the renderer each frame. */
  sx?: number;
  sy?: number;
}

export interface Person extends AgentBase {
  kind: 'person';
  name: string;
  age: number;
}

export interface Car extends AgentBase {
  kind: 'car';
  model: string;
  driver: string;
  plate: string;
  passengers: number;
}

export type Agent = Person | Car;

/** One deterministically-seeded chunk of world. */
export interface Cell {
  key: string;
  tx: number;
  ty: number;
  bounds: MercBounds;
  agents: Agent[];
  /** 0..1 procedural "how built-up is this" score, drives population. */
  urbanness: number;
  /** True when this cell's agents were routed onto real road geometry. */
  onRoads: boolean;
  /** Last time (ms) this cell was inside the active viewport. */
  lastSeen: number;
}

/** Snapshot of what a selected agent looks like to the UI. */
export interface SelectionInfo {
  agent: Agent;
  progress: number;
  remainingMeters: number;
  travelledMeters: number;
}
