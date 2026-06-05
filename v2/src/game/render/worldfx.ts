// worldfx.ts — detailed PROCEDURAL renderer for projectiles, pickups, and husks
// in the Pixi v8 (WebGL) renderer of Tommy Tomato: Harvest Souls. Everything is
// drawn in code (no art assets): glowing lobbed orbs with motion trails, bobbing
// pickups (estus flask / sap droplet / planted weapon / charm ring / iron key),
// and the soulslike "bloodstain" husk where you died.
//
// These read against a dark, lit world, so they POP: additive glow halos, bright
// cores, specular highlights, and rising motes. Detail silhouettes are drawn with
// `Graphics`; the soft glows are a single baked radial texture reused across many
// pooled additive `Sprite`s (cheap, GPU-friendly — the lighting.ts trick), so the
// hot per-frame path is transform/tint/alpha writes, not gradient rebuilds.
//
// ----------------------------------------------------------------------------
// COORDINATE SPACE:
//   WORLD space. Add this Container UNDER the camera/world container, near the
//   entity/actor layer (it shares the same world coordinates as entities). It is
//   self-sorting front-to-back via child zIndex so lobbed orbs and pickup bodies
//   layer correctly over their ground shadows.
//
// LIFECYCLE:
//   1. const fx = new WorldFxLayer();  scene.addChild(fx);
//   2. fx.init(renderer);              // bake the shared glow texture (once)
//   3. every frame: fx.update(state, t);   // t = seconds (drives all animation)
//
// POOLING: display objects are keyed by projectile/pickup id — created when an id
// first appears, reused while it lives, and parked (hidden) then reclaimed when
// the id is gone. Husks are few, so they pool by index and rebuild on change.
// Nothing is allocated on the steady-state hot path.
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  Sprite,
  Texture,
  type Renderer,
} from "pixi.js";

import type { WorldState, Projectile, Pickup, Husk, PickupKind } from "@/game/sim/types";

// ============================================================================
// Palette (harvest gothic — matches the rest of the renderer)
// ============================================================================

const OUTLINE = 0x140d0a;
const TOMATO = 0xd83a2e;
const TOMATO_BRIGHT = 0xff5742;
const SAP = 0xe8b53a;
const SAP_BRIGHT = 0xffd56b;
const ROT_BRIGHT = 0x9fd44e;
const EMBER = 0xff7a3a;
const HEAL_BLUE = 0x7ac0ff;
const HEAL_BLUE_DK = 0x3a8bd8;
const PARCH = 0xe9dcc0;
const STEEL = 0xd7dbe2;

// Projectile color hints the sim sends (used to branch flavor: drip / sparkle /
// crackle). Compared against the parsed hex of `projectile.color`.
const POISON_HEX = 0x9fd44e; // "#9fd44e"
const SLAM_HEX = 0xff7a3a; // "#ff7a3a"
const NOVA_HEX = 0xffd56b; // "#ffd56b"

// How high (px) the orb / pickup body floats above its true (x,y) ground point.
const LIFT = 12;

// ============================================================================
// Small helpers (module-local; no deps on the rest of the game)
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
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

/** Blend two 0xRRGGBB colors by t (0 = a, 1 = b). */
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = (ar + (br - ar) * t) | 0;
  const g = (ag + (bg - ag) * t) | 0;
  const bl = (ab + (bb - ab) * t) | 0;
  return (r << 16) | (g << 8) | bl;
}

/** Lighten a color toward white by t. */
function lighten(c: number, t: number): number {
  return mix(c, 0xffffff, t);
}

/** Cheap deterministic hash -> [0,1). For stable per-entity phase, not RNG. */
function hash1(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// ============================================================================
// Baked glow texture
// ============================================================================
//
// One soft radial sprite source (white hot core -> transparent rim), reused by
// every additive glow in the scene. Built once from the renderer in init(). All
// halos/motes are this Sprite, recolored via .tint and resized via .scale —
// no per-frame gradient draws. anchor 0.5; the texture's radius == half its
// width, so worldRadius -> scale = (2*worldRadius)/texSize.

function makeGlowTexture(renderer: Renderer): { tex: Texture; size: number } {
  const R = 64;
  const g = new Graphics();
  const steps = 16;
  for (let i = steps; i >= 1; i--) {
    const t = i / steps; // 1 (rim) -> ~0 (core)
    // quadratic core bias: hot center, long soft falloff
    const a = (1 - t) * (1 - t) * 0.92;
    g.circle(R, R, R * t).fill({ color: 0xffffff, alpha: a });
  }
  const tex = renderer.generateTexture({ target: g, resolution: 1, antialias: true });
  g.destroy();
  return { tex, size: tex.width };
}

// ============================================================================
// Projectile node
// ============================================================================
//
// A lobbed glowing orb. Layered bottom-to-top:
//   [shadow]  faint additive-off dark blob at the TRUE (x,y) ground point
//   [trail]   N additive glow ghosts behind the orb, fading with distance
//   [halo]    big pulsing additive glow, tinted by color, at the LIFTED orb
//   [core]    Graphics: crisp orb body + rim + specular + flavor bits
//   [flavor]  per-color motes (poison drips / nova sparkles / slam crackle)
//
// The whole node sits at the orb's screen position; the shadow is offset back
// down by LIFT so the orb reads as lobbed above the ground.

const TRAIL_MAX = 5; // hard cap on trail ghosts per projectile

class ProjectileNode extends Container {
  readonly shadow: Sprite;
  readonly halo: Sprite;
  readonly trail: Sprite[] = [];
  readonly motes: Sprite[] = [];
  readonly core: Graphics;

  // Pre-allocated ring buffer of recent world positions for the motion trail:
  // 2 floats (x,y) per sample, no per-frame allocation. `head` indexes the slot
  // the NEXT sample will be written to; `count` ramps up to TRAIL_MAX.
  private readonly samples = new Float64Array(TRAIL_MAX * 2);
  private head = 0;
  private count = 0;
  private lastColor = -1;
  private lastR = -1;

  constructor(glow: Texture, glowSize: number) {
    super();
    this.sortableChildren = true;

    // ground shadow (dark soft blob, NORMAL blend so it darkens the floor)
    this.shadow = new Sprite(glow);
    this.shadow.anchor.set(0.5);
    this.shadow.tint = 0x000000;
    this.shadow.alpha = 0.34;
    this.shadow.zIndex = 0;
    this.addChild(this.shadow);

    // motion-trail ghosts (additive), farthest/faintest first
    for (let i = 0; i < TRAIL_MAX; i++) {
      const s = new Sprite(glow);
      s.anchor.set(0.5);
      s.blendMode = "add";
      s.alpha = 0;
      s.zIndex = 1;
      this.trail.push(s);
      this.addChild(s);
    }

    // big soft halo behind the orb (additive, pulses)
    this.halo = new Sprite(glow);
    this.halo.anchor.set(0.5);
    this.halo.blendMode = "add";
    this.halo.zIndex = 2;
    this.addChild(this.halo);

    // crisp orb body + specular (redrawn each frame; a few cheap arcs)
    this.core = new Graphics();
    this.core.zIndex = 3;
    this.addChild(this.core);

    // flavor motes (additive sparks/drips/crackle) on top of the core
    for (let i = 0; i < 4; i++) {
      const m = new Sprite(glow);
      m.anchor.set(0.5);
      m.blendMode = "add";
      m.alpha = 0;
      m.zIndex = 4;
      this.motes.push(m);
      this.addChild(m);
    }

    this.glowSize = glowSize;
  }

  private glowSize: number;

  /** Reset transient state when this node is reclaimed for a new projectile. */
  recycle(): void {
    this.head = 0;
    this.count = 0;
    this.lastColor = -1;
    this.lastR = -1;
    for (const s of this.trail) s.alpha = 0;
    for (const m of this.motes) m.alpha = 0;
  }

  update(p: Projectile, t: number): void {
    const col = hexToNum(p.color);
    const bright = lighten(col, 0.55);
    const r = p.r;
    const gscale = (px: number): number => (2 * px) / this.glowSize;

    // record a trail sample (WORLD space; converted to local below) into the
    // pre-allocated ring buffer — one write, no allocation. Capped to TRAIL_MAX.
    this.samples[this.head * 2] = p.x;
    this.samples[this.head * 2 + 1] = p.y;
    this.head = (this.head + 1) % TRAIL_MAX;
    if (this.count < TRAIL_MAX) this.count++;

    // place the node at the LIFTED orb position; everything else is local.
    this.x = p.x;
    this.y = p.y - LIFT;

    // --- ground shadow at the true (x,y): shift back down by LIFT, local ---
    // smaller + tighter the higher it floats (constant LIFT here, so steady).
    this.shadow.y = LIFT;
    const shScale = gscale(r * 1.5);
    this.shadow.scale.set(shScale, shScale * 0.42);
    this.shadow.alpha = 0.3;

    // --- motion trail: draw ghosts at recent positions, fading to the orb ---
    // The newest sample (head-1) is where the orb itself is; ghosts walk back
    // from (head-2) outward, brightest -> faintest. We have `count` samples, so
    // up to (count-1) ghosts exist.
    const ghosts = this.count - 1; // how many real ghost positions we have
    for (let i = 0; i < TRAIL_MAX; i++) {
      const s = this.trail[i];
      if (i >= ghosts) {
        s.alpha = 0; // not enough history yet
        continue;
      }
      const age = i; // 0 = first ghost behind the orb
      // ring index of sample (head-2-age), wrapped into [0,TRAIL_MAX)
      const idx = (this.head - 2 - age + TRAIL_MAX * 2) % TRAIL_MAX;
      const sx = this.samples[idx * 2];
      const sy = this.samples[idx * 2 + 1];
      const f = 1 - age / TRAIL_MAX; // 1 -> ~0 with distance
      s.x = sx - this.x;
      s.y = sy - LIFT - this.y; // ghosts also ride at orb height
      s.tint = col;
      s.alpha = 0.32 * f * f;
      const sc = gscale(r * (1.4 + 0.5 * f));
      s.scale.set(sc);
    }

    // --- halo: big additive glow, pulsing ---
    const pulse = 0.85 + Math.sin(t * 9 + p.id) * 0.15;
    this.halo.tint = col;
    this.halo.alpha = 0.5 * pulse;
    const haloScale = gscale(r * 3.4 * pulse);
    this.halo.scale.set(haloScale);

    // --- crisp core (Graphics): only redraw when color/size actually change ---
    // The body silhouette is static per-projectile; the pulsing/specular life is
    // carried by the halo + a rotating specular sprite would be overkill, so we
    // bake the body once and let the halo do the breathing.
    if (col !== this.lastColor || r !== this.lastR) {
      this.lastColor = col;
      this.lastR = r;
      const g = this.core;
      g.clear();
      // outer dark seat so the orb reads on bright glow
      g.circle(0, 0, r + 1.2).fill({ color: OUTLINE, alpha: 0.5 });
      // body: bright rim -> saturated core (fake spherical shading)
      g.circle(0, 0, r).fill(col);
      g.circle(-r * 0.18, -r * 0.18, r * 0.82).fill(bright);
      g.circle(-r * 0.28, -r * 0.28, r * 0.5).fill(lighten(col, 0.8));
      // hot specular highlight
      g.circle(-r * 0.34, -r * 0.34, r * 0.26).fill({ color: 0xffffff, alpha: 0.95 });
      // thin bright rim arc on the lit edge
      g.arc(0, 0, r * 0.92, Math.PI * 0.9, Math.PI * 1.7).stroke({
        color: lighten(col, 0.9),
        width: Math.max(1, r * 0.18),
        cap: "round",
      });
    }

    // --- per-color flavor motes ---
    this.flavor(p, col, bright, t, gscale);
  }

  /** Poison drips / nova sparkles / slam crackle, keyed off the color hint. */
  private flavor(
    p: Projectile,
    col: number,
    bright: number,
    t: number,
    gscale: (px: number) => number
  ): void {
    const r = p.r;
    const seed = p.id;

    if (col === POISON_HEX || p.poison) {
      // toxic globs dripping off the bottom of the orb
      for (let i = 0; i < this.motes.length; i++) {
        const m = this.motes[i];
        const ph = (t * 1.6 + i * 0.27 + hash1(seed + i)) % 1; // 0..1 fall cycle
        m.tint = mix(ROT_BRIGHT, 0x6b7d3a, ph * 0.7);
        m.x = (hash1(seed + i * 3.1) - 0.5) * r * 1.2;
        m.y = r * 0.4 + ph * (r * 1.8 + LIFT * 0.6); // drips toward ground
        m.alpha = (1 - ph) * 0.8;
        const sc = gscale(r * (0.5 - ph * 0.25));
        m.scale.set(Math.max(0.001, sc));
      }
    } else if (col === NOVA_HEX) {
      // golden sparkles orbiting/twinkling around the orb
      for (let i = 0; i < this.motes.length; i++) {
        const m = this.motes[i];
        const a = t * 2.2 + (i / this.motes.length) * Math.PI * 2;
        const rad = r * 1.5 + Math.sin(t * 5 + i) * r * 0.3;
        m.tint = i % 2 ? SAP_BRIGHT : lighten(SAP_BRIGHT, 0.5);
        m.x = Math.cos(a) * rad;
        m.y = Math.sin(a) * rad * 0.8;
        // twinkle: sharp on/off shimmer
        const tw = Math.sin(t * 11 + i * 2.3);
        m.alpha = clamp(0.25 + tw * 0.6, 0, 0.9);
        const sc = gscale(r * (0.35 + Math.max(0, tw) * 0.3));
        m.scale.set(sc);
      }
    } else if (col === SLAM_HEX) {
      // ember crackle: short flickering sparks flicking outward
      for (let i = 0; i < this.motes.length; i++) {
        const m = this.motes[i];
        const ph = (t * 3.3 + hash1(seed + i * 7.7)) % 1;
        const a = hash1(seed + i) * Math.PI * 2 + t * 0.7;
        const rad = r * (0.6 + ph * 1.6);
        m.tint = mix(EMBER, SAP_BRIGHT, ph * 0.6);
        m.x = Math.cos(a) * rad;
        m.y = Math.sin(a) * rad - ph * r * 0.6; // bias upward like sparks
        m.alpha = (1 - ph) * 0.75;
        const sc = gscale(r * (0.45 - ph * 0.3));
        m.scale.set(Math.max(0.001, sc));
      }
    } else {
      // generic: a soft inner twinkle so unflavored orbs still feel alive
      for (let i = 0; i < this.motes.length; i++) {
        const m = this.motes[i];
        if (i === 0) {
          m.tint = bright;
          m.x = 0;
          m.y = 0;
          m.alpha = 0.3 + Math.sin(t * 7 + seed) * 0.15;
          const sc = gscale(r * 0.9);
          m.scale.set(sc);
        } else {
          m.alpha = 0;
        }
      }
    }
  }
}

// ============================================================================
// Pickup node
// ============================================================================
//
// A bobbing, glowing collectible. Layered:
//   [shadow]  ground shadow at true (x,y)
//   [halo]    pulsing additive pickup glow (kind-tinted)
//   [body]    Graphics silhouette (estus / sap / weapon / charm / key)
//   [spark]   a couple of additive motes (sparkle / rising sap)
//
// Bob is applied to the body+halo as a local y offset; the shadow stays put and
// breathes slightly so the bob reads as a hover. The body silhouette is baked
// once per (kind) and re-pose only when the kind changes; living motion is the
// transform bob + the additive sparks.

class PickupNode extends Container {
  readonly shadow: Sprite;
  readonly halo: Sprite;
  readonly body: Graphics;
  readonly lift: Container; // holds body so bob doesn't move the shadow
  readonly sparks: Sprite[] = [];

  private builtKind: PickupKind | null = null;
  private accent = SAP_BRIGHT; // halo/spark tint, set per kind

  constructor(glow: Texture, glowSize: number) {
    super();
    this.sortableChildren = true;
    this.glowSize = glowSize;

    this.shadow = new Sprite(glow);
    this.shadow.anchor.set(0.5);
    this.shadow.tint = 0x000000;
    this.shadow.alpha = 0.3;
    this.shadow.zIndex = 0;
    this.addChild(this.shadow);

    this.halo = new Sprite(glow);
    this.halo.anchor.set(0.5);
    this.halo.blendMode = "add";
    this.halo.zIndex = 1;
    this.addChild(this.halo);

    this.lift = new Container();
    this.lift.zIndex = 2;
    this.addChild(this.lift);

    this.body = new Graphics();
    this.lift.addChild(this.body);

    for (let i = 0; i < 3; i++) {
      const s = new Sprite(glow);
      s.anchor.set(0.5);
      s.blendMode = "add";
      s.alpha = 0;
      s.zIndex = 3;
      this.sparks.push(s);
      this.addChild(s);
    }
  }

  private glowSize: number;

  recycle(): void {
    this.builtKind = null;
    for (const s of this.sparks) s.alpha = 0;
  }

  update(p: Pickup, t: number): void {
    const gscale = (px: number): number => (2 * px) / this.glowSize;
    this.x = p.x;
    this.y = p.y;

    if (this.builtKind !== p.kind) {
      this.builtKind = p.kind;
      this.buildBody(p);
    }

    // bob the lifted body
    const bob = Math.sin(t * 3 + p.id) * 3 - 6; // float ~6px up, ±3 bob
    this.lift.y = bob;
    this.lift.rotation = p.kind === "weapon" ? Math.sin(t * 1.5 + p.id) * 0.05 : 0;

    // ground shadow (breathes inversely with bob: tighter when higher)
    const h = (bob + 9) / 12; // ~0 low .. 1 high
    const shScale = gscale(13 * (1 - h * 0.2));
    this.shadow.scale.set(shScale, shScale * 0.4);
    this.shadow.alpha = 0.32 - h * 0.1;

    // pulsing pickup halo
    const pulse = 0.8 + Math.sin(t * 4 + p.id) * 0.2;
    this.halo.tint = this.accent;
    this.halo.alpha = 0.42 * pulse;
    this.halo.y = bob * 0.6;
    const haloScale = gscale(18 * pulse);
    this.halo.scale.set(haloScale);

    this.sparkle(p, t, bob, gscale);
  }

  /** Per-kind floating sparks / rising sap motes. */
  private sparkle(
    p: Pickup,
    t: number,
    bob: number,
    gscale: (px: number) => number
  ): void {
    const seed = p.id;
    for (let i = 0; i < this.sparks.length; i++) {
      const s = this.sparks[i];
      if (p.kind === "sap" || p.kind === "weapon" || p.kind === "key" || p.kind === "charm") {
        // golden glints orbiting / rising
        const ph = (t * 0.9 + i / this.sparks.length + hash1(seed + i)) % 1;
        const a = t * 1.6 + (i / this.sparks.length) * Math.PI * 2;
        s.tint = SAP_BRIGHT;
        s.x = Math.cos(a) * 8;
        s.y = bob - ph * 16 + Math.sin(a) * 3; // drift upward
        const tw = Math.sin(t * 9 + i * 2.1);
        s.alpha = clamp(0.2 + tw * 0.5, 0, 0.8) * (1 - ph * 0.5);
        const sc = gscale(2.2 + Math.max(0, tw) * 1.6);
        s.scale.set(sc);
      } else {
        // estus: soft blue motes rising off the flask
        const ph = (t * 1.1 + i * 0.33 + hash1(seed + i)) % 1;
        s.tint = lighten(HEAL_BLUE, 0.3);
        s.x = (hash1(seed + i * 5) - 0.5) * 8;
        s.y = bob - 4 - ph * 18;
        s.alpha = (1 - ph) * 0.6;
        const sc = gscale(2 + (1 - ph) * 2);
        s.scale.set(sc);
      }
    }
  }

  /** Bake the detailed silhouette for this pickup kind into `body`. */
  private buildBody(p: Pickup): void {
    const g = this.body;
    g.clear();
    switch (p.kind) {
      case "estus":
        this.accent = HEAL_BLUE;
        this.drawEstus(g);
        break;
      case "sap":
        this.accent = SAP_BRIGHT;
        this.drawSap(g);
        break;
      case "weapon":
        this.accent = SAP_BRIGHT;
        this.drawWeapon(g, p.wid);
        break;
      case "charm":
        this.accent = TOMATO_BRIGHT;
        this.drawCharm(g);
        break;
      case "key":
        this.accent = SAP_BRIGHT;
        this.drawKey(g);
        break;
    }
  }

  // ---- pickup silhouettes (origin = body center; +y down) ----

  /** Cracked tin watering-can / flask with glowing blue liquid. */
  private drawEstus(g: Graphics): void {
    // dark seat
    g.ellipse(0, 8, 8, 3).fill({ color: OUTLINE, alpha: 0.4 });
    // tin body (rounded flask)
    g.roundRect(-7, -6, 14, 16, 5).fill(0x6b7a82); // pewter tin
    // shaded left + lit right
    g.roundRect(-7, -6, 7, 16, 5).fill({ color: 0x4a565c, alpha: 0.5 });
    g.roundRect(1, -6, 6, 16, 5).fill({ color: 0x9fb0b8, alpha: 0.45 });
    // blue liquid showing through the open top
    g.ellipse(0, -1, 5.5, 4).fill(HEAL_BLUE_DK);
    g.ellipse(0, 0, 4.5, 3.2).fill(HEAL_BLUE);
    g.ellipse(-1, -1, 2, 1.4).fill({ color: 0xbfe3ff, alpha: 0.9 }); // sheen
    // tin neck/spout (watering-can lip)
    g.moveTo(5, -3).lineTo(11, -6).lineTo(11, -3).lineTo(6, 0).fill(0x8a99a0);
    g.moveTo(5, -3).lineTo(11, -6).lineTo(11, -3).lineTo(6, 0).stroke({ color: OUTLINE, width: 1.2 });
    // rim + handle
    g.ellipse(0, -6, 7, 2.4).stroke({ color: 0x3a454a, width: 2 });
    g.arc(-4, -2, 5, -Math.PI * 0.5, Math.PI * 0.5).stroke({ color: 0x3a454a, width: 1.6 });
    // body outline
    g.roundRect(-7, -6, 14, 16, 5).stroke({ color: OUTLINE, width: 2 });
    // cracks (worn tin)
    g.moveTo(-3, 1).lineTo(-1, 5).lineTo(-3, 9).stroke({ color: 0x2a3236, width: 0.9 });
    g.moveTo(3, -2).lineTo(4, 3).stroke({ color: 0x2a3236, width: 0.8 });
  }

  /** Golden gleaming sap droplet/coin. */
  private drawSap(g: Graphics): void {
    g.ellipse(0, 7, 6, 2.5).fill({ color: OUTLINE, alpha: 0.35 });
    // teardrop body
    g.moveTo(0, -9)
      .bezierCurveTo(6, -2, 6, 6, 0, 7)
      .bezierCurveTo(-6, 6, -6, -2, 0, -9)
      .fill(SAP);
    // shaded + lit
    g.ellipse(1.5, 2, 4, 5).fill({ color: 0xc99826, alpha: 0.5 });
    g.ellipse(-1.5, -1, 3, 4).fill(SAP_BRIGHT);
    g.circle(-2, -3, 1.6).fill({ color: 0xfff0c0, alpha: 0.95 }); // specular
    g.moveTo(0, -9)
      .bezierCurveTo(6, -2, 6, 6, 0, 7)
      .bezierCurveTo(-6, 6, -6, -2, 0, -9)
      .stroke({ color: 0x9e7a1e, width: 1.6 });
  }

  /** A weapon planted blade-down in the ground (kind picks the silhouette). */
  private drawWeapon(g: Graphics, wid?: string): void {
    // ground mound the weapon is stuck into
    g.ellipse(0, 11, 9, 3.5).fill({ color: 0x2a1d12, alpha: 0.7 });
    g.ellipse(0, 11, 9, 3.5).stroke({ color: OUTLINE, width: 1.2 });

    if (wid === "mace") {
      // beet-mace: haft up, heavy root head at top
      g.roundRect(-1.6, -2, 3.2, 13, 1.4).fill(0x6b4a2a); // haft
      g.roundRect(-1.6, -2, 3.2, 13, 1.4).stroke({ color: OUTLINE, width: 1.4 });
      g.circle(0, -7, 6).fill(0x8e1f3a); // beet head
      g.circle(-2, -9, 3).fill({ color: 0xc8456a, alpha: 0.7 });
      g.circle(0, -7, 6).stroke({ color: OUTLINE, width: 1.6 });
    } else if (wid === "rapier") {
      // thin thorn rapier: long needle blade
      g.moveTo(0, -13).lineTo(1.4, 6).lineTo(-1.4, 6).fill(0xcaa0d8);
      g.moveTo(0, -13).lineTo(1.4, 6).lineTo(-1.4, 6).stroke({ color: OUTLINE, width: 1.2 });
      g.moveTo(-5, 6).lineTo(5, 6).stroke({ color: SAP, width: 2.4, cap: "round" }); // guard
      g.circle(9, -2, 3).stroke({ color: 0x8a5fa0, width: 1.4 }); // basket hint
    } else if (wid === "dagger") {
      // short broad blade
      g.moveTo(0, -9).lineTo(2.6, 5).lineTo(-2.6, 5).fill(STEEL);
      g.moveTo(0, -9).lineTo(2.6, 5).lineTo(-2.6, 5).stroke({ color: OUTLINE, width: 1.4 });
      g.moveTo(-5, 5).lineTo(5, 5).stroke({ color: SAP, width: 2.6, cap: "round" });
      g.roundRect(-1.4, 5, 2.8, 5, 1).fill(0x6b4a2a); // grip
    } else {
      // whip / default: planted longsword silhouette
      g.moveTo(0, -13)
        .lineTo(2.6, -8)
        .lineTo(2.2, 4)
        .lineTo(-2.2, 4)
        .lineTo(-2.6, -8)
        .fill(STEEL);
      g.moveTo(-3, -3).lineTo(0, -3).stroke({ color: 0xf2f5fa, width: 1, alpha: 0.7 }); // fuller sheen
      g.moveTo(0, -13)
        .lineTo(2.6, -8)
        .lineTo(2.2, 4)
        .lineTo(-2.2, 4)
        .lineTo(-2.6, -8)
        .stroke({ color: OUTLINE, width: 1.6 });
      g.moveTo(-6, 4).lineTo(6, 4).stroke({ color: SAP, width: 3, cap: "round" }); // crossguard
      g.roundRect(-1.4, 4, 2.8, 6, 1).fill(0x6b4a2a); // grip
      g.circle(0, 10, 1.8).fill(SAP); // pommel
    }
  }

  /** A beaded talisman ring with a tomato-seed gem. */
  private drawCharm(g: Graphics): void {
    g.ellipse(0, 8, 7, 2.5).fill({ color: OUTLINE, alpha: 0.3 });
    // cord ring
    g.circle(0, 0, 7).stroke({ color: 0x8a5a2a, width: 2.2 });
    // beads around the ring
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      g.circle(Math.cos(a) * 7, Math.sin(a) * 7, 1.5).fill(i % 2 ? SAP_BRIGHT : SAP);
    }
    // central seed gem
    g.circle(0, 0, 3.2).fill(TOMATO);
    g.circle(-1, -1, 1.6).fill({ color: TOMATO_BRIGHT, alpha: 0.9 });
    g.circle(0, 0, 3.2).stroke({ color: OUTLINE, width: 1.2 });
  }

  /** An old iron key. */
  private drawKey(g: Graphics): void {
    g.ellipse(0, 9, 5, 2).fill({ color: OUTLINE, alpha: 0.3 });
    // bow (ring head)
    g.circle(0, -6, 4.2).stroke({ color: 0x9a9aa2, width: 2.6 });
    g.circle(0, -6, 1.6).fill(0x2a2a30); // hole
    // shaft
    g.roundRect(-1.4, -3, 2.8, 12, 1).fill(0x8a8a92);
    g.roundRect(-1.4, -3, 2.8, 12, 1).stroke({ color: OUTLINE, width: 1.2 });
    // bit teeth
    g.rect(1.4, 5, 3.2, 2).fill(0x8a8a92);
    g.rect(1.4, 8, 2.2, 2).fill(0x8a8a92);
    g.rect(1.4, 5, 3.2, 2).stroke({ color: OUTLINE, width: 0.8 });
    // glint
    g.circle(-1.4, -7, 1).fill({ color: 0xffffff, alpha: 0.8 });
  }
}

// ============================================================================
// Husk node  (the soulslike "bloodstain")
// ============================================================================
//
// A withered, slumped tomato husk leaking a little sap, marked by a soft pulsing
// golden glow column so the player can spot where they died. Pooled by index
// (husks are few). The body silhouette is baked once; the beacon column + rising
// sap motes animate via transform/alpha.

class HuskNode extends Container {
  readonly beacon: Sprite; // tall soft golden glow column (additive)
  readonly pool: Sprite; // ground glow puddle (additive)
  readonly body: Graphics;
  readonly motes: Sprite[] = [];
  private built = false;

  constructor(glow: Texture, glowSize: number) {
    super();
    this.sortableChildren = true;
    this.glowSize = glowSize;

    // ground glow puddle (where they fell)
    this.pool = new Sprite(glow);
    this.pool.anchor.set(0.5);
    this.pool.blendMode = "add";
    this.pool.zIndex = 0;
    this.addChild(this.pool);

    // tall beacon column: a glow sprite stretched vertically, fading upward
    this.beacon = new Sprite(glow);
    this.beacon.anchor.set(0.5, 1); // anchored at its base
    this.beacon.blendMode = "add";
    this.beacon.tint = SAP_BRIGHT;
    this.beacon.zIndex = 1;
    this.addChild(this.beacon);

    this.body = new Graphics();
    this.body.zIndex = 2;
    this.addChild(this.body);

    for (let i = 0; i < 4; i++) {
      const m = new Sprite(glow);
      m.anchor.set(0.5);
      m.blendMode = "add";
      m.alpha = 0;
      m.zIndex = 3;
      this.motes.push(m);
      this.addChild(m);
    }
  }

  private glowSize: number;

  update(h: Husk, t: number): void {
    const gscale = (px: number): number => (2 * px) / this.glowSize;
    this.x = h.x;
    this.y = h.y;

    if (!this.built) {
      this.built = true;
      this.buildBody();
    }

    const pulse = 0.7 + Math.sin(t * 3 + h.x * 0.05) * 0.3;

    // ground puddle
    this.pool.tint = SAP;
    this.pool.alpha = 0.4 * pulse;
    const pScale = gscale(22 * pulse);
    this.pool.scale.set(pScale, pScale * 0.4);
    this.pool.y = 2;

    // beacon column: rises from the husk, soft and tall, gently breathing
    this.beacon.alpha = 0.32 + 0.18 * pulse;
    this.beacon.y = 2;
    // width modest, height tall so it reads as a column of light
    this.beacon.scale.set(gscale(14), gscale(70 * (0.9 + pulse * 0.2)));

    // rising sap motes
    for (let i = 0; i < this.motes.length; i++) {
      const m = this.motes[i];
      const ph = (t * 0.5 + i * 0.25 + hash1(h.x + i)) % 1;
      m.tint = SAP_BRIGHT;
      m.x = Math.sin(t * 1.5 + i) * 4;
      m.y = 2 - ph * 26;
      m.alpha = (1 - ph) * 0.7;
      const sc = gscale(2 + (1 - ph) * 1.5);
      m.scale.set(sc);
    }
  }

  /** Bake the withered, slumped husk silhouette. */
  private buildBody(): void {
    const g = this.body;
    g.clear();
    // dark seat
    g.ellipse(0, 6, 11, 4).fill({ color: OUTLINE, alpha: 0.45 });
    // slumped, deflated husk body (squashed wide, collapsed)
    g.ellipse(0, 1, 11, 8).fill(0x5a3a2a); // withered skin
    g.ellipse(2, 3, 7, 5).fill({ color: 0x3a2418, alpha: 0.6 }); // shade
    g.ellipse(-3, -2, 5, 3.5).fill({ color: 0x8a5a3a, alpha: 0.5 }); // dim rim light
    // collapsed hollow top (the "scoop" where the fruit gave out)
    g.ellipse(0, -2, 5.5, 3).fill({ color: 0x1a0e08, alpha: 0.85 });
    // shriveled stem nub
    g.roundRect(-1.4, -8, 2.8, 5, 1).fill(0x3a2418);
    g.roundRect(-1.4, -8, 2.8, 5, 1).stroke({ color: OUTLINE, width: 1.2 });
    // a couple of withered leaves drooping off the crown
    g.moveTo(-2, -6).bezierCurveTo(-9, -8, -11, -3, -6, -1).fill(0x4e6b2e);
    g.moveTo(2, -6).bezierCurveTo(9, -8, 11, -3, 6, -1).fill(0x3c5226);
    // sap leak: a glistening bead running down the side, pooling
    g.moveTo(6, 0).bezierCurveTo(8, 3, 7, 7, 5, 9).stroke({ color: SAP, width: 1.8, cap: "round" });
    g.circle(5, 9, 2).fill(SAP_BRIGHT);
    g.circle(4.4, 8.4, 0.8).fill({ color: 0xfff0c0, alpha: 0.9 });
    // body outline + a few wrinkle creases
    g.ellipse(0, 1, 11, 8).stroke({ color: OUTLINE, width: 2 });
    g.moveTo(-6, -2).lineTo(-5, 5).stroke({ color: 0x2a160c, width: 1, alpha: 0.6 });
    g.moveTo(0, -4).lineTo(1, 7).stroke({ color: 0x2a160c, width: 1, alpha: 0.5 });
  }
}

// ============================================================================
// WorldFxLayer — the public layer
// ============================================================================

/**
 * World-space FX layer for projectiles, pickups, and husks. Pools display
 * objects keyed by entity id (husks by index) and animates them every frame.
 *
 * Add UNDER the camera/world container near the entity layer; call init(renderer)
 * once after the renderer exists, then update(state, t) every frame.
 */
export class WorldFxLayer extends Container {
  // sub-layers so projectiles (lobbed, glowy) draw over pickups/husks which sit
  // closer to the ground. Each is plain world space.
  private readonly huskLayer = new Container();
  private readonly pickupLayer = new Container();
  private readonly projLayer = new Container();

  // pools keyed by sim id
  private readonly projById = new Map<number, ProjectileNode>();
  private readonly pickupById = new Map<number, PickupNode>();
  private readonly huskNodes: HuskNode[] = []; // pooled by index

  // free lists for reclaimed (parked) nodes, reused before allocating new ones
  private readonly freeProj: ProjectileNode[] = [];
  private readonly freePickup: PickupNode[] = [];

  // scratch id-sets to detect disappearance without per-frame allocation churn
  private readonly seenProj = new Set<number>();
  private readonly seenPickup = new Set<number>();

  private glowTex: Texture = Texture.WHITE;
  private glowSize = 1;
  private ready = false;

  constructor() {
    super();
    this.sortableChildren = true;
    this.huskLayer.zIndex = 0;
    this.pickupLayer.zIndex = 1;
    this.projLayer.zIndex = 2;
    this.addChild(this.huskLayer);
    this.addChild(this.pickupLayer);
    this.addChild(this.projLayer);
  }

  /** Bake the shared glow texture. Call once after the renderer exists. */
  init(renderer: Renderer): void {
    if (this.ready) return;
    const { tex, size } = makeGlowTexture(renderer);
    this.glowTex = tex;
    this.glowSize = size;
    this.ready = true;
  }

  /**
   * Reconcile + animate against the world snapshot. `t` is seconds (drives every
   * pulse/bob/sparkle). Creates nodes for newly-appeared ids, reuses live ones,
   * and parks+reclaims ones whose id is gone. No allocation on the steady path.
   */
  update(state: WorldState, t: number): void {
    if (!this.ready) return; // glow texture not baked yet; nothing to draw

    this.syncProjectiles(state.projectiles, t);
    this.syncPickups(state.pickups, t);
    this.syncHusks(state.husks, state.areaId, t);
  }

  // ---- projectiles ----
  private syncProjectiles(list: Projectile[], t: number): void {
    const seen = this.seenProj;
    seen.clear();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      seen.add(p.id);
      let node = this.projById.get(p.id);
      if (!node) {
        node = this.freeProj.pop() ?? new ProjectileNode(this.glowTex, this.glowSize);
        node.recycle();
        node.visible = true;
        this.projLayer.addChild(node);
        this.projById.set(p.id, node);
      }
      node.update(p, t);
    }
    // park + reclaim vanished projectiles
    if (this.projById.size > seen.size) {
      for (const [id, node] of this.projById) {
        if (!seen.has(id)) {
          this.projById.delete(id);
          this.projLayer.removeChild(node);
          node.visible = false;
          this.freeProj.push(node);
        }
      }
    }
  }

  // ---- pickups ----
  private syncPickups(list: Pickup[], t: number): void {
    const seen = this.seenPickup;
    seen.clear();
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      seen.add(p.id);
      let node = this.pickupById.get(p.id);
      if (!node) {
        node = this.freePickup.pop() ?? new PickupNode(this.glowTex, this.glowSize);
        node.recycle();
        node.visible = true;
        this.pickupLayer.addChild(node);
        this.pickupById.set(p.id, node);
      }
      node.update(p, t);
    }
    if (this.pickupById.size > seen.size) {
      for (const [id, node] of this.pickupById) {
        if (!seen.has(id)) {
          this.pickupById.delete(id);
          this.pickupLayer.removeChild(node);
          node.visible = false;
          this.freePickup.push(node);
        }
      }
    }
  }

  // ---- husks (pool by index; render only those in the current area) ----
  private syncHusks(list: Husk[], areaId: string, t: number): void {
    // collect the husks that belong to this area
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      if (h.areaId !== areaId) continue;
      let node = this.huskNodes[n];
      if (!node) {
        node = new HuskNode(this.glowTex, this.glowSize);
        this.huskNodes[n] = node;
        this.huskLayer.addChild(node);
      }
      node.visible = true;
      node.update(h, t);
      n++;
    }
    // hide any surplus pooled husk nodes
    for (let i = n; i < this.huskNodes.length; i++) {
      if (this.huskNodes[i].visible) this.huskNodes[i].visible = false;
    }
  }

  /** Release GPU resources (the baked glow texture + all pooled children). */
  destroy(): void {
    if (this.ready && this.glowTex !== Texture.WHITE) {
      this.glowTex.destroy(true);
      this.glowTex = Texture.WHITE;
      this.ready = false;
    }
    this.projById.clear();
    this.pickupById.clear();
    this.freeProj.length = 0;
    this.freePickup.length = 0;
    this.huskNodes.length = 0;
    super.destroy({ children: true });
  }
}
