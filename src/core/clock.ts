export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export function fakeClock(startMs: number): Clock & { advance(ms: number): void; set(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}

// Deterministic PRNG (mulberry32) so tests and demos are fully reproducible.
export interface Rng {
  next(): number;
}

export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function pick(rng: Rng, items: string[]): string {
  return items[Math.floor(rng.next() * items.length)]!;
}

export function gaussian(rng: Rng, mean: number, sd: number): number {
  const u1 = Math.max(rng.next(), 1e-12);
  const u2 = rng.next();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * sd;
}
