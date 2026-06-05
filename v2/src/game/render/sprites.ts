// src/game/render/sprites.ts
//
// PixiJS v8 loader + actor controller for the repaired animation pack.
//
// The clean tree (scripts/fix-pack.mjs output) gives us one corrected
// TexturePacker JSON per clip whose meta.image points at its sibling PNG.
// `Assets.load(url)` on that JSON yields a Spritesheet; `sheet.textures` is a
// record of frame textures keyed frame_000..frame_NNN. Keys are zero-padded so
// lexical sort == frame order.

import {
  Assets,
  AnimatedSprite,
  Container,
  Texture,
  type Spritesheet,
} from "pixi.js";

import {
  MANIFEST,
  VFX_MANIFEST,
  BASE_SCALE,
  VFX_BASE_SCALE,
  allClipUrls,
  type Creature,
  type ClipDef,
} from "@/game/assets/manifest";

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** url -> loaded Spritesheet (deduped; multiple clips never share a url here). */
const sheetByUrl = new Map<string, Spritesheet>();

/** url -> frame textures in frame order (memoized). */
const framesByUrl = new Map<string, Texture[]>();

let loaded = false;

/** Sort a spritesheet's frame textures by their (zero-padded) frame key. */
function sortedFrames(sheet: Spritesheet): Texture[] {
  const keys = Object.keys(sheet.textures).sort();
  return keys.map((k) => sheet.textures[k as keyof typeof sheet.textures]);
}

/** Resolve a clip's frame textures from cache, loading nothing. */
function framesForUrl(url: string): Texture[] | null {
  const cached = framesByUrl.get(url);
  if (cached) return cached;
  const sheet = sheetByUrl.get(url);
  if (!sheet) return null;
  const frames = sortedFrames(sheet);
  framesByUrl.set(url, frames);
  return frames;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Preload every clip's spritesheet (creature states + vfx). Safe to call more
 * than once; subsequent calls are no-ops. Individual clip failures are logged
 * and skipped so one bad asset never blocks the rest of the pack.
 */
async function loadUrls(urls: string[]): Promise<void> {
  await Promise.all(
    Array.from(new Set(urls)).map(async (url) => {
      if (sheetByUrl.has(url)) return;
      try {
        const sheet = await Assets.load<Spritesheet>(url);
        sheetByUrl.set(url, sheet);
        framesByUrl.set(url, sortedFrames(sheet)); // warm frame-order cache
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[sprites] failed to load clip: ${url}`, err);
      }
    })
  );
}

export async function loadAllAnimations(): Promise<void> {
  if (loaded) return;
  await loadUrls(allClipUrls());
  loaded = true;
}

/**
 * Load only the given creatures' clips (memory-friendly — the source atlases are
 * large, so load per-scene rather than all at once). Idempotent per url.
 */
export async function loadCreatures(creatures: Creature[]): Promise<void> {
  const urls: string[] = [];
  for (const c of creatures) {
    const clips = MANIFEST[c];
    if (!clips) continue;
    for (const k of Object.keys(clips)) urls.push(clips[k].url);
  }
  await loadUrls(urls);
}

/** Load only the named vfx clips. */
export async function loadVfx(names: string[]): Promise<void> {
  const urls: string[] = [];
  for (const n of names) {
    const def = VFX_MANIFEST[n];
    if (def) urls.push(def.url);
  }
  await loadUrls(urls);
}

/** True once loadAllAnimations() has completed at least once. */
export function animationsReady(): boolean {
  return loaded;
}

// ---------------------------------------------------------------------------
// Frame access
// ---------------------------------------------------------------------------

/**
 * Sorted frame textures for a creature state, or null if the clip is unknown
 * or not yet loaded.
 */
export function getFrames(creature: Creature, state: string): Texture[] | null {
  const def = MANIFEST[creature]?.[state];
  if (!def) return null;
  return framesForUrl(def.url);
}

/** Sorted frame textures for a vfx clip, or null if unknown / not loaded. */
export function getVfxFrames(name: string): Texture[] | null {
  const def = VFX_MANIFEST[name];
  if (!def) return null;
  return framesForUrl(def.url);
}

/** Convert a clip's fps into a Pixi animationSpeed (ticker runs ~60 fps). */
function fpsToSpeed(fps: number): number {
  return fps / 60;
}

// ---------------------------------------------------------------------------
// Actor controller
// ---------------------------------------------------------------------------

/** Bottom-center-ish anchor so feet/base sit on the ground plane. */
const GROUND_ANCHOR_X = 0.5;
// Center the body vertically on the entity point so the visible sprite overlaps
// the sim's hit circle 1:1 (was 0.92 = feet-at-point, which floated the body
// above the hitbox — you'd whiff the body and only connect below it).
const GROUND_ANCHOR_Y = 0.5;

export interface PlayOpts {
  /** Called when a non-looping clip finishes. Ignored for looping clips. */
  onComplete?: () => void;
  /** Force a restart even if the requested state is already playing. */
  restart?: boolean;
}

/**
 * A game actor backed by a single inner AnimatedSprite. Swap states with
 * `play(state)`; flip with `setFacing(dir)`. The Container's scale.x carries
 * facing while the inner sprite carries the creature's BASE_SCALE, so flipping
 * never disturbs sizing.
 */
export class ActorSprite extends Container {
  readonly creature: Creature;

  private sprite: AnimatedSprite;
  private currentState: string | null = null;
  private facing: 1 | -1 = 1;
  private baseScale: number;

  constructor(creature: Creature) {
    super();
    this.creature = creature;
    this.baseScale = BASE_SCALE[creature] ?? 0.05;

    // Seed with whatever clip is available so the inner sprite always has
    // valid textures. Prefer idle, then the first defined state, then a
    // single transparent placeholder frame.
    const seed = this.pickSeedFrames();
    this.sprite = new AnimatedSprite(seed.frames, true);
    this.sprite.anchor.set(GROUND_ANCHOR_X, GROUND_ANCHOR_Y);
    this.sprite.scale.set(this.baseScale);
    this.addChild(this.sprite);

    // Apply initial facing (no-op multiplier of 1).
    this.scale.x = this.facing;

    if (seed.state) {
      // Start the seed state playing with its proper loop/fps.
      this.play(seed.state, { restart: true });
    }
  }

  /** Choose initial frames: idle -> first defined state -> placeholder. */
  private pickSeedFrames(): { frames: Texture[]; state: string | null } {
    const idle = getFrames(this.creature, "idle");
    if (idle && idle.length) return { frames: idle, state: "idle" };

    const states = Object.keys(MANIFEST[this.creature] ?? {});
    for (const s of states) {
      const f = getFrames(this.creature, s);
      if (f && f.length) return { frames: f, state: s };
    }
    return { frames: [Texture.EMPTY], state: null };
  }

  /** Currently playing state name, or null if none. */
  get state(): string | null {
    return this.currentState;
  }

  /**
   * Swap to a state's frames and start playing with the manifest's loop/fps.
   * If the state is missing or not loaded, the current animation is kept
   * (graceful fallback) and the call is a no-op.
   */
  play(state: string, opts: PlayOpts = {}): void {
    const def: ClipDef | undefined = MANIFEST[this.creature]?.[state];
    if (!def) return; // unknown state -> keep current

    const frames = getFrames(this.creature, state);
    if (!frames || frames.length === 0) return; // not loaded -> keep current

    // Already in this state and not forced -> leave it running.
    if (this.currentState === state && !opts.restart) {
      if (def.loop) return;
      // Non-looping replay request without restart: fall through to restart
      // so callers can re-trigger one-shots (e.g. repeated attacks).
    }

    this.currentState = state;
    this.sprite.textures = frames; // resets internal frame index
    this.sprite.loop = def.loop;
    this.sprite.animationSpeed = fpsToSpeed(def.fps);
    this.sprite.onComplete = def.loop ? undefined : opts.onComplete;
    this.sprite.gotoAndPlay(0);
  }

  /** Flip horizontally. 1 = face right (default), -1 = face left. */
  setFacing(dir: 1 | -1): void {
    if (this.facing === dir) return;
    this.facing = dir;
    this.scale.x = dir; // base scale lives on the inner sprite
  }

  /** Current facing direction. */
  getFacing(): 1 | -1 {
    return this.facing;
  }

  /** Override the creature's default scale at runtime (tuning hook). */
  setBaseScale(scale: number): void {
    this.baseScale = scale;
    this.sprite.scale.set(scale);
  }

  /** Stop playback on the current frame. */
  stop(): void {
    this.sprite.stop();
  }

  /** The underlying AnimatedSprite, for advanced tuning (tint, alpha, etc.). */
  get animatedSprite(): AnimatedSprite {
    return this.sprite;
  }
}

// ---------------------------------------------------------------------------
// One-shot VFX
// ---------------------------------------------------------------------------

export interface VfxOpts {
  /** Called when the effect finishes (before any caller-driven cleanup). */
  onComplete?: () => void;
  /** Override the default vfx scale. */
  scale?: number;
  /**
   * Auto-destroy the sprite when the (non-looping) animation completes.
   * Defaults to true — convenient for fire-and-forget effects.
   */
  autoDestroy?: boolean;
}

/**
 * Build a one-shot VFX AnimatedSprite (loop=false, center anchor). Returns null
 * if the clip is unknown or not yet loaded. Add it to the stage and it plays
 * immediately; by default it destroys itself on completion.
 */
export function makeVfxSprite(name: string, opts: VfxOpts = {}): AnimatedSprite | null {
  const def = VFX_MANIFEST[name];
  if (!def) return null;
  const frames = getVfxFrames(name);
  if (!frames || frames.length === 0) return null;

  const sprite = new AnimatedSprite(frames, true);
  sprite.anchor.set(0.5, 0.5);
  sprite.scale.set(opts.scale ?? VFX_BASE_SCALE);
  sprite.loop = false;
  sprite.animationSpeed = fpsToSpeed(def.fps);

  const autoDestroy = opts.autoDestroy ?? true;
  sprite.onComplete = () => {
    opts.onComplete?.();
    if (autoDestroy && !sprite.destroyed) sprite.destroy();
  };

  sprite.gotoAndPlay(0);
  return sprite;
}
