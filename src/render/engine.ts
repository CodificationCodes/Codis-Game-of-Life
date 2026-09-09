import type { MapMouseEvent, Map as MlMap } from 'maplibre-gl';
import { lngLatToMerc, mercPerMeter, mercToLngLat, type MercBounds, type ViewTransform } from '../sim/geo';
import { RoadNetwork } from '../sim/roads';
import type { Agent } from '../sim/types';
import { cellKeyFor, World } from '../sim/world';

/**
 * Owns the canvas overlay, the animation loop and the bridge between MapLibre's
 * camera and the simulation's mercator coordinate space.
 *
 * Three clocks run at different rates on purpose:
 *   - render + integration: every animation frame
 *   - cell spawn/despawn/culling: 4 Hz (the expensive bookkeeping)
 *   - road network extraction: only when the map goes idle
 */

const CELL_UPDATE_MS = 250;
const MAX_ROAD_EDGES = 30000;
const MIN_ROAD_ZOOM = 13.5;
/** Cooldown between road-extraction attempts while we have no network. */
const ROAD_RETRY_MS = 1500;
/** Fixed simulation step, decoupled from the frame rate. */
const SIM_STEP = 1 / 30;

export interface Stats {
  people: number;
  cars: number;
  fps: number;
  cells: number;
  roadEdges: number;
}

export interface EngineCallbacks {
  onStats(s: Stats): void;
  onSelect(a: Agent | null): void;
}

interface Bucket {
  color: string;
  items: Agent[];
}

export class Engine {
  readonly world = new World();
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private lastFrame = 0;
  private lastCellUpdate = 0;
  private accumulator = 0;
  private fpsEma = 60;
  private statsAt = 0;
  private transform: ViewTransform = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  private centerMercX = 0.5;
  private buckets = new Map<string, Bucket>();
  private dark: Agent[] = [];
  private selected: Agent | null = null;
  private roadSourceId: string | null = null;
  private lastRoadAttempt = 0;
  private visiblePeople = 0;
  private visibleCars = 0;
  private disposed = false;

  constructor(
    private map: MlMap,
    private canvas: HTMLCanvasElement,
    private cb: EngineCallbacks,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.resize();
    // Input is taken from MapLibre rather than the canvas: the overlay is
    // pointer-events:none so drag/zoom gestures reach the map untouched, and
    // MapLibre's own click event already distinguishes a click from a drag.
    map.on('idle', this.onIdle);
    map.on('resize', this.onResize);
    map.on('click', this.onClick);
    map.on('mousemove', this.onHover);

    this.raf = requestAnimationFrame(this.frame);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.map.off('idle', this.onIdle);
    this.map.off('resize', this.onResize);
    this.map.off('click', this.onClick);
    this.map.off('mousemove', this.onHover);
    this.map.getCanvas().style.cursor = '';
  }

  select(a: Agent | null): void {
    this.selected = a;
    this.cb.onSelect(a);
  }

  /** Re-resolve the selected agent (it may have been despawned by culling). */
  private validateSelection(): void {
    if (!this.selected) return;
    if (!this.world.cells.has(this.selected.cellKey)) this.select(null);
  }

  // ------------------------------------------------------------- transform

  /**
   * Derive the mercator -> CSS-pixel affine transform by projecting two
   * reference points through MapLibre itself. Using the map's own projection
   * (rather than reimplementing its camera maths) is what keeps agents pinned
   * to the ground with zero drift through pans, zooms and flyTo animations.
   */
  private updateTransform(): void {
    const c = this.map.getCenter();
    const a = lngLatToMerc(c.lng, c.lat);
    const d = 1e-3;
    const bx = a.x + d;
    const by = Math.min(0.999, a.y + d);
    const bll = mercToLngLat(bx, by);
    const sa = this.map.project([c.lng, c.lat]);
    const sb = this.map.project([bll.lng, bll.lat]);

    const scaleX = (sb.x - sa.x) / (bx - a.x);
    const scaleY = (sb.y - sa.y) / (by - a.y);
    this.transform = {
      scaleX,
      scaleY,
      offsetX: sa.x - a.x * scaleX,
      offsetY: sa.y - a.y * scaleY,
    };
    this.centerMercX = a.x;
  }

  /** Viewport in mercator units, derived by unprojecting the canvas corners. */
  private viewBounds(): MercBounds {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const t = this.transform;
    const minX = (0 - t.offsetX) / t.scaleX;
    const maxX = (w - t.offsetX) / t.scaleX;
    const minY = (0 - t.offsetY) / t.scaleY;
    const maxY = (h - t.offsetY) / t.scaleY;
    return {
      minX: Math.min(minX, maxX),
      maxX: Math.max(minX, maxX),
      minY: Math.max(0, Math.min(minY, maxY)),
      maxY: Math.min(1, Math.max(minY, maxY)),
    };
  }

  /** Shift an agent's x into the same 360deg copy of the world as the camera. */
  private wrapX(x: number): number {
    const d = x - this.centerMercX;
    if (d > 0.5) return x - 1;
    if (d < -0.5) return x + 1;
    return x;
  }

  // ----------------------------------------------------------------- loop

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);

    const dt = this.lastFrame ? Math.min(0.25, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (dt > 0) this.fpsEma = this.fpsEma * 0.92 + (1 / dt) * 0.08;

    this.syncSize();
    this.updateTransform();

    if (!this.world.net && this.map.getZoom() >= MIN_ROAD_ZOOM) {
      this.extractRoads(now, false);
    }

    if (now - this.lastCellUpdate > CELL_UPDATE_MS) {
      this.lastCellUpdate = now;
      this.world.updateCells(
        {
          bounds: this.viewBounds(),
          zoom: this.map.getZoom(),
          settled: !this.map.isMoving() && !this.map.isZooming(),
        },
        now,
      );
      this.validateSelection();
    }

    // Fixed-step integration so behaviour is frame-rate independent.
    this.accumulator = Math.min(this.accumulator + dt, SIM_STEP * 5);
    while (this.accumulator >= SIM_STEP) {
      this.world.tick(SIM_STEP, now);
      this.accumulator -= SIM_STEP;
    }

    this.draw();

    if (now - this.statsAt > 200) {
      this.statsAt = now;
      this.cb.onStats({
        people: this.visiblePeople,
        cars: this.visibleCars,
        fps: Math.round(this.fpsEma),
        cells: this.world.cells.size,
        roadEdges: this.world.net?.size ?? 0,
      });
    }
  };

  private onResize = (): void => {
    this.resize();
  };

  /**
   * Keep both canvases matched to the container every frame.
   *
   * MapLibre measures its container once at construction and silently falls
   * back to 400x300 when that measurement is zero — which is exactly what
   * happens if the stylesheet has not been applied yet. Rather than racing
   * that with timers, the render loop notices the mismatch and corrects it.
   */
  private syncSize(): void {
    const container = this.map.getContainer();
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (!w || !h) return;

    const mapCanvas = this.map.getCanvas();
    if (mapCanvas.clientWidth !== w || mapCanvas.clientHeight !== h) {
      this.map.resize();
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.resize();
    }
  }

  private resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const container = this.map.getContainer();
    const w = this.canvas.clientWidth || container.clientWidth;
    const h = this.canvas.clientHeight || container.clientHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------------------------------------------------------------- roads

  /**
   * Harvest road geometry from whichever vector source the basemap uses.
   * MapLibre has already parsed these tiles to draw the map, so this is
   * essentially free compared with fetching our own road data.
   */
  private onIdle = (): void => {
    this.extractRoads(performance.now(), true);
  };

  /**
   * @param force bypass the cooldown (used when the map has just settled).
   *
   * `idle` alone is not enough: it often fires once while tiles are still
   * arriving and then never again, so the render loop also retries at a low
   * rate whenever we have no road data but are zoomed in far enough to expect
   * some.
   */
  private extractRoads(now: number, force: boolean): void {
    if (!force && now - this.lastRoadAttempt < ROAD_RETRY_MS) return;
    this.lastRoadAttempt = now;

    if (this.map.getZoom() < MIN_ROAD_ZOOM) {
      if (this.world.net) {
        this.world.setNetwork(null);
        this.dropProceduralCells(true);
      }
      return;
    }

    const features = this.queryRoads();
    if (!features.length) return;

    const net = RoadNetwork.build(features, cellKeyFor, MAX_ROAD_EDGES);
    if (!net.size) return;
    this.world.setNetwork(net);
    // Cells generated before road data arrived are wandering procedurally;
    // respawn just those so they snap onto real streets. Cells already on
    // roads are left alone to avoid reshuffling the world on every idle.
    this.dropProceduralCells(false);
  }

  private dropProceduralCells(all: boolean): void {
    for (const [key, cell] of this.world.cells) {
      if (all || !cell.onRoads) {
        for (const a of cell.agents) {
          if (a.kind === 'person') this.world.peopleCount--;
          else this.world.carCount--;
        }
        this.world.cells.delete(key);
      }
    }
    this.validateSelection();
  }

  private queryRoads(): GeoJSON.Feature[] {
    const style = this.map.getStyle();
    if (!style?.sources) return [];

    const tryIds = this.roadSourceId
      ? [this.roadSourceId]
      : Object.entries(style.sources)
          .filter(([, s]) => s.type === 'vector')
          .map(([id]) => id);

    for (const id of tryIds) {
      try {
        const feats = this.map.querySourceFeatures(id, {
          sourceLayer: 'transportation',
        }) as unknown as GeoJSON.Feature[];
        if (feats.length) {
          this.roadSourceId = id;
          return feats;
        }
      } catch {
        // Source not ready, or has no such layer; try the next one.
      }
    }
    return [];
  }

  // ------------------------------------------------------------ selection

  /** Pointer position -> nearest agent, or null. */
  private pick(ev: MapMouseEvent): Agent | null {
    const t = this.transform;
    const rawX = (ev.point.x - t.offsetX) / t.scaleX;
    const my = (ev.point.y - t.offsetY) / t.scaleY;
    // Agents are stored in the canonical [0,1) world; the camera may sit in a
    // neighbouring copy of it after crossing the antimeridian.
    const mx = ((rawX % 1) + 1) % 1;
    return this.world.hitTest(mx, my, 14 / Math.abs(t.scaleX));
  }

  private onClick = (ev: MapMouseEvent): void => {
    this.select(this.pick(ev));
  };

  private onHover = (ev: MapMouseEvent): void => {
    this.map.getCanvas().style.cursor = this.pick(ev) ? 'pointer' : '';
  };

  // ----------------------------------------------------------------- draw

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);

    const t = this.transform;
    const agents = this.world.activeAgents;

    // Agents are sized from real-world dimensions so they stay in proportion to
    // the map, but with generous floors: at true scale a pedestrian is under a
    // pixel wide at street zoom, which reads as noise rather than a crowd.
    const vb = this.viewBounds();
    const centerY = (vb.minY + vb.maxY) / 2;
    const pxPerMeter = Math.abs(t.scaleX) * mercPerMeter(centerY);
    const carLen = clamp(5.5 * pxPerMeter, 9, 54);
    const carWide = clamp(2.4 * pxPerMeter, 3.8, 24);
    const personR = clamp(0.9 * pxPerMeter, 2.5, 9);

    for (const b of this.buckets.values()) b.items.length = 0;
    this.dark.length = 0;

    let people = 0;
    let cars = 0;
    const margin = 40;

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      const sx = this.wrapX(a.x) * t.scaleX + t.offsetX;
      if (sx < -margin || sx > w + margin) continue;
      const sy = a.y * t.scaleY + t.offsetY;
      if (sy < -margin || sy > h + margin) continue;
      a.sx = sx;
      a.sy = sy;
      if (a.kind === 'person') people++;
      else cars++;
      this.dark.push(a);
      this.bucket(a.color).items.push(a);
    }
    this.visiblePeople = people;
    this.visibleCars = cars;

    if (this.selected) this.drawTrip(this.selected, personR);

    // Pass 1: a single dark silhouette slightly larger than each agent, so
    // everything stays readable over light or busy basemap tiles.
    ctx.fillStyle = 'rgba(12,14,20,0.72)';
    ctx.beginPath();
    for (const a of this.dark) {
      if (a.kind === 'car') addCar(ctx, a, carLen + 2.5, carWide + 2.5);
      else addDot(ctx, a.sx!, a.sy!, personR + 1.1);
    }
    ctx.fill();

    // Pass 2: one batched path per colour keeps draw calls in the low tens
    // regardless of how many agents are on screen.
    for (const b of this.buckets.values()) {
      if (!b.items.length) continue;
      ctx.fillStyle = b.color;
      ctx.beginPath();
      for (const a of b.items) {
        if (a.kind === 'car') addCar(ctx, a, carLen, carWide);
        else addDot(ctx, a.sx!, a.sy!, personR);
      }
      ctx.fill();
    }

    if (this.selected?.sx != null) {
      const a = this.selected;
      ctx.strokeStyle = '#ffd451';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a.sx!, a.sy!, Math.max(9, (a.kind === 'car' ? carLen : personR * 2) * 0.9), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private bucket(color: string): Bucket {
    let b = this.buckets.get(color);
    if (!b) {
      b = { color, items: [] };
      this.buckets.set(color, b);
    }
    return b;
  }

  /** Draw the selected agent's route: travelled behind, remaining ahead. */
  private drawTrip(a: Agent, personR: number): void {
    const ctx = this.ctx;
    const t = this.transform;
    const { pts, cum } = a.path;
    const n = cum.length;

    const project = (i: number): [number, number] => [
      this.wrapX(pts[i * 2]) * t.scaleX + t.offsetX,
      pts[i * 2 + 1] * t.scaleY + t.offsetY,
    ];

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // Travelled portion.
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      if (cum[i] > a.dist) break;
      const [x, y] = project(i);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    if (started && a.sx != null) ctx.lineTo(a.sx, a.sy!);
    ctx.stroke();
    ctx.setLineDash([]);

    // Remaining portion.
    ctx.strokeStyle = '#ffd451';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    if (a.sx != null) ctx.moveTo(a.sx, a.sy!);
    for (let i = 0; i < n; i++) {
      if (cum[i] <= a.dist) continue;
      const [x, y] = project(i);
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Endpoints.
    const [ex, ey] = project(n - 1);
    const [ox, oy] = project(0);
    ctx.fillStyle = '#ffd451';
    ctx.beginPath();
    ctx.arc(ex, ey, personR + 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.arc(ox, oy, personR + 2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function addDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** Append a heading-aligned rectangle as a subpath of the current batch. */
function addCar(ctx: CanvasRenderingContext2D, a: Agent, len: number, wide: number): void {
  const c = Math.cos(a.heading);
  const s = Math.sin(a.heading);
  const hl = len / 2;
  const hw = wide / 2;
  const x = a.sx!;
  const y = a.sy!;
  const ax = c * hl;
  const ay = s * hl;
  const bx = -s * hw;
  const by = c * hw;
  ctx.moveTo(x + ax + bx, y + ay + by);
  ctx.lineTo(x + ax - bx, y + ay - by);
  ctx.lineTo(x - ax - bx, y - ay - by);
  ctx.lineTo(x - ax + bx, y - ay + by);
  ctx.closePath();
}
