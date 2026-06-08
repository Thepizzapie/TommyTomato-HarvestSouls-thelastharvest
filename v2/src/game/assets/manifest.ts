// src/game/assets/manifest.ts
//
// Typed manifest for the repaired animation pack. The clean asset tree lives at
// public/assets/anim/<creature>/<state>.{png,json} (produced by
// scripts/fix-pack.mjs). Each entry points at the corrected TexturePacker JSON,
// which Pixi's Assets loader resolves into a Spritesheet.
//
// FPS rationale: Ludo clips are ~1.6 s long. Frame counts per geometry group:
//   - 25 frames  -> 25 / 1.6 ~= 15.6 fps  (most creature states)
//   - 36 frames  -> 36 / 1.6 ~= 22.5 fps  (weed, drone, most vfx)
//   - 16 frames  -> 16 / 1.6 ~= 10   fps  (player roll; bumped for snappiness)
// Values are rounded to sane per-type numbers and are tunable.

export type Creature =
  | "player"
  | "grub"
  | "weed"
  | "drone"
  | "hornet"
  | "king"
  | "oldtom"
  | "harvester";

export interface ClipDef {
  /** Absolute (site-root) URL of the corrected spritesheet JSON. */
  url: string;
  /** Playback rate in frames per second. */
  fps: number;
  /** Whether the clip loops (idle/move) or plays once (attacks/death/etc.). */
  loop: boolean;
}

/** One creature's set of states. Keys are state names; values are clip defs. */
export type CreatureClips = Record<string, ClipDef>;

// Prefix with the deploy base path (CI sets NEXT_PUBLIC_BASE_PATH for GitHub
// Pages sub-path hosting; empty for local dev / root hosting). NEXT_PUBLIC_* is
// inlined at build time, so this resolves at build, not runtime.
const ANIM_ROOT = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/assets/anim`;

function clip(creature: string, state: string, fps: number, loop: boolean): ClipDef {
  return { url: `${ANIM_ROOT}/${creature}/${state}.json`, fps, loop };
}

// FPS presets by clip role (see rationale above).
const FPS = {
  // 25-frame creature clips
  idle: 14, // calm breathing/sway
  move: 16, // run / stride / crawl / skitter
  attack: 18, // light/heavy/lunge/sweep/spin/stab — punchy
  death: 14, // 25-frame deaths read better a touch slower
  hurt: 18,
  // 16-frame player roll
  roll: 18,
  // 36-frame clips (weed/drone) run faster to fit ~1.6s
  bigIdle: 22,
  bigAttack: 24,
  bigDeath: 20,
} as const;

export const MANIFEST: Record<Creature, CreatureClips> = {
  player: {
    idle: clip("player", "idle", FPS.idle, true),
    run: clip("player", "run", FPS.move, true),
    roll: clip("player", "roll", FPS.roll, false),
    lightAttack: clip("player", "lightAttack", FPS.attack, false),
    heavyAttack: clip("player", "heavyAttack", FPS.attack, false),
    hurt: clip("player", "hurt", FPS.hurt, false),
    death: clip("player", "death", FPS.death, false),
  },
  grub: {
    idle: clip("grub", "idle", FPS.idle, true),
    move: clip("grub", "move", FPS.move, true),
    attack: clip("grub", "attack", FPS.attack, false),
    death: clip("grub", "death", FPS.death, false),
  },
  weed: {
    // weed clips are the 36-frame geometry
    idle: clip("weed", "idle", FPS.bigIdle, true),
    attack: clip("weed", "attack", FPS.bigAttack, false),
    death: clip("weed", "death", FPS.bigDeath, false),
  },
  drone: {
    // drone clips are the 36-frame geometry
    idle: clip("drone", "idle", FPS.bigIdle, true),
    attack: clip("drone", "attack", FPS.bigAttack, false),
    death: clip("drone", "death", FPS.bigDeath, false),
  },
  hornet: {
    idle: clip("hornet", "idle", FPS.idle, true),
    move: clip("hornet", "move", FPS.move, true),
    attack: clip("hornet", "attack", FPS.attack, false),
    death: clip("hornet", "death", FPS.death, false),
  },
  king: {
    idle: clip("king", "idle", FPS.idle, true),
    move: clip("king", "move", FPS.move, true),
    scytheSweep: clip("king", "scytheSweep", FPS.attack, false),
    lunge: clip("king", "lunge", FPS.attack, false),
    summonRoar: clip("king", "summonRoar", FPS.attack, false),
    spinAttack: clip("king", "spinAttack", FPS.attack, false),
    death: clip("king", "death", FPS.death, false),
  },
  oldtom: {
    idle: clip("oldtom", "idle", FPS.idle, true),
    move: clip("oldtom", "move", FPS.move, true),
    lungingStab: clip("oldtom", "lungingStab", FPS.attack, false),
    griefNova: clip("oldtom", "griefNova", FPS.attack, false),
    phase2Roar: clip("oldtom", "phase2Roar", FPS.attack, false),
    death: clip("oldtom", "death", FPS.death, false),
  },
  harvester: {
    idle: clip("harvester", "idle", FPS.idle, true),
    charge: clip("harvester", "charge", FPS.move, false),
    bladeSweep: clip("harvester", "bladeSweep", FPS.attack, false),
    poisonVolley: clip("harvester", "poisonVolley", FPS.attack, false),
    groundSlam: clip("harvester", "groundSlam", FPS.attack, false),
    overdriveRoar: clip("harvester", "overdriveRoar", FPS.attack, false),
    death: clip("harvester", "death", FPS.death, false),
  },
};

// VFX clips are one-shot (loop=false). Mixed geometry: most are 36-frame,
// poisonCloud + sapPickup are 25-frame.
export const VFX_MANIFEST: Record<string, ClipDef> = {
  bossDeath: clip("vfx", "bossDeath", 22, false),
  levelUp: clip("vfx", "levelUp", 22, false),
  parryFlash: clip("vfx", "parryFlash", 26, false), // quick flash
  healMotes: clip("vfx", "healMotes", 18, false), // gentle rise
  waterSplash: clip("vfx", "waterSplash", 24, false),
  poisonCloud: clip("vfx", "poisonCloud", 14, false), // 25-frame, slow drift
  sapPickup: clip("vfx", "sapPickup", 18, false), // 25-frame
  pulpSplatter: clip("vfx", "pulpSplatter", 24, false),
};

export type VfxName = keyof typeof VFX_MANIFEST;

// Per-creature render scale. Source frames are ~534 px tall (a single grid
// cell is 573x534). In-game a player should stand ~72 px tall, so the player
// scale is ~72/534 ~= 0.135 of a cell... but the subject only fills part of the
// cell, so the brief's calibration of ~0.045 for the player (subject ~ a third
// of the cell) is the baseline. Bosses are larger. All values are tunable.
// Source atlases were downscaled to cut VRAM ~10x (scripts/shrink-pack.mjs:
// creatures/vfx x1/3, bosses x2/3). These render scales are bumped to
// compensate (creatures x3, bosses x1.5) so on-screen sizes are unchanged.
export const BASE_SCALE: Record<Creature, number> = {
  player: 0.54,
  grub: 0.33, // small crawler
  weed: 0.45, // rooted, mid-height
  drone: 0.405, // hovering, small-to-mid
  hornet: 0.315, // small flyer
  king: 1.275, // scarecrow king boss — towering
  oldtom: 1.35, // final-form tomato boss — towering
  harvester: 1.575, // hulking machine boss — largest
};

/** Default scale for one-shot VFX sprites (tunable per call site).
 *  x3 to compensate for the 1/3 atlas downscale (see BASE_SCALE note). */
export const VFX_BASE_SCALE = 0.15;

/** Flat list of every clip URL (creature + vfx), handy for preloading. */
export function allClipUrls(): string[] {
  const urls: string[] = [];
  for (const clips of Object.values(MANIFEST)) {
    for (const def of Object.values(clips)) urls.push(def.url);
  }
  for (const def of Object.values(VFX_MANIFEST)) urls.push(def.url);
  return urls;
}
