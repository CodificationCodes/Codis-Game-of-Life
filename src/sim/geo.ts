/**
 * Web Mercator helpers.
 *
 * All simulation state lives in *normalized mercator* coordinates: x and y in
 * [0, 1], y increasing southward. That space is zoom-independent, so agents
 * never need to be re-derived when the map zooms, and converting to screen
 * pixels is a single affine transform (see ViewTransform).
 */

/** Circumference of the earth at the equator, in metres. */
export const EARTH_CIRCUMFERENCE = 40075016.686;

export interface MercPoint {
  x: number;
  y: number;
}

export function lngLatToMerc(lng: number, lat: number): MercPoint {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
  };
}

export function mercToLngLat(x: number, y: number): { lng: number; lat: number } {
  const lng = x * 360 - 180;
  const n = Math.PI * (1 - 2 * y);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lng, lat };
}

/**
 * How many mercator units correspond to one ground metre at a given mercator
 * y. Mercator distorts by 1/cos(lat), so this shrinks toward the poles.
 */
export function mercPerMeter(mercY: number): number {
  const { lat } = mercToLngLat(0, mercY);
  const cos = Math.cos((lat * Math.PI) / 180);
  return 1 / (EARTH_CIRCUMFERENCE * Math.max(0.02, cos));
}

/** Inverse of {@link mercPerMeter}: ground metres per mercator unit. */
export function metersPerMerc(mercY: number): number {
  return 1 / mercPerMeter(mercY);
}

/**
 * Affine mapping from normalized mercator to CSS pixels.
 *
 * Derived once per frame from two projected reference points rather than from
 * MapLibre internals, which keeps agents pinned to the map with no drift
 * across pan, zoom and flyTo animations.
 */
export interface ViewTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

export function mercToScreenX(t: ViewTransform, x: number): number {
  return x * t.scaleX + t.offsetX;
}

export function mercToScreenY(t: ViewTransform, y: number): number {
  return y * t.scaleY + t.offsetY;
}

/** Axis-aligned bounds in mercator space. */
export interface MercBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsIntersect(a: MercBounds, b: MercBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Grow bounds by a separate pad on each axis. */
export function expandBounds(b: MercBounds, padX: number, padY = padX): MercBounds {
  return { minX: b.minX - padX, minY: b.minY - padY, maxX: b.maxX + padX, maxY: b.maxY + padY };
}
