// props.ts — DETAILED procedural prop renderer for the Pixi v8 (WebGL) renderer
// of Tommy Tomato: Harvest Souls.
//
// The game ships NO painted prop art, so every prop here is drawn in code with
// the `Graphics` fluent API and made to look hand-crafted ("harvest gothic":
// chunky outlines, warm rot palette, soft contact shadows, gentle life). This
// is the v2 reimplementation of v1's Canvas2D prop helpers (drawCompostHeap,
// drawTorch, drawLantern, drawMushroom, drawBones, drawBanner, drawGrassTuft,
// drawVinePatch, drawHusk, ...) — RICHER, and retained-mode instead of
// immediate-mode.
//
// ----------------------------------------------------------------------------
// PERFORMANCE MODEL (60fps with many props on screen):
//   * GEOMETRY IS BUILT ONCE in build(). A prop becomes a Container of static
//     `Graphics` (plus a couple of additive glow Sprites that share ONE baked
//     radial texture). We never rebuild vector geometry per frame.
//   * ANIMATION IS CHEAP. update(t) only mutates transforms (rotation / x / y /
//     scale) and `alpha` on pre-built nodes — flicker via alpha+scale, sway via
//     rotation, embers via repositioning a fixed pool of dots, ripples via
//     scaling a ring. No allocations, no .clear()/.rect() in the hot path.
//   * GLOWS are additive Sprites (blendMode "add") of one baked soft-radial
//     texture; flicker = changing their alpha/scale. This matches lighting.ts /
//     vfx.ts and is far cheaper than re-filling radial FillGradients each frame.
//
// COORDINATE SPACE: add PropLayer to the WORLD container, ABOVE the ground/floor
// layer and UNDER the entities (so creatures and the hero walk in front of
// props). Props are positioned at their PropDef (x,y) in world space.
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  Sprite,
  Texture,
  type Renderer,
} from "pixi.js";

import type { AreaDef, PropDef } from "@/game/sim/content";

// ============================================================================
// Palette (harvest gothic) — hex numbers for Pixi color args.
// ============================================================================
const SOIL = 0x0d0a09;
const BARK_DK = 0x2c2018;
const BARK = 0x5a3b22;
const TOMATO = 0xd83a2e;
const TOMATO_DK = 0x9e2018;
const ROT = 0x6b7d3a;
const ROT_BRIGHT = 0x9fb24e;
const SAP = 0xe8b53a;
const SAP_BRIGHT = 0xffd56b;
const PARCH = 0xe9dcc0;
const BLOOD = 0x7a1414;
const EMBER = 0xff7a3a;
const EMBER_HI = 0xffb347;
const OUTLINE = 0x140d0a;
const IRON = 0x6a6a72;
const IRON_HI = 0x9a9aa2;
const BONE = 0xd8ccb0;
const WAX = 0x8e1f2a;
const MUSH_GLOW = 0x8fe06a;
const FLESH = 0x9a6a3a;

// ============================================================================
// Small deterministic helpers (no RNG state; stable per-prop variation).
// ============================================================================

/** Cheap deterministic hash of (x,y) -> [0,1). Keeps identical prop types from
 *  animating in lockstep without needing stored seeds. */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** rgb lerp between two 0xRRGGBB colors. */
function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff;
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff;
  const r = (ar + (br - ar) * t) | 0;
  const g = (ag + (bg - ag) * t) | 0;
  const bl = (ab + (bb - ab) * t) | 0;
  return (r << 16) | (g << 8) | bl;
}

/** A soft filled "blob" ellipse with optional crisp outline. */
function blob(
  g: Graphics,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: number,
  alpha = 1,
  outline = 0,
  ow = 0
): void {
  g.ellipse(x, y, rx, ry).fill({ color, alpha });
  if (ow > 0) g.ellipse(x, y, rx, ry).stroke({ width: ow, color: outline });
}

/** A pointed leaf along -y from origin (0,0) with a midrib, outlined. */
function leaf(g: Graphics, len: number, w: number, fill: number): void {
  g.moveTo(0, 0)
    .quadraticCurveTo(-w, -len * 0.5, 0, -len)
    .quadraticCurveTo(w, -len * 0.5, 0, 0)
    .fill({ color: fill })
    .stroke({ width: 1.6, color: OUTLINE });
  g.moveTo(0, -2)
    .lineTo(0, -len * 0.85)
    .stroke({ width: 1, color: 0x000000, alpha: 0.28 });
}

/** A soft contact shadow ellipse baked into a Graphics (a few faded rings, so
 *  it reads as a radial falloff without a per-prop gradient texture). */
function contactShadow(
  g: Graphics,
  x: number,
  y: number,
  rx: number,
  ry: number,
  a = 0.34
): void {
  const rings = 4;
  for (let i = rings; i >= 1; i--) {
    const t = i / rings;
    g.ellipse(x, y, rx * t, ry * t).fill({ color: 0x000000, alpha: (a / rings) * (1.2 - t * 0.4) });
  }
}

// ============================================================================
// A light source this layer contributes to the lighting system (lighting.ts
// `Light`-compatible: { x, y, radius, color, intensity, flicker? }).
// ============================================================================
export interface PropLight {
  x: number;
  y: number;
  radius: number;
  color: number;
  intensity: number;
  flicker?: number;
}

// Per-prop animation closure. Built in build(); called from update(t).
type Animator = (t: number) => void;

// ============================================================================
// PropLayer
// ============================================================================
export class PropLayer extends Container {
  /** Reused baked soft-radial texture for every additive glow/halo Sprite. */
  private glowTex: Texture = Texture.WHITE;
  private glowSize = 1;
  private renderer: Renderer | null = null;

  /** Per-frame animation callbacks (cheap transform/alpha tweaks only). */
  private animators: Animator[] = [];

  /** Light sources contributed to the lighting layer (world coords). */
  private lightSpecs: PropLight[] = [];

  /** Lights staged during makeProp(), resolved to world coords in build() once
   *  the owning node has been positioned. Keyed by the prop's Container. */
  private pendingLights = new Map<Container, { light: PropLight; ox: number; oy: number }[]>();

  // ----------------------------------------------------------------------------
  // init — bake the shared radial glow texture from the renderer. Idempotent.
  // ----------------------------------------------------------------------------
  init(renderer: Renderer): void {
    this.renderer = renderer;
    if (this.glowSize > 1) return; // already baked
    const R = 64;
    const g = new Graphics();
    // soft falloff: many faint stacked discs -> hot core, transparent rim.
    const steps = 22;
    for (let i = steps; i >= 1; i--) {
      const f = i / steps;
      const a = (1 - f) * (1 - f) * 0.92;
      g.circle(R, R, R * f).fill({ color: 0xffffff, alpha: a });
    }
    this.glowTex = renderer.generateTexture({ target: g, resolution: 1, antialias: true });
    this.glowSize = this.glowTex.width;
    g.destroy();
  }

  /** Make an additive glow Sprite of the baked radial texture, sized to a world
   *  radius and tinted. Anchored center. Used for halos, embers, sap motes. */
  private glow(radius: number, color: number, alpha: number): Sprite {
    const s = new Sprite(this.glowTex);
    s.anchor.set(0.5);
    s.blendMode = "add";
    s.tint = color;
    s.alpha = alpha;
    s.scale.set((radius * 2) / this.glowSize);
    return s;
  }

  // ----------------------------------------------------------------------------
  // build — clear, then construct every prop in area.props at its (x,y), PLUS
  // the compost-heap bonfire at area.compost. Geometry is built ONCE here.
  // ----------------------------------------------------------------------------
  build(area: AreaDef): void {
    // tear down any previous area
    this.removeChildren().forEach((c) => c.destroy({ children: true }));
    this.animators.length = 0;
    this.lightSpecs.length = 0;
    this.pendingLights.clear();

    for (const p of area.props) {
      const node = this.makeProp(p);
      node.x = p.x;
      node.y = p.y;
      this.addChild(node);
      this.resolveLights(node);
    }

    if (area.compost) {
      const heap = this.makeCompostHeap();
      heap.x = area.compost.x;
      heap.y = area.compost.y;
      this.addChild(heap);
      this.resolveLights(heap);
    }

    this.pendingLights.clear();
  }

  /** Finalize any lights a prop staged: convert local offsets to world coords
   *  (the node is already positioned) and add them to the active light list. */
  private resolveLights(node: Container): void {
    const list = this.pendingLights.get(node);
    if (!list) return;
    for (const { light, ox, oy } of list) {
      light.x = node.x + ox;
      light.y = node.y + oy;
      this.lightSpecs.push(light);
    }
  }

  // ----------------------------------------------------------------------------
  // update — animate flames/embers/sway/glow/ripples. Cheap: transforms + alpha
  // on pre-built nodes only.
  // ----------------------------------------------------------------------------
  update(t: number): void {
    const a = this.animators;
    for (let i = 0; i < a.length; i++) a[i](t);
  }

  // ----------------------------------------------------------------------------
  // lights — light sources for lighting.ts (compost heaps, torches, lanterns,
  // glowing mushrooms). Returned by reference; feed into LightLayer.setLights().
  // ----------------------------------------------------------------------------
  lights(): PropLight[] {
    return this.lightSpecs;
  }

  destroy(): void {
    this.animators.length = 0;
    this.lightSpecs.length = 0;
    if (this.glowSize > 1) this.glowTex.destroy(true);
    super.destroy({ children: true });
  }

  // ==========================================================================
  // Prop factory
  // ==========================================================================
  private makeProp(p: PropDef): Container {
    switch (p.type) {
      case "crate":
        return this.makeCrate(p);
      case "torch":
        return this.makeTorch(p);
      case "lantern":
        return this.makeLantern(p);
      case "mushroom":
        return this.makeMushroom(p);
      case "stalk":
        return this.makeStalk(p);
      case "fence":
        return this.makeFence(p);
      case "sign":
        return this.makeSign(p);
      case "bones":
        return this.makeBones(p);
      case "banner":
        return this.makeBanner(p);
      case "grass":
        return this.makeGrass(p);
      case "flower":
        return this.makeFlower(p);
      case "vines":
        return this.makeVines(p);
      case "puddle":
        return this.makePuddle(p);
      case "glass":
        return this.makeGlass(p);
      case "stone":
        return this.makeStone(p);
      default:
        return new Container();
    }
  }

  // ==========================================================================
  // COMPOST HEAP — the bonfire / checkpoint. Centerpiece.
  //   Layered rotting mound (peels, cores, eggshells, sprouts), a planted
  //   pitchfork, an animated multi-tongue flame, rising embers, and a warm
  //   heat-glow halo. Contributes a flickering light.
  // ==========================================================================
  private makeCompostHeap(): Container {
    const c = new Container();
    const seed = 13.37;

    // ---- ground heat-glow halo (additive, behind everything) ----
    const halo = this.glow(58, EMBER_HI, 0.34);
    halo.y = -2;
    c.addChild(halo);
    const halo2 = this.glow(34, SAP_BRIGHT, 0.3);
    halo2.y = -8;
    c.addChild(halo2);

    // ---- contact shadow + layered mound ----
    const base = new Graphics();
    contactShadow(base, 0, 14, 30, 10, 0.4);
    // mound, layered for depth (back darker, front lit)
    blob(base, 0, 7, 26, 15, BARK_DK, 1, OUTLINE, 3);
    blob(base, 0, 5, 23, 13, 0x3a2a18, 1);
    blob(base, -4, 3, 17, 9, mix(0x3a2a18, BARK, 0.4), 1);
    // rim peels & vegetable scraps around the mound
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2 + seed;
      const px = Math.cos(ang) * 17;
      const py = 7 + Math.sin(ang) * 7;
      const col = i % 3 === 0 ? ROT : i % 3 === 1 ? 0x8a5a2a : TOMATO_DK;
      blob(base, px, py, 4.2, 2.6, col, 1, OUTLINE, 1.3);
    }
    // buried tomato cores + eggshells
    blob(base, -9, 4, 4, 3.4, TOMATO_DK, 1, OUTLINE, 1.2);
    blob(base, 9, 6, 3.6, 3, BLOOD, 1, OUTLINE, 1.2);
    blob(base, 3, 9, 3, 2, PARCH, 1, OUTLINE, 1); // eggshell
    blob(base, -3, 10, 2.4, 1.6, mix(PARCH, 0xffffff, 0.3), 1, OUTLINE, 1);
    // little hopeful sprouts pushing out of the rot
    for (const [sx, sy, sr] of [
      [-12, 2, 0.7],
      [11, 3, 0.6],
      [6, -1, 0.55],
    ] as const) {
      this.sprout(base, sx, sy, sr);
    }
    c.addChild(base);

    // ---- planted pitchfork (the "coiled sword" of this bonfire) ----
    const fork = new Graphics();
    // shaft (worn iron) with a faint rim-light
    fork
      .moveTo(0.5, 5)
      .lineTo(0.5, -30)
      .stroke({ width: 3.4, color: mix(IRON, OUTLINE, 0.3) });
    fork
      .moveTo(-0.6, 4)
      .lineTo(-0.6, -28)
      .stroke({ width: 1.2, color: IRON_HI, alpha: 0.7 });
    // tines + crossbar
    for (const px of [-5, 0, 5]) {
      fork.moveTo(px, -22).lineTo(px, -36).stroke({ width: 2.4, color: IRON });
    }
    fork.moveTo(-5.5, -22).lineTo(5.5, -22).stroke({ width: 2.4, color: IRON });
    // a tied rag near the grip
    blob(fork, 0, -10, 3.2, 4.5, BLOOD, 1, OUTLINE, 1.4);
    c.addChild(fork);

    // ---- flame: a fixed pool of tongues we squash/sway each frame ----
    const flameRoot = new Container();
    flameRoot.y = 3;
    c.addChild(flameRoot);
    const tongues: { g: Graphics; bx: number; h: number; ph: number }[] = [];
    const TN = 6;
    for (let i = 0; i < TN; i++) {
      const bx = (i - (TN - 1) / 2) * 3.6;
      const h = 20 + (i % 2 ? 6 : 0);
      const fg = new Graphics();
      // build one teardrop tongue in local space (apex up at -h). Two layers:
      // an outer ember body and an inner gold core. Animated via scale/alpha.
      fg.moveTo(-4.2, 0)
        .quadraticCurveTo(-3, -h * 0.55, 0, -h)
        .quadraticCurveTo(3, -h * 0.55, 4.2, 0)
        .closePath()
        .fill({ color: EMBER, alpha: 0.85 });
      fg.moveTo(-2.4, -1)
        .quadraticCurveTo(-1.6, -h * 0.55, 0, -h * 0.86)
        .quadraticCurveTo(1.6, -h * 0.55, 2.4, -1)
        .closePath()
        .fill({ color: SAP_BRIGHT, alpha: 0.95 });
      fg.x = bx;
      flameRoot.addChild(fg);
      tongues.push({ g: fg, bx, h, ph: i * 1.3 });
    }
    // a hot additive core glow that pulses at the flame base
    const coreGlow = this.glow(22, EMBER_HI, 0.7);
    coreGlow.y = -8;
    flameRoot.addChild(coreGlow);

    // ---- ember pool (fixed sprites repositioned each frame) ----
    const embers: Sprite[] = [];
    const EN = 12;
    for (let i = 0; i < EN; i++) {
      const e = this.glow(2.4, i % 3 === 0 ? SAP_BRIGHT : EMBER, 0.9);
      flameRoot.addChild(e);
      embers.push(e);
    }

    // ---- light contribution (warm, strongly flickering) ----
    // captured in build()-space; world position is the heap's (x,y) — but lights
    // are world coords, so we store absolute coords lazily in collectLight().
    const lightRef: PropLight = {
      x: 0,
      y: 0,
      radius: 150,
      color: EMBER_HI,
      intensity: 0.95,
      flicker: 0.85,
    };
    this.deferLight(c, lightRef, 0, -6);

    // ---- animation ----
    this.animators.push((t) => {
      // flame tongues: squash/stretch in Y, gentle X sway, alpha flicker
      for (const tn of tongues) {
        const flick = 0.82 + Math.sin(t * 9 + tn.ph) * 0.12 + Math.sin(t * 21 + tn.ph) * 0.06;
        tn.g.scale.y = flick;
        tn.g.scale.x = 1 + Math.sin(t * 7 + tn.ph * 1.7) * 0.1;
        tn.g.x = tn.bx + Math.sin(t * 5 + tn.ph) * 2.6;
        tn.g.alpha = 0.8 + Math.sin(t * 13 + tn.ph) * 0.18;
      }
      coreGlow.alpha = 0.55 + Math.sin(t * 8) * 0.18 + Math.sin(t * 19) * 0.08;
      coreGlow.scale.set((22 * (1 + Math.sin(t * 6) * 0.08) * 2) / this.glowSize);
      halo.alpha = 0.3 + Math.sin(t * 6) * 0.06;
      halo2.alpha = 0.26 + Math.sin(t * 9 + 1) * 0.06;
      // embers rise + drift, recycle over a fixed loop
      for (let i = 0; i < embers.length; i++) {
        const e = embers[i];
        const ph = i * 7;
        const fy = -2 - ((t * 30 + ph) % 34);
        e.y = fy;
        e.x = Math.sin(t * 3 + i * 1.7) * (5 + -fy * 0.16);
        e.alpha = Math.max(0, 0.85 + fy / 36);
      }
    });

    return c;
  }

  /** A tiny pale-green sprout (stem + two leaves) for the compost mound. */
  private sprout(g: Graphics, x: number, y: number, s: number): void {
    g.moveTo(x, y)
      .quadraticCurveTo(x + s, y - 5 * s, x, y - 9 * s)
      .stroke({ width: 1.6 * s, color: ROT_BRIGHT });
    blob(g, x - 2 * s, y - 7 * s, 2 * s, 1.1 * s, ROT_BRIGHT, 1);
    blob(g, x + 2 * s, y - 8 * s, 2 * s, 1.1 * s, ROT, 1);
  }

  // ==========================================================================
  // CRATE — extruded wooden box: planks + iron corner brackets + a wax seal,
  // plus grime. Static (no animator), but grounded with a contact shadow.
  // ==========================================================================
  private makeCrate(p: PropDef): Container {
    const c = new Container();
    const w = (p.w ?? 44) * 0.5; // half-extent
    const h = p.h ?? 44;
    const depth = 6; // faux-extrusion offset
    const g = new Graphics();

    contactShadow(g, 0, h * 0.5 + 2, w + 6, 8, 0.34);

    // extruded side + top faces (drawn behind the front)
    g.poly([
      -w, -h * 0.5,
      -w + depth, -h * 0.5 - depth,
      w + depth, -h * 0.5 - depth,
      w, -h * 0.5,
    ]).fill({ color: mix(BARK, OUTLINE, 0.5) }); // top
    g.poly([
      w, -h * 0.5,
      w + depth, -h * 0.5 - depth,
      w + depth, h * 0.5 - depth,
      w, h * 0.5,
    ]).fill({ color: mix(BARK_DK, OUTLINE, 0.3) }); // right side

    // front face
    g.rect(-w, -h * 0.5, w * 2, h).fill({ color: BARK }).stroke({ width: 3, color: OUTLINE });
    // plank seams + per-plank shading
    const planks = 3;
    for (let i = 1; i < planks; i++) {
      const py = -h * 0.5 + (h / planks) * i;
      g.moveTo(-w, py).lineTo(w, py).stroke({ width: 1.6, color: mix(BARK_DK, OUTLINE, 0.4) });
    }
    for (let i = 0; i < planks; i++) {
      const py = -h * 0.5 + (h / planks) * (i + 0.12);
      g.rect(-w + 2, py, w * 2 - 4, 2).fill({ color: mix(BARK, 0xffffff, 0.12), alpha: 0.5 });
    }
    // diagonal cross-brace (classic crate)
    g.moveTo(-w + 3, -h * 0.5 + 3)
      .lineTo(w - 3, h * 0.5 - 3)
      .stroke({ width: 2.4, color: mix(BARK_DK, BARK, 0.4) });

    // iron corner brackets w/ rivets
    const bk = 8;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const cx = sx * w,
          cy = sy * (h * 0.5);
        g.poly([
          cx, cy,
          cx - sx * bk, cy,
          cx - sx * bk, cy - sy * 3,
          cx - sx * 3, cy - sy * 3,
          cx - sx * 3, cy - sy * bk,
          cx, cy - sy * bk,
        ]).fill({ color: IRON }).stroke({ width: 1.2, color: OUTLINE });
        g.circle(cx - sx * 4, cy - sy * 4, 1.3).fill({ color: IRON_HI }); // rivet
      }

    // grime streaks
    g.rect(-w + 5, -h * 0.5, 3, h).fill({ color: 0x000000, alpha: 0.12 });
    g.rect(w - 9, -h * 0.5 + 4, 4, h - 8).fill({ color: 0x000000, alpha: 0.1 });

    // wax seal on the front
    blob(g, 0, -2, 6, 6, WAX, 1, OUTLINE, 1.6);
    blob(g, 0, -2, 3, 3, mix(WAX, 0xffffff, 0.25), 0.8);
    // pressed sigil — a little tomato glyph
    g.circle(0, -2, 2).fill({ color: mix(WAX, OUTLINE, 0.4) });
    c.addChild(g);
    return c;
  }

  // ==========================================================================
  // TORCH — bracket post + animated flame + sparks + glow pool. Contributes a
  // flickering warm light.
  // ==========================================================================
  private makeTorch(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y) * 6.28;

    const halo = this.glow(34, EMBER_HI, 0.5);
    halo.y = -20;
    c.addChild(halo);

    const post = new Graphics();
    contactShadow(post, 0, 16, 8, 3, 0.3);
    // bracket post
    post.moveTo(0, 16).lineTo(0, -10).stroke({ width: 4, color: BARK_DK });
    post.moveTo(-1.2, 14).lineTo(-1.2, -8).stroke({ width: 1.2, color: BARK, alpha: 0.7 });
    // wrapped head (oiled rag bundle)
    post.roundRect(-3.6, -16, 7.2, 8, 2).fill({ color: BARK }).stroke({ width: 2, color: OUTLINE });
    post.moveTo(-3, -13).lineTo(3, -13).stroke({ width: 1, color: OUTLINE, alpha: 0.5 });
    post.moveTo(-3, -10).lineTo(3, -10).stroke({ width: 1, color: OUTLINE, alpha: 0.5 });
    c.addChild(post);

    // flame: 3 tongues squashed/swayed each frame
    const flameRoot = new Container();
    flameRoot.y = -16;
    c.addChild(flameRoot);
    const tongues: { g: Graphics; bx: number; ph: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const bx = (i - 1) * 2;
      const h = 15 + (i === 1 ? 4 : 0);
      const fg = new Graphics();
      fg.moveTo(-3, 0)
        .quadraticCurveTo(-2, -h * 0.55, 0, -h)
        .quadraticCurveTo(2, -h * 0.55, 3, 0)
        .closePath()
        .fill({ color: EMBER, alpha: 0.9 });
      fg.moveTo(-1.6, -1)
        .quadraticCurveTo(-1, -h * 0.55, 0, -h * 0.84)
        .quadraticCurveTo(1, -h * 0.55, 1.6, -1)
        .closePath()
        .fill({ color: SAP_BRIGHT });
      fg.x = bx;
      flameRoot.addChild(fg);
      tongues.push({ g: fg, bx, ph: i * 1.5 + seed });
    }
    const core = this.glow(14, EMBER_HI, 0.6);
    flameRoot.addChild(core);

    const sparks: Sprite[] = [];
    for (let i = 0; i < 4; i++) {
      const sp = this.glow(1.6, SAP_BRIGHT, 0.9);
      flameRoot.addChild(sp);
      sparks.push(sp);
    }

    const lightRef: PropLight = {
      x: 0,
      y: 0,
      radius: 110,
      color: EMBER_HI,
      intensity: 0.8,
      flicker: 0.7,
    };
    this.deferLight(c, lightRef, 0, -20);

    this.animators.push((t) => {
      for (const tn of tongues) {
        tn.g.scale.y = 0.85 + Math.sin(t * 10 + tn.ph) * 0.13;
        tn.g.x = tn.bx + Math.sin(t * 6 + tn.ph) * 1.8;
        tn.g.alpha = 0.82 + Math.sin(t * 14 + tn.ph) * 0.16;
      }
      core.alpha = 0.5 + Math.sin(t * 9 + seed) * 0.16;
      halo.alpha = 0.46 + Math.sin(t * 6 + seed) * 0.08;
      for (let i = 0; i < sparks.length; i++) {
        const sp = sparks[i];
        const fy = -4 - ((t * 22 + i * 9) % 18);
        sp.y = fy;
        sp.x = Math.sin(t * 4 + i + seed) * 3;
        sp.alpha = Math.max(0, 0.8 + fy / 20);
      }
    });

    return c;
  }

  // ==========================================================================
  // LANTERN — standing pole with a hanging lantern that gently swings; warm
  // glow + glass + flame. Contributes a soft, lightly flickering light.
  // ==========================================================================
  private makeLantern(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y) * 6.28;

    // pole + hook (static)
    const pole = new Graphics();
    contactShadow(pole, 0, 14, 7, 2.6, 0.3);
    pole
      .moveTo(0, 14)
      .lineTo(0, -22)
      .quadraticCurveTo(0, -28, -8, -28)
      .stroke({ width: 3.5, color: BARK_DK });
    pole.moveTo(-1.2, 12).lineTo(-1.2, -22).stroke({ width: 1.1, color: BARK, alpha: 0.6 });
    c.addChild(pole);

    // swinging assembly: chain + lantern body hang under the hook at (-8,-28)
    const swing = new Container();
    swing.x = -8;
    swing.y = -28;
    c.addChild(swing);

    const halo = this.glow(28, SAP_BRIGHT, 0.5);
    halo.y = 12;
    swing.addChild(halo);

    const body = new Graphics();
    // chain
    body.moveTo(0, 0).lineTo(0, 8).stroke({ width: 1.5, color: IRON });
    // top cap
    body.moveTo(-6, 10).lineTo(0, 4).lineTo(6, 10).closePath().fill({ color: BARK_DK }).stroke({ width: 2, color: OUTLINE });
    // cage
    body.poly([-6, 10, 6, 10, 5, 24, -5, 24]).fill({ color: BARK_DK }).stroke({ width: 2, color: OUTLINE });
    // cage bars
    for (const bx of [-2, 2]) body.moveTo(bx, 11).lineTo(bx, 23).stroke({ width: 1, color: OUTLINE, alpha: 0.6 });
    // warm glass pane behind the flame
    blob(body, 0, 17, 4.2, 6, mix(SAP_BRIGHT, 0xffffff, 0.2), 0.85);
    swing.addChild(body);

    // inner flame glow (additive)
    const flame = this.glow(7, SAP_BRIGHT, 0.85);
    flame.y = 18;
    swing.addChild(flame);
    // glass specular streak
    body.moveTo(-2, 13).lineTo(-3, 20).stroke({ width: 1.4, color: 0xffffff, alpha: 0.4 });

    const lightRef: PropLight = {
      x: 0,
      y: 0,
      radius: 95,
      color: SAP_BRIGHT,
      intensity: 0.7,
      flicker: 0.35,
    };
    this.deferLight(c, lightRef, -8, -10);

    this.animators.push((t) => {
      swing.rotation = Math.sin(t * 1.8 + seed) * 0.12;
      const fl = 0.7 + Math.sin(t * 8 + seed) * 0.18 + Math.sin(t * 17) * 0.06;
      flame.alpha = fl;
      flame.scale.set((7 * (0.92 + (fl - 0.7) * 0.5) * 2) / this.glowSize);
      halo.alpha = 0.46 + Math.sin(t * 5 + seed) * 0.08;
    });

    return c;
  }

  // ==========================================================================
  // MUSHROOM — a small cluster of caps with bioluminescent pulse, gills, spots.
  // Contributes a soft glowing light.
  // ==========================================================================
  private makeMushroom(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y);

    const base = new Graphics();
    contactShadow(base, 0, 7, 12, 4, 0.3);
    c.addChild(base);

    // bioluminescent ground halo (additive, behind caps)
    const halo = this.glow(22, MUSH_GLOW, 0.4);
    halo.y = -6;
    c.addChild(halo);

    // 3 caps of varying size; each is a swaying container so the cluster breathes
    const caps: { ct: Container; ph: number; spot: Sprite }[] = [];
    const layout = [
      { x: 0, y: 0, s: 1, big: true },
      { x: -8, y: 4, s: 0.7, big: false },
      { x: 7, y: 5, s: 0.6, big: false },
    ];
    layout.forEach((L, i) => {
      const ct = new Container();
      ct.x = L.x;
      ct.y = L.y;
      const g = new Graphics();
      const sc = L.s;
      // stalk
      g.moveTo(-3 * sc, 6 * sc)
        .quadraticCurveTo(-2 * sc, -2 * sc, -2.4 * sc, -6 * sc)
        .lineTo(2.4 * sc, -6 * sc)
        .quadraticCurveTo(2 * sc, -2 * sc, 3 * sc, 6 * sc)
        .closePath()
        .fill({ color: PARCH })
        .stroke({ width: 1.8, color: OUTLINE });
      // gills under the cap
      for (let k = -2; k <= 2; k++) {
        g.moveTo(k * 1.6 * sc, -6 * sc).lineTo(k * 2.2 * sc, -8.5 * sc).stroke({ width: 1, color: mix(WAX, OUTLINE, 0.3), alpha: 0.7 });
      }
      // cap (deep rot-violet or rot-red)
      const capC = (i + (seed > 0.5 ? 1 : 0)) % 2 ? 0x7b3f6f : TOMATO_DK;
      g.ellipse(0, -7 * sc, 9 * sc, 6 * sc).fill({ color: capC }).stroke({ width: 2.2, color: OUTLINE });
      // cap rim-light + underside shadow
      g.ellipse(-2 * sc, -9 * sc, 4 * sc, 2 * sc).fill({ color: mix(capC, 0xffffff, 0.3), alpha: 0.6 });
      // glowing spots
      for (const [dx, dy] of [
        [-4, -8],
        [3, -9],
        [0, -6],
      ] as const) {
        g.circle(dx * sc, dy * sc, 1.3 * sc).fill({ color: mix(MUSH_GLOW, 0xffffff, 0.3) });
      }
      ct.addChild(g);
      // a per-cap additive bloom over the spots that pulses
      const spot = this.glow(7 * sc, MUSH_GLOW, 0.5);
      spot.y = -7 * sc;
      ct.addChild(spot);
      c.addChild(ct);
      caps.push({ ct, ph: i * 2.1 + seed * 6.28, spot });
    });

    const lightRef: PropLight = {
      x: 0,
      y: 0,
      radius: 70,
      color: MUSH_GLOW,
      intensity: 0.45,
      flicker: 0.15,
    };
    this.deferLight(c, lightRef, 0, -6);

    this.animators.push((t) => {
      for (const cap of caps) {
        cap.ct.rotation = Math.sin(t * 1.2 + cap.ph) * 0.05;
        cap.spot.alpha = 0.4 + Math.sin(t * 2.4 + cap.ph) * 0.28;
      }
      halo.alpha = 0.34 + Math.sin(t * 2 + seed) * 0.12;
    });

    return c;
  }

  // ==========================================================================
  // STALK — a tall corn/tomato stalk that sways: segmented stem, drooping
  // leaves, and a withered fruit hanging near the top.
  // ==========================================================================
  private makeStalk(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y) * 6.28;
    const H = 60;

    const base = new Graphics();
    contactShadow(base, 0, 4, 9, 3, 0.3);
    c.addChild(base);

    // the stalk pivots at its base; upper segments sway more (built as nested
    // containers so a single rotation per segment cascades realistically).
    const seg1 = new Container(); // lower
    const seg2 = new Container(); // mid
    const seg3 = new Container(); // top
    seg1.y = 2;
    c.addChild(seg1);
    seg2.y = -H * 0.38;
    seg1.addChild(seg2);
    seg3.y = -H * 0.34;
    seg2.addChild(seg3);

    // lower stem
    const g1 = new Graphics();
    g1.moveTo(0, 0).quadraticCurveTo(-2, -H * 0.2, 0, -H * 0.4).stroke({ width: 5, color: mix(ROT, BARK, 0.4) });
    g1.moveTo(-1.5, -2).lineTo(-1.5, -H * 0.36).stroke({ width: 1.4, color: ROT_BRIGHT, alpha: 0.5 });
    // node rings
    for (const ny of [-H * 0.14, -H * 0.3]) g1.moveTo(-3, ny).lineTo(3, ny).stroke({ width: 1.4, color: OUTLINE, alpha: 0.5 });
    // a big drooping leaf off the lower stem
    this.stalkLeaf(g1, 0, -H * 0.22, -1, 1.1);
    seg1.addChild(g1);

    // mid stem
    const g2 = new Graphics();
    g2.moveTo(0, 0).quadraticCurveTo(2, -H * 0.18, 0, -H * 0.36).stroke({ width: 4.2, color: mix(ROT, BARK, 0.4) });
    for (const ny of [-H * 0.12, -H * 0.28]) g2.moveTo(-2.6, ny).lineTo(2.6, ny).stroke({ width: 1.2, color: OUTLINE, alpha: 0.5 });
    this.stalkLeaf(g2, 0, -H * 0.2, 1, 0.95);
    seg2.addChild(g2);

    // top stem + withered fruit + tassel
    const g3 = new Graphics();
    g3.moveTo(0, 0).quadraticCurveTo(-1, -H * 0.14, 0, -H * 0.3).stroke({ width: 3.4, color: mix(ROT, BARK, 0.4) });
    // dry tassel
    for (const a of [-0.4, -0.1, 0.2]) {
      g3.moveTo(0, -H * 0.3)
        .lineTo(Math.sin(a) * 10, -H * 0.3 - 10)
        .stroke({ width: 1.4, color: SAP, alpha: 0.8 });
    }
    // withered tomato hanging from a short peduncle
    g3.moveTo(2, -H * 0.18).lineTo(5, -H * 0.12).stroke({ width: 1.6, color: BARK_DK });
    blob(g3, 6, -H * 0.1, 5, 4.6, mix(TOMATO_DK, BARK_DK, 0.4), 1, OUTLINE, 2);
    blob(g3, 4.5, -H * 0.12, 1.8, 1.4, mix(TOMATO, 0xffffff, 0.2), 0.5); // sad highlight
    // a collapsed/rotten dimple
    blob(g3, 7, -H * 0.08, 2, 1.4, 0x000000, 0.3);
    this.stalkLeaf(g3, 0, -H * 0.16, -1, 0.8);
    seg3.addChild(g3);

    this.animators.push((t) => {
      seg1.rotation = Math.sin(t * 1.1 + seed) * 0.05;
      seg2.rotation = Math.sin(t * 1.3 + seed + 0.6) * 0.07;
      seg3.rotation = Math.sin(t * 1.6 + seed + 1.2) * 0.1;
    });

    return c;
  }

  /** A drooping stalk leaf attached at (x,y), curving to one side. */
  private stalkLeaf(g: Graphics, x: number, y: number, dir: number, s: number): void {
    const c = mix(ROT, ROT_BRIGHT, 0.3);
    g.moveTo(x, y)
      .quadraticCurveTo(x + dir * 16 * s, y - 6 * s, x + dir * 26 * s, y + 6 * s)
      .quadraticCurveTo(x + dir * 16 * s, y + 4 * s, x, y + 2)
      .closePath()
      .fill({ color: c })
      .stroke({ width: 1.6, color: OUTLINE });
    // midrib
    g.moveTo(x, y).quadraticCurveTo(x + dir * 16 * s, y - 2 * s, x + dir * 25 * s, y + 5 * s).stroke({ width: 1, color: OUTLINE, alpha: 0.4 });
  }

  // ==========================================================================
  // FENCE — a run of weathered posts + two rails, with one broken post. Sized
  // by p.w (length). Static. p.h is the (thin) rail thickness hint.
  // ==========================================================================
  private makeFence(p: PropDef): Container {
    const c = new Container();
    const len = p.w ?? 200;
    const g = new Graphics();
    const n = Math.max(2, Math.round(len / 50));
    const step = len / (n - 1);
    const seed = hash2(p.x, p.y);

    contactShadow(g, len / 2, 4, len * 0.55, 5, 0.26);

    // two rails behind the posts (sag slightly)
    for (const ry of [-14, -4]) {
      g.moveTo(0, ry)
        .quadraticCurveTo(len / 2, ry + 3, len, ry)
        .stroke({ width: 3.4, color: mix(BARK, BARK_DK, 0.4) });
      g.moveTo(0, ry - 1.2)
        .quadraticCurveTo(len / 2, ry + 1.8, len, ry - 1.2)
        .stroke({ width: 1, color: BARK, alpha: 0.5 });
    }

    // posts
    for (let i = 0; i < n; i++) {
      const px = i * step;
      const broken = (i === Math.floor(n * 0.5 + seed * 2)) && n > 2;
      const top = broken ? -8 : -24;
      g.moveTo(px, 6).lineTo(px, top).stroke({ width: 5, color: BARK });
      g.moveTo(px - 1.4, 4).lineTo(px - 1.4, top + 2).stroke({ width: 1.3, color: mix(BARK, 0xffffff, 0.15), alpha: 0.5 });
      if (broken) {
        // jagged snapped top + the broken-off piece lying on the ground
        g.moveTo(px - 2.5, top)
          .lineTo(px - 0.5, top - 4)
          .lineTo(px + 1, top - 1)
          .lineTo(px + 2.5, top - 5)
          .stroke({ width: 2, color: mix(BARK_DK, OUTLINE, 0.3) });
        g.roundRect(px + 6, 2, 16, 4, 2).fill({ color: BARK }).stroke({ width: 1.6, color: OUTLINE });
      } else {
        // post cap nick + a knot
        g.moveTo(px - 2.5, top).lineTo(px + 2.5, top).stroke({ width: 2, color: OUTLINE, alpha: 0.6 });
        g.circle(px + 1, -16, 1.4).fill({ color: BARK_DK });
      }
    }
    c.addChild(g);
    return c;
  }

  // ==========================================================================
  // SIGN — post + carved board (renders p.text small if present), nails, moss.
  // Static.
  // ==========================================================================
  private makeSign(p: PropDef): Container {
    const c = new Container();
    const bw = 56,
      bh = 26;
    const g = new Graphics();
    contactShadow(g, 0, 18, 9, 3, 0.3);
    // post
    g.rect(-3, -10, 6, 30).fill({ color: BARK_DK }).stroke({ width: 2, color: OUTLINE });
    g.rect(-3, -10, 2, 30).fill({ color: BARK, alpha: 0.5 });
    // board (slightly tilted look via trapezoid)
    g.poly([-bw / 2, -bh - 8, bw / 2, -bh - 6, bw / 2, -6, -bw / 2, -8])
      .fill({ color: BARK })
      .stroke({ width: 3, color: OUTLINE });
    // plank seams
    g.moveTo(-bw / 2 + 2, -bh + 2).lineTo(bw / 2 - 2, -bh + 4).stroke({ width: 1.2, color: BARK_DK, alpha: 0.6 });
    g.moveTo(-bw / 2 + 2, -14).lineTo(bw / 2 - 2, -12).stroke({ width: 1.2, color: BARK_DK, alpha: 0.6 });
    // nails (corners)
    for (const [nx, ny] of [
      [-bw / 2 + 5, -bh - 3],
      [bw / 2 - 5, -bh - 1],
      [-bw / 2 + 5, -10],
      [bw / 2 - 5, -8],
    ] as const) {
      g.circle(nx, ny, 1.6).fill({ color: IRON }).stroke({ width: 0.8, color: OUTLINE });
    }
    // moss creeping up the bottom-left
    blob(g, -bw / 2 + 6, -8, 7, 4, ROT, 0.8);
    blob(g, -bw / 2 + 11, -7, 4, 2.6, ROT_BRIGHT, 0.7);
    blob(g, -2, 16, 5, 3, ROT, 0.7);
    c.addChild(g);

    // carved text rendered small if present — drawn as scratched glyph strokes
    // (no font dependency; reads as carved runes). Centered on the board.
    if (p.text) {
      const tg = new Graphics();
      this.carveText(tg, p.text, 0, -bh - 1, bw - 12, 14);
      c.addChild(tg);
    }
    return c;
  }

  /** Render text as tiny carved scratch-marks: per character we stroke a small
   *  jagged glyph. Not a real font — deliberately runic/illegible-but-textual,
   *  which suits the painterly tone and avoids loading a TextStyle per sign. */
  private carveText(
    g: Graphics,
    text: string,
    cx: number,
    cy: number,
    maxW: number,
    maxH: number
  ): void {
    const lines = text.split("\n").slice(0, 3);
    const lineH = Math.min(6, maxH / lines.length);
    const gw = 3.2; // glyph advance
    lines.forEach((line, li) => {
      const chars = Math.min(line.length, Math.floor(maxW / gw));
      const startX = cx - (chars * gw) / 2;
      const y = cy + li * lineH;
      for (let i = 0; i < chars; i++) {
        const ch = line[i];
        if (ch === " ") continue;
        const x = startX + i * gw;
        const h = hash2(x, y + ch.charCodeAt(0));
        // a 2-3 segment scratch per glyph, varied by hash -> looks carved
        g.moveTo(x, y + (h < 0.5 ? 0 : lineH * 0.3))
          .lineTo(x + gw * 0.7, y + (h < 0.5 ? lineH * 0.4 : 0))
          .stroke({ width: 0.9, color: 0x000000, alpha: 0.6 });
        if (h > 0.4) {
          g.moveTo(x, y + lineH * 0.4)
            .lineTo(x + gw * 0.6, y + lineH * 0.4)
            .stroke({ width: 0.9, color: 0x000000, alpha: 0.55 });
        }
        // a faint lighter scratch beside it for "carved" depth
        g.moveTo(x + 0.6, y + 0.5)
          .lineTo(x + gw * 0.7 + 0.6, y + lineH * 0.4 + 0.5)
          .stroke({ width: 0.7, color: PARCH, alpha: 0.18 });
      }
    });
  }

  // ==========================================================================
  // BONES — a scattered pile of long bones + a cracked skull. Sized by p.w.
  // Static. The skull's hollow sockets read as quietly ominous.
  // ==========================================================================
  private makeBones(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y);
    const scale = (p.w ?? 40) / 40;
    const g = new Graphics();
    g.scale.set(scale);

    contactShadow(g, 0, 4, 16, 5, 0.28);

    // a couple of long bones crossed
    for (const [ang, len] of [
      [0.3 + seed, 17],
      [-0.5 + seed, 13],
      [1.5 - seed, 11],
    ] as [number, number][]) {
      const dx = Math.cos(ang),
        dy = Math.sin(ang) * 0.5;
      const hx = (dx * len) / 2,
        hy = (dy * len) / 2;
      g.moveTo(-hx, -hy)
        .lineTo(hx, hy)
        .stroke({ width: 4, color: BONE });
      g.moveTo(-hx, -hy - 1)
        .lineTo(hx, hy - 1)
        .stroke({ width: 1.2, color: mix(BONE, 0xffffff, 0.4), alpha: 0.6 });
      // knobby epiphyses at each end
      for (const s of [-1, 1]) {
        g.circle(s * hx, s * hy - 1, 2.4).fill({ color: BONE }).stroke({ width: 1, color: OUTLINE });
        g.circle(s * hx, s * hy + 1.5, 2.2).fill({ color: mix(BONE, OUTLINE, 0.15) }).stroke({ width: 1, color: OUTLINE });
      }
    }

    // a little cracked skull (tomato-rounded — harvest gothic)
    const sx = -6,
      sy = 3;
    g.ellipse(sx, sy, 7, 6).fill({ color: BONE }).stroke({ width: 2, color: OUTLINE });
    g.ellipse(sx - 2, sy - 2, 3, 1.6).fill({ color: 0xffffff, alpha: 0.35 }); // pate sheen
    // eye sockets (deep, hollow)
    g.circle(sx - 2.4, sy - 0.4, 1.9).fill({ color: 0x000000, alpha: 0.85 });
    g.circle(sx + 2.4, sy - 0.4, 1.9).fill({ color: 0x000000, alpha: 0.85 });
    // nasal + jaw line
    g.poly([sx, sy + 1, sx - 1, sy + 3, sx + 1, sy + 3]).fill({ color: 0x000000, alpha: 0.7 });
    g.moveTo(sx - 4, sy + 4).lineTo(sx + 4, sy + 4).stroke({ width: 0.9, color: OUTLINE, alpha: 0.5 });
    // jagged crack across the cranium
    g.moveTo(sx, sy - 6).lineTo(sx + 1.2, sy - 2.5).lineTo(sx - 1, sy - 0.5).stroke({ width: 1, color: OUTLINE, alpha: 0.6 });
    c.addChild(g);
    return c;
  }

  // ==========================================================================
  // BANNER — a tattered hanging cloth that ripples. Pole + finial + cloth.
  // Cloth ripple is animated by skewing a fixed strip of quads (cheap).
  // ==========================================================================
  private makeBanner(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y) * 6.28;
    const cw = p.w ?? 28; // cloth width hint
    const ch = p.h ?? 100; // cloth height hint

    const post = new Graphics();
    contactShadow(post, 0, 18, 9, 3, 0.3);
    post.rect(-2.5, -ch * 0.45, 5, ch * 0.45 + 18).fill({ color: BARK_DK }).stroke({ width: 2, color: OUTLINE });
    post.circle(0, -ch * 0.45 - 2, 3.2).fill({ color: SAP }).stroke({ width: 1.4, color: OUTLINE }); // finial
    // crossarm the cloth hangs from
    post.moveTo(-2, -ch * 0.42).lineTo(cw + 4, -ch * 0.42).stroke({ width: 3, color: BARK_DK });
    c.addChild(post);

    // cloth as a vertical stack of strip quads; each strip's right edge is
    // displaced by a sine wave we update each frame -> a travelling ripple.
    const cloth = new Graphics();
    c.addChild(cloth);
    const strips = 8;
    const top = -ch * 0.42;
    const stripH = (ch * 0.9) / strips;
    const color = DEEP_BANNER(seed);

    const drawCloth = (t: number): void => {
      cloth.clear();
      // NOTE: this is the one prop that re-tessellates a *tiny* mesh per frame
      // (8 quads). It's deliberately bounded and trivial vs. rebuilding a full
      // prop; everything else animates by transform only.
      const xOff = (i: number) =>
        Math.sin(t * 2 + i * 0.55 + seed) * (1.5 + i * 0.5);
      for (let i = 0; i < strips; i++) {
        const y0 = top + i * stripH;
        const y1 = y0 + stripH;
        const lx0 = 2 + xOff(i),
          lx1 = 2 + xOff(i + 1);
        const rx0 = 2 + cw + xOff(i),
          rx1 = 2 + cw + xOff(i + 1);
        const shade = mix(color, OUTLINE, 0.04 + (i / strips) * 0.18);
        cloth
          .poly([lx0, y0, rx0, y0, rx1, y1, lx1, y1])
          .fill({ color: shade });
      }
      // outline + tattered bottom (a swallowtail notch + frayed slits)
      const bx = (i: number) => 2 + xOff(strips) + (i / 4) * cw;
      const by = top + strips * stripH;
      cloth
        .moveTo(2 + xOff(strips), by)
        .lineTo(bx(1), by + 6)
        .lineTo(bx(2), by - 4)
        .lineTo(bx(3), by + 7)
        .lineTo(2 + cw + xOff(strips), by)
        .stroke({ width: 2, color: mix(color, OUTLINE, 0.3) });
      // left + right edges
      cloth
        .moveTo(2 + xOff(0), top)
        .lineTo(2 + xOff(strips), by)
        .stroke({ width: 1.6, color: OUTLINE, alpha: 0.5 });
      cloth
        .moveTo(2 + cw + xOff(0), top)
        .lineTo(2 + cw + xOff(strips), by)
        .stroke({ width: 1.6, color: OUTLINE, alpha: 0.5 });
      // emblem: a pale tomato sigil mid-cloth
      const ex = 2 + cw * 0.5 + xOff(strips / 2),
        ey = top + ch * 0.42;
      cloth.ellipse(ex, ey, 6, 5.6).fill({ color: TOMATO, alpha: 0.92 }).stroke({ width: 1.6, color: OUTLINE });
      cloth.ellipse(ex - 2, ey - 2, 2, 1.4).fill({ color: 0xffffff, alpha: 0.3 });
      for (const a of [-0.5, 0, 0.5]) {
        cloth
          .moveTo(ex, ey - 5)
          .lineTo(ex + Math.sin(a) * 5, ey - 9)
          .stroke({ width: 1.6, color: 0x3c6b2f });
      }
    };
    drawCloth(0);
    this.animators.push(drawCloth);

    return c;
  }

  // ==========================================================================
  // GRASS — a dry tuft of blades that sway in the wind. Cheap: each blade is a
  // child container rotated a little each frame.
  // ==========================================================================
  private makeGrass(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y) * 6.28;

    const base = new Graphics();
    contactShadow(base, 0, 3, 9, 2.4, 0.22);
    c.addChild(base);

    const blades: { ct: Container; ph: number; amp: number }[] = [];
    const N = 6;
    for (let i = 0; i < N; i++) {
      const off = i - (N - 1) / 2;
      const ct = new Container();
      ct.x = off * 2.2;
      const len = 12 + (i % 2) * 5;
      const dead = (i + (seed > 0.5 ? 0 : 1)) % 2 === 0;
      const base1 = dead ? 0x8a7a3a : ROT;
      const tip = dead ? 0xa89a4a : ROT_BRIGHT;
      const g = new Graphics();
      g.moveTo(0, 2)
        .quadraticCurveTo(off * 1.5, -len * 0.6, off * 2.5, -len)
        .stroke({ width: 2.4, color: base1 });
      g.moveTo(0, 0)
        .quadraticCurveTo(off * 1.5, -len * 0.6, off * 2.5, -len)
        .stroke({ width: 1, color: tip, alpha: 0.7 });
      ct.addChild(g);
      c.addChild(ct);
      blades.push({ ct, ph: i * 0.9 + seed, amp: 0.1 + (i % 2) * 0.04 });
    }

    this.animators.push((t) => {
      for (const b of blades) b.ct.rotation = Math.sin(t * 1.8 + b.ph) * b.amp;
    });
    return c;
  }

  // ==========================================================================
  // FLOWER — a small rot-flower: stem, leaf, ring of petals that slowly turn,
  // and a sap center. Gentle sway.
  // ==========================================================================
  private makeFlower(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y);

    const base = new Graphics();
    contactShadow(base, 0, 3, 7, 2, 0.2);
    c.addChild(base);

    const sway = new Container();
    c.addChild(sway);

    const stem = new Graphics();
    stem.moveTo(0, 5).quadraticCurveTo(2, -2, 0, -8).stroke({ width: 2.4, color: ROT });
    // a single side leaf
    this.smallLeaf(stem, 1, 0, 0.55, 0.6);
    sway.addChild(stem);

    // petal head (a container we rotate slowly)
    const head = new Container();
    head.y = -9;
    sway.addChild(head);
    const petC = [TOMATO, SAP_BRIGHT, 0xca7ad8, 0xff9fb0][Math.floor(seed * 4) % 4];
    const pg = new Graphics();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const dx = Math.cos(a) * 4,
        dy = Math.sin(a) * 4;
      pg.ellipse(dx, dy, 2.4, 4).fill({ color: petC }).stroke({ width: 1.2, color: OUTLINE });
    }
    head.addChild(pg);
    const center = new Graphics();
    center.circle(0, 0, 2.4).fill({ color: SAP }).stroke({ width: 1.2, color: OUTLINE });
    // a few seed dots
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      center.circle(Math.cos(a) * 1, Math.sin(a) * 1, 0.5).fill({ color: BARK_DK });
    }
    head.addChild(center);

    this.animators.push((t) => {
      sway.rotation = Math.sin(t * 1.6 + seed * 6.28) * 0.12;
      head.rotation = t * 0.3;
    });
    return c;
  }

  /** A small leaf attached at (x,y), used by flower/vines. */
  private smallLeaf(g: Graphics, x: number, y: number, dir: number, s: number): void {
    g.moveTo(x, y)
      .quadraticCurveTo(x + dir * 6 * s, y - 2 * s, x + dir * 9 * s, y + 2 * s)
      .quadraticCurveTo(x + dir * 5 * s, y + 1 * s, x, y + 1)
      .closePath()
      .fill({ color: ROT })
      .stroke({ width: 1.2, color: OUTLINE });
  }

  // ==========================================================================
  // VINES — creeping thorned vines along a wall edge. Sized by p.w x p.h.
  //   Built as a wavy stem with thorns, leaves, and a couple of cherry fruit;
  //   the leaves breathe gently.
  // ==========================================================================
  private makeVines(p: PropDef): Container {
    const c = new Container();
    const seed = hash2(p.x, p.y);
    const w = p.w ?? 30;
    const h = p.h ?? 120;
    // vines hang DOWN a vertical surface; main axis is +y over height h.

    const g = new Graphics();
    const n = Math.max(4, Math.round(h / 30));
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const py = (h / n) * i;
      const px = Math.sin(i * 1.1 + seed * 6.28) * (w * 0.4);
      pts.push([px, py]);
    }
    // main stem (two-tone)
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= n; i++) {
      const [px, py] = pts[i];
      const [qx, qy] = pts[i - 1];
      g.quadraticCurveTo((qx + px) / 2 + 4, (qy + py) / 2, px, py);
    }
    g.stroke({ width: 3.2, color: 0x3c5a28 });
    // a thinner secondary tendril
    g.moveTo(pts[0][0] + 4, pts[0][1]);
    for (let i = 1; i <= n; i++) {
      const [px, py] = pts[i];
      g.lineTo(px + Math.sin(i * 1.7 + seed) * (w * 0.3) + 5, py);
    }
    g.stroke({ width: 1.8, color: ROT });

    // thorns + leaves along the stem
    const leafNodes: { ct: Container; ph: number; baseRot: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i];
      // thorn
      const side = i % 2 ? 1 : -1;
      g.moveTo(px, py)
        .lineTo(px + side * 4, py - 2)
        .lineTo(px + side * 1, py + 1)
        .closePath()
        .fill({ color: 0x2a3a18 });
      // breathing leaf in its own container
      const ct = new Container();
      ct.x = px;
      ct.y = py;
      const baseRot = side > 0 ? 0.7 : -0.7 + Math.PI;
      ct.rotation = baseRot;
      const lg = new Graphics();
      lg.scale.set(0.7);
      leaf(lg, 11, 4, mix(ROT, ROT_BRIGHT, 0.3));
      ct.addChild(lg);
      c.addChild(ct);
      leafNodes.push({ ct, ph: i * 0.8 + seed * 6.28, baseRot });
    }
    // cherry tomatoes at a couple of nodes
    for (const idx of [Math.floor(n * 0.4), Math.floor(n * 0.8)]) {
      if (pts[idx]) {
        const [bx, by] = pts[idx];
        blob(g, bx + 3, by + 3, 3.4, 3.4, TOMATO, 1, OUTLINE, 1.4);
        blob(g, bx + 2, by + 2, 1.2, 1, mix(TOMATO, 0xffffff, 0.3), 0.6);
      }
    }
    c.addChildAt(g, 0);

    // leaves breathe: a small rotation wobble around their planted base angle
    // plus a subtle horizontal squash. Transform-only — no geometry rebuild.
    this.animators.push((t) => {
      for (const l of leafNodes) {
        l.ct.rotation = l.baseRot + Math.sin(t * 1.5 + l.ph) * 0.08;
        l.ct.scale.x = 0.66 + Math.sin(t * 1.5 + l.ph) * 0.05;
      }
    });
    return c;
  }

  // ==========================================================================
  // PUDDLE — a murky reflective pool with a subtle, slow ripple. Sized by
  // p.w x p.h. Animated by scaling two faint concentric ripple rings + a
  // breathing sheen; no geometry rebuild.
  // ==========================================================================
  private makePuddle(p: PropDef): Container {
    const c = new Container();
    const rx = (p.w ?? 120) / 2;
    const ry = (p.h ?? 70) / 2;
    const seed = hash2(p.x, p.y) * 6.28;

    const g = new Graphics();
    // body — murky bog water, darker at the rim, a greenish reflective center
    g.ellipse(0, 0, rx, ry).fill({ color: mix(SOIL, ROT, 0.2) });
    g.ellipse(0, 0, rx * 0.82, ry * 0.82).fill({ color: mix(0x16302a, ROT, 0.18) });
    g.ellipse(0, 0, rx, ry).stroke({ width: 2.5, color: mix(SOIL, 0x000000, 0.3) });
    // a darker muck blotch + a reflected cold sky streak
    g.ellipse(rx * 0.2, ry * 0.15, rx * 0.3, ry * 0.28).fill({ color: 0x000000, alpha: 0.28 });
    g.ellipse(-rx * 0.25, -ry * 0.2, rx * 0.5, ry * 0.12).fill({ color: 0x9fc0d0, alpha: 0.18 });
    c.addChild(g);

    // a soft specular sheen that breathes (additive)
    const sheen = this.glow(Math.min(rx, ry) * 0.9, 0xbfe0ea, 0.12);
    sheen.scale.set((Math.min(rx, ry) * 1.4 * 2) / this.glowSize);
    sheen.x = -rx * 0.15;
    sheen.y = -ry * 0.15;
    c.addChild(sheen);

    // two ripple rings (drawn as thin ellipse strokes; scaled out + faded)
    const ring1 = new Graphics();
    ring1.ellipse(0, 0, rx * 0.5, ry * 0.5).stroke({ width: 1.4, color: 0xbfe0ea, alpha: 0.5 });
    const ring2 = new Graphics();
    ring2.ellipse(0, 0, rx * 0.5, ry * 0.5).stroke({ width: 1.2, color: 0xbfe0ea, alpha: 0.4 });
    c.addChild(ring1);
    c.addChild(ring2);

    this.animators.push((t) => {
      const p1 = (t * 0.35 + seed) % 1;
      ring1.scale.set(0.3 + p1 * 1.5);
      ring1.alpha = Math.max(0, 0.5 * (1 - p1));
      const p2 = (t * 0.35 + seed + 0.5) % 1;
      ring2.scale.set(0.3 + p2 * 1.5);
      ring2.alpha = Math.max(0, 0.45 * (1 - p2));
      sheen.alpha = 0.1 + Math.sin(t * 1.3 + seed) * 0.05;
    });
    return c;
  }

  // ==========================================================================
  // GLASS — a cracked greenhouse pane. Sized by p.w x p.h (a tall or wide
  // shard). Static: frame, a translucent tinted pane, crack lines, and a
  // diagonal specular streak.
  // ==========================================================================
  private makeGlass(p: PropDef): Container {
    const c = new Container();
    const w = p.w ?? 60;
    const h = p.h ?? 200;
    const g = new Graphics();
    const hw = w / 2,
      hh = h / 2;
    const seed = hash2(p.x, p.y);

    contactShadow(g, 0, hh + 2, hw + 2, 5, 0.22);
    // wooden/iron frame
    g.rect(-hw - 2, -hh - 2, w + 4, h + 4).fill({ color: BARK_DK }).stroke({ width: 2, color: OUTLINE });
    // the pane — cool translucent green, condensation-fogged
    g.rect(-hw, -hh, w, h).fill({ color: 0x4a7a6a, alpha: 0.4 });
    g.rect(-hw, -hh, w, h).stroke({ width: 1.5, color: 0x2a4a40, alpha: 0.7 });
    // fogged condensation blobs
    for (let i = 0; i < 4; i++) {
      const fy = -hh + ((i + 0.5) / 4) * h;
      const fx = (hash2(p.x + i, p.y) - 0.5) * w * 0.5;
      g.ellipse(fx, fy, w * 0.18, h * 0.05).fill({ color: 0xcfe6df, alpha: 0.12 });
    }
    // a starburst crack from an impact point
    const ix = (seed - 0.5) * w * 0.4,
      iy = (hash2(p.y, p.x) - 0.5) * h * 0.4;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + seed;
      const len = (0.3 + hash2(i, seed) * 0.5) * Math.min(w, h);
      g.moveTo(ix, iy)
        .lineTo(ix + Math.cos(a) * len, iy + Math.sin(a) * len * 1.4)
        .stroke({ width: 1, color: 0xffffff, alpha: 0.5 });
    }
    // concentric crack rings near the impact
    g.circle(ix, iy, 4).stroke({ width: 0.8, color: 0xffffff, alpha: 0.4 });
    g.circle(ix, iy, 8).stroke({ width: 0.7, color: 0xffffff, alpha: 0.3 });
    // big diagonal specular streak
    g.moveTo(-hw + 3, -hh + h * 0.2)
      .lineTo(hw - 3, -hh + h * 0.5)
      .stroke({ width: 3, color: 0xffffff, alpha: 0.12 });
    c.addChild(g);
    return c;
  }

  // ==========================================================================
  // STONE — a mossy boulder with a cast shadow. Sized by p.w x p.h. Static:
  // rounded rock body with facet shading, moss patches, lichen speckle.
  // ==========================================================================
  private makeStone(p: PropDef): Container {
    const c = new Container();
    const rx = (p.w ?? 60) / 2;
    const ry = (p.h ?? 60) / 2.2;
    const g = new Graphics();
    const seed = hash2(p.x, p.y);

    // a long soft cast shadow to the lower-right
    contactShadow(g, rx * 0.4, ry + 4, rx * 1.2, ry * 0.5, 0.34);

    // boulder body — irregular polygon so it doesn't read as a perfect ellipse
    const verts: number[] = [];
    const VN = 9;
    for (let i = 0; i < VN; i++) {
      const a = (i / VN) * Math.PI * 2;
      const wob = 0.82 + hash2(i, seed) * 0.3;
      verts.push(Math.cos(a) * rx * wob, Math.sin(a) * ry * wob);
    }
    g.poly(verts).fill({ color: mix(0x4a4a52, SOIL, 0.2) }).stroke({ width: 3, color: OUTLINE });
    // top-light facet + bottom core-shadow
    g.ellipse(-rx * 0.2, -ry * 0.35, rx * 0.6, ry * 0.4).fill({ color: mix(0x6a6a72, 0xffffff, 0.12), alpha: 0.5 });
    g.ellipse(rx * 0.15, ry * 0.3, rx * 0.6, ry * 0.45).fill({ color: 0x000000, alpha: 0.28 });
    // cracks
    g.moveTo(-rx * 0.4, -ry * 0.2)
      .lineTo(rx * 0.1, ry * 0.1)
      .lineTo(rx * 0.5, -ry * 0.1)
      .stroke({ width: 1.2, color: OUTLINE, alpha: 0.5 });
    // moss blanket over the top + dripping down one side
    g.moveTo(-rx * 0.8, -ry * 0.1)
      .quadraticCurveTo(0, -ry * 1.1, rx * 0.8, -ry * 0.1)
      .quadraticCurveTo(rx * 0.5, -ry * 0.2, rx * 0.3, ry * 0.1)
      .quadraticCurveTo(0, -ry * 0.5, -rx * 0.3, ry * 0.05)
      .quadraticCurveTo(-rx * 0.5, -ry * 0.2, -rx * 0.8, -ry * 0.1)
      .closePath()
      .fill({ color: ROT, alpha: 0.85 });
    // moss highlight + speckle
    g.ellipse(-rx * 0.1, -ry * 0.55, rx * 0.4, ry * 0.18).fill({ color: ROT_BRIGHT, alpha: 0.6 });
    for (let i = 0; i < 7; i++) {
      const a = hash2(i, seed) * 6.28;
      const rr = hash2(i + 3, seed);
      g.circle(Math.cos(a) * rx * 0.5 * rr, -ry * 0.3 + Math.sin(a) * ry * 0.3 * rr, 1).fill({
        color: i % 2 ? ROT_BRIGHT : 0x8aa84a,
        alpha: 0.7,
      });
    }
    c.addChild(g);
    return c;
  }

  // ==========================================================================
  // Light bookkeeping. Lights live in WORLD coords; a prop's local glow sits at
  // (ox,oy) within a node placed at the prop's (x,y). We register the absolute
  // world position lazily after the node has been positioned by build().
  // ==========================================================================
  private deferLight(node: Container, light: PropLight, ox: number, oy: number): void {
    // The owning `node` is positioned by build() AFTER makeProp() returns, so we
    // can't read node.x/y here. Stage the light + its local offset; build()
    // resolves the absolute world position once the node is placed.
    const list = this.pendingLights.get(node);
    if (list) list.push({ light, ox, oy });
    else this.pendingLights.set(node, [{ light, ox, oy }]);
  }
}

// DEEP red banner cloth, varied a touch per-instance so two banners differ.
function DEEP_BANNER(seed: number): number {
  return mix(0x9e2018, 0x6b1414, seed);
}
