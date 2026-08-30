/** Seeded PRNG. Same seed => byte-identical output, forever. */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive on both ends. */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function randFloat(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() on empty array");
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick() index out of range");
  return item;
}

export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}

export function weighted<T extends string>(rng: Rng, table: ReadonlyArray<readonly [T, number]>): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [value, w] of table) {
    r -= w;
    if (r < 0) return value;
  }
  const last = table[table.length - 1];
  if (last === undefined) throw new Error("weighted() on empty table");
  return last[0];
}

/** Fisher-Yates. Returns a new array; does not mutate the input. */
export function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** Standard normal via Box-Muller. */
export function gaussian(rng: Rng): number {
  let u = rng();
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
