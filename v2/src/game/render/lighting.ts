// lighting.ts — dynamic 2D lighting for the Pixi v8 (WebGL) renderer of
// Tommy Tomato: Harvest Souls. Renders a darkness/ambient sheet pierced by
// radial light pools (flashlight in the dark catacombs; golden-dusk fields).
//
// TECHNIQUE (cheap, ~60fps, one reused RenderTexture, no per-frame allocation):
//   1. Each frame, render a *light buffer* into a reused RenderTexture:
//        - clear it to the ambient color scaled by darkness (the "dark" base),
//        - additively draw a soft radial sprite per light (projected to screen),
//          tinted by the light color * intensity.
//   2. Composite that buffer over the scene with a single full-screen Sprite
//      using blendMode 'multiply'. Unlit areas multiply down to the dark ambient
//      color; lit disks multiply by ~white and show the scene (warmly tinted).
//
//   This needs the Pixi `Renderer` (passed to `update`) and a baked radial
//   light texture (built lazily from the renderer). No destination-out, no
//   masks, no shaders — just one RT + one multiply blit.
//
// ----------------------------------------------------------------------------
// COORDINATE SPACES:
//   * Add LightLayer in SCREEN space, ON TOP of the world (and under the HUD).
//   * Lights are given in WORLD coordinates via setLights(...).
//   * Call setCamera(camX, camY, scale, screenW, screenH) whenever the camera or
//     viewport changes so world lights project to the right screen pixels.
//   * Call update(dtMS, tSeconds, renderer) once per frame BEFORE the renderer
//     draws the stage (it renders into its own RenderTexture; the composite
//     Sprite is then drawn as part of the normal stage render).
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  Sprite,
  RenderTexture,
  Texture,
  Color,
  type Renderer,
  type ColorSource,
} from "pixi.js";

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A radial light source positioned in WORLD coordinates. */
export interface Light {
  x: number; // world x
  y: number; // world y
  radius: number; // world-space radius of the lit pool
  color: ColorSource; // light tint (e.g. 0xffb347 warm, 0x7ac0ff cold)
  intensity: number; // 0..1 brightness of the pool
  flicker?: number; // 0..1 subtle time-based flicker (0 = steady)
}

/** Internal projected/cached light + its pooled composite Sprite. */
interface LightSlot {
  sprite: Sprite; // additive radial sprite drawn into the buffer
  phase: number; // per-light flicker phase (set when assigned)
}

/**
 * Dynamic 2D light layer. Owns a reused RenderTexture light buffer and a
 * full-screen multiply composite Sprite (this container's only visible child).
 *
 * SCREEN space: add on top of the world. Feed it WORLD-space lights + the
 * camera each frame.
 */
export class LightLayer extends Container {
  /** The composite that multiplies the light buffer over the scene. */
  private readonly composite: Sprite;
  private buffer: RenderTexture | null = null;

  /** Pool of additive light sprites (reused; never reallocated per frame). */
  private readonly pool: LightSlot[] = [];
  /** Scratch container the lights are rendered through into the buffer. */
  private readonly lightScene: Container;
  private radialTex: Texture = Texture.WHITE;
  private radialSize = 1;
  private ready = false;

  // darkness / ambient
  private darkness = 0.75; // 0 = full bright (no effect), 1 = pitch black
  private ambient = new Color(0x0a0d1a); // ambient/darkness tint
  private ambientNum = 0x0a0d1a;

  // camera projection (world -> screen). Note: `scale` is taken by Container
  // (it's an ObservablePoint), so the camera zoom lives in `camScale`.
  private camX = 0;
  private camY = 0;
  private camScale = 1;
  private screenW = 1;
  private screenH = 1;

  // current light set (kept by reference; cheap to re-read each frame)
  private lights: Light[] = [];
  private resolution: number;

  /**
   * @param screenW initial screen width in px
   * @param screenH initial screen height in px
   * @param resolution buffer resolution multiplier (0.5 = half-res for speed;
   *   light is soft so half-res looks fine and is much cheaper). Default 1.
   */
  constructor(screenW = 1, screenH = 1, resolution = 1) {
    super();
    this.screenW = Math.max(1, screenW);
    this.screenH = Math.max(1, screenH);
    this.resolution = resolution;

    this.lightScene = new Container();
    this.composite = new Sprite(Texture.WHITE);
    this.composite.blendMode = "multiply";
    this.composite.width = this.screenW;
    this.composite.height = this.screenH;
    this.addChild(this.composite);
  }

  /**
   * Lazily build the baked radial light texture + the RenderTexture buffer.
   * Call once after the renderer exists (or it self-inits on first update()).
   */
  init(renderer: Renderer): void {
    if (this.ready) return;
    // soft radial falloff baked once: bright white core -> transparent rim.
    const R = 128;
    const g = new Graphics();
    const steps = 24;
    for (let i = steps; i >= 1; i--) {
      const t = i / steps; // 1 (rim) -> ~0 (core)
      // quadratic-ish core bias so the pool has a hot center + soft edge
      const a = (1 - t) * (1 - t) * 0.9;
      g.circle(R, R, R * t).fill({ color: 0xffffff, alpha: a });
    }
    this.radialTex = renderer.generateTexture({
      target: g,
      resolution: 1,
      antialias: true,
    });
    this.radialSize = this.radialTex.width;
    g.destroy();

    this.buffer = RenderTexture.create({
      width: this.screenW,
      height: this.screenH,
      resolution: this.resolution,
    });
    this.composite.texture = this.buffer;
    this.composite.width = this.screenW;
    this.composite.height = this.screenH;
    this.ready = true;
  }

  /** Resize the screen / buffer. Cheap; reuses the RenderTexture object. */
  resize(screenW: number, screenH: number): void {
    this.screenW = Math.max(1, screenW);
    this.screenH = Math.max(1, screenH);
    if (this.buffer) {
      this.buffer.resize(this.screenW, this.screenH, this.resolution);
      this.composite.width = this.screenW;
      this.composite.height = this.screenH;
    }
  }

  /**
   * Set overall darkness. 0 disables the effect (the composite goes fully
   * transparent / no multiply), 1 is pitch black outside lit pools.
   */
  setDarkness(d01: number): void {
    this.darkness = clamp(d01, 0, 1);
  }

  /** Set the ambient/darkness tint (e.g. 0x0a0d1a cold night, 0x2a1c10 dusk). */
  setAmbient(colorHex: ColorSource): void {
    this.ambient.setValue(colorHex);
    this.ambientNum = this.ambient.toNumber();
  }

  /**
   * Project the world -> screen camera. `scale` is world->screen zoom; (camX,
   * camY) is the world point at screen center.
   */
  setCamera(
    camX: number,
    camY: number,
    scale: number,
    screenW: number,
    screenH: number
  ): void {
    this.camX = camX;
    this.camY = camY;
    this.camScale = scale;
    if (screenW !== this.screenW || screenH !== this.screenH) {
      this.resize(screenW, screenH);
    }
  }

  /**
   * Set the active light list (WORLD coords). Held by reference — you may keep
   * mutating the same array each frame; it's re-read in update(). Grows the
   * internal sprite pool as needed (only when the count increases).
   */
  setLights(lights: Light[]): void {
    this.lights = lights;
    while (this.pool.length < lights.length) {
      const s = new Sprite(this.radialTex);
      s.anchor.set(0.5);
      s.blendMode = "add";
      this.lightScene.addChild(s);
      this.pool.push({ sprite: s, phase: 0 });
    }
  }

  /** Subtle per-light flicker multiplier on radius/intensity, driven by time. */
  private flicker(L: Light, t: number, phase: number): number {
    const f = L.flicker ?? 0;
    if (f <= 0) return 1;
    const n =
      Math.sin(t * 11 + phase) * 0.6 +
      Math.sin(t * 23.3 + phase * 2.1) * 0.3 +
      Math.sin(t * 4.7 + phase) * 0.1;
    return 1 + n * 0.12 * f;
  }

  /**
   * Render the light buffer and update the composite. Call once per frame,
   * BEFORE the main `renderer.render(stage)` (this performs its own off-screen
   * render into the reused RenderTexture; the composite Sprite is then drawn
   * normally when the stage renders).
   *
   * @param dtMS  delta milliseconds (currently advisory; flicker uses `t`)
   * @param t     time in seconds (drives flicker)
   * @param renderer the Pixi renderer
   */
  update(dtMS: number, t: number, renderer: Renderer): void {
    if (!this.ready) this.init(renderer);
    const buffer = this.buffer;
    if (!buffer) return;

    // Darkness off: hide the composite entirely (no multiply, full bright).
    if (this.darkness <= 0.001) {
      this.composite.visible = false;
      return;
    }
    this.composite.visible = true;

    // Make sure every pooled sprite uses the (now-baked) radial texture.
    if (this.pool.length && this.pool[0].sprite.texture !== this.radialTex) {
      for (let i = 0; i < this.pool.length; i++) {
        this.pool[i].sprite.texture = this.radialTex;
      }
    }

    const lights = this.lights;
    const n = lights.length;
    const W = this.screenW;
    const H = this.screenH;
    const halfW = W / 2;
    const halfH = H / 2;
    const texDiv = this.radialSize;

    // Position/scale/tint each active light sprite (projected world->screen);
    // park the rest at alpha 0 (they stay in lightScene, cost ~nothing).
    for (let i = 0; i < this.pool.length; i++) {
      const slot = this.pool[i];
      const spr = slot.sprite;
      if (i >= n) {
        spr.visible = false;
        continue;
      }
      const L = lights[i];
      if (slot.phase === 0) {
        // derive a stable phase from world pos once it's first used
        slot.phase = (L.x * 0.013 + L.y * 0.017) % (Math.PI * 2);
      }
      const fl = this.flicker(L, t, slot.phase);
      const sx = (L.x - this.camX) * this.camScale + halfW;
      const sy = (L.y - this.camY) * this.camScale + halfH;
      const rad = L.radius * this.camScale * fl;

      // cull fully off-screen lights
      if (rad <= 0 || sx + rad < 0 || sx - rad > W || sy + rad < 0 || sy - rad > H) {
        spr.visible = false;
        continue;
      }

      spr.visible = true;
      spr.x = sx;
      spr.y = sy;
      const sc = (rad * 2) / texDiv; // radial tex is radius=half its width
      spr.scale.set(sc);
      spr.tint = L.color;
      // intensity (with a touch of flicker) drives how hard the pool lifts the
      // multiply back toward full scene brightness.
      spr.alpha = clamp(L.intensity * (0.85 + 0.15 * fl), 0, 1);
    }

    // Render: clear to the ambient*darkness base, then additive lights on top.
    // The clear color IS the darkness floor the scene multiplies down to.
    const r = (this.ambientNum >> 16) & 0xff;
    const g = (this.ambientNum >> 8) & 0xff;
    const b = this.ambientNum & 0xff;
    // darkness 1 -> ambient color as-is (dark); darkness 0 -> white (no effect).
    const k = 1 - this.darkness;
    const cr = (r / 255) * (1 - k) + k;
    const cg = (g / 255) * (1 - k) + k;
    const cb = (b / 255) * (1 - k) + k;

    renderer.render({
      container: this.lightScene,
      target: buffer,
      clear: true,
      clearColor: [cr, cg, cb, 1],
    });
  }

  /** Release GPU resources (RenderTexture + baked radial texture + children). */
  destroy(): void {
    if (this.buffer) {
      this.buffer.destroy(true);
      this.buffer = null;
    }
    if (this.ready) {
      this.radialTex.destroy(true);
      this.ready = false;
    }
    this.lightScene.destroy({ children: true });
    super.destroy({ children: true });
  }
}
