// env.ts — procedural ENVIRONMENT renderer for the Pixi v8 (WebGL) build of
// Tommy Tomato: Harvest Souls. The game ships NO painted tile art, so the whole
// world has to look good drawn in code. This is the v2 reimagining of v1's
// Canvas2D drawFloor / drawBlock (src/game/sim/Game.ts), rebuilt RICHER and on
// the GPU: painterly, layered grime instead of flat fills.
//
// ----------------------------------------------------------------------------
// WHAT THIS OWNS
//   * the GROUND — a per-biome floor (rows / glass / stone / bog / yard / soil),
//     drawn as layered, varied, painterly texture (not a flat color).
//   * the WALLS — every area.walls rect rendered as a chunky extruded 2.5D block
//     (contact shadow + lit front face + textured top cap + bevel + base rot).
//   * a soft VIGNETTE baked into the ground so the playfield reads.
//
// ----------------------------------------------------------------------------
// PERFORMANCE STRATEGY (the whole point of this file)
//   Areas are big (up to 1700×1300). Drawing thousands of Graphics ops every
//   build — let alone every frame — would tank the framerate. So:
//     1. We BAKE one seamless ~256×256 floor tile per biome into a Texture once
//        (renderer.generateTexture) and cover the area with a single
//        TilingSprite. One draw call for the entire floor.
//     2. A bounded amount of *macro* detail (big cracks, water sheets, blood
//        pools, scattered bones) is drawn ONCE into a per-build Graphics that
//        lives in the layer — these are area-sized but cheap (tens of ops), and
//        only rebuilt on area change, never per frame.
//     3. The ONLY per-frame work (update) is a thin animated overlay for the bog
//        (water shimmer + ripples) and a faint heat haze — a handful of cheap
//        Graphics redraws on a small fixed budget.
//
// ----------------------------------------------------------------------------
// COORDINATE SPACE / INTEGRATION
//   GroundLayer lives in WORLD space. Add it to the world/camera container
//   UNDER the entity (sprite) layer and under VFX. Then:
//       const ground = new GroundLayer();
//       ground.init(renderer);          // once, after the Renderer exists
//       world.addChildAt(ground, 0);    // bottom of the world stack
//       // on area change:
//       ground.build(area);             // area is the sim's AreaDef
//       // every frame:
//       ground.update(t);               // t = elapsed seconds (for bog/haze)
//   Walls here are PURELY visual extrusions of area.walls; collision still lives
//   in the sim. Props, pickups, lighting, weather and grade are other layers'
//   jobs — this file deliberately stops at ground + walls + vignette.
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  TilingSprite,
  Texture,
  FillGradient,
  type Renderer,
} from "pixi.js";

// ============================================================================
// AreaDef — structural shape we consume (kept local so env.ts has no hard
// import dependency on the sim; the real AreaDef in sim/content.ts is a
// superset and is assignable to this).
// ============================================================================

type FloorKind = "soil" | "rows" | "glass" | "stone" | "yard" | "bog";

interface WallRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface EnvAreaDef {
  id: string;
  name?: string;
  w: number;
  h: number;
  floor: FloorKind;
  tint?: string;
  walls: WallRect[];
  // ...the sim's AreaDef carries more (props, gates, spawnPoint, compost);
  // the environment renderer only needs the fields above.
}

// ============================================================================
// Palette (harvest-gothic) — matched to the painterly Ludo character art.
// Stored as 0xRRGGBB ints (Pixi-native). Names mirror v1's art.ts.
// ============================================================================

const SOIL = 0x0d0a09;
const BARK = 0x2c2018;
const TOMATO = 0xd83a2e;
const ROT = 0x6b7d3a;
const ROT_BRIGHT = 0x9fb24e;
const SAP = 0xe8b53a;
const SAP_BRIGHT = 0xffd56b;
const PARCH = 0xe9dcc0;
const BLOOD = 0x7a1414;
const OUTLINE = 0x140d0a;

// ============================================================================
// Tiny deterministic RNG — so an area's grime/clods/cracks are the same every
// build (no shimmering on revisits) but each area looks unique. Mulberry32.
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of an area id string -> RNG seed. */
function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ============================================================================
// Color helpers (work directly on 0xRRGGBB ints — no string parsing in hot
// paths). lerp for shading, jitter for per-instance variation.
// ============================================================================

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

const lighten = (c: number, t: number) => mix(c, 0xffffff, t);
const darken = (c: number, t: number) => mix(c, 0x000000, t);

/** Nudge a color randomly within ±amt (per channel) for organic variation. */
function jitterCol(c: number, rnd: () => number, amt: number): number {
  const r = clampByte(((c >> 16) & 0xff) + (rnd() - 0.5) * 2 * amt);
  const g = clampByte(((c >> 8) & 0xff) + (rnd() - 0.5) * 2 * amt);
  const b = clampByte((c & 0xff) + (rnd() - 0.5) * 2 * amt);
  return (r << 16) | (g << 8) | b;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

// ============================================================================
// Per-biome base/wall description. Base = the flat fill *under* the texture
// tile (so seams never flash through). Walls: top cap + lit front + extrusion
// height, biome-appropriate.
// ============================================================================

interface BiomeStyle {
  /** Solid color painted under the tiling floor (fallback / seam guard). */
  base: number;
  /** Wall top-cap base color (gets the biome surface texture on top). */
  wallTop: number;
  /** Wall lit front-face base color (gets planks / courses / grime). */
  wallFront: number;
  /** Extrusion height in px toward the camera. */
  wallH: number;
  /** Moss/rot tone creeping at the wall base. */
  wallRot: number;
}

function biomeStyle(floor: FloorKind, areaId: string): BiomeStyle {
  // The throne arena is stone but bloodier/darker — special-cased like v1.
  const king = areaId === "kingarena";
  switch (floor) {
    case "rows":
      return { base: 0x2a1c12, wallTop: 0x4a3725, wallFront: 0x1c130c, wallH: 28, wallRot: ROT };
    case "glass":
      return { base: 0x1c2622, wallTop: 0x2c3a36, wallFront: 0x121a18, wallH: 24, wallRot: 0x4a6a4a };
    case "stone":
      return king
        ? { base: 0x17120f, wallTop: 0x3a322c, wallFront: 0x160f0c, wallH: 32, wallRot: 0x3a2a1a }
        : { base: 0x1a1614, wallTop: 0x403a32, wallFront: 0x181410, wallH: 32, wallRot: 0x3a4a2a };
    case "bog":
      return { base: 0x141d18, wallTop: 0x243028, wallFront: 0x0e1612, wallH: 18, wallRot: 0x2a3a24 };
    case "yard":
      return { base: 0x2a1810, wallTop: 0x3e2a1c, wallFront: 0x180f09, wallH: 30, wallRot: 0x4a2a1a };
    case "soil":
    default:
      return { base: 0x241712, wallTop: 0x4a3725, wallFront: 0x1c130c, wallH: 26, wallRot: ROT };
  }
}

// Size of a baked floor tile. 256 keeps the texture cheap to bake while large
// enough that the repeat doesn't read as an obvious grid at the game's zoom.
const TILE = 256;

// ============================================================================
// GroundLayer
// ============================================================================

export class GroundLayer extends Container {
  private renderer: Renderer | null = null;

  // child layers (bottom -> top within the ground)
  private readonly baseG = new Graphics(); // flat seam-guard fill
  private floorSprite: TilingSprite | null = null; // the baked, tiled floor
  private readonly macroG = new Graphics(); // area-sized once-per-build detail
  private readonly waterG = new Graphics(); // animated bog water (update())
  private readonly wallG = new Graphics(); // extruded 2.5D walls
  private readonly hazeG = new Graphics(); // faint per-frame heat haze (yard)
  private readonly vignetteG = new Graphics(); // baked edge-darkening

  // current build state
  private area: EnvAreaDef | null = null;
  private style: BiomeStyle = biomeStyle("soil", "");
  private bakedTexture: Texture | null = null; // owned; destroyed on rebuild
  private animated = false; // true only for bog (drives update cost)
  private hazy = false; // true for yard (heat shimmer)

  constructor() {
    super();
    // z-order inside the ground: base < floor-tile < macro detail < water <
    // walls < haze < vignette. The floor sprite is inserted at build() time
    // (index 1) once its texture exists.
    this.addChild(this.baseG); // 0
    // (floorSprite inserted at index 1 in build)
    this.addChild(this.macroG); // grime / cracks / pools
    this.addChild(this.waterG); // animated bog sheet
    this.addChild(this.wallG); // extruded barriers
    this.addChild(this.hazeG); // heat haze
    this.addChild(this.vignetteG); // edge darkening
    // The ground never needs to receive pointer events.
    this.eventMode = "none";
    this.interactiveChildren = false;
  }

  /** Store the renderer used to BAKE floor textures. Call once at setup. */
  init(renderer: Renderer): void {
    this.renderer = renderer;
  }

  // --------------------------------------------------------------------------
  // build — clear everything and (re)construct ground + walls for `area`.
  // Called on area change. Heavy work happens here, NOT in update().
  // --------------------------------------------------------------------------
  build(area: EnvAreaDef): void {
    this.area = area;
    this.style = biomeStyle(area.floor, area.id);
    this.animated = area.floor === "bog";
    this.hazy = area.floor === "yard";

    const rnd = mulberry32(hashStr(area.id) ^ 0x9e3779b9);

    // ---- 0. flat seam-guard fill under the tile (so tile edges never show) --
    this.baseG.clear();
    this.baseG.rect(0, 0, area.w, area.h).fill(this.style.base);

    // ---- 1. baked, tiled floor texture -------------------------------------
    this.buildFloorTile(area, rnd);

    // ---- 2. macro detail layer (area-sized, drawn once) --------------------
    this.macroG.clear();
    this.buildMacroDetail(area, rnd);

    // ---- 3. extruded 2.5D walls --------------------------------------------
    this.wallG.clear();
    for (const w of area.walls) this.drawWallBlock(w, rnd);

    // ---- 4. animated water / haze are seeded but drawn in update() ----------
    this.waterG.clear();
    this.hazeG.clear();
    if (this.animated) this.drawBogWater(0); // initial static frame
    if (this.hazy) this.drawHeatHaze(0);

    // ---- 5. baked vignette over the whole playfield -------------------------
    this.buildVignette(area);
  }

  // --------------------------------------------------------------------------
  // update — subtle per-frame animation. No-op for static biomes.
  //   * bog: water shimmer + drifting ripples + rising bubbles.
  //   * yard: faint heat haze bands.
  // Everything else returns immediately (the common case).
  // --------------------------------------------------------------------------
  update(t: number): void {
    if (this.animated) this.drawBogWater(t);
    if (this.hazy) this.drawHeatHaze(t);
  }

  // --------------------------------------------------------------------------
  // Cleanup — release the baked texture if the layer is torn down.
  // --------------------------------------------------------------------------
  override destroy(options?: Parameters<Container["destroy"]>[0]): void {
    if (this.bakedTexture) {
      this.bakedTexture.destroy(true);
      this.bakedTexture = null;
    }
    super.destroy(options);
  }

  // ==========================================================================
  // FLOOR TILE BAKING — one seamless TILE×TILE texture per biome, then a
  // single TilingSprite covers the whole area. The Graphics used to draw the
  // tile is temporary; we generateTexture from it and discard it.
  // ==========================================================================
  private buildFloorTile(area: EnvAreaDef, rnd: () => number): void {
    // dispose the previous bake
    if (this.bakedTexture) {
      this.bakedTexture.destroy(true);
      this.bakedTexture = null;
    }

    const g = new Graphics();
    switch (area.floor) {
      case "rows":
        this.paintRowsTile(g, rnd);
        break;
      case "glass":
        this.paintGlassTile(g, rnd);
        break;
      case "stone":
        this.paintStoneTile(g, rnd, area.id === "kingarena");
        break;
      case "bog":
        this.paintBogTile(g, rnd);
        break;
      case "yard":
        this.paintYardTile(g, rnd);
        break;
      case "soil":
      default:
        this.paintSoilTile(g, rnd);
        break;
    }

    // Bake to a Texture. If no renderer (e.g. headless/test), fall back to the
    // flat base fill already painted by baseG — the floor still renders, just
    // untextured.
    if (!this.renderer) {
      if (this.floorSprite) {
        this.floorSprite.destroy();
        this.floorSprite = null;
      }
      g.destroy();
      return;
    }

    const tex = this.renderer.generateTexture({
      target: g,
      // Bake exactly the tile rect; the painters draw within [0,TILE).
      // (frame omitted -> uses graphics bounds, but we keep an explicit
      // background-free transparent bake so overlaps blend correctly.)
      resolution: 1,
      antialias: true,
    });
    this.bakedTexture = tex;
    g.destroy();

    if (this.floorSprite) {
      this.floorSprite.texture = tex;
      this.floorSprite.width = area.w;
      this.floorSprite.height = area.h;
    } else {
      this.floorSprite = new TilingSprite({
        texture: tex,
        width: area.w,
        height: area.h,
      });
      this.floorSprite.eventMode = "none";
      // insert just above the seam-guard base (index 1)
      this.addChildAt(this.floorSprite, 1);
    }
  }

  // ==========================================================================
  // PER-BIOME TILE PAINTERS
  // Each paints a SEAMLESS TILE×TILE patch of ground. "Seamless" here means we
  // keep big features away from a single clean edge, scatter detail in a torus
  // (wrap with %), and rely on the dim, grimy palette to hide any faint seam.
  // ==========================================================================

  /** Shared base: a soft two-tone vertical gradient + a wash of noise speckle. */
  private paintTileBase(g: Graphics, lo: number, hi: number): void {
    const grad = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: hi },
        { offset: 1, color: lo },
      ],
      textureSpace: "local",
    });
    g.rect(0, 0, TILE, TILE).fill(grad);
  }

  /** Scatter `n` little speckles (grime/grain) wrapped to tile borders. */
  private speckle(
    g: Graphics,
    rnd: () => number,
    n: number,
    col: number,
    alpha: number,
    rMin: number,
    rMax: number,
    jitter: number
  ): void {
    for (let i = 0; i < n; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = rMin + rnd() * (rMax - rMin);
      g.circle(x, y, r).fill({ color: jitterCol(col, rnd, jitter), alpha });
    }
  }

  // ---- rows: tilled chocolate-soil furrows ---------------------------------
  // Raised ridges + dark valleys running horizontally, clods, tiny sprouts,
  // hairline cracks, scattered pebbles.
  private paintRowsTile(g: Graphics, rnd: () => number): void {
    const dirt = 0x2a1c12;
    this.paintTileBase(g, darken(dirt, 0.35), lighten(dirt, 0.06));

    // furrows: alternating dark valley + lit ridge bands across the tile.
    const rows = 6; // 6 furrows across 256 -> ~42px pitch (matches v1's ~48)
    const pitch = TILE / rows;
    for (let i = 0; i < rows; i++) {
      const y = i * pitch;
      // dark valley trough
      g.rect(0, y, TILE, pitch * 0.42).fill({ color: darken(dirt, 0.5), alpha: 0.9 });
      // raised ridge crown (lit top edge of the next ridge)
      g.rect(0, y + pitch * 0.42, TILE, pitch * 0.18).fill({
        color: lighten(dirt, 0.16),
        alpha: 0.55,
      });
      // soft mid body
      g.rect(0, y + pitch * 0.6, TILE, pitch * 0.4).fill({ color: dirt, alpha: 0.6 });
      // crumbly broken edge along each ridge (short dark dashes)
      const dashes = 14;
      for (let d = 0; d < dashes; d++) {
        const dx = (d / dashes) * TILE + rnd() * 6;
        const dw = 4 + rnd() * 10;
        g.rect(dx, y + pitch * 0.4 + (rnd() - 0.5) * 4, dw, 2).fill({
          color: darken(dirt, 0.6),
          alpha: 0.4,
        });
      }
    }

    // clods of turned earth — small shaded lumps sitting on the ridges
    for (let i = 0; i < 26; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 2.5 + rnd() * 4.5;
      const c = jitterCol(dirt, rnd, 14);
      g.ellipse(x, y, r, r * 0.7).fill({ color: darken(c, 0.25), alpha: 0.8 });
      g.ellipse(x - r * 0.25, y - r * 0.3, r * 0.5, r * 0.34).fill({
        color: lighten(c, 0.22),
        alpha: 0.7,
      }); // tiny lit cap
    }

    // scattered pebbles (cool grey, with a highlight)
    for (let i = 0; i < 10; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 1.5 + rnd() * 2.5;
      g.ellipse(x, y, r, r * 0.8).fill({ color: 0x4a443c, alpha: 0.9 });
      g.circle(x - r * 0.3, y - r * 0.3, r * 0.4).fill({ color: 0x6a6258, alpha: 0.7 });
    }

    // hairline cracks in the dry crust
    g.setStrokeStyle({ width: 1, color: darken(dirt, 0.7), alpha: 0.4 });
    for (let i = 0; i < 7; i++) {
      let x = rnd() * TILE;
      let y = rnd() * TILE;
      g.moveTo(x, y);
      const segs = 2 + (rnd() * 3) | 0;
      for (let s = 0; s < segs; s++) {
        x += (rnd() - 0.5) * 26;
        y += (rnd() - 0.5) * 14;
        g.lineTo(x, y);
      }
      g.stroke();
    }

    // tiny hopeful sprouts pushing through (two-leaf seedlings)
    for (let i = 0; i < 5; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      g.setStrokeStyle({ width: 1.4, color: darken(ROT, 0.1), alpha: 0.85 });
      g.moveTo(x, y).lineTo(x, y - 4 - rnd() * 3).stroke();
      const lr = 2 + rnd() * 1.5;
      g.ellipse(x - 1.5, y - 4, lr, lr * 0.5).fill({ color: ROT_BRIGHT, alpha: 0.8 });
      g.ellipse(x + 1.5, y - 4.5, lr, lr * 0.5).fill({ color: ROT, alpha: 0.8 });
    }

    // fine grime grain over everything
    this.speckle(g, rnd, 60, dirt, 0.18, 0.5, 1.3, 18);
  }

  // ---- glass: cracked greenhouse panes over pale soil ----------------------
  // Pale soil base, a lattice of pane mullions, fracture lines, condensation
  // bloom, moss in the seams, sharp broken-glass glints.
  private paintGlassTile(g: Graphics, rnd: () => number): void {
    const soil = 0x39463f; // pale, mossy-grey soil under the glass
    this.paintTileBase(g, darken(soil, 0.3), lighten(soil, 0.1));

    // faint pale soil mottling beneath the glass
    this.speckle(g, rnd, 40, 0x4a564c, 0.25, 1, 3, 16);

    // a cool greenish glass wash so the whole tile reads "under glass"
    g.rect(0, 0, TILE, TILE).fill({ color: 0x4a6e64, alpha: 0.1 });

    // pane lattice — mullions on a ~64 grid (2 panes per tile axis -> wraps)
    const cell = TILE / 2;
    g.setStrokeStyle({ width: 3, color: darken(0x2a3a34, 0.2), alpha: 0.6 });
    for (let i = 0; i <= 2; i++) {
      const p = i * cell;
      g.moveTo(p, 0).lineTo(p, TILE).stroke();
      g.moveTo(0, p).lineTo(TILE, p).stroke();
    }
    // mullion highlight (thin lit edge beside each bar)
    g.setStrokeStyle({ width: 1, color: lighten(0x4a6e64, 0.25), alpha: 0.4 });
    for (let i = 0; i <= 2; i++) {
      const p = i * cell + 1.5;
      g.moveTo(p, 0).lineTo(p, TILE).stroke();
      g.moveTo(0, p).lineTo(TILE, p).stroke();
    }

    // per-pane content: fracture lines + condensation + a glint
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const ox = cx * cell;
        const oy = cy * cell;
        // fracture: lines radiating from a random impact point
        const ix = ox + cell * (0.3 + rnd() * 0.4);
        const iy = oy + cell * (0.3 + rnd() * 0.4);
        g.setStrokeStyle({ width: 1, color: lighten(0xb9d4cc, 0.0), alpha: 0.35 });
        const cracks = 3 + ((rnd() * 3) | 0);
        for (let c = 0; c < cracks; c++) {
          const a = rnd() * Math.PI * 2;
          const len = 14 + rnd() * (cell * 0.45);
          g.moveTo(ix, iy).lineTo(ix + Math.cos(a) * len, iy + Math.sin(a) * len).stroke();
        }
        // a couple of concentric stress rings near the impact
        g.setStrokeStyle({ width: 1, color: 0xb9d4cc, alpha: 0.18 });
        g.circle(ix, iy, 4 + rnd() * 3).stroke();

        // condensation bloom — stacked translucent disks fake a soft radial
        // falloff (cheap and reliable; no gradient texture per pane).
        const bx = ox + cell * (0.2 + rnd() * 0.6);
        const by = oy + cell * (0.2 + rnd() * 0.6);
        const br = 12 + rnd() * 18;
        g.circle(bx, by, br).fill({ color: 0xcfe6df, alpha: 0.05 });
        g.circle(bx, by, br * 0.6).fill({ color: 0xcfe6df, alpha: 0.06 });
        g.circle(bx, by, br * 0.3).fill({ color: 0xcfe6df, alpha: 0.07 });

        // sharp broken-glass glint
        const gx = ox + cell * (0.15 + rnd() * 0.7);
        const gy = oy + cell * (0.15 + rnd() * 0.7);
        g.setStrokeStyle({ width: 1.5, color: 0xffffff, alpha: 0.5 });
        g.moveTo(gx - 3, gy - 3).lineTo(gx + 3, gy + 3).stroke();
        g.moveTo(gx + 2, gy - 2).lineTo(gx - 2, gy + 2).stroke();
      }
    }

    // moss creeping in the seams (clusters hugging the lattice)
    for (let i = 0; i < 16; i++) {
      const onV = rnd() < 0.5;
      const along = rnd() * TILE;
      const at = (rnd() < 0.5 ? 0 : 1) * cell + cell; // near a mullion
      const x = onV ? at : along;
      const y = onV ? along : at;
      const r = 2 + rnd() * 3;
      g.ellipse(x, y, r, r * 0.7).fill({ color: jitterCol(ROT, rnd, 22), alpha: 0.55 });
    }
  }

  // ---- stone: mossy catacomb flagstones -------------------------------------
  // Irregular flagstones with deep mortar gaps, cracks, lichen patches, water
  // stains, and the odd bone. Throne variant is bloodier.
  private paintStoneTile(g: Graphics, rnd: () => number, throne: boolean): void {
    const stone = throne ? 0x2a2420 : 0x312b26;
    this.paintTileBase(g, darken(stone, 0.45), darken(stone, 0.1));

    // mortar background (dark) shows between the flagstones
    g.rect(0, 0, TILE, TILE).fill(darken(stone, 0.6));

    // a 4×4 grid of flagstones with jittered inset + per-stone shading.
    const n = 4;
    const cw = TILE / n;
    const gap = 3;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        // brick-offset alternate rows so seams don't line up vertically
        const offset = r % 2 === 0 ? 0 : cw * 0.5;
        const sx = c * cw + offset;
        const sy = r * cw;
        // wrap x so the offset row stays seamless
        const x0 = ((sx % TILE) + TILE) % TILE;
        const jw = cw - gap - rnd() * 4;
        const jh = cw - gap - rnd() * 4;
        const px = x0 + gap * 0.5 + (rnd() - 0.5) * 2;
        const py = sy + gap * 0.5 + (rnd() - 0.5) * 2;
        const c0 = jitterCol(stone, rnd, 16);
        // stone body
        this.drawFlagstone(g, px, py, jw, jh, c0, rnd);
        // (draw the wrapped twin if it crosses the right edge)
        if (px + jw > TILE) {
          this.drawFlagstone(g, px - TILE, py, jw, jh, c0, rnd);
        }
      }
    }

    // lichen patches sprawling across stones (rot-green, irregular)
    for (let i = 0; i < 8; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const blobs = 3 + ((rnd() * 3) | 0);
      for (let b = 0; b < blobs; b++) {
        const bx = x + (rnd() - 0.5) * 16;
        const by = y + (rnd() - 0.5) * 16;
        const r = 2 + rnd() * 4;
        g.ellipse(bx, by, r, r * 0.7).fill({
          color: jitterCol(throne ? 0x4a3a1a : ROT, rnd, 20),
          alpha: 0.35,
        });
      }
    }

    // water stains (cool dark seeping pools)
    for (let i = 0; i < 4; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 8 + rnd() * 14;
      g.ellipse(x, y, r, r * 0.6).fill({ color: 0x1c2a2a, alpha: 0.22 });
    }

    // blood in the throne room (old, dark, dragged)
    if (throne) {
      for (let i = 0; i < 5; i++) {
        const x = rnd() * TILE;
        const y = rnd() * TILE;
        const r = 4 + rnd() * 10;
        g.ellipse(x, y, r, r * 0.55).fill({ color: BLOOD, alpha: 0.3 });
        g.ellipse(x + r, y + 2, r * 0.4, r * 0.2).fill({ color: BLOOD, alpha: 0.2 }); // smear tail
      }
    }

    // the odd bone shard wedged in the mortar
    if (rnd() < 0.7) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const a = rnd() * Math.PI;
      const len = 8 + rnd() * 8;
      g.setStrokeStyle({ width: 2.5, color: 0xc9bda0, alpha: 0.7 });
      g.moveTo(x, y)
        .lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
        .stroke();
      // knobby ends
      g.circle(x, y, 1.8).fill({ color: 0xd8ceb4, alpha: 0.7 });
      g.circle(x + Math.cos(a) * len, y + Math.sin(a) * len, 1.8).fill({
        color: 0xd8ceb4,
        alpha: 0.7,
      });
    }

    this.speckle(g, rnd, 50, stone, 0.18, 0.5, 1.4, 14);
  }

  /** One shaded flagstone: body + lit top bevel + dark bottom + a crack. */
  private drawFlagstone(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    col: number,
    rnd: () => number
  ): void {
    g.roundRect(x, y, w, h, 2).fill(col);
    // top/left lit bevel
    g.setStrokeStyle({ width: 1.5, color: lighten(col, 0.18), alpha: 0.6 });
    g.moveTo(x + 1, y + h - 2).lineTo(x + 1, y + 1).lineTo(x + w - 2, y + 1).stroke();
    // bottom/right shade
    g.setStrokeStyle({ width: 1.5, color: darken(col, 0.4), alpha: 0.6 });
    g.moveTo(x + w - 1, y + 1).lineTo(x + w - 1, y + h - 1).lineTo(x + 1, y + h - 1).stroke();
    // a hairline crack across the face
    if (rnd() < 0.5) {
      g.setStrokeStyle({ width: 1, color: darken(col, 0.55), alpha: 0.5 });
      const cx = x + w * (0.2 + rnd() * 0.6);
      g.moveTo(cx, y + 2)
        .lineTo(cx + (rnd() - 0.5) * w * 0.5, y + h - 2)
        .stroke();
    }
  }

  // ---- bog: murky standing water between mud humps ---------------------------
  // The STATIC tile is the mud + scum + reeds bed. The moving water sheet is
  // drawn separately (drawBogWater) so it can animate cheaply.
  private paintBogTile(g: Graphics, rnd: () => number): void {
    const mud = 0x1c2620;
    this.paintTileBase(g, darken(mud, 0.4), lighten(mud, 0.08));

    // mud humps (raised islands of darker, lumpier earth)
    for (let i = 0; i < 7; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const rx = 14 + rnd() * 26;
      const ry = rx * (0.5 + rnd() * 0.3);
      const c = jitterCol(0x2a3026, rnd, 14);
      g.ellipse(x, y, rx, ry).fill({ color: c, alpha: 0.85 });
      // lit crest
      g.ellipse(x - rx * 0.2, y - ry * 0.3, rx * 0.55, ry * 0.4).fill({
        color: lighten(c, 0.16),
        alpha: 0.5,
      });
      // dark waterline ring at the hump's foot
      g.setStrokeStyle({ width: 2, color: darken(mud, 0.5), alpha: 0.4 });
      g.ellipse(x, y + ry * 0.5, rx * 0.95, ry * 0.5).stroke();
    }

    // green scum film floating in patches
    for (let i = 0; i < 10; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 5 + rnd() * 12;
      g.ellipse(x, y, r, r * 0.7).fill({ color: jitterCol(ROT, rnd, 22), alpha: 0.22 });
    }

    // reeds poking up (thin dark blades with a pale tip)
    for (let i = 0; i < 12; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const h = 8 + rnd() * 14;
      const lean = (rnd() - 0.5) * 6;
      g.setStrokeStyle({ width: 1.6, color: darken(ROT, 0.25), alpha: 0.7 });
      g.moveTo(x, y).lineTo(x + lean, y - h).stroke();
      g.circle(x + lean, y - h, 1).fill({ color: SAP, alpha: 0.6 }); // seed head
    }

    this.speckle(g, rnd, 40, mud, 0.18, 0.5, 1.4, 12);
  }

  // ---- yard: packed dirt with blood, ruts, chaff ----------------------------
  private paintYardTile(g: Graphics, rnd: () => number): void {
    const dirt = 0x2a1810;
    this.paintTileBase(g, darken(dirt, 0.32), lighten(dirt, 0.08));

    // broad packed-earth mottling
    for (let i = 0; i < 18; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 6 + rnd() * 18;
      g.ellipse(x, y, r, r * 0.6).fill({ color: jitterCol(dirt, rnd, 16), alpha: 0.4 });
    }

    // tire/cart ruts — paired parallel grooves crossing the tile
    g.setStrokeStyle({ width: 4, color: darken(dirt, 0.5), alpha: 0.4 });
    const ry0 = TILE * (0.2 + rnd() * 0.2);
    g.moveTo(0, ry0).bezierCurveTo(TILE * 0.3, ry0 + 10, TILE * 0.7, ry0 - 8, TILE, ry0 + 4).stroke();
    g.moveTo(0, ry0 + 16).bezierCurveTo(TILE * 0.3, ry0 + 26, TILE * 0.7, ry0 + 8, TILE, ry0 + 20).stroke();
    // lit lip on the upper edge of each rut
    g.setStrokeStyle({ width: 1, color: lighten(dirt, 0.14), alpha: 0.3 });
    g.moveTo(0, ry0 - 3).bezierCurveTo(TILE * 0.3, ry0 + 7, TILE * 0.7, ry0 - 11, TILE, ry0 + 1).stroke();

    // old blood stains (dark, irregular, with a darker crust ring)
    for (let i = 0; i < 5; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 6 + rnd() * 14;
      g.ellipse(x, y, r, r * 0.7).fill({ color: BLOOD, alpha: 0.3 });
      // darker dried crust ring around the pool
      g.setStrokeStyle({ width: 1.5, color: darken(BLOOD, 0.3), alpha: 0.3 });
      g.ellipse(x, y, r, r * 0.7).stroke();
      // spatter droplets
      for (let d = 0; d < 4; d++) {
        g.circle(x + (rnd() - 0.5) * r * 3, y + (rnd() - 0.5) * r * 2, 1 + rnd() * 1.5).fill({
          color: BLOOD,
          alpha: 0.3,
        });
      }
    }

    // dried husks & chaff (little curled amber flecks)
    for (let i = 0; i < 20; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const a = rnd() * Math.PI;
      const len = 2 + rnd() * 4;
      g.setStrokeStyle({ width: 1.4, color: jitterCol(0x8a6a32, rnd, 22), alpha: 0.6 });
      g.moveTo(x, y)
        .lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len)
        .stroke();
    }

    this.speckle(g, rnd, 55, dirt, 0.16, 0.5, 1.3, 16);
  }

  // ---- soil: generic dark tilth (fallback biome) ----------------------------
  private paintSoilTile(g: Graphics, rnd: () => number): void {
    const dirt = 0x241712;
    this.paintTileBase(g, darken(dirt, 0.35), lighten(dirt, 0.07));
    for (let i = 0; i < 22; i++) {
      const x = rnd() * TILE;
      const y = rnd() * TILE;
      const r = 3 + rnd() * 7;
      const c = jitterCol(dirt, rnd, 14);
      g.ellipse(x, y, r, r * 0.7).fill({ color: darken(c, 0.2), alpha: 0.6 });
      g.ellipse(x - r * 0.2, y - r * 0.25, r * 0.5, r * 0.34).fill({
        color: lighten(c, 0.16),
        alpha: 0.5,
      });
    }
    this.speckle(g, rnd, 50, dirt, 0.18, 0.5, 1.4, 16);
  }

  // ==========================================================================
  // MACRO DETAIL — area-sized features drawn ONCE per build into macroG. These
  // are cheap (a few dozen ops total) but break up the tiled repeat at the
  // playfield scale: long cracks, large pools, drifts, edge crud.
  // ==========================================================================
  private buildMacroDetail(area: EnvAreaDef, rnd: () => number): void {
    const { w, h } = area;
    const g = this.macroG;

    // Edge crud: a darker, grimier band hugging the area's interior border so
    // the field feels enclosed and the floor doesn't read as a clean rectangle.
    const band = 46;
    g.rect(0, 0, w, band).fill({ color: 0x000000, alpha: 0.16 });
    g.rect(0, h - band, w, band).fill({ color: 0x000000, alpha: 0.16 });
    g.rect(0, 0, band, h).fill({ color: 0x000000, alpha: 0.16 });
    g.rect(w - band, 0, band, h).fill({ color: 0x000000, alpha: 0.16 });

    switch (area.floor) {
      case "rows":
      case "soil":
      case "yard": {
        // a few long meandering cracks across the whole field
        g.setStrokeStyle({ width: 2, color: 0x000000, alpha: 0.22 });
        const cracks = 4 + ((rnd() * 3) | 0);
        for (let i = 0; i < cracks; i++) {
          let x = rnd() * w;
          let y = rnd() * h;
          g.moveTo(x, y);
          const segs = 5 + ((rnd() * 5) | 0);
          for (let s = 0; s < segs; s++) {
            x += (rnd() - 0.5) * 160;
            y += (rnd() - 0.5) * 90;
            g.lineTo(x, y);
          }
          g.stroke();
        }
        // big dry patches (lighter sun-baked earth)
        for (let i = 0; i < 5; i++) {
          const x = rnd() * w;
          const y = rnd() * h;
          const r = 60 + rnd() * 120;
          g.ellipse(x, y, r, r * 0.6).fill({ color: 0xffffff, alpha: 0.03 });
        }
        break;
      }
      case "stone": {
        // long structural cracks + a couple of big damp stains
        g.setStrokeStyle({ width: 2.5, color: 0x000000, alpha: 0.28 });
        for (let i = 0; i < 4; i++) {
          let x = rnd() * w;
          let y = rnd() * h;
          g.moveTo(x, y);
          const segs = 4 + ((rnd() * 4) | 0);
          for (let s = 0; s < segs; s++) {
            x += (rnd() - 0.5) * 200;
            y += (rnd() - 0.5) * 120;
            g.lineTo(x, y);
          }
          g.stroke();
        }
        for (let i = 0; i < 4; i++) {
          const x = rnd() * w;
          const y = rnd() * h;
          const r = 50 + rnd() * 90;
          g.ellipse(x, y, r, r * 0.55).fill({ color: 0x1c2a2a, alpha: 0.18 });
        }
        break;
      }
      case "glass": {
        // sweeping fracture runs spanning several panes
        g.setStrokeStyle({ width: 1.5, color: 0xcfe6df, alpha: 0.18 });
        for (let i = 0; i < 6; i++) {
          let x = rnd() * w;
          let y = rnd() * h;
          g.moveTo(x, y);
          const segs = 3 + ((rnd() * 3) | 0);
          for (let s = 0; s < segs; s++) {
            x += (rnd() - 0.5) * 180;
            y += (rnd() - 0.5) * 120;
            g.lineTo(x, y);
          }
          g.stroke();
        }
        break;
      }
      case "bog": {
        // large still-water sheets sunk into the field (the dark base shows
        // through; the animated sheet rides on top in update()).
        for (let i = 0; i < 5; i++) {
          const x = rnd() * w;
          const y = rnd() * h;
          const rx = 80 + rnd() * 160;
          const ry = rx * (0.5 + rnd() * 0.3);
          g.ellipse(x, y, rx, ry).fill({ color: 0x0a1410, alpha: 0.5 });
          g.setStrokeStyle({ width: 3, color: 0x0a1410, alpha: 0.4 });
          g.ellipse(x, y, rx, ry).stroke(); // dark shoreline
        }
        break;
      }
    }
  }

  // ==========================================================================
  // BOG WATER — the one animated floor layer. Redrawn each frame into waterG.
  // Cheap: a fixed small set of drifting ripple ellipses, scum sheen, and a
  // few rising bubbles. Cell positions are deterministic from a coarse grid so
  // ripples sit in the sunken sheets, not on the mud humps.
  // ==========================================================================
  private drawBogWater(t: number): void {
    const area = this.area;
    if (!area) return;
    const g = this.waterG;
    g.clear();

    const { w, h } = area;
    // A coarse grid of ripple sources; only emit on ~half the cells (the
    // "wet" ones) so water reads as patchy standing pools, not a full flood.
    const step = 220;
    const cols = Math.ceil(w / step);
    const rows = Math.ceil(h / step);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // deterministic per-cell wetness + phase
        const seed = (c * 73856093) ^ (r * 19349663);
        const wet = ((seed >>> 3) & 7) > 2; // ~62% wet
        if (!wet) continue;
        const cx = c * step + step * 0.5;
        const cy = r * step + step * 0.5;
        const ph = (seed & 1023) / 1023;

        // shimmering water sheet (slow vertical-bob translucent fill)
        const sheen = 0.1 + Math.sin(t * 0.7 + ph * 6.28) * 0.04;
        g.ellipse(cx, cy, step * 0.46, step * 0.3).fill({
          color: 0x1a3a32,
          alpha: Math.max(0.04, sheen),
        });
        // cool sky-glint highlight drifting across the sheet
        const gx = cx + Math.sin(t * 0.5 + ph * 6.28) * step * 0.18;
        const gy = cy + Math.cos(t * 0.4 + ph * 6.28) * step * 0.1;
        g.ellipse(gx, gy, step * 0.16, step * 0.06).fill({ color: 0x6f9a8c, alpha: 0.12 });

        // 2 expanding concentric ripples, phase-offset
        for (let k = 0; k < 2; k++) {
          const prog = (t * 0.35 + ph + k * 0.5) % 1;
          const rr = prog * step * 0.4;
          const a = (1 - prog) * 0.25;
          g.setStrokeStyle({ width: 1.5, color: 0x8fb2a4, alpha: a });
          g.ellipse(cx, cy, rr, rr * 0.55).stroke();
        }

        // a rising bubble that pops at the top of its travel
        const bprog = (t * 0.6 + ph) % 1;
        const bx = cx + Math.sin(ph * 12) * step * 0.2;
        const by = cy + step * 0.25 - bprog * step * 0.4;
        g.circle(bx, by, 1.5 + (1 - bprog) * 1.5).fill({
          color: 0xb9d4cc,
          alpha: 0.18 * (1 - bprog),
        });
      }
    }
  }

  // ==========================================================================
  // HEAT HAZE — faint horizontal shimmer bands for the yard. Per-frame, cheap.
  // A handful of low-alpha warm bands that slide & breathe. Reads as rising
  // heat over the packed dirt without a shader.
  // ==========================================================================
  private drawHeatHaze(t: number): void {
    const area = this.area;
    if (!area) return;
    const g = this.hazeG;
    g.clear();
    const { w, h } = area;
    const bands = 7;
    for (let i = 0; i < bands; i++) {
      const baseY = (i / bands) * h;
      const y = baseY + Math.sin(t * 0.6 + i * 1.3) * 10;
      const a = 0.02 + (Math.sin(t * 0.9 + i) * 0.5 + 0.5) * 0.025;
      g.rect(0, y, w, 18 + Math.sin(t + i) * 6).fill({ color: 0xffb060, alpha: a });
    }
  }

  // ==========================================================================
  // WALLS — extruded 2.5D blocks. Each area.walls rect (a footprint at z=0) is
  // drawn raised by wallH toward the camera (screen-up). Layers, bottom->top:
  //   1. contact / AO shadow hugging the south base on the ground
  //   2. dark lit FRONT (south) face with biome texture (planks/courses/grime)
  //   3. TOP cap with the biome surface texture + beveled lit north edge
  //   4. moss / rot creeping at the base
  //   5. crisp outline so it reads as a chunky solid, not a flat rect
  // The painter is deterministic per wall (seeded by position) so texture is
  // stable across rebuilds.
  // ==========================================================================
  private drawWallBlock(wall: WallRect, _rnd: () => number): void {
    const { x, y, w, h } = wall;
    const s = this.style;
    const H = s.wallH;
    const g = this.wallG;
    const topY = y - H; // the cap's north edge after extrusion
    const floor = this.area?.floor ?? "soil";

    // per-wall deterministic rng so plank/course jitter is stable
    const wr = mulberry32((((x * 73856093) ^ (y * 19349663) ^ (w * 83492791)) >>> 0) || 1);

    // ---- 1. contact / ambient-occlusion shadow on the ground ----------------
    // a soft dark skirt south of the base + a tight dark contact line.
    g.rect(x - 4, y + h - 2, w + 8, 10).fill({ color: 0x000000, alpha: 0.22 });
    g.rect(x - 2, y + h - 1, w + 4, 4).fill({ color: 0x000000, alpha: 0.34 });

    // ---- 2. FRONT (south) face ---------------------------------------------
    const frontTop = topY + h; // y where the front face starts
    const front = s.wallFront;
    // base gradient: a touch lighter at the top of the face (catching light),
    // darker toward the ground.
    const fg = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: lighten(front, 0.12) },
        { offset: 1, color: darken(front, 0.25) },
      ],
      textureSpace: "local",
    });
    g.rect(x, frontTop, w, H).fill(fg);

    // biome texture on the front face
    this.textureWallFront(g, x, frontTop, w, H, floor, wr);

    // ---- 3. TOP cap --------------------------------------------------------
    g.rect(x, topY, w, h).fill(s.wallTop);
    this.textureWallTop(g, x, topY, w, h, floor, wr);
    // beveled lit north edge (the top lip facing away from camera)
    g.rect(x, topY, w, 3).fill({ color: lighten(s.wallTop, 0.25), alpha: 0.9 });
    // left/right top bevels
    g.rect(x, topY, 2, h).fill({ color: lighten(s.wallTop, 0.12), alpha: 0.6 });
    g.rect(x + w - 2, topY, 2, h).fill({ color: darken(s.wallTop, 0.3), alpha: 0.6 });
    // soft AO where the cap meets the front face
    g.rect(x, frontTop - 2, w, 2).fill({ color: 0x000000, alpha: 0.25 });

    // ---- 4. moss / rot creeping at the base of the front face ---------------
    const rot = s.wallRot;
    const clumps = Math.max(3, (w / 26) | 0);
    for (let i = 0; i < clumps; i++) {
      if (wr() < 0.4) continue; // patchy, not continuous
      const mx = x + (i + 0.5) * (w / clumps) + (wr() - 0.5) * 8;
      const my = frontTop + H - 1;
      const rw = 4 + wr() * 7;
      const rh = 3 + wr() * 5;
      g.ellipse(mx, my, rw, rh).fill({ color: jitterCol(rot, wr, 22), alpha: 0.6 });
      // a few blades climbing up
      g.setStrokeStyle({ width: 1.2, color: lighten(rot, 0.1), alpha: 0.5 });
      for (let b = 0; b < 2; b++) {
        const bx = mx + (wr() - 0.5) * rw;
        g.moveTo(bx, my).lineTo(bx + (wr() - 0.5) * 4, my - 3 - wr() * 5).stroke();
      }
    }
    // a little moss spilling onto the top cap's south edge too
    for (let i = 0; i < clumps; i++) {
      if (wr() < 0.6) continue;
      const mx = x + (i + 0.5) * (w / clumps);
      g.ellipse(mx, frontTop - 1, 3 + wr() * 4, 2 + wr() * 2).fill({
        color: jitterCol(rot, wr, 20),
        alpha: 0.4,
      });
    }

    // ---- 5. outline (chunky, reads as a solid) ------------------------------
    g.setStrokeStyle({ width: 2, color: OUTLINE, alpha: 0.9 });
    // cap outline
    g.rect(x, topY, w, h).stroke();
    // vertical front corners + bottom edge
    g.moveTo(x, frontTop)
      .lineTo(x, frontTop + H)
      .moveTo(x + w, frontTop)
      .lineTo(x + w, frontTop + H)
      .moveTo(x, frontTop + H)
      .lineTo(x + w, frontTop + H)
      .stroke();
  }

  /** Biome-specific texture for a wall's lit FRONT face. */
  private textureWallFront(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    H: number,
    floor: FloorKind,
    wr: () => number
  ): void {
    switch (floor) {
      case "stone": {
        // horizontal stone COURSES with offset vertical joints
        const courses = Math.max(2, Math.round(H / 11));
        const ch = H / courses;
        g.setStrokeStyle({ width: 1, color: 0x000000, alpha: 0.4 });
        for (let r = 1; r < courses; r++) {
          const cy = y + r * ch;
          g.moveTo(x, cy).lineTo(x + w, cy).stroke();
        }
        // vertical joints, brick-offset per course
        g.setStrokeStyle({ width: 1, color: 0x000000, alpha: 0.3 });
        for (let r = 0; r < courses; r++) {
          const cy = y + r * ch;
          const off = (r % 2) * 18;
          for (let jx = x + 14 + off; jx < x + w; jx += 36) {
            g.moveTo(jx, cy + 1).lineTo(jx, cy + ch - 1).stroke();
          }
        }
        // lit top edge of each course (subtle relief)
        g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.05 });
        for (let r = 1; r < courses; r++) {
          const cy = y + r * ch + 1;
          g.moveTo(x, cy).lineTo(x + w, cy).stroke();
        }
        break;
      }
      case "glass": {
        // glass-house frame: vertical posts + a mid rail, cool tint, glints
        g.setStrokeStyle({ width: 2, color: 0x0e1614, alpha: 0.6 });
        for (let px = x + 16; px < x + w; px += 30) {
          g.moveTo(px, y).lineTo(px, y + H).stroke();
        }
        g.moveTo(x, y + H * 0.5).lineTo(x + w, y + H * 0.5).stroke();
        // pale vertical highlight beside each post
        g.setStrokeStyle({ width: 1, color: 0x4a6e64, alpha: 0.5 });
        for (let px = x + 17; px < x + w; px += 30) {
          g.moveTo(px, y).lineTo(px, y + H).stroke();
        }
        break;
      }
      case "bog": {
        // sodden rotted planks: vertical boards, dark wet streaks
        g.setStrokeStyle({ width: 1.5, color: 0x000000, alpha: 0.45 });
        for (let px = x + 12; px < x + w; px += 22) {
          g.moveTo(px, y).lineTo(px + (wr() - 0.5) * 3, y + H).stroke();
        }
        // wet vertical drip streaks
        g.setStrokeStyle({ width: 2, color: 0x0a1410, alpha: 0.3 });
        for (let i = 0; i < Math.max(2, (w / 40) | 0); i++) {
          const px = x + wr() * w;
          g.moveTo(px, y).lineTo(px, y + H * (0.5 + wr() * 0.5)).stroke();
        }
        break;
      }
      case "rows":
      case "yard":
      case "soil":
      default: {
        // weathered WOOD PLANKS (fence/board wall): vertical boards with seams,
        // grain streaks, knots, and lit/shadow edges.
        const boards = Math.max(2, (w / 22) | 0);
        const bw = w / boards;
        const plank = 0x2c1d12;
        for (let b = 0; b < boards; b++) {
          const bx = x + b * bw;
          // alternate board tone slightly so adjacent boards read apart
          const boardCol = b % 2 === 0 ? lighten(plank, 0.05) : darken(plank, 0.08);
          g.rect(bx, y, bw, H).fill({ color: boardCol, alpha: 0.35 });
          // seam (dark) + lit right edge
          g.setStrokeStyle({ width: 1.5, color: 0x000000, alpha: 0.4 });
          g.moveTo(bx, y).lineTo(bx, y + H).stroke();
          g.setStrokeStyle({ width: 1, color: lighten(plank, 0.18), alpha: 0.3 });
          g.moveTo(bx + 1.5, y).lineTo(bx + 1.5, y + H).stroke();
          // grain streaks
          g.setStrokeStyle({ width: 1, color: 0x000000, alpha: 0.18 });
          for (let s = 0; s < 2; s++) {
            const gx = bx + 2 + wr() * (bw - 4);
            g.moveTo(gx, y + 2).lineTo(gx + (wr() - 0.5) * 2, y + H - 2).stroke();
          }
          // knot
          if (wr() < 0.3) {
            const ky = y + 4 + wr() * (H - 8);
            g.circle(bx + bw * 0.5, ky, 1.6).fill({ color: 0x000000, alpha: 0.3 });
          }
        }
        // a horizontal cross-rail nailed across the boards
        g.rect(x, y + H * 0.4, w, 4).fill({ color: darken(plank, 0.2), alpha: 0.4 });
        break;
      }
    }
  }

  /** Biome-specific surface texture for a wall's TOP cap. */
  private textureWallTop(
    g: Graphics,
    x: number,
    y: number,
    w: number,
    h: number,
    floor: FloorKind,
    wr: () => number
  ): void {
    const s = this.style;
    switch (floor) {
      case "stone": {
        // cap reads as cut flagstone: a couple of joint lines + speckle
        g.setStrokeStyle({ width: 1, color: 0x000000, alpha: 0.35 });
        for (let jx = x + 18; jx < x + w; jx += 24) {
          g.moveTo(jx, y + 1).lineTo(jx, y + h - 1).stroke();
        }
        for (let jy = y + 12; jy < y + h; jy += 16) {
          g.moveTo(x + 1, jy).lineTo(x + w - 1, jy).stroke();
        }
        // a few lichen flecks
        for (let i = 0; i < Math.max(2, (w * h) / 900); i++) {
          g.ellipse(x + wr() * w, y + wr() * h, 1.5 + wr() * 2, 1.2 + wr() * 1.5).fill({
            color: jitterCol(s.wallRot, wr, 20),
            alpha: 0.3,
          });
        }
        break;
      }
      case "glass": {
        // cap = a thin glass run: pale streaks + a couple of glints
        g.rect(x + 1, y + 1, w - 2, h - 2).fill({ color: 0x4a6e64, alpha: 0.12 });
        g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.18 });
        g.moveTo(x + 3, y + 2).lineTo(x + w - 3, y + 2).stroke();
        break;
      }
      case "bog": {
        // mossy wet cap
        for (let i = 0; i < Math.max(3, (w / 14) | 0); i++) {
          g.ellipse(x + wr() * w, y + wr() * h, 2 + wr() * 3, 1.5 + wr() * 2).fill({
            color: jitterCol(ROT, wr, 22),
            alpha: 0.4,
          });
        }
        break;
      }
      case "rows":
      case "yard":
      case "soil":
      default: {
        // earthy cap: clods + the odd weed tuft + grain speckle
        for (let i = 0; i < Math.max(3, (w / 16) | 0); i++) {
          const cx = x + wr() * w;
          const cy = y + wr() * h;
          const r = 1.5 + wr() * 3;
          g.ellipse(cx, cy, r, r * 0.7).fill({ color: darken(s.wallTop, 0.2), alpha: 0.5 });
          g.ellipse(cx - r * 0.2, cy - r * 0.25, r * 0.5, r * 0.34).fill({
            color: lighten(s.wallTop, 0.18),
            alpha: 0.5,
          });
        }
        // sparse weed tufts on top
        for (let i = 0; i < Math.max(1, (w / 60) | 0); i++) {
          const tx = x + wr() * w;
          const ty = y + wr() * h;
          g.setStrokeStyle({ width: 1, color: darken(ROT, 0.1), alpha: 0.5 });
          for (let b = 0; b < 3; b++) {
            g.moveTo(tx, ty).lineTo(tx + (b - 1) * 2, ty - 3 - wr() * 3).stroke();
          }
        }
        break;
      }
    }
  }

  // ==========================================================================
  // VIGNETTE — a baked edge-darkening over the whole playfield so the action
  // reads against the world. Stacked translucent border bands that get
  // progressively thinner & darker toward the very edge read as a smooth dark
  // frame at game zoom and cost ~32 fills total — baked once per build, never
  // touched per frame. The bottom edge is weighted heavier (ground falls into
  // shadow toward the bottom of frame). Plus a touch of corner darkening.
  // ==========================================================================
  private buildVignette(area: EnvAreaDef): void {
    const g = this.vignetteG;
    g.clear();
    const { w, h } = area;

    const depth = Math.min(w, h) * 0.22;
    const steps = 8;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1); // 0 (inner) .. 1 (edge)
      const inset = depth * (1 - t);
      const alpha = 0.05 + t * 0.16; // darker toward edge
      // top
      g.rect(0, 0, w, inset).fill({ color: 0x000000, alpha: alpha * 0.5 });
      // bottom (heavier — ground falls into shadow at the bottom of frame)
      g.rect(0, h - inset, w, inset).fill({ color: 0x000000, alpha });
      // left
      g.rect(0, 0, inset, h).fill({ color: 0x000000, alpha: alpha * 0.5 });
      // right
      g.rect(w - inset, 0, inset, h).fill({ color: 0x000000, alpha: alpha * 0.5 });
    }
    // darker corners (where the bands overlap they already deepen; add a touch)
    const cs = depth * 0.9;
    for (const [cx, cy] of [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ] as [number, number][]) {
      g.circle(cx, cy, cs).fill({ color: 0x000000, alpha: 0.06 });
    }
  }
}

export default GroundLayer;
