// tween.ts — easing curves, frame-rate-independent smoothing, and a tiny tween
// manager. Zero deps, hot-path friendly. Self-contained so vfx.ts can import
// lerp/clamp from here without pulling in the wider sim math module.

/** Clamp v into [lo, hi]. */
export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Linear interpolation from a to b by t (t is NOT clamped). */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Inverse lerp: where does v sit in [a,b] as a 0..1 fraction (unclamped). */
export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

/** Easing functions, each maps t on [0,1] -> eased value (generally [0,1]). */
export const Ease = {
  /** No easing — constant velocity. */
  linear: (t: number): number => t,
  /** Accelerate from zero (t^2). */
  inQuad: (t: number): number => t * t,
  /** Decelerate to zero. */
  outQuad: (t: number): number => t * (2 - t),
  /** Accelerate then decelerate (quadratic). */
  inOutQuad: (t: number): number =>
    t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  /** Strong deceleration to zero (t^3). */
  outCubic: (t: number): number => {
    const u = t - 1;
    return u * u * u + 1;
  },
  /** Accelerate then decelerate (cubic). */
  inOutCubic: (t: number): number =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  /** Overshoot slightly past 1 then settle (nice for pops/spawns). */
  outBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const u = t - 1;
    return 1 + c3 * u * u * u + c1 * u * u;
  },
  /** Springy overshoot oscillation settling to 1 (UI pings, level-up). */
  outElastic: (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  /** Bouncing settle to 1 (landings, drops). */
  outBounce: (t: number): number => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) {
      const u = t - 1.5 / d1;
      return n1 * u * u + 0.75;
    }
    if (t < 2.5 / d1) {
      const u = t - 2.25 / d1;
      return n1 * u * u + 0.9375;
    }
    const u = t - 2.625 / d1;
    return n1 * u * u + 0.984375;
  },
} as const;

/** Name of any easing curve in {@link Ease}. */
export type EaseName = keyof typeof Ease;

/**
 * Frame-rate-independent exponential smoothing: ease `current` toward `target`.
 * `lambda` is the decay rate (higher = snappier; ~6-12 feels good). Stable for
 * any dt because it uses exp() rather than a raw per-frame factor.
 */
export const damp = (
  current: number,
  target: number,
  lambda: number,
  dt: number
): number => lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Angular variant of {@link damp} that wraps correctly across +/-PI. */
export const dampAngle = (
  current: number,
  target: number,
  lambda: number,
  dt: number
): number => {
  let d = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
};

/** A single scalar tween from `from`->`to` over `dur` seconds with easing. */
export class Tween {
  from: number;
  to: number;
  dur: number;
  ease: (t: number) => number;
  t = 0;
  done = false;
  value: number;
  private onUpdate?: (v: number) => void;
  private onDone?: () => void;

  constructor(
    from: number,
    to: number,
    dur: number,
    ease: (t: number) => number = Ease.linear,
    onUpdate?: (v: number) => void,
    onDone?: () => void
  ) {
    this.from = from;
    this.to = to;
    this.dur = Math.max(1e-6, dur);
    this.ease = ease;
    this.value = from;
    this.onUpdate = onUpdate;
    this.onDone = onDone;
  }

  /** Advance by dt seconds; returns the current eased value. */
  update(dt: number): number {
    if (this.done) return this.value;
    this.t += dt;
    const k = clamp(this.t / this.dur, 0, 1);
    this.value = lerp(this.from, this.to, this.ease(k));
    this.onUpdate?.(this.value);
    if (k >= 1) {
      this.done = true;
      this.onDone?.();
    }
    return this.value;
  }
}

/** Lightweight manager that ticks a batch of tweens and drops finished ones. */
export class Tweens {
  private list: Tween[] = [];

  /** Register and return a tween (so the caller can read `.value`). */
  add(t: Tween): Tween {
    this.list.push(t);
    return t;
  }

  /** Convenience: build, register, and return a tween in one call. */
  to(
    from: number,
    to: number,
    dur: number,
    ease: (t: number) => number = Ease.linear,
    onUpdate?: (v: number) => void,
    onDone?: () => void
  ): Tween {
    return this.add(new Tween(from, to, dur, ease, onUpdate, onDone));
  }

  /** Advance all tweens; prune completed ones. */
  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const t = this.list[i];
      t.update(dt);
      if (!t.done) this.list[w++] = t;
    }
    this.list.length = w;
  }

  /** Drop every tween. */
  clear(): void {
    this.list.length = 0;
  }

  /** Number of live tweens. */
  get count(): number {
    return this.list.length;
  }
}
