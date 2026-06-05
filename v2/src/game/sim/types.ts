// Shared sim types. Framework-agnostic: no DOM, no Pixi, no rendering.
// The renderer and net layer consume these; the only thing flowing IN is an
// InputState snapshot (already resolved to world coordinates by the integrator).

// ----------------------------------------------------------------------------
// Kinds
// ----------------------------------------------------------------------------

// Every creature archetype the sim knows. v2 only ships ART for a subset
// (see ART_BACKED in content.ts); areas spawn the art-backed kinds.
export type EnemyKind =
  | "grub"
  | "weed"
  | "drone"
  | "hornet"
  | "king"
  | "oldtom"
  | "harvester";

export type PlayerKind = "player";
export type EntityKind = PlayerKind | EnemyKind;

export type WeaponKind = "whip" | "dagger" | "mace" | "rapier";

// ----------------------------------------------------------------------------
// Canonical animState values — the renderer maps these strings 1:1 to clips.
// Keep these EXACT. Each entity's animState is set every tick by the sim.
// ----------------------------------------------------------------------------
//   player    : idle | run | roll | lightAttack | heavyAttack | hurt | death | heal | guard
//   grub      : idle | move | attack | death
//   weed      : idle | attack | death
//   drone     : idle | attack | death
//   hornet    : idle | move | attack | death
//   king      : idle | move | scytheSweep | lunge | summonRoar | spinAttack | death
//   oldtom    : idle | move | lungingStab | griefNova | phase2Roar | death
//   harvester : idle | charge | bladeSweep | poisonVolley | groundSlam | overdriveRoar | death
export type PlayerAnim =
  | "idle"
  | "run"
  | "roll"
  | "lightAttack"
  | "heavyAttack"
  | "hurt"
  | "death"
  | "heal"
  | "guard";
export type GrubAnim = "idle" | "move" | "attack" | "death";
export type WeedAnim = "idle" | "attack" | "death";
export type DroneAnim = "idle" | "attack" | "death";
export type HornetAnim = "idle" | "move" | "attack" | "death";
export type KingAnim =
  | "idle"
  | "move"
  | "scytheSweep"
  | "lunge"
  | "summonRoar"
  | "spinAttack"
  | "death";
export type OldTomAnim =
  | "idle"
  | "move"
  | "lungingStab"
  | "griefNova"
  | "phase2Roar"
  | "death";
export type HarvesterAnim =
  | "idle"
  | "charge"
  | "bladeSweep"
  | "poisonVolley"
  | "groundSlam"
  | "overdriveRoar"
  | "death";

export type AnimState =
  | PlayerAnim
  | GrubAnim
  | WeedAnim
  | DroneAnim
  | HornetAnim
  | KingAnim
  | OldTomAnim
  | HarvesterAnim;

// ----------------------------------------------------------------------------
// Input — a per-frame snapshot the integrator builds from keyboard/mouse/gamepad.
// `aimX`/`aimY` are in WORLD coordinates (integrator does screen->world).
// "pressed" = rising edge this frame; "held" = currently down.
// ----------------------------------------------------------------------------
export interface InputState {
  // movement direction (need NOT be normalized; sim normalizes)
  moveX: number;
  moveY: number;
  // where the player is aiming, in world space
  aimX: number;
  aimY: number;
  // edge-triggered actions (true only on the frame the button went down)
  lightPressed: boolean;
  heavyPressed: boolean;
  rollPressed: boolean;
  lockOnPressed: boolean;
  healPressed: boolean;
  interactPressed: boolean;
  weapon1Pressed: boolean;
  weapon2Pressed: boolean;
  weapon3Pressed: boolean;
  weapon4Pressed: boolean;
  // held actions
  guardHeld: boolean;
  // optional held variants (sim only needs guardHeld; others are edge-driven)
  lightHeld?: boolean;
  heavyHeld?: boolean;
}

export const EMPTY_INPUT: InputState = {
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  lightPressed: false,
  heavyPressed: false,
  rollPressed: false,
  lockOnPressed: false,
  healPressed: false,
  interactPressed: false,
  weapon1Pressed: false,
  weapon2Pressed: false,
  weapon3Pressed: false,
  weapon4Pressed: false,
  guardHeld: false,
};

// ----------------------------------------------------------------------------
// Entity — unified shape for player + every enemy. animState drives rendering.
// Internal AI/state fields are kept on the same object so the sim stays simple;
// the renderer should read only the documented presentational fields.
// ----------------------------------------------------------------------------

// coarse lifecycle flags (presentational + logic). The renderer mostly reads
// animState; these are here for HUD / tint / debug and net reconciliation.
export interface EntityFlags {
  windup: boolean; // telegraphing an attack
  attacking: boolean; // attack hitbox is (or is about to be) live
  staggered: boolean; // poise broken / parried — stunned
  dead: boolean;
  hurt: boolean; // took damage very recently (hit-flash)
  invuln: boolean; // i-frames (roll) — player only, but kept generic
  blocking: boolean; // guard raised — player only
}

export interface Entity {
  id: number;
  kind: EntityKind;

  // transform / motion
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number; // radians

  // vitals
  hp: number;
  maxHp: number;

  // presentation
  animState: AnimState; // canonical clip name (set every tick)
  animOnce: boolean; // true => play once & hold last frame (attacks, death, hurt)
  animPhase: number; // free-running phase for idle/loop wobble (renderer hint)
  big: number; // visual scale multiplier (bosses)
  facingFlip: boolean; // true => face left (renderer convenience; derived from facing)

  flags: EntityFlags;

  // hit-flash / transient timers the renderer may read
  hurtT: number; // >0 = flashing white
}

// ----------------------------------------------------------------------------
// Projectiles / pickups — light serializable records.
// ----------------------------------------------------------------------------
export interface Projectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  ttl: number;
  hostile: boolean;
  color: string; // renderer hint ("#9fd44e" poison, "#ff7a3a" slam, "#ffd56b" nova)
  poison?: number; // applies poison-over-time on hit
  ownerId?: number; // entity id that fired it (0 = world)
}

export type PickupKind = "estus" | "sap" | "key" | "weapon" | "charm";
export interface Pickup {
  id: number;
  x: number;
  y: number;
  kind: PickupKind;
  amt: number;
  wid?: WeaponKind;
  cid?: string; // charm id
}

// husk = the soulslike bloodstain: dropped sap you can reclaim where you died
export interface Husk {
  x: number;
  y: number;
  sap: number;
  areaId: string;
}

// ----------------------------------------------------------------------------
// Player view-model — the player IS an Entity, but carries extra HUD state.
// getState() returns this so the renderer/HUD can read everything in one place.
// ----------------------------------------------------------------------------
export interface PlayerView {
  entity: Entity;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  estus: number; // heal charges left
  estusMax: number;
  sap: number; // currency
  poison: number; // remaining poison budget
  exhausted: boolean; // out of stamina
  weapon: WeaponKind;
  ownedWeapons: WeaponKind[];
  charmId: string | null;
  ownedCharms: string[];
  lockTarget: number | null; // entity id of lock-on target
  stats: PlayerStats;
  level: number;
  nextLevelCost: number;
}

export interface PlayerStats {
  vigor: number;
  strength: number;
  vitality: number;
  agility: number;
}

// ----------------------------------------------------------------------------
// World state — the full readable snapshot the renderer & HUD consume.
// ----------------------------------------------------------------------------
export type Screen =
  | "play"
  | "bonfire"
  | "dead"
  | "victory"
  | "paused"
  | "loading";

export interface BossView {
  id: number;
  name: string;
  hp01: number; // 0..1 health fraction (for the boss bar)
  active: boolean; // false during the intro/fog-gate beat
  phase2: boolean;
}

export interface WorldState {
  areaId: string;
  areaName: string;
  areaSubtitle: string;
  areaW: number;
  areaH: number;

  player: PlayerView;
  entities: Entity[]; // enemies only (player.entity is separate but also here? -> no, enemies only)
  projectiles: Projectile[];
  pickups: Pickup[];
  husks: Husk[]; // only those in the current area are gameplay-active

  boss: BossView | null;
  bossIntro: number; // seconds remaining on the boss intro

  time: number; // accumulated sim time
  screen: Screen;
  bonfireSel: number; // bonfire menu cursor (renderer draws the menu)
}

// ----------------------------------------------------------------------------
// Events — the sim emits transient cues; the integrator triggers VFX/audio.
// The sim itself knows nothing about how these are presented.
// ----------------------------------------------------------------------------
export type SimEventType =
  | "hit" // melee/ranged landed on something
  | "playerHit" // the player took damage
  | "block" // a blow was blocked
  | "parry" // a blow was parried (opens riposte)
  | "riposte" // an empowered riposte landed
  | "backstab" // a back-strike crit landed
  | "stagger" // an enemy's poise broke
  | "death" // any entity died
  | "bossDeath" // a boss died
  | "bossPhase" // a boss entered phase 2
  | "bossRoar" // boss intro / phase roar
  | "sap" // sap gained
  | "sapReclaim" // husk reclaimed
  | "poison" // poison applied / ticking
  | "heal" // player healed (estus)
  | "footstep"
  | "roll"
  | "swing" // a swing started (whoosh)
  | "shoot" // a projectile was fired
  | "projectileHit" // a projectile struck a wall/entity
  | "pickup" // an item was picked up
  | "levelUp"
  | "bonfire" // rested at a compost heap
  | "guardBreak" // guard shattered (stamina gone)
  | "areaChange" // moved to a new area
  | "weaponSwitch"
  | "uiMove"
  | "uiSelect"
  | "floatText"; // damage number / status text

export interface SimEvent {
  type: SimEventType;
  x: number;
  y: number;
  // optional payload (varies by type)
  amount?: number; // damage / sap / etc.
  crit?: boolean;
  kind?: string; // entity kind, weapon kind, area id, etc.
  text?: string; // for floatText
  color?: string; // renderer hint for floatText / fx
  id?: number; // entity / projectile id
  big?: boolean;
}

// ----------------------------------------------------------------------------
// Serializable snapshot for the net layer (authoritative-friendly).
// snapshot() produces this; applySnapshot() consumes it. No methods, all data.
// ----------------------------------------------------------------------------
export interface EntitySnap {
  id: number;
  kind: EntityKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: number;
  hp: number;
  maxHp: number;
  animState: AnimState;
  animOnce: boolean;
  animPhase: number;
  big: number;
  flags: EntityFlags;
}

export interface SimSnapshot {
  areaId: string;
  time: number;
  rngState: number;
  player: EntitySnap;
  enemies: EntitySnap[];
  projectiles: Projectile[];
  boss: BossView | null;
  bossIntro: number;
}

// ----------------------------------------------------------------------------
// Persistence — what survives between runs (mirrors v1 SaveData).
// ----------------------------------------------------------------------------
export interface SaveData {
  stats: PlayerStats;
  sap: number;
  estusMax: number;
  areaId: string;
  bonfireArea: string;
  bossesDead: string[];
  ownedWeapons: WeaponKind[];
  ownedCharms: string[];
  weapon: WeaponKind;
  charmId: string | null;
  playtime: number;
}
