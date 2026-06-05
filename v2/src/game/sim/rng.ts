// Seeded RNG (mulberry32). Deterministic across host/clients when seeded equal.
// Ported verbatim from v1 (src/game/core/rng.ts).
//
// The sim keeps a single RNG instance so an authoritative host and its clients
// produce identical world events when fed the same seed + input stream. The
// internal state `s` is exposed via getState/setState so a snapshot can carry
// it (keeping a re-simulating client bit-for-bit in step with the host).

export class RNG {
  private s: number;
  constructor(seed = 1) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    this.s |= 0;
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number) {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hi: number) {
    return Math.floor(this.range(lo, hi + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
  // ---- for snapshots: capture / restore the generator's internal state ----
  getState(): number {
    return this.s >>> 0;
  }
  setState(s: number) {
    this.s = s >>> 0 || 1;
  }
}

export const hashSeed = (str: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
