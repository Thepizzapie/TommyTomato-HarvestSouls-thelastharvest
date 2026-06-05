// vfx.ts — reusable Canvas2D visual-effects toolkit for Tommy Tomato.
// Particles (pooled), dynamic lighting (offscreen-composited), weather overlays,
// post-processing (vignette / color grade / flash), and trauma-based screenshake.
// Framework-free, zero deps, no per-frame allocations in hot paths, count-capped.
//
// COORDINATE SPACES (read carefully — the integrator wires these into Game.ts):
//   * ParticleSystem.draw  -> WORLD space (call INSIDE the world transform,
//       i.e. between ctx.translate(-camX,-camY)... and ctx.restore(); right where
//       the old drawParticles() ran).
//   * renderLighting / drawWeather / vignette / colorGrade / flashScreen
//       -> SCREEN space (call AFTER ctx.restore(), before/around drawHUD()).
//       They reset the transform themselves (identity * dpr).
//   * ScreenShake just yields x/y offsets you add to the world translate.

import { clamp, lerp } from "./tween";

// ============================================================================
// Shared offscreen-canvas helper (reused, never recreated per frame)
// ============================================================================

/** Create a 2D canvas that works in DOM or worker/OffscreenCanvas contexts. */
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** A lazily-sized scratch canvas + context, resized only when dimensions grow. */
class Scratch {
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;

  /** Ensure the scratch is at least w*h device pixels; returns its context. */
  ensure(w: number, h: number): CanvasRenderingContext2D {
    w = Math.max(1, Math.ceil(w));
    h = Math.max(1, Math.ceil(h));
    if (!this.canvas || w > this.w || h > this.h) {
      // grow to requested size (only ever grows -> avoids realloc churn)
      this.w = Math.max(this.w, w);
      this.h = Math.max(this.h, h);
      this.canvas = makeCanvas(this.w, this.h);
      this.ctx = this.canvas.getContext("2d");
    }
    return this.ctx!;
  }
}

// ============================================================================
// 1. PARTICLE SYSTEM (pooled)
// ============================================================================

/** Named particle effect presets understood by ParticleSystem.emit(). */
export type ParticlePreset =
  | "blood" // tomato-pulp splats, gravity, fades to a smear
  | "leaf" // drifting leaf bits, slow wobble
  | "spark" // additive hit sparks, fast, short-lived
  | "ember" // rising glowing fire embers
  | "dust" // footstep / landing puffs
  | "poison" // sickly green rising gas
  | "splash" // water droplets, gravity
  | "heal" // blue rising motes (additive)
  | "sapglow" // golden glints (additive)
  | "death" // big mixed burst (pulp + sparks)
  | "muzzle" // projectile spawn flash
  | "ring"; // expanding shockwave ring

/** Per-emit overrides. All optional; presets supply sensible defaults. */
export interface EmitOpts {
  color?: string; // base color (presets that mix colors may ignore)
  count?: number; // number of particles to spawn (capped to pool headroom)
  speed?: number; // base outward speed (px/s)
  spread?: number; // angular spread in radians around `angle`
  gravity?: number; // downward accel (px/s^2)
  life?: number; // lifetime in seconds
  size?: number; // base size in px
  angle?: number; // emission center direction (radians); default full circle
}

/** Low-level single-particle parameters for ParticleSystem.spawn(). */
export interface SpawnOpts {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: string;
  gravity?: number;
  drag?: number; // velocity multiplier per second-ish (0..1, default 0.92)
  glow?: boolean; // additive (lighter) blend
  shape?: "rect" | "circle" | "ring"; // ring = expanding outline
  spin?: number; // rad/s (visual only for rect)
  fade?: number; // 0..1 portion of life spent fading (default 1)
  shrink?: boolean; // shrink size with life
}

interface P {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  size0: number;
  color: string;
  gravity: number;
  drag: number;
  glow: boolean;
  shape: 0 | 1 | 2; // 0 rect, 1 circle, 2 ring
  rot: number;
  spin: number;
  fade: number;
  shrink: boolean;
}

/** Pooled, count-capped particle system. Replaces the engine's inline particles. */
export class ParticleSystem {
  private pool: P[];
  private cap: number;
  private alive = 0;
  /** Cursor for round-robin reuse when the pool is full. */
  private cursor = 0;

  constructor(cap = 1400) {
    this.cap = cap;
    this.pool = new Array(cap);
    for (let i = 0; i < cap; i++) {
      this.pool[i] = {
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        max: 1,
        size: 1,
        size0: 1,
        color: "#fff",
        gravity: 0,
        drag: 0.92,
        glow: false,
        shape: 0,
        rot: 0,
        spin: 0,
        fade: 1,
        shrink: false,
      };
    }
  }

  /** Number of currently-alive particles. */
  get count(): number {
    return this.alive;
  }

  /** Deactivate every particle. */
  clear(): void {
    for (let i = 0; i < this.cap; i++) this.pool[i].active = false;
    this.alive = 0;
  }

  /** Grab a free slot (or recycle the oldest if the pool is saturated). */
  private acquire(): P {
    // fast path: scan a small window from the cursor for an inactive slot
    for (let i = 0; i < this.cap; i++) {
      const idx = (this.cursor + i) % this.cap;
      const p = this.pool[idx];
      if (!p.active) {
        this.cursor = (idx + 1) % this.cap;
        p.active = true;
        this.alive++;
        return p;
      }
    }
    // saturated: steal the slot at the cursor (oldest-ish), keep alive count
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.cap;
    return p;
  }

  /** Low-level spawn of one particle. Returns false if no capacity at all. */
  spawn(o: SpawnOpts): boolean {
    const p = this.acquire();
    p.active = true;
    p.x = o.x;
    p.y = o.y;
    p.vx = o.vx;
    p.vy = o.vy;
    p.life = o.life;
    p.max = o.life;
    p.size = o.size;
    p.size0 = o.size;
    p.color = o.color;
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0.92;
    p.glow = o.glow ?? false;
    p.shape = o.shape === "circle" ? 1 : o.shape === "ring" ? 2 : 0;
    p.rot = 0;
    p.spin = o.spin ?? 0;
    p.fade = o.fade ?? 1;
    p.shrink = o.shrink ?? false;
    return true;
  }

  /**
   * Emit a preset burst at world (x,y). `opts` overrides preset defaults.
   * Counts are clamped so a single emit can never blow the pool.
   */
  emit(preset: ParticlePreset, x: number, y: number, opts: EmitOpts = {}): void {
    const a0 = opts.angle;
    const full = a0 === undefined;
    const center = a0 ?? 0;
    const spread = opts.spread ?? (full ? Math.PI : 0.6);

    // helper: random angle within [center-spread, center+spread] (or full circle)
    const ang = (): number =>
      full ? Math.random() * Math.PI * 2 : center + (Math.random() * 2 - 1) * spread;

    switch (preset) {
      case "blood": {
        const n = clampCount(opts.count ?? 12);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 130) * (0.3 + Math.random() * 0.7);
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s - 40,
            life: (opts.life ?? 0.7) * (0.6 + Math.random() * 0.6),
            size: (opts.size ?? 3) * (0.7 + Math.random()),
            color: opts.color ?? (Math.random() < 0.3 ? "#7d1d1d" : "#b21f1f"),
            gravity: opts.gravity ?? 520,
            drag: 0.9,
            shape: Math.random() < 0.4 ? "circle" : "rect",
            shrink: true,
          });
        }
        break;
      }
      case "death": {
        // big mixed burst: pulp + a few sparks + a shockwave ring
        const n = clampCount(opts.count ?? 26);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 170) * (0.3 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s - 60,
            life: 0.6 + Math.random() * 0.6,
            size: 2 + Math.random() * 4,
            color: Math.random() < 0.5 ? "#b21f1f" : "#7d9a3a",
            gravity: 480,
            drag: 0.9,
            shape: Math.random() < 0.4 ? "circle" : "rect",
            shrink: true,
          });
        }
        for (let i = 0; i < 8; i++) {
          const a = ang();
          const s = 220 + Math.random() * 160;
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s,
            life: 0.25 + Math.random() * 0.2,
            size: 2,
            color: "#ffd56b",
            drag: 0.86,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        this.spawn({
          x,
          y,
          vx: 0,
          vy: 0,
          life: 0.4,
          size: 8,
          color: opts.color ?? "#ffe7a0",
          glow: true,
          shape: "ring",
        });
        break;
      }
      case "leaf": {
        const n = clampCount(opts.count ?? 8);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 50) * (0.3 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s - 20,
            life: (opts.life ?? 1.4) * (0.7 + Math.random() * 0.6),
            size: (opts.size ?? 4) * (0.7 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? "#4e7a2e" : "#7d9a3a"),
            gravity: opts.gravity ?? 40,
            drag: 0.95,
            shape: "rect",
            spin: (Math.random() * 2 - 1) * 6,
          });
        }
        break;
      }
      case "spark": {
        const n = clampCount(opts.count ?? 10);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 180) * (0.4 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s,
            life: (opts.life ?? 0.3) * (0.5 + Math.random()),
            size: (opts.size ?? 2.2) * (0.6 + Math.random()),
            color: opts.color ?? "#fff2c0",
            drag: 0.85,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        break;
      }
      case "ember": {
        const n = clampCount(opts.count ?? 6);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 40) * (0.4 + Math.random());
          this.spawn({
            x: x + (Math.random() * 2 - 1) * 6,
            y,
            vx: Math.cos(a) * s * 0.4,
            vy: -Math.abs(Math.sin(a) * s) - 40 - Math.random() * 30,
            life: (opts.life ?? 1.1) * (0.6 + Math.random() * 0.7),
            size: (opts.size ?? 2.4) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? "#ffb347" : "#ff7a3a"),
            gravity: opts.gravity ?? -20,
            drag: 0.96,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        break;
      }
      case "dust": {
        const n = clampCount(opts.count ?? 8);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 70) * (0.3 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s * 0.5 - 10,
            life: (opts.life ?? 0.5) * (0.6 + Math.random() * 0.6),
            size: (opts.size ?? 4) * (0.8 + Math.random()),
            color: opts.color ?? "#a98a5a",
            drag: 0.88,
            shape: "circle",
            shrink: false,
          });
        }
        break;
      }
      case "poison": {
        const n = clampCount(opts.count ?? 7);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 30) * (0.3 + Math.random());
          this.spawn({
            x: x + (Math.random() * 2 - 1) * 8,
            y,
            vx: Math.cos(a) * s * 0.5,
            vy: -30 - Math.random() * 30,
            life: (opts.life ?? 1.3) * (0.7 + Math.random() * 0.6),
            size: (opts.size ?? 6) * (0.7 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? "#7db32e" : "#9fd44e"),
            gravity: -10,
            drag: 0.97,
            glow: true,
            shape: "circle",
            shrink: false,
          });
        }
        break;
      }
      case "splash": {
        const n = clampCount(opts.count ?? 10);
        for (let i = 0; i < n; i++) {
          const a = full ? -Math.PI / 2 + (Math.random() * 2 - 1) * 1.2 : ang();
          const s = (opts.speed ?? 150) * (0.3 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s - 60,
            life: (opts.life ?? 0.6) * (0.5 + Math.random()),
            size: (opts.size ?? 2.5) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? "#86c5e6" : "#bfe3f2"),
            gravity: opts.gravity ?? 600,
            drag: 0.93,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        break;
      }
      case "heal": {
        const n = clampCount(opts.count ?? 12);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 50) * (0.3 + Math.random());
          this.spawn({
            x: x + (Math.random() * 2 - 1) * 12,
            y: y + (Math.random() * 2 - 1) * 8,
            vx: Math.cos(a) * s * 0.4,
            vy: -50 - Math.random() * 50,
            life: (opts.life ?? 0.9) * (0.6 + Math.random() * 0.6),
            size: (opts.size ?? 3) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? "#7ac0ff" : "#bfe3ff"),
            gravity: -30,
            drag: 0.97,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        break;
      }
      case "sapglow": {
        const n = clampCount(opts.count ?? 10);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 70) * (0.2 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s * 0.6,
            vy: Math.sin(a) * s * 0.6 - 30,
            life: (opts.life ?? 1.0) * (0.6 + Math.random() * 0.7),
            size: (opts.size ?? 2.4) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? "#ffd56b" : "#ffe7a0"),
            gravity: -8,
            drag: 0.96,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        break;
      }
      case "muzzle": {
        // brief directional flash: a few fast sparks + a tiny ring
        const n = clampCount(opts.count ?? 6);
        for (let i = 0; i < n; i++) {
          const a = ang();
          const s = (opts.speed ?? 220) * (0.4 + Math.random());
          this.spawn({
            x,
            y,
            vx: Math.cos(a) * s,
            vy: Math.sin(a) * s,
            life: (opts.life ?? 0.2) * (0.5 + Math.random()),
            size: (opts.size ?? 2) * (0.6 + Math.random()),
            color: opts.color ?? "#fff2c0",
            drag: 0.82,
            glow: true,
            shape: "circle",
            shrink: true,
          });
        }
        this.spawn({
          x,
          y,
          vx: 0,
          vy: 0,
          life: 0.16,
          size: (opts.size ?? 4),
          color: opts.color ?? "#ffe7a0",
          glow: true,
          shape: "ring",
        });
        break;
      }
      case "ring": {
        // single expanding shockwave outline (size grows via shape=ring)
        this.spawn({
          x,
          y,
          vx: 0,
          vy: 0,
          life: opts.life ?? 0.4,
          size: opts.size ?? 10,
          color: opts.color ?? "#ffffff",
          glow: true,
          shape: "ring",
        });
        break;
      }
    }
  }

  /** Advance all particles by dt seconds and retire the expired ones. */
  update(dt: number): void {
    let alive = 0;
    const pool = this.pool;
    for (let i = 0; i < this.cap; i++) {
      const p = pool[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dt;
      // frame-rate-aware drag (drag is a per-"unit-time" retention factor)
      const d = Math.pow(p.drag, dt * 60);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.shrink) {
        const k = p.life / p.max;
        p.size = p.size0 * (0.25 + 0.75 * k);
      }
      alive++;
    }
    this.alive = alive;
  }

  /**
   * Draw all particles. MUST be called inside the world transform (world space).
   * Batches by blend mode: opaque pass first, then a single additive pass for
   * glow particles (so we don't thrash globalCompositeOperation per particle).
   */
  draw(ctx: CanvasRenderingContext2D): void {
    const pool = this.pool;
    // --- opaque pass ---
    ctx.globalCompositeOperation = "source-over";
    for (let i = 0; i < this.cap; i++) {
      const p = pool[i];
      if (!p.active || p.glow) continue;
      this.drawOne(ctx, p);
    }
    // --- additive (glow) pass ---
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < this.cap; i++) {
      const p = pool[i];
      if (!p.active || !p.glow) continue;
      this.drawOne(ctx, p);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  private drawOne(ctx: CanvasRenderingContext2D, p: P): void {
    const k = p.life / p.max; // 1 -> 0 over lifetime
    const a = p.fade >= 1 ? clamp(k, 0, 1) : clamp(k / p.fade, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    if (p.shape === 2) {
      // expanding ring: radius grows as the particle ages, stroke fades
      const grow = 1 - k; // 0 -> 1
      const r = p.size0 + grow * p.size0 * 6;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = Math.max(1, 3 * k);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    if (p.shape === 1) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // rect (optionally spinning)
    if (p.spin !== 0) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    } else {
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
}

/** Hard cap on a single emit() burst so one call can't saturate the pool. */
function clampCount(n: number): number {
  return n < 0 ? 0 : n > 120 ? 120 : n | 0;
}

// ============================================================================
// 2. DYNAMIC LIGHTING
// ============================================================================

/** A radial light source positioned in WORLD coordinates. */
export interface Light {
  x: number; // world x
  y: number; // world y
  radius: number; // world-space radius of the lit pool
  color: string; // light tint (e.g. "#ffb347"); used for a warm additive glow
  intensity: number; // 0..1, how strongly it pierces the darkness
  flicker?: number; // 0..1 amount of subtle time-based flicker (0 = steady)
}

/** Parameters for {@link renderLighting} / {@link LightLayer.render}. */
export interface LightingOpts {
  cssW: number; // screen width in CSS px
  cssH: number; // screen height in CSS px
  dpr: number; // device pixel ratio (engine's this.dpr)
  camX: number; // world->screen: camera center x
  camY: number; // world->screen: camera center y
  viewScale: number; // world->screen scale (engine's this.viewScale)
  darkness: number; // 0 = bright day (no overlay), 1 = pitch black
  ambient?: string; // ambient darkness tint, default near-black blue "#05060a"
  lights: Light[]; // light sources in WORLD coords
  t?: number; // time in seconds (drives flicker); default 0
  warmGlow?: boolean; // also additively paint each light's color (default true)
}

/**
 * Composites a darkness overlay pierced by radial lights. Call in SCREEN space
 * AFTER the world transform is restored. Internally renders the darkness +
 * 'destination-out' light holes to a reused offscreen canvas, then blits it
 * over the scene; optionally adds a soft additive color glow per light.
 */
export class LightLayer {
  private dark = new Scratch();

  /** See {@link renderLighting}. Kept as a class to own the scratch canvas. */
  render(ctx: CanvasRenderingContext2D, o: LightingOpts): void {
    const darkness = clamp(o.darkness, 0, 1);
    if (darkness <= 0.001) return; // bright day: nothing to do

    const dpr = o.dpr || 1;
    const W = Math.max(1, Math.floor(o.cssW * dpr));
    const H = Math.max(1, Math.floor(o.cssH * dpr));
    const t = o.t ?? 0;
    const ambient = o.ambient ?? "#05060a";

    const dctx = this.dark.ensure(W, H);
    // reset + clear the scratch region we use
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, W, H);

    // 1) fill the darkness sheet (alpha == darkness)
    dctx.globalCompositeOperation = "source-over";
    dctx.globalAlpha = darkness;
    dctx.fillStyle = ambient;
    dctx.fillRect(0, 0, W, H);
    dctx.globalAlpha = 1;

    // 2) punch holes where lights are (destination-out erases the darkness)
    dctx.globalCompositeOperation = "destination-out";
    for (let i = 0; i < o.lights.length; i++) {
      const L = o.lights[i];
      const sx = (L.x - o.camX) * o.viewScale * dpr + (o.cssW * dpr) / 2;
      const sy = (L.y - o.camY) * o.viewScale * dpr + (o.cssH * dpr) / 2;
      const rad = L.radius * o.viewScale * dpr * flickerScale(L, t);
      if (rad <= 0) continue;
      // cull lights fully offscreen
      if (sx + rad < 0 || sx - rad > W || sy + rad < 0 || sy - rad > H) continue;
      const inten = clamp(L.intensity, 0, 1);
      const g = dctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      // erase strongly at the core, feather to nothing at the rim
      g.addColorStop(0, `rgba(0,0,0,${inten})`);
      g.addColorStop(0.55, `rgba(0,0,0,${inten * 0.75})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      dctx.fillStyle = g;
      dctx.beginPath();
      dctx.arc(sx, sy, rad, 0, Math.PI * 2);
      dctx.fill();
    }
    dctx.globalCompositeOperation = "source-over";

    // 3) blit darkness sheet over the scene (in screen space, device pixels)
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // source region (0,0,W,H) of the (possibly larger) scratch -> screen
    ctx.drawImage(this.dark.canvas!, 0, 0, W, H, 0, 0, W, H);

    // 4) optional warm additive glow so lights read as colored, not just gaps
    if (o.warmGlow !== false) {
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < o.lights.length; i++) {
        const L = o.lights[i];
        const sx = (L.x - o.camX) * o.viewScale * dpr + W / 2;
        const sy = (L.y - o.camY) * o.viewScale * dpr + H / 2;
        const rad = L.radius * o.viewScale * dpr * flickerScale(L, t);
        if (rad <= 0) continue;
        if (sx + rad < 0 || sx - rad > W || sy + rad < 0 || sy - rad > H) continue;
        const inten = clamp(L.intensity, 0, 1) * darkness; // only glow in the dark
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
        const c = parseColor(L.color);
        g.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.45 * inten})`);
        g.addColorStop(0.5, `rgba(${c.r},${c.g},${c.b},${0.18 * inten})`);
        g.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// module-level singleton so the function form reuses one offscreen canvas
const _lightLayer = new LightLayer();

/**
 * Functional entry point for dynamic lighting (wraps a shared LightLayer).
 * SCREEN space; call AFTER the world transform is restored, before drawHUD.
 */
export function renderLighting(
  ctx: CanvasRenderingContext2D,
  opts: LightingOpts
): void {
  _lightLayer.render(ctx, opts);
}

/** Subtle per-light flicker multiplier on radius, driven by time. */
function flickerScale(L: Light, t: number): number {
  const f = L.flicker ?? 0;
  if (f <= 0) return 1;
  // layered sines + cheap hash phase per-light => organic, non-repetitive
  const ph = (L.x * 0.013 + L.y * 0.017) % (Math.PI * 2);
  const n =
    Math.sin(t * 11 + ph) * 0.6 +
    Math.sin(t * 23.3 + ph * 2.1) * 0.3 +
    Math.sin(t * 4.7 + ph) * 0.1;
  return 1 + n * 0.08 * f;
}

// ============================================================================
// 3. WEATHER (screen-space overlays)
// ============================================================================

/** Weather kinds for {@link drawWeather}. */
export type Weather = "none" | "rain" | "dust" | "pollen" | "snow" | "fog";

/** Minimal view rect for screen-space overlays. */
export interface ViewRect {
  cssW: number;
  cssH: number;
}

/**
 * Draws an animated, self-contained weather overlay in SCREEN space.
 * Call AFTER the world transform is restored (ctx must be at identity*dpr, which
 * the engine already sets before drawHUD; or call right after renderLighting).
 * Deterministic from `t` — no internal particle state, so it never leaks.
 */
export function drawWeather(
  ctx: CanvasRenderingContext2D,
  kind: Weather,
  t: number,
  view: ViewRect
): void {
  if (kind === "none") return;
  const W = view.cssW;
  const H = view.cssH;
  ctx.save();

  switch (kind) {
    case "rain": {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(170,190,210,0.35)";
      ctx.lineWidth = 1.4;
      const cols = 90;
      const slant = 0.25; // x drift per unit y
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        const seed = i * 73.1;
        const speed = 900 + (i % 5) * 180;
        const x0 = (hash1(seed) * (W + 200) - 100 + ((t * slant * speed) % W));
        const y = (hash1(seed + 9) * H + t * speed) % (H + 40) - 20;
        const len = 12 + (i % 4) * 5;
        const x = ((x0 % (W + 200)) + (W + 200)) % (W + 200) - 100;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * slant, y + len);
      }
      ctx.stroke();
      break;
    }
    case "dust": {
      ctx.globalCompositeOperation = "source-over";
      drawMotes(ctx, t, W, H, 70, {
        r: 200,
        g: 170,
        b: 110,
        baseA: 0.22,
        size: 2.2,
        driftX: 26,
        driftY: 6,
        wobble: 10,
      });
      break;
    }
    case "pollen": {
      ctx.globalCompositeOperation = "lighter";
      drawMotes(ctx, t, W, H, 55, {
        r: 230,
        g: 210,
        b: 120,
        baseA: 0.3,
        size: 2.6,
        driftX: 14,
        driftY: -8,
        wobble: 16,
        glow: true,
      });
      break;
    }
    case "snow": {
      ctx.globalCompositeOperation = "source-over";
      drawMotes(ctx, t, W, H, 80, {
        r: 235,
        g: 240,
        b: 250,
        baseA: 0.5,
        size: 2.8,
        driftX: 12,
        driftY: 70,
        wobble: 22,
        soft: true,
      });
      break;
    }
    case "fog": {
      // two slow rolling translucent bands using moving radial blobs
      ctx.globalCompositeOperation = "source-over";
      const bands = 2;
      for (let b = 0; b < bands; b++) {
        const yc = H * (0.45 + b * 0.28);
        const speed = 18 + b * 10;
        const off = ((t * speed) % (W + 400)) - 200;
        for (let i = 0; i < 5; i++) {
          const cx = off + i * ((W + 200) / 4);
          const r = 180 + (i % 3) * 60;
          const g = ctx.createRadialGradient(cx, yc, 0, cx, yc, r);
          const a = 0.06 + 0.05 * b;
          g.addColorStop(0, `rgba(200,205,215,${a})`);
          g.addColorStop(1, "rgba(200,205,215,0)");
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(cx, yc, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.restore();
}

interface MoteStyle {
  r: number;
  g: number;
  b: number;
  baseA: number;
  size: number;
  driftX: number;
  driftY: number;
  wobble: number;
  glow?: boolean;
  soft?: boolean;
}

/** Shared deterministic drifting-mote field used by several weather kinds. */
function drawMotes(
  ctx: CanvasRenderingContext2D,
  t: number,
  W: number,
  H: number,
  n: number,
  s: MoteStyle
): void {
  for (let i = 0; i < n; i++) {
    const seed = i * 53.7;
    const px = hash1(seed);
    const py = hash1(seed + 11);
    const phase = px * Math.PI * 2;
    // wrap positions over the screen with per-mote drift + sine wobble
    let x = (px * W + t * s.driftX + Math.sin(t * 0.6 + phase) * s.wobble) % (W + 40);
    let y = (py * H + t * s.driftY) % (H + 40);
    x = ((x % (W + 40)) + (W + 40)) % (W + 40) - 20;
    y = ((y % (H + 40)) + (H + 40)) % (H + 40) - 20;
    const tw = 0.6 + 0.4 * Math.sin(t * 2 + phase * 3); // twinkle
    const a = s.baseA * tw;
    const size = s.size * (0.7 + 0.6 * px);
    if (s.glow || s.soft) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, size * 2.4);
      g.addColorStop(0, `rgba(${s.r},${s.g},${s.b},${a})`);
      g.addColorStop(1, `rgba(${s.r},${s.g},${s.b},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, size * 2.4, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = `rgba(${s.r},${s.g},${s.b},${a})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ============================================================================
// 4. POST-PROCESS (screen space)
// ============================================================================

/** Named biome color-grade looks for {@link colorGrade}. */
export type GradePreset =
  | "none"
  | "rows" // open soil fields: warm, slightly faded
  | "greenhouse" // glass: cool green, humid
  | "catacombs" // stone: cold desaturated blue-black
  | "kingarena" // boss yard: bruised amber/red
  | "yard" // final yard: dusty sunset
  | "sodden"; // rain-soaked: cool muted blue

/**
 * Soft radial darkening at the screen edges. SCREEN space; call near the end of
 * the frame (after lighting/weather, around drawHUD). `strength` ~0..1.
 */
export function vignette(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  strength: number,
  color = "#000000"
): void {
  const s = clamp(strength, 0, 1);
  if (s <= 0.001) return;
  const c = parseColor(color);
  const cx = cssW / 2;
  const cy = cssH / 2;
  const r = Math.hypot(cx, cy);
  const g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
  g.addColorStop(0, `rgba(${c.r},${c.g},${c.b},0)`);
  g.addColorStop(1, `rgba(${c.r},${c.g},${c.b},${s})`);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.restore();
}

interface Grade {
  mult?: string; // multiply tint (darkens/colors)
  multA?: number; // multiply strength 0..1
  over?: string; // overlay/screen-ish additive tint
  overA?: number; // additive strength 0..1
}

const GRADES: Record<GradePreset, Grade> = {
  none: {},
  rows: { mult: "#ffe6b0", multA: 0.1, over: "#3a1e08", overA: 0.06 },
  greenhouse: { mult: "#bfeecf", multA: 0.16, over: "#0c3a22", overA: 0.05 },
  catacombs: { mult: "#9fb0c8", multA: 0.24, over: "#060814", overA: 0.14 },
  kingarena: { mult: "#ffb27a", multA: 0.14, over: "#5a0e08", overA: 0.12 },
  yard: { mult: "#ffcf9a", multA: 0.16, over: "#3a1404", overA: 0.1 },
  sodden: { mult: "#aac0d8", multA: 0.2, over: "#0a1622", overA: 0.1 },
};

/**
 * Applies a tasteful per-biome color grade (a multiply tint plus a faint
 * additive wash). SCREEN space; call after the world is drawn (after lighting,
 * before/with HUD so the HUD stays crisp). Cheap: two fullscreen fills max.
 */
export function colorGrade(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  preset: GradePreset
): void {
  const g = GRADES[preset];
  if (!g || (!g.mult && !g.over)) return;
  ctx.save();
  if (g.mult && (g.multA ?? 0) > 0) {
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = g.multA!;
    ctx.fillStyle = g.mult;
    ctx.fillRect(0, 0, cssW, cssH);
  }
  if (g.over && (g.overA ?? 0) > 0) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = g.overA!;
    ctx.fillStyle = g.over;
    ctx.fillRect(0, 0, cssW, cssH);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

/**
 * Full-screen color flash (hit feedback, heal pulse, boss phase). SCREEN space.
 * `alpha` 0..1; tints the whole screen with `color`. Call after the scene,
 * typically before the HUD so HUD text stays readable.
 */
export function flashScreen(
  ctx: CanvasRenderingContext2D,
  cssW: number,
  cssH: number,
  color: string,
  alpha: number
): void {
  const a = clamp(alpha, 0, 1);
  if (a <= 0.001) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = a;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ============================================================================
// 5. SCREEN SHAKE (trauma-based)
// ============================================================================

/**
 * Trauma-based screenshake. Add trauma on impacts; trauma decays each frame and
 * the visible offset uses trauma^2 (so small hits barely shake, big ones punch).
 * Read .x/.y each frame and add them to the engine's world translate.
 */
export class ScreenShake {
  private trauma = 0;
  private tt = 0;
  /** Current screen-space x offset in CSS px. */
  x = 0;
  /** Current screen-space y offset in CSS px. */
  y = 0;

  /** Max pixel offset at full trauma. */
  maxOffset: number;
  /** How fast trauma decays per second (1/secs-to-zero-ish). */
  decay: number;

  constructor(maxOffset = 16, decay = 1.4) {
    this.maxOffset = maxOffset;
    this.decay = decay;
  }

  /** Add trauma (0..1 scale; clamps). Map the engine's old `shake` ~/16 here. */
  add(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  /** Set trauma directly (0..1). */
  set(amount: number): void {
    this.trauma = clamp(amount, 0, 1);
  }

  /** Advance shake; updates .x/.y. Uses smooth noise so it doesn't jitter hard. */
  update(dt: number): void {
    this.tt += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const shake = this.trauma * this.trauma; // perceptual curve
    if (shake <= 0) {
      this.x = 0;
      this.y = 0;
      return;
    }
    const amp = shake * this.maxOffset;
    // two decorrelated smooth-ish noise channels
    const t = this.tt;
    this.x =
      amp *
      (Math.sin(t * 47.1) * 0.6 + Math.sin(t * 91.7 + 1.3) * 0.4);
    this.y =
      amp *
      (Math.sin(t * 53.7 + 2.1) * 0.6 + Math.sin(t * 83.3 + 0.7) * 0.4);
  }

  /** Current trauma (0..1), handy for chaining extra effects to big shakes. */
  get value(): number {
    return this.trauma;
  }
}

// ============================================================================
// Color utilities (shared, allocation-light)
// ============================================================================

interface RGB {
  r: number;
  g: number;
  b: number;
}

// tiny cache so repeated parses of the same literal don't re-run the regex
const _colorCache = new Map<string, RGB>();

/** Parse "#rgb"/"#rrggbb"/"rgb(...)"/"rgba(...)" to {r,g,b}. Cached. */
function parseColor(s: string): RGB {
  const hit = _colorCache.get(s);
  if (hit) return hit;
  let out: RGB = { r: 255, g: 255, b: 255 };
  const str = s.trim();
  if (str[0] === "#") {
    if (str.length === 4) {
      out = {
        r: parseInt(str[1] + str[1], 16),
        g: parseInt(str[2] + str[2], 16),
        b: parseInt(str[3] + str[3], 16),
      };
    } else if (str.length >= 7) {
      out = {
        r: parseInt(str.slice(1, 3), 16),
        g: parseInt(str.slice(3, 5), 16),
        b: parseInt(str.slice(5, 7), 16),
      };
    }
  } else if (str.startsWith("rgb")) {
    const m = str.match(/(\d+(?:\.\d+)?)/g);
    if (m && m.length >= 3) {
      out = { r: +m[0] | 0, g: +m[1] | 0, b: +m[2] | 0 };
    }
  }
  if (_colorCache.size < 256) _colorCache.set(s, out);
  return out;
}

/** Cheap deterministic hash -> [0,1). Used by weather (no RNG state, no leaks). */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
