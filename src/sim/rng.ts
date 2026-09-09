/**
 * Deterministic hashing + PRNG.
 *
 * Every cell in the world grid derives its agents from a seed computed purely
 * from the cell's integer tile coordinates, so revisiting an area regenerates
 * the same population.
 */

/** 32-bit integer mix (based on MurmurHash3's finalizer). */
export function hash32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Combine several integers into one 32-bit seed. */
export function seedFrom(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = (Math.imul(h ^ (p | 0), 0x01000193) + 0x9e3779b9) | 0;
    h = hash32(h);
  }
  return h >>> 0;
}

/** Small fast PRNG (mulberry32). Deterministic given its seed. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }

  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}
