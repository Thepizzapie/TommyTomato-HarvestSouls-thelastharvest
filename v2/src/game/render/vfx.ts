// vfx.ts — GPU-friendly particle + screen-FX system for the Pixi v8 (WebGL)
// renderer of Tommy Tomato: Harvest Souls. This is the v2 reimplementation of
// the v1 Canvas2D toolkit (src/game/core/vfx.ts); same effects palette and
// presets, but rebuilt to lean on the GPU: pooled `Particle`s inside
// `ParticleContainer`s, `ColorMatrixFilter`/`BlurFilter` post-processing, and
// allocation-free hot paths.
//
// ----------------------------------------------------------------------------
// COORDINATE SPACES (the integrator wires these into the render pipeline):
//   * ParticleSystem  -> WORLD space. Add it UNDER the camera/world container
//       so emit(preset, worldX, worldY) lines up with entities. Call
//       ParticleSystem.init(renderer) once, then update(dtMS) each frame.
//   * ScreenShake     -> yields x/y pixel offsets; add them to the camera/world
//       container position each frame (screen space displacement of the world).
//   * makeBloomFilters / gradeFor -> filters applied to a WORLD/scene layer
//       (Container.filters = [...]). They post-process whatever is under them.
//   * makeVignette / FlashOverlay -> SCREEN space overlays. Add on TOP of the
//       world (and usually under the HUD). Size them to the screen.
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Texture,
  Rectangle,
  FillGradient,
  ColorMatrixFilter,
  BlurFilter,
  type Renderer,
  type ColorSource,
} from "pixi.js";

// ============================================================================
// Small math helpers (module-local; no deps on the rest of the game)
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Cheap deterministic hash -> [0,1). Used for steady-state phase, not RNG. */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** Parse "#rgb"/"#rrggbb" to a 0xRRGGBB number. Cached. */
const _hexCache = new Map<string, number>();
function hexToNum(s: string): number {
  const hit = _hexCache.get(s);
  if (hit !== undefined) return hit;
  let out = 0xffffff;
  const str = s.trim();
  if (str[0] === "#") {
    if (str.length === 4) {
      const r = parseInt(str[1] + str[1], 16);
      const g = parseInt(str[2] + str[2], 16);
      const b = parseInt(str[3] + str[3], 16);
      out = (r << 16) | (g << 8) | b;
    } else if (str.length >= 7) {
      out = parseInt(str.slice(1, 7), 16);
    }
  }
  if (_hexCache.size < 256) _hexCache.set(s, out);
  return out;
}

// ============================================================================
// 1. PARTICLE SYSTEM
// ============================================================================

/** Named particle effect presets understood by ParticleSystem.emit(). */
export type ParticlePreset =
  | "blood" // tomato-pulp splats, gravity, fades to a smear
  | "leaf" // drifting leaf bits, slow wobble + spin
  | "spark" // additive hit sparks, fast, short-lived
  | "ember" // rising glowing fire embers (additive)
  | "dust" // footstep / landing puffs
  | "poison" // sickly green rising gas (additive)
  | "splash" // water droplets, gravity (additive sheen)
  | "heal" // blue rising motes (additive)
  | "sapglow" // golden glints (additive)
  | "death" // big mixed burst (pulp + sparks + ring)
  | "muzzle" // projectile spawn flash (additive)
  | "ring"; // expanding shockwave ring (additive)

/** Per-emit overrides. All optional; presets supply sensible defaults. */
export interface EmitOpts {
  color?: ColorSource; // base color (presets that mix colors may ignore)
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
  life: number; // seconds
  size: number; // px (texture is ~unit; scale derives from this)
  color: ColorSource;
  gravity?: number; // px/s^2 (default 0)
  drag?: number; // velocity retention per 1/60s (0..1, default 0.92)
  glow?: boolean; // additive blend (routes to the additive container)
  shape?: "rect" | "circle" | "ring"; // default circle (soft dot)
  spin?: number; // rad/s (visual)
  fade?: number; // 0..1 portion of life spent fading (default 1 = whole life)
  shrink?: boolean; // shrink scale toward 0 with life
}

/** 0 = soft circle, 1 = hard circle, 2 = square, 3 = ring. */
type ShapeId = 0 | 1 | 2 | 3;

/** Parallel simulation record for one pooled particle. */
interface P {
  spr: Particle; // the Pixi particle (lives in `add` or `norm` container)
  glow: boolean; // which container this slot belongs to
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size0: number; // base px size at spawn
  texScale: number; // px-size -> scale factor for the chosen texture
  gravity: number;
  drag: number;
  rot: number;
  spin: number;
  fade: number;
  shape: ShapeId;
  ring: boolean; // shape === ring (cached)
  shrink: boolean;
}

/** Hard cap on a single emit() burst so one call can't saturate the pool. */
function clampCount(n: number): number {
  return n < 0 ? 0 : n > 160 ? 160 : n | 0;
}

/**
 * Pooled, count-capped particle system rendered on the GPU.
 *
 * Internally holds two {@link ParticleContainer}s — one `normal`-blend and one
 * `add`-blend — and a fixed pool of {@link Particle}s split between them. After
 * init NOTHING is allocated per frame and no particles are added/removed from
 * the containers (dead particles are parked at alpha 0). emit() pops free slots
 * from the matching blend pool; update() advances live particles and parks the
 * expired ones.
 *
 * WORLD space: add this Container under the camera/world container.
 */
export class ParticleSystem extends Container {
  /** Additive-blend particle layer (spark/ember/heal/etc + rings). */
  private readonly addLayer: ParticleContainer;
  /** Normal-blend particle layer (blood/leaf/dust/etc). */
  private readonly normLayer: ParticleContainer;

  private readonly cap: number;
  private readonly addPool: P[] = [];
  private readonly normPool: P[] = [];
  private addFree: number[] = []; // stack of free indices into addPool
  private normFree: number[] = []; // stack of free indices into normPool
  private aliveCount = 0;

  // Shape textures — all sub-frames of ONE shared atlas source (built in
  // `init`). A ParticleContainer requires a single texture source for all its
  // particles, so the 4 shapes are tiles of one generated atlas; per-particle
  // frame selection works because `uvs` is a dynamic property. Until init they
  // are Texture.WHITE so the system is safe to construct before the renderer.
  private atlas: Texture = Texture.WHITE; // the generated atlas (keeps source)
  private texByShape: Texture[] = [Texture.WHITE, Texture.WHITE, Texture.WHITE, Texture.WHITE];
  // Per-shape px->scale divisor (the tile's drawn size in px).
  private divByShape: number[] = [1, 1, 1, 1];
  private ready = false;

  /**
   * @param cap Total particle pool capacity (split evenly across the two blend
   *   layers). ~2000 is comfortable for this game.
   */
  constructor(cap = 2000) {
    super();
    this.cap = cap;
    const half = Math.max(2, cap >> 1);

    // Which per-particle attributes upload every frame:
    //  - vertex: scaleX/scaleY + anchor are baked into the vertex quad in Pixi
    //    v8 (there is NO separate `scale` property), and we animate scale each
    //    frame (shrink / ring growth) -> must be dynamic.
    //  - position, rotation, color (tint*alpha): all animate -> dynamic.
    //  - uvs: dynamic so a pooled slot can switch shape FRAME (soft/hard/square/
    //    ring) when reused. All shapes live in ONE shared atlas source, which is
    //    what ParticleContainer requires (single texture source per container).
    const dyn = {
      vertex: true,
      position: true,
      rotation: true,
      color: true,
      uvs: true,
    };
    this.addLayer = new ParticleContainer({ dynamicProperties: dyn });
    this.addLayer.blendMode = "add";
    this.normLayer = new ParticleContainer({ dynamicProperties: dyn });
    this.normLayer.blendMode = "normal";
    // additive on top reads as light over the opaque pass.
    this.addChild(this.normLayer);
    this.addChild(this.addLayer);

    this.buildPool(this.addPool, this.addFree, this.addLayer, half, true);
    this.buildPool(this.normPool, this.normFree, this.normLayer, half, false);
  }

  private buildPool(
    pool: P[],
    free: number[],
    layer: ParticleContainer,
    n: number,
    glow: boolean
  ): void {
    for (let i = 0; i < n; i++) {
      const spr = new Particle({
        texture: this.texByShape[0],
        x: 0,
        y: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        scaleX: 1,
        scaleY: 1,
        alpha: 0,
        tint: 0xffffff,
      });
      layer.addParticle(spr);
      pool.push({
        spr,
        glow,
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        max: 1,
        size0: 1,
        texScale: 1,
        gravity: 0,
        drag: 0.92,
        rot: 0,
        spin: 0,
        fade: 1,
        shape: 0,
        ring: false,
        shrink: false,
      });
      free.push(i);
    }
  }

  /**
   * Generate the GPU base textures from a renderer. Call ONCE after the Pixi
   * app/renderer exists (e.g. right after `app.init`). Safe to call again to
   * re-bake at a different resolution; existing live particles keep rendering.
   */
  init(renderer: Renderer): void {
    // Build ONE atlas: 4 tiles in a row (soft, hard, square, ring), each TILE
    // wide with PAD gutters so linear sampling doesn't bleed between tiles.
    const TILE = 64;
    const PAD = 4;
    const R = TILE / 2;
    const g = new Graphics();

    // tile 0: soft radial dot (white core -> transparent). The workhorse.
    {
      const cx = PAD + R;
      const cy = R;
      const steps = 12;
      for (let i = steps; i >= 1; i--) {
        const t = i / steps;
        g.circle(cx, cy, R * 0.94 * t).fill({ color: 0xffffff, alpha: 0.14 });
      }
    }
    // tile 1: hard dot (crisp filled circle).
    {
      const cx = (PAD + TILE) * 1 + PAD + R;
      g.circle(cx, R, R * 0.9).fill(0xffffff);
    }
    // tile 2: square (chunky pulp / leaf bits).
    {
      const x = (PAD + TILE) * 2 + PAD;
      const m = TILE * 0.12; // small inset so AA edges stay inside the tile
      g.rect(x + m, m, TILE - 2 * m, TILE - 2 * m).fill(0xffffff);
    }
    // tile 3: ring (hollow stroked circle -> shockwaves).
    {
      const cx = (PAD + TILE) * 3 + PAD + R;
      g.circle(cx, R, R * 0.82).stroke({ color: 0xffffff, width: R * 0.16, alignment: 0.5 });
    }

    this.atlas = renderer.generateTexture({
      target: g,
      resolution: 1,
      antialias: true,
    });
    g.destroy();

    // Slice the atlas into 4 sub-frame Textures sharing the same source.
    const src = this.atlas.source;
    const frames = [
      new Rectangle(PAD, 0, TILE, TILE),
      new Rectangle((PAD + TILE) * 1 + PAD, 0, TILE, TILE),
      new Rectangle((PAD + TILE) * 2 + PAD, 0, TILE, TILE),
      new Rectangle((PAD + TILE) * 3 + PAD, 0, TILE, TILE),
    ];
    for (let i = 0; i < 4; i++) {
      this.texByShape[i] = new Texture({ source: src, frame: frames[i] });
      // drawn footprint of the tile in px (used to map px-size -> scale).
      this.divByShape[i] = TILE;
    }

    // retarget every parked pooled particle to the soft tile + recompute scale.
    this.retexture(this.addPool);
    this.retexture(this.normPool);
    this.ready = true;
  }

  private retexture(pool: P[]): void {
    const soft = this.texByShape[0];
    const div = this.divByShape[0];
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.active) {
        p.spr.texture = soft;
        p.texScale = 1 / div;
      }
    }
  }

  /** Number of currently-alive particles. */
  get count(): number {
    return this.aliveCount;
  }

  /** Park every particle (instant clear). */
  clear(): void {
    this.parkAll(this.addPool, this.addFree);
    this.parkAll(this.normPool, this.normFree);
    this.aliveCount = 0;
  }

  private parkAll(pool: P[], free: number[]): void {
    free.length = 0;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      p.active = false;
      p.spr.alpha = 0;
      free.push(i);
    }
  }

  private texForShape(shape: ShapeId): { tex: Texture; div: number } {
    return { tex: this.texByShape[shape], div: this.divByShape[shape] };
  }

  /**
   * Low-level spawn of one particle. Routes to the additive or normal pool by
   * `glow`. Returns false if that pool has no free slot (burst is dropped, the
   * frame stays cheap). No allocation.
   */
  spawn(o: SpawnOpts): boolean {
    const glow = o.glow ?? false;
    const pool = glow ? this.addPool : this.normPool;
    const free = glow ? this.addFree : this.normFree;
    const idx = free.pop();
    if (idx === undefined) return false;

    const p = pool[idx];
    const shape: ShapeId =
      o.shape === "rect"
        ? 2
        : o.shape === "ring"
        ? 3
        : o.shape === "circle"
        ? 1
        : 0;
    const { tex, div } = this.texForShape(shape);

    p.active = true;
    p.x = o.x;
    p.y = o.y;
    p.vx = o.vx;
    p.vy = o.vy;
    p.life = o.life;
    p.max = o.life;
    p.size0 = o.size;
    p.texScale = 1 / div;
    p.gravity = o.gravity ?? 0;
    p.drag = o.drag ?? 0.92;
    p.rot = 0;
    p.spin = o.spin ?? 0;
    p.fade = o.fade ?? 1;
    p.shape = shape;
    p.ring = shape === 3;
    p.shrink = o.shrink ?? false;

    const spr = p.spr;
    spr.texture = tex;
    spr.tint = o.color;
    spr.x = o.x;
    spr.y = o.y;
    spr.rotation = 0;
    spr.alpha = 1;
    const sc = o.size * p.texScale;
    spr.scaleX = sc;
    spr.scaleY = sc;

    this.aliveCount++;
    return true;
  }

  /**
   * Emit a preset burst at WORLD (x,y). `opts` overrides preset defaults.
   * Counts are clamped so a single emit can never blow the pool.
   *
   * NOTE: `Container` inherits EventEmitter's `emit(event, ...args)`. We keep
   * the spec'd `emit(preset, x, y, opts?)` as the primary API and provide an
   * overload so the inherited event form still type-checks (a ParticleSystem
   * is never used as an event bus, but this keeps it 100% compatible).
   */
  emit(preset: ParticlePreset, x: number, y: number, opts?: EmitOpts): void;
  emit(event: string | symbol, ...args: unknown[]): boolean;
  emit(
    preset: ParticlePreset | string | symbol,
    x?: number | unknown,
    y?: number | unknown,
    opts?: EmitOpts | unknown,
    ...rest: unknown[]
  ): void | boolean {
    // Event-emitter form: anything that isn't our (preset, number, number)
    // shape is delegated to the inherited EventEmitter.emit.
    if (typeof preset !== "string" || typeof x !== "number" || typeof y !== "number") {
      return super.emit(
        preset as never,
        x as never,
        y as never,
        opts as never,
        ...(rest as never[])
      );
    }
    this.emitBurst(preset as ParticlePreset, x, y, (opts as EmitOpts) ?? {});
  }

  /** Internal burst dispatcher (the real work behind {@link emit}). */
  private emitBurst(
    preset: ParticlePreset,
    x: number,
    y: number,
    opts: EmitOpts = {}
  ): void {
    const a0 = opts.angle;
    const full = a0 === undefined;
    const center = a0 ?? 0;
    const spread = opts.spread ?? (full ? Math.PI : 0.6);
    const ang = (): number =>
      full
        ? Math.random() * Math.PI * 2
        : center + (Math.random() * 2 - 1) * spread;

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
            size: (opts.size ?? 4) * (0.7 + Math.random()),
            color: opts.color ?? (Math.random() < 0.3 ? 0x7d1d1d : 0xb21f1f),
            gravity: opts.gravity ?? 520,
            drag: 0.9,
            shape: Math.random() < 0.4 ? "circle" : "rect",
            spin: (Math.random() * 2 - 1) * 5,
            shrink: true,
          });
        }
        break;
      }
      case "death": {
        // big mixed burst: pulp + sparks + a shockwave ring
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
            size: 3 + Math.random() * 5,
            color: Math.random() < 0.5 ? 0xb21f1f : 0x7d9a3a,
            gravity: 480,
            drag: 0.9,
            shape: Math.random() < 0.4 ? "circle" : "rect",
            spin: (Math.random() * 2 - 1) * 6,
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
            size: 5,
            color: 0xffd56b,
            drag: 0.86,
            glow: true,
            shrink: true,
          });
        }
        this.spawn({
          x,
          y,
          vx: 0,
          vy: 0,
          life: 0.4,
          size: 22,
          color: opts.color ?? 0xffe7a0,
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
            size: (opts.size ?? 5) * (0.7 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? 0x4e7a2e : 0x7d9a3a),
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
            size: (opts.size ?? 4) * (0.6 + Math.random()),
            color: opts.color ?? 0xfff2c0,
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
            size: (opts.size ?? 4) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? 0xffb347 : 0xff7a3a),
            gravity: opts.gravity ?? -20,
            drag: 0.96,
            glow: true,
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
            size: (opts.size ?? 7) * (0.8 + Math.random()),
            color: opts.color ?? 0xa98a5a,
            drag: 0.88,
            shape: "circle",
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
            size: (opts.size ?? 10) * (0.7 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? 0x7db32e : 0x9fd44e),
            gravity: -10,
            drag: 0.97,
            glow: true,
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
            size: (opts.size ?? 4) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? 0x86c5e6 : 0xbfe3f2),
            gravity: opts.gravity ?? 600,
            drag: 0.93,
            glow: true,
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
            size: (opts.size ?? 5) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? 0x7ac0ff : 0xbfe3ff),
            gravity: -30,
            drag: 0.97,
            glow: true,
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
            size: (opts.size ?? 4) * (0.6 + Math.random()),
            color: opts.color ?? (Math.random() < 0.5 ? 0xffd56b : 0xffe7a0),
            gravity: -8,
            drag: 0.96,
            glow: true,
            shrink: true,
          });
        }
        break;
      }
      case "muzzle": {
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
            size: (opts.size ?? 4) * (0.6 + Math.random()),
            color: opts.color ?? 0xfff2c0,
            drag: 0.82,
            glow: true,
            shrink: true,
          });
        }
        this.spawn({
          x,
          y,
          vx: 0,
          vy: 0,
          life: 0.16,
          size: (opts.size ?? 10),
          color: opts.color ?? 0xffe7a0,
          glow: true,
          shape: "ring",
        });
        break;
      }
      case "ring": {
        this.spawn({
          x,
          y,
          vx: 0,
          vy: 0,
          life: opts.life ?? 0.4,
          size: opts.size ?? 24,
          color: opts.color ?? 0xffffff,
          glow: true,
          shape: "ring",
        });
        break;
      }
    }
  }

  /**
   * Advance the simulation by `dtMS` milliseconds, syncing each live particle's
   * transform/alpha onto its Pixi `Particle`, and parking the expired ones.
   * No allocation. Call once per frame.
   */
  update(dtMS: number): void {
    const dt = dtMS * 0.001;
    if (dt <= 0) return;
    this.step(this.addPool, this.addFree, dt);
    this.step(this.normPool, this.normFree, dt);
  }

  private step(pool: P[], free: number[], dt: number): void {
    const dragPow = dt * 60;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        p.spr.alpha = 0;
        free.push(i);
        this.aliveCount--;
        continue;
      }

      p.vy += p.gravity * dt;
      const d = Math.pow(p.drag, dragPow);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;

      const k = p.life / p.max; // 1 -> 0
      const spr = p.spr;
      spr.x = p.x;
      spr.y = p.y;
      spr.rotation = p.rot;
      spr.alpha = p.fade >= 1 ? k : clamp(k / p.fade, 0, 1);

      if (p.ring) {
        // expanding shockwave: grow scale, fade handled above.
        const grow = 1 - k; // 0 -> 1
        const sc = (p.size0 + grow * p.size0 * 5) * p.texScale;
        spr.scaleX = sc;
        spr.scaleY = sc;
      } else if (p.shrink) {
        const sc = p.size0 * (0.25 + 0.75 * k) * p.texScale;
        spr.scaleX = sc;
        spr.scaleY = sc;
      }
    }
  }

  /** Release GPU resources. Destroys the atlas + sub-frames + containers. */
  destroy(): void {
    if (this.ready) {
      // Sub-frame textures share the atlas source; free the frames without
      // touching the source, then destroy the atlas (which frees the source).
      for (let i = 0; i < this.texByShape.length; i++) {
        const t = this.texByShape[i];
        if (t !== Texture.WHITE && t !== this.atlas) t.destroy(false);
        this.texByShape[i] = Texture.WHITE;
      }
      if (this.atlas !== Texture.WHITE) this.atlas.destroy(true);
      this.atlas = Texture.WHITE;
      this.ready = false;
    }
    super.destroy({ children: true });
  }
}

// ============================================================================
// 2. SCREEN SHAKE (trauma-based)
// ============================================================================

/**
 * Trauma-based screenshake. Add trauma on impacts; trauma decays each frame and
 * the visible offset uses trauma^2 (small hits barely shake, big ones punch).
 * Read .x/.y each frame and add them to the camera/world container position.
 */
export class ScreenShake {
  private trauma = 0;
  private tt = 0;
  /** Current screen-space x offset in px. */
  x = 0;
  /** Current screen-space y offset in px. */
  y = 0;

  /** Max pixel offset at full trauma. */
  maxOffset: number;
  /** Trauma decayed per second. */
  decay: number;

  constructor(maxOffset = 16, decay = 1.4) {
    this.maxOffset = maxOffset;
    this.decay = decay;
  }

  /** Add trauma (0..1 scale; clamps). */
  add(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, 1);
  }

  /** Set trauma directly (0..1). */
  set(amount: number): void {
    this.trauma = clamp(amount, 0, 1);
  }

  /** Advance shake; updates .x/.y. `dtMS` in milliseconds. */
  update(dtMS: number): void {
    const dt = dtMS * 0.001;
    this.tt += dt;
    this.trauma = Math.max(0, this.trauma - this.decay * dt);
    const shake = this.trauma * this.trauma;
    if (shake <= 0) {
      this.x = 0;
      this.y = 0;
      return;
    }
    const amp = shake * this.maxOffset;
    const t = this.tt;
    this.x = amp * (Math.sin(t * 47.1) * 0.6 + Math.sin(t * 91.7 + 1.3) * 0.4);
    this.y = amp * (Math.sin(t * 53.7 + 2.1) * 0.6 + Math.sin(t * 83.3 + 0.7) * 0.4);
  }

  /** Current trauma (0..1). */
  get value(): number {
    return this.trauma;
  }
}

// ============================================================================
// 3. POST-PROCESS — bloom, vignette, color grade, flash
// ============================================================================

/** A cheap "bloom-ish" glow built from filters you assign to a scene layer. */
export interface BloomFilters {
  /** Soft blur — the glow spread. */
  blur: BlurFilter;
  /** Brightness/contrast lift that fakes a bright-pass + tone. */
  grade: ColorMatrixFilter;
  /** Both, in render order, for `layer.filters = bloom.filters`. */
  filters: [ColorMatrixFilter, BlurFilter];
  /** Dial the glow 0..1 (scales blur strength + filter blend). */
  setStrength(s01: number): void;
}

/**
 * Build a cheap bloom-ish post chain. Assign `makeBloomFilters().filters` to a
 * Container that holds the lit/glowy scene (e.g. the world container or a
 * dedicated "glow" layer). It is NOT a true threshold bloom — it's a tasteful
 * blur + brightness/contrast lift, which on additive particles + bright sprites
 * reads as a glow for a fraction of the cost. Keep the layer count modest.
 *
 * WORLD/scene space (it post-processes whatever is under the layer).
 */
export function makeBloomFilters(strength = 0.6): BloomFilters {
  const blur = new BlurFilter({
    strength: 8,
    quality: 3,
    kernelSize: 5,
  });
  blur.repeatEdgePixels = true;

  const grade = new ColorMatrixFilter();

  const out: BloomFilters = {
    blur,
    grade,
    filters: [grade, blur],
    setStrength(s01: number) {
      const s = clamp(s01, 0, 1);
      // BlurFilter has no alpha; glow spread is purely its strength. The grade
      // filter (which DOES have .alpha) carries the bright-pass lift + blend.
      blur.strength = 2 + s * 12;
      grade.reset();
      grade.brightness(1 + s * 0.12, true);
      grade.contrast(0.12 + s * 0.18, true);
      grade.saturate(s * 0.25, true);
      grade.alpha = 0.5 + s * 0.4;
    },
  };
  out.setStrength(strength);
  return out;
}

/**
 * A SCREEN-space vignette overlay (soft radial edge darkening). Add on top of
 * the world (usually under the HUD). Call {@link Vignette.resize} on viewport
 * change. Built from a single radial {@link FillGradient} (transparent center
 * -> dark rim) filled into a full-screen rect — one draw, no per-frame work.
 */
export class Vignette extends Container {
  private gfx: Graphics;
  private color: ColorSource;
  private strength: number;
  private w: number;
  private h: number;

  constructor(w: number, h: number, strength = 0.55, color: ColorSource = 0x000000) {
    super();
    this.w = w;
    this.h = h;
    this.strength = clamp(strength, 0, 1);
    this.color = color;
    this.gfx = new Graphics();
    this.addChild(this.gfx);
    this.redraw();
  }

  /** Resize to the screen and re-bake the gradient. */
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.redraw();
  }

  /** Set vignette darkness 0..1. */
  setStrength(s01: number): void {
    this.strength = clamp(s01, 0, 1);
    this.redraw();
  }

  private redraw(): void {
    const g = this.gfx;
    g.clear();
    const cx = this.w / 2;
    const cy = this.h / 2;
    const rMax = Math.hypot(cx, cy);
    const baseHex = hexToNum(typeof this.color === "string" ? this.color : "#000000");
    const colNum = typeof this.color === "number" ? this.color : baseHex;
    // Normalized RGB of the vignette color (0..1).
    const r = ((colNum >> 16) & 0xff) / 255;
    const gg = ((colNum >> 8) & 0xff) / 255;
    const b = (colNum & 0xff) / 255;
    const s = clamp(this.strength, 0, 1);
    // Radial gradient in GLOBAL (pixel) space so it matches the rect exactly:
    // fully transparent out to ~55% of the corner radius, then ramps to the
    // dark rim at `strength` alpha. RGBA color stops as normalized [r,g,b,a].
    const grad = new FillGradient({
      type: "radial",
      center: { x: cx, y: cy },
      innerRadius: rMax * 0.55,
      outerCenter: { x: cx, y: cy },
      outerRadius: rMax,
      textureSpace: "global",
      colorStops: [
        { offset: 0, color: [r, gg, b, 0] },
        { offset: 0.6, color: [r, gg, b, s * 0.35] },
        { offset: 1, color: [r, gg, b, s] },
      ],
    });
    g.rect(0, 0, this.w, this.h).fill(grad);
  }
}

/**
 * Convenience factory matching the spec's `makeVignette(w,h)` shape: returns a
 * SCREEN-space {@link Vignette} Container ready to add on top of the world.
 */
export function makeVignette(
  w: number,
  h: number,
  strength = 0.55,
  color: ColorSource = 0x000000
): Vignette {
  return new Vignette(w, h, strength, color);
}

/** Named biome color-grade looks for {@link gradeFor}. */
export type BiomePreset =
  | "none"
  | "rows" // open soil fields: warm, slightly faded
  | "greenhouse" // glass: cool green, humid
  | "catacombs" // stone: cold desaturated blue-black
  | "kingarena" // boss yard: bruised amber/red
  | "yard" // final yard: dusty sunset
  | "sodden"; // rain-soaked: cool muted blue

interface GradeSpec {
  saturate: number; // -1..1 (negative desaturates)
  brightness: number; // ~1 nominal
  contrast: number; // 0..1
  tint?: number; // multiplied tint
  tintA?: number; // 0..1 strength of the tint pass (via filter alpha mix)
  hue?: number; // degrees
}

const GRADES: Record<BiomePreset, GradeSpec> = {
  none: { saturate: 0, brightness: 1, contrast: 0 },
  rows: { saturate: 0.08, brightness: 1.04, contrast: 0.12, tint: 0xffe6b0, tintA: 0.12 },
  greenhouse: { saturate: 0.14, brightness: 1.0, contrast: 0.1, tint: 0xbfeecf, tintA: 0.16, hue: -6 },
  catacombs: { saturate: -0.45, brightness: 0.82, contrast: 0.22, tint: 0x9fb0c8, tintA: 0.26, hue: 6 },
  kingarena: { saturate: 0.18, brightness: 0.92, contrast: 0.2, tint: 0xffb27a, tintA: 0.18, hue: -4 },
  yard: { saturate: 0.1, brightness: 0.98, contrast: 0.16, tint: 0xffcf9a, tintA: 0.18 },
  sodden: { saturate: -0.2, brightness: 0.88, contrast: 0.14, tint: 0xaac0d8, tintA: 0.2, hue: 8 },
};

/**
 * Build a {@link ColorMatrixFilter} for a biome look. Assign it to the scene
 * layer's `filters` (often together with bloom). Cheap: a single matrix filter.
 *
 * WORLD/scene space.
 */
export function gradeFor(biome: BiomePreset): ColorMatrixFilter {
  const f = new ColorMatrixFilter();
  applyGrade(f, biome);
  return f;
}

/** Re-apply a biome look to an existing filter (e.g. on biome change). */
export function applyGrade(f: ColorMatrixFilter, biome: BiomePreset): void {
  const g = GRADES[biome] ?? GRADES.none;
  f.reset();
  if (g.hue) f.hue(g.hue, true);
  f.saturate(g.saturate, true);
  f.brightness(g.brightness, true);
  f.contrast(g.contrast, true);
  if (g.tint && g.tintA) {
    f.tint(g.tint, true);
    // ColorMatrixFilter.tint is full-strength; soften it by blending the whole
    // filter result toward the source via alpha when the tint dominates.
    f.alpha = clamp(0.7 + g.tintA, 0, 1);
  }
}

/**
 * A SCREEN-space full-screen color flash overlay (hit feedback, heal pulse,
 * boss phase). Add on top of the world (usually under the HUD). Drive it with
 * `flash(color, alpha01)` on the event, then `update(dtMS)` each frame to decay.
 */
export class FlashOverlay extends Container {
  private gfx: Graphics;
  private w: number;
  private h: number;
  private a = 0; // current alpha
  private decayPerSec: number;
  private curColor = 0xffffff;

  constructor(w: number, h: number, decayPerSec = 4) {
    super();
    this.w = w;
    this.h = h;
    this.decayPerSec = decayPerSec;
    this.gfx = new Graphics();
    this.addChild(this.gfx);
    this.redraw();
    this.alpha = 0;
  }

  /** Resize to the screen. */
  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.redraw();
  }

  private redraw(): void {
    this.gfx.clear();
    this.gfx.rect(0, 0, this.w, this.h).fill(0xffffff);
  }

  /**
   * Trigger a flash. `alpha01` is the peak opacity; the strongest active flash
   * wins (so rapid hits don't dim each other). Color tints the whole screen.
   */
  flash(color: ColorSource, alpha01: number): void {
    const a = clamp(alpha01, 0, 1);
    if (a <= this.a) {
      // keep the brighter ongoing flash, but allow color refresh if equal-ish
      return;
    }
    this.a = a;
    this.curColor = hexToNum(typeof color === "string" ? color : "#ffffff");
    if (typeof color === "number") this.curColor = color;
    this.gfx.tint = this.curColor;
    this.alpha = this.a;
  }

  /** Decay the flash. `dtMS` in milliseconds. */
  update(dtMS: number): void {
    if (this.a <= 0) {
      if (this.alpha !== 0) this.alpha = 0;
      return;
    }
    this.a = Math.max(0, this.a - this.decayPerSec * dtMS * 0.001);
    this.alpha = this.a;
  }
}
