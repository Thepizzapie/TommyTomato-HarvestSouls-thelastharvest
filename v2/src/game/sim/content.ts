// Static game content — enemies, areas, weapons, charms, progression.
// Ported from v1 (src/game/content/world.ts) with the enemy roster RE-POINTED
// to the art-backed creature set v2 ships (player + grub, weed, drone, hornet +
// king, oldtom, harvester). Tuned hp / dmg / sap / timing numbers are preserved.

import type { Rect } from "./math";
import type { EnemyKind, WeaponKind, PlayerStats, AnimState } from "./types";

// ----------------------------------------------------------------------------
// Which creature kinds have ART in v2. Enemy *defs* keep their tuned identity,
// but their renderable `kind` is always one of these (see ENEMIES below).
// ----------------------------------------------------------------------------
export const ART_BACKED: EnemyKind[] = [
  "grub",
  "weed",
  "drone",
  "hornet",
  "king",
  "oldtom",
  "harvester",
];

// ----------------------------------------------------------------------------
// Enemy archetypes
// ----------------------------------------------------------------------------
export type AIRole =
  | "chaser" // walks at you, contact + melee swing
  | "swarm" // fast, erratic, contact
  | "flyer" // hovers, dive attacks
  | "ranged" // keeps distance, shoots
  | "rooted" // stationary, lunges/grabs when near
  | "shielded" // blocks frontally, heavy telegraphed swing
  | "boss_king"
  | "boss_harvester"
  | "boss_oldtom";

export interface EnemyDef {
  id: string; // roster key (e.g. "mite") — preserved from v1 for tuning identity
  kind: EnemyKind; // ART-backed renderable kind
  name: string;
  role: AIRole;
  hp: number;
  speed: number; // px/sec
  radius: number;
  contactDmg: number; // damage on touch
  attackDmg: number; // damage on a committed swing/shot
  attackRange: number;
  attackCooldown: number; // seconds
  windup: number; // telegraph seconds
  sap: number; // currency dropped
  big?: number; // visual scale
  projectile?: boolean;
  knockback?: number;
  poison?: number; // if set, hit/projectile applies poison-over-time budget
  armor?: number; // flat damage soaked per hit before HP loss
  staggerHp?: number; // poise pool; depleting it interrupts/stuns
}

// Roster preserved from v1 (all tuned values intact). The `kind` field is the
// only thing remapped, so every def renders with an available sprite:
//   swarm  (mite, aphid)            -> grub
//   chaser (grub, slug)             -> grub
//   flyer  (crow, hornet)           -> hornet
//   ranged (spore, drone)           -> drone
//   rooted (weed)                   -> weed
//   shielded (beetle, scarecrow)    -> grub (slow, armored ground brute)
export const ENEMIES: Record<string, EnemyDef> = {
  // ---- swarm / fodder tier ----
  mite: {
    id: "mite",
    kind: "grub",
    name: "Soil Mite",
    role: "swarm",
    hp: 9,
    speed: 138,
    radius: 8,
    contactDmg: 4,
    attackDmg: 0,
    attackRange: 0,
    attackCooldown: 0,
    windup: 0,
    sap: 5,
    knockback: 40,
    big: 0.7,
  },
  aphid: {
    id: "aphid",
    kind: "grub",
    name: "Aphid Drone",
    role: "swarm",
    hp: 16,
    speed: 104,
    radius: 11,
    contactDmg: 6,
    attackDmg: 0,
    attackRange: 0,
    attackCooldown: 0,
    windup: 0,
    sap: 8,
    knockback: 60,
    big: 0.85,
  },
  grub: {
    id: "grub",
    kind: "grub",
    name: "Cutworm Grub",
    role: "chaser",
    hp: 34,
    speed: 42,
    radius: 13,
    contactDmg: 7,
    attackDmg: 12,
    attackRange: 26,
    attackCooldown: 1.8,
    windup: 0.5,
    sap: 11,
  },
  crow: {
    id: "crow",
    kind: "hornet",
    name: "Gallows Crow",
    role: "flyer",
    hp: 22,
    speed: 78,
    radius: 12,
    contactDmg: 8,
    attackDmg: 13,
    attackRange: 220,
    attackCooldown: 2.4,
    windup: 0.6,
    sap: 16,
    knockback: 80,
    big: 1.15,
  },
  hornet: {
    id: "hornet",
    kind: "hornet",
    name: "Husk Hornet",
    role: "flyer",
    hp: 18,
    speed: 132,
    radius: 10,
    contactDmg: 9,
    attackDmg: 16,
    attackRange: 260,
    attackCooldown: 1.9,
    windup: 0.42, // quick, nasty sting-dash
    sap: 19,
    knockback: 70,
  },
  slug: {
    id: "slug",
    kind: "grub",
    name: "Brine Slug",
    role: "chaser",
    hp: 78,
    speed: 26,
    radius: 18,
    contactDmg: 14,
    attackDmg: 18,
    attackRange: 30,
    attackCooldown: 2.2,
    windup: 0.7,
    sap: 24,
    knockback: 40,
    big: 1.3,
  },
  weed: {
    id: "weed",
    kind: "weed",
    name: "Strangleweed",
    role: "rooted",
    hp: 48,
    speed: 0,
    radius: 16,
    contactDmg: 0,
    attackDmg: 17,
    attackRange: 70,
    attackCooldown: 1.6,
    windup: 0.55,
    sap: 20,
    knockback: 120,
  },
  spore: {
    id: "spore",
    kind: "drone",
    name: "Bloatspore",
    role: "ranged", // lobs poison; projectile applies poison via the `poison` field
    hp: 40,
    speed: 38,
    radius: 14,
    contactDmg: 8,
    attackDmg: 12,
    attackRange: 280,
    attackCooldown: 2.6,
    windup: 0.7,
    sap: 27,
    projectile: true,
    poison: 18,
    knockback: 30,
  },
  drone: {
    id: "drone",
    kind: "drone",
    name: "Pesticide Sprayer",
    role: "ranged",
    hp: 30,
    speed: 64,
    radius: 13,
    contactDmg: 6,
    attackDmg: 10,
    attackRange: 300,
    attackCooldown: 2.0,
    windup: 0.5,
    sap: 26,
    projectile: true,
  },
  beetle: {
    id: "beetle",
    kind: "grub",
    name: "Carapace Beetle",
    role: "shielded", // armored wall: slow, soaks chip damage, heavy telegraphed swing
    hp: 132,
    speed: 34,
    radius: 17,
    contactDmg: 10,
    attackDmg: 24,
    attackRange: 48,
    attackCooldown: 2.6,
    windup: 0.95,
    sap: 54,
    knockback: 100,
    armor: 6, // soaks 6 per hit — punishes spam, rewards heavy hits
    staggerHp: 70, // crack the shell to stun it
    big: 1.4,
  },
  scarecrow: {
    id: "scarecrow",
    kind: "grub",
    name: "Scarecrow Sentinel",
    role: "shielded",
    hp: 96,
    speed: 46,
    radius: 16,
    contactDmg: 8,
    attackDmg: 22,
    attackRange: 46,
    attackCooldown: 2.4,
    windup: 0.85,
    sap: 48,
    knockback: 90,
    staggerHp: 44,
    big: 1.25,
  },
  // ---- bosses (all art-backed) ----
  king: {
    id: "king",
    kind: "king",
    name: "The Scarecrow King, Hollow of the Husk",
    role: "boss_king",
    hp: 720,
    speed: 64,
    radius: 72, // scaled to match the ~3.5x bigger sprite
    contactDmg: 10,
    attackDmg: 26,
    attackRange: 170,
    attackCooldown: 2.0,
    windup: 0.8,
    sap: 1800,
    big: 1.5,
    knockback: 140,
  },
  oldtom: {
    id: "oldtom",
    kind: "oldtom",
    name: "Old Tom, the First Fruit",
    role: "boss_oldtom",
    hp: 1050,
    speed: 72,
    radius: 66, // scaled to match the ~3.5x bigger sprite
    contactDmg: 12,
    attackDmg: 28,
    attackRange: 185,
    attackCooldown: 1.9,
    windup: 0.75,
    sap: 3200,
    big: 1.35,
    knockback: 160,
    staggerHp: 120, // poise-breakable at the apex of a combo
  },
  harvester: {
    id: "harvester",
    kind: "harvester",
    name: "THE HARVESTER",
    role: "boss_harvester",
    hp: 1500,
    speed: 78,
    radius: 120, // scaled to match the ~3.5x bigger sprite
    contactDmg: 18,
    attackDmg: 34,
    attackRange: 250,
    attackCooldown: 1.7,
    windup: 0.7,
    sap: 6000,
    big: 1.0,
    knockback: 220,
  },
};

export type EnemyId = keyof typeof ENEMIES;

// ----------------------------------------------------------------------------
// Areas
// ----------------------------------------------------------------------------
export interface SpawnDef {
  kind: EnemyId;
  x: number;
  y: number;
}
export interface GateDef {
  rect: Rect;
  to: string;
  toX: number;
  toY: number;
  label?: string;
  fog?: boolean; // boss fog gate
  locked?: boolean; // requires the area boss to be dead
  oneWay?: boolean;
}
export interface PropDef {
  type:
    | "fence"
    | "crate"
    | "glass"
    | "stone"
    | "stalk"
    | "sign"
    | "puddle"
    | "mushroom"
    | "flower"
    | "lantern"
    | "bones"
    | "banner"
    | "torch"
    | "grass"
    | "vines";
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
}
export interface AreaDef {
  id: string;
  name: string;
  subtitle: string;
  w: number;
  h: number;
  floor: "soil" | "rows" | "glass" | "stone" | "yard" | "bog";
  tint: string;
  walls: Rect[];
  spawns: SpawnDef[];
  props: PropDef[];
  gates: GateDef[];
  compost?: { x: number; y: number };
  spawnPoint: { x: number; y: number };
  boss?: EnemyId;
  bossName?: string;
  music?: "ambient" | "boss";
}

// border walls helper
const border = (w: number, h: number, th = 40): Rect[] => [
  { x: -th, y: -th, w: w + th * 2, h: th },
  { x: -th, y: h, w: w + th * 2, h: th },
  { x: -th, y: 0, w: th, h: h },
  { x: w, y: 0, w: th, h: h },
];

// Areas — a linear 3-act march: two rooms feed each early boss, then the pace
// tightens to one room per boss. Every spawn key resolves through ENEMIES to a
// grub/weed/drone/hornet sprite. Gate contract matches Sim.ts:
//   - room->room and room->bossFog gates are open;
//   - boss-room ENTRANCE gates carry fog:true (cosmetic);
//   - boss-room EXIT gates carry locked:true + oneWay:true (the engine clears
//     `locked` on boss death), funnelling the player forward into the next act.
//
//   ACT I   rows -> greenhouse -> kingarena (BOSS king)
//   ACT II  catacombs -> sodden (BOSS oldtom)
//   ACT III threshing -> yard (BOSS harvester)
export const AREAS: Record<string, AreaDef> = {
  // ===== ACT I — room 1 =====================================================
  // The opening field. Two parallel hedge-rows split the map into three lanes
  // joined by staggered gaps, so fodder must be pulled lane by lane. A walled
  // ambush pocket on the far right hides a flyer above the exit.
  rows: {
    id: "rows",
    name: "The Rotting Rows",
    subtitle: "where the first frost forgot to come",
    w: 1600,
    h: 900,
    floor: "rows",
    tint: "rgba(40,30,15,0.18)",
    spawnPoint: { x: 160, y: 450 },
    compost: { x: 240, y: 450 },
    walls: [
      ...border(1600, 900),
      // first hedge-row: gap in the lower third
      { x: 620, y: 0, w: 34, h: 520 },
      { x: 620, y: 700, w: 34, h: 200 },
      // second hedge-row: gap in the upper third (staggered against the first)
      { x: 1000, y: 0, w: 34, h: 220 },
      { x: 1000, y: 400, w: 34, h: 500 },
      // ambush pocket wall hugging the exit corridor
      { x: 1320, y: 600, w: 200, h: 30 },
    ],
    props: [
      { type: "sign", x: 320, y: 380, text: "ROLL: Spacebar.\nThe harvest fears the nimble." },
      { type: "torch", x: 240, y: 360 },
      { type: "stalk", x: 470, y: 200 },
      { type: "stalk", x: 520, y: 250 },
      { type: "stalk", x: 470, y: 700 },
      { type: "stalk", x: 800, y: 200 },
      { type: "stalk", x: 860, y: 700 },
      { type: "fence", x: 380, y: 140, w: 200, h: 14 },
      { type: "fence", x: 700, y: 780, w: 240, h: 14 },
      { type: "crate", x: 820, y: 470, w: 44, h: 44 },
      { type: "crate", x: 864, y: 470, w: 44, h: 44 },
      { type: "puddle", x: 1180, y: 300, w: 130, h: 70 },
      { type: "grass", x: 300, y: 620 },
      { type: "grass", x: 360, y: 660 },
      { type: "grass", x: 760, y: 560 },
      { type: "flower", x: 250, y: 250 },
      { type: "flower", x: 540, y: 820 },
      { type: "bones", x: 1180, y: 720, w: 30, h: 20 },
      { type: "sign", x: 1430, y: 470, text: "East: glass and green rot.\nThe GREENHOUSE swallows the light." },
      { type: "torch", x: 1500, y: 360 },
    ],
    spawns: [
      // lane 1: a knot of swarm fodder around the first gap
      { kind: "mite", x: 470, y: 600 },
      { kind: "mite", x: 520, y: 640 },
      { kind: "aphid", x: 560, y: 560 },
      { kind: "aphid", x: 540, y: 680 },
      // lane 2: a pair of chasers guarding the second gap
      { kind: "grub", x: 820, y: 300 },
      { kind: "grub", x: 880, y: 340 },
      { kind: "aphid", x: 800, y: 460 },
      // lane 3 + ambush pocket: a crow perched over the exit
      { kind: "mite", x: 1200, y: 460 },
      { kind: "aphid", x: 1240, y: 500 },
      { kind: "crow", x: 1420, y: 720 },
    ],
    gates: [
      {
        rect: { x: 1560, y: 380, w: 40, h: 140 },
        to: "greenhouse",
        toX: 130,
        toY: 500,
        label: "The Greenhouse of Glass",
      },
    ],
  },

  // ===== ACT I — room 2 =====================================================
  // A glass cathedral. A long central spine with one mid gap separates two
  // halves: a humid south wing (rooted weeds + a lurking slug) and a north
  // gauntlet where two sprayer drones hold sightlines down the aisle. A short
  // glass baffle makes a flanking pocket by the boss door.
  greenhouse: {
    id: "greenhouse",
    name: "The Greenhouse of Glass",
    subtitle: "a cathedral of condensation and rot",
    w: 1700,
    h: 1000,
    floor: "glass",
    tint: "rgba(60,90,80,0.16)",
    spawnPoint: { x: 120, y: 500 },
    compost: { x: 220, y: 500 },
    walls: [
      ...border(1700, 1000),
      // entry baffle: forces a turn out of the spawn alcove
      { x: 360, y: 0, w: 30, h: 320 },
      // central spine with a single mid gap (the only crossing)
      { x: 820, y: 0, w: 30, h: 380 },
      { x: 820, y: 600, w: 30, h: 400 },
      // north drone gallery wall
      { x: 1180, y: 0, w: 30, h: 400 },
      // flank pocket baffle near the boss door
      { x: 1180, y: 640, w: 240, h: 30 },
    ],
    props: [
      { type: "glass", x: 300, y: 560, w: 60, h: 220 },
      { type: "glass", x: 700, y: 700, w: 200, h: 60 },
      { type: "glass", x: 1180, y: 470, w: 30, h: 140 },
      { type: "crate", x: 1080, y: 760, w: 44, h: 44 },
      { type: "crate", x: 1124, y: 760, w: 44, h: 44 },
      { type: "stalk", x: 560, y: 300 },
      { type: "stalk", x: 1450, y: 760 },
      { type: "puddle", x: 600, y: 760, w: 140, h: 80 },
      { type: "sign", x: 280, y: 600, text: "GUARD: hold Right-click.\nBLOCK what you cannot dodge." },
      { type: "mushroom", x: 440, y: 740 },
      { type: "mushroom", x: 480, y: 780 },
      { type: "mushroom", x: 1240, y: 880 },
      { type: "flower", x: 900, y: 780 },
      { type: "flower", x: 760, y: 780 },
      { type: "vines", x: 820, y: 420, w: 30, h: 160 },
      { type: "vines", x: 1180, y: 430, w: 30, h: 30 },
      { type: "lantern", x: 200, y: 360 },
      { type: "lantern", x: 1500, y: 200 },
      { type: "torch", x: 1560, y: 480 },
      { type: "grass", x: 640, y: 880 },
      { type: "sign", x: 1480, y: 560, text: "The straw throne waits east.\nA king of husk and hunger." },
    ],
    spawns: [
      // south wing: rooted weeds and a tanky slug behind the spine gap
      { kind: "weed", x: 620, y: 760 },
      { kind: "weed", x: 740, y: 560 },
      { kind: "slug", x: 560, y: 640 },
      { kind: "spore", x: 460, y: 520 },
      // north gallery: two sprayer drones with long sightlines down the aisle
      { kind: "drone", x: 1000, y: 240 },
      { kind: "drone", x: 1450, y: 300 },
      { kind: "hornet", x: 1300, y: 200 },
      // flank pocket by the boss door: a scarecrow ambush + chaff
      { kind: "scarecrow", x: 1500, y: 760 },
      { kind: "aphid", x: 1280, y: 800 },
      { kind: "aphid", x: 1340, y: 840 },
    ],
    gates: [
      {
        rect: { x: 1660, y: 440, w: 40, h: 140 },
        to: "kingarena",
        toX: 500,
        toY: 880,
        label: "Throne of Straw",
        fog: true,
      },
      {
        rect: { x: 0, y: 440, w: 30, h: 120 },
        to: "rows",
        toX: 1500,
        toY: 450,
        label: "back to the Rows",
      },
    ],
  },

  // ===== ACT I — BOSS: The Scarecrow King ===================================
  // Open straw court. Boss spawns center-top; the floor is left clear. Only the
  // four corners carry cover and the entrance edge holds a rest + torchlight.
  kingarena: {
    id: "kingarena",
    name: "Throne of Straw",
    subtitle: "The Scarecrow King, Hollow of the Husk",
    w: 1100,
    h: 1100,
    floor: "stone",
    tint: "rgba(30,10,10,0.3)",
    spawnPoint: { x: 550, y: 950 },
    compost: { x: 550, y: 870 },
    walls: [...border(1100, 1100)],
    props: [
      { type: "stone", x: 130, y: 130, w: 56, h: 56 },
      { type: "stone", x: 914, y: 130, w: 56, h: 56 },
      { type: "stone", x: 130, y: 914, w: 56, h: 56 },
      { type: "stone", x: 914, y: 914, w: 56, h: 56 },
      { type: "banner", x: 550, y: 60, w: 28, h: 120 },
      { type: "torch", x: 120, y: 560 },
      { type: "torch", x: 980, y: 560 },
      { type: "torch", x: 440, y: 940 },
      { type: "torch", x: 660, y: 940 },
      { type: "bones", x: 320, y: 820, w: 50, h: 30 },
      { type: "bones", x: 740, y: 820, w: 50, h: 30 },
      { type: "lantern", x: 550, y: 980 },
    ],
    spawns: [],
    boss: "king",
    bossName: "The Scarecrow King",
    music: "boss",
    gates: [
      {
        rect: { x: 510, y: 0, w: 80, h: 30 },
        to: "catacombs",
        toX: 130,
        toY: 520,
        label: "The Compost Catacombs",
        locked: true,
        oneWay: true,
      },
    ],
  },

  // ===== ACT II — room 1 ====================================================
  // Crypt corridors. A T-shaped wall splits the room into a left antechamber,
  // a central nave choke, and a right reliquary held by ranged enemies behind a
  // low altar shelf. A beetle guards the narrow throat to the boss fog.
  catacombs: {
    id: "catacombs",
    name: "The Compost Catacombs",
    subtitle: "where last season's failures ferment",
    w: 1500,
    h: 1100,
    floor: "stone",
    tint: "rgba(20,15,25,0.34)",
    spawnPoint: { x: 130, y: 520 },
    compost: { x: 240, y: 520 },
    walls: [
      ...border(1500, 1100),
      // left/center divider with a single nave gap
      { x: 440, y: 0, w: 34, h: 430 },
      { x: 440, y: 670, w: 34, h: 430 },
      // T crossbar: a low shelf jutting into the nave (flank cover)
      { x: 474, y: 520, w: 220, h: 30 },
      // center/right divider — the throat to the reliquary, gap up high
      { x: 900, y: 240, w: 34, h: 860 },
      { x: 900, y: 0, w: 34, h: 100 },
      // altar shelf the ranged enemies hide behind
      { x: 1160, y: 430, w: 340, h: 34 },
    ],
    props: [
      { type: "stone", x: 600, y: 250, w: 60, h: 60 },
      { type: "stone", x: 600, y: 820, w: 60, h: 60 },
      { type: "crate", x: 300, y: 800, w: 44, h: 44 },
      { type: "puddle", x: 1040, y: 720, w: 160, h: 100 },
      { type: "sign", x: 300, y: 420, text: "LOCK-ON: Tab / Q.\nFix your gaze. Circle. Punish." },
      { type: "bones", x: 560, y: 640, w: 44, h: 28 },
      { type: "bones", x: 980, y: 200, w: 44, h: 28 },
      { type: "torch", x: 240, y: 360 },
      { type: "torch", x: 700, y: 200 },
      { type: "torch", x: 700, y: 880 },
      { type: "torch", x: 1180, y: 560 },
      { type: "banner", x: 600, y: 120, w: 24, h: 90 },
      { type: "mushroom", x: 1040, y: 780 },
      { type: "vines", x: 900, y: 360, w: 34, h: 140 },
      { type: "sign", x: 1180, y: 200, text: "The throne lies north.\nClimb, and kneel, and die." },
    ],
    spawns: [
      // left antechamber: a chaser pair + rooted weed at the nave gap
      { kind: "grub", x: 600, y: 380 },
      { kind: "weed", x: 560, y: 720 },
      { kind: "grub", x: 660, y: 760 },
      // nave choke + shelf flank: a slug holds the middle
      { kind: "slug", x: 700, y: 620 },
      { kind: "crow", x: 760, y: 320 },
      // right reliquary: ranged behind the altar shelf, beetle on the throat
      { kind: "drone", x: 1240, y: 280 },
      { kind: "spore", x: 1320, y: 320 },
      { kind: "beetle", x: 1040, y: 620 },
      { kind: "scarecrow", x: 1240, y: 820 },
    ],
    gates: [
      {
        rect: { x: 1300, y: 60, w: 40, h: 160 },
        to: "sodden",
        toX: 625,
        toY: 1120,
        label: "The Sodden Mire",
        fog: true,
      },
      {
        rect: { x: 0, y: 480, w: 30, h: 120 },
        to: "kingarena",
        toX: 540,
        toY: 120,
        label: "back to the Throne",
      },
    ],
  },

  // ===== ACT II — BOSS: Old Tom, the First Fruit ============================
  // Drowned bog. Boss spawns center-top over open mud; the middle is clear.
  // Only the rim carries puddles and a little reed cover, and the entrance
  // (bottom) holds a rest before the fight.
  sodden: {
    id: "sodden",
    name: "The Sodden Mire",
    subtitle: "where the first to ripen went to rot",
    w: 1250,
    h: 1250,
    floor: "bog",
    tint: "rgba(30,45,40,0.40)",
    spawnPoint: { x: 625, y: 1120 },
    compost: { x: 625, y: 1010 },
    walls: [...border(1250, 1250)],
    props: [
      { type: "sign", x: 625, y: 1080, text: "Here a fruit stood where you stand.\nHe did not leave. He grew roots and a grudge." },
      { type: "puddle", x: 220, y: 300, w: 200, h: 130 },
      { type: "puddle", x: 880, y: 320, w: 200, h: 130 },
      { type: "puddle", x: 200, y: 880, w: 200, h: 140 },
      { type: "puddle", x: 880, y: 880, w: 200, h: 140 },
      { type: "mushroom", x: 180, y: 560 },
      { type: "mushroom", x: 220, y: 600 },
      { type: "mushroom", x: 1050, y: 560 },
      { type: "mushroom", x: 1010, y: 600 },
      { type: "vines", x: 0, y: 500, w: 30, h: 220 },
      { type: "vines", x: 1220, y: 500, w: 30, h: 220 },
      { type: "grass", x: 300, y: 760 },
      { type: "grass", x: 940, y: 760 },
      { type: "bones", x: 360, y: 460, w: 40, h: 26 },
      { type: "bones", x: 880, y: 1080, w: 40, h: 26 },
      { type: "lantern", x: 625, y: 1050 },
      { type: "torch", x: 460, y: 1100 },
      { type: "torch", x: 790, y: 1100 },
    ],
    spawns: [],
    boss: "oldtom",
    bossName: "Old Tom, the First Fruit",
    music: "boss",
    gates: [
      {
        rect: { x: 545, y: 0, w: 160, h: 30 },
        to: "threshing",
        toX: 130,
        toY: 520,
        label: "The Threshing Floor",
        locked: true,
        oneWay: true,
      },
    ],
  },

  // ===== ACT III — room 1 (NEW) =============================================
  // The threshing floor. Stacked grain crates form two staggered chokepoints; a
  // squat thresher-block sits dead center as hard cover to circle. A walled
  // ambush bay on the right springs a scarecrow as you near the final door,
  // while a crow and a drone work the open sightlines. The toughest room yet.
  threshing: {
    id: "threshing",
    name: "The Threshing Floor",
    subtitle: "where the chaff is beaten from the bones",
    w: 1600,
    h: 1100,
    floor: "yard",
    tint: "rgba(46,26,12,0.26)",
    spawnPoint: { x: 130, y: 520 },
    compost: { x: 240, y: 520 },
    walls: [
      ...border(1600, 1100),
      // first crate choke: gap low
      { x: 460, y: 0, w: 34, h: 460 },
      { x: 460, y: 700, w: 34, h: 400 },
      // central thresher-block: hard cover to circle
      { x: 720, y: 470, w: 160, h: 160 },
      // second crate choke: gap high (staggered)
      { x: 1080, y: 0, w: 34, h: 220 },
      { x: 1080, y: 460, w: 34, h: 640 },
      // ambush bay wall by the final door
      { x: 1300, y: 600, w: 220, h: 30 },
    ],
    props: [
      { type: "sign", x: 320, y: 420, text: "The blade waits east.\nRipen, or be paste." },
      { type: "torch", x: 240, y: 360 },
      { type: "crate", x: 540, y: 500, w: 46, h: 46 },
      { type: "crate", x: 586, y: 500, w: 46, h: 46 },
      { type: "crate", x: 540, y: 546, w: 46, h: 46 },
      { type: "crate", x: 1140, y: 560, w: 46, h: 46 },
      { type: "crate", x: 1186, y: 560, w: 46, h: 46 },
      { type: "stalk", x: 300, y: 240 },
      { type: "stalk", x: 320, y: 820 },
      { type: "stalk", x: 980, y: 240 },
      { type: "stalk", x: 980, y: 840 },
      { type: "fence", x: 540, y: 760, w: 220, h: 14 },
      { type: "puddle", x: 800, y: 820, w: 150, h: 80 },
      { type: "bones", x: 800, y: 280, w: 50, h: 30 },
      { type: "grass", x: 620, y: 880 },
      { type: "grass", x: 1240, y: 300 },
      { type: "sign", x: 1420, y: 470, text: "THE HARVESTER stirs beyond.\nIt does not tire. You will." },
      { type: "torch", x: 1500, y: 360 },
      { type: "banner", x: 1500, y: 760, w: 26, h: 100 },
    ],
    spawns: [
      // first choke: a chaser pair + rooted weed pinning the low gap
      { kind: "grub", x: 600, y: 760 },
      { kind: "grub", x: 660, y: 820 },
      { kind: "weed", x: 560, y: 700 },
      // center thresher-block: a slug to circle + a crow overhead
      { kind: "slug", x: 800, y: 320 },
      { kind: "crow", x: 940, y: 560 },
      // second choke + sightline: a sprayer drone holds the high gap
      { kind: "drone", x: 1000, y: 180 },
      { kind: "spore", x: 1240, y: 820 },
      // ambush bay by the door: scarecrow springs late + a hornet harries
      { kind: "scarecrow", x: 1420, y: 720 },
      { kind: "hornet", x: 1360, y: 300 },
    ],
    gates: [
      {
        rect: { x: 1560, y: 440, w: 40, h: 140 },
        to: "yard",
        toX: 700,
        toY: 1180,
        label: "The Harvest Yard",
        fog: true,
      },
      {
        rect: { x: 0, y: 480, w: 30, h: 120 },
        to: "sodden",
        toX: 625,
        toY: 200,
        label: "back to the Mire",
      },
    ],
  },

  // ===== ACT III — BOSS: THE HARVESTER ======================================
  // The final yard. The largest, most open arena — the Harvester is huge and
  // charges, so the center is left completely clear. Only the four corners hold
  // dead stalks, with a rest and torchlight at the southern entrance.
  yard: {
    id: "yard",
    name: "The Harvest Yard",
    subtitle: "where all rows end",
    w: 1400,
    h: 1300,
    floor: "yard",
    tint: "rgba(50,20,10,0.28)",
    spawnPoint: { x: 700, y: 1150 },
    compost: { x: 700, y: 1050 },
    walls: [...border(1400, 1300)],
    props: [
      { type: "stalk", x: 220, y: 280 },
      { type: "stalk", x: 1180, y: 280 },
      { type: "stalk", x: 220, y: 980 },
      { type: "stalk", x: 1180, y: 980 },
      { type: "sign", x: 700, y: 1110, text: "Beyond lies the blade.\nRipen, or be paste." },
      { type: "bones", x: 460, y: 520, w: 60, h: 34 },
      { type: "bones", x: 900, y: 760, w: 60, h: 34 },
      { type: "torch", x: 260, y: 1120 },
      { type: "torch", x: 1140, y: 1120 },
      { type: "torch", x: 560, y: 1140 },
      { type: "torch", x: 840, y: 1140 },
      { type: "banner", x: 700, y: 120, w: 30, h: 120 },
      { type: "lantern", x: 700, y: 1080 },
    ],
    spawns: [],
    boss: "harvester",
    bossName: "The Harvester",
    music: "boss",
    gates: [],
  },
};

export const FIRST_AREA = "rows";

// ----------------------------------------------------------------------------
// Weapons
// ----------------------------------------------------------------------------
export interface WeaponDef {
  id: WeaponKind;
  name: string;
  flavor: string;
  reach: number; // px — melee hitbox length
  arcHalf: number; // radians — half-angle of the swing arc
  lightMul: number; // damage multiplier vs base attack (light)
  heavyMul: number; // damage multiplier vs base attack (heavy)
  speedMul: number; // scales swing duration (>1 = slower)
  staminaLight: number;
  staminaHeavy: number;
  poise?: number; // stagger dealt to staggerHp pools
  special?: string; // "thrust" | "sweep" | "crush" | "riposte"
}

export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  whip: {
    id: "whip",
    name: "Vine Whip",
    flavor:
      "A length of your own creeper, cured stiff. It remembers being part of you and strikes like it resents the separation.",
    reach: 72,
    arcHalf: 1.15,
    lightMul: 1.0,
    heavyMul: 1.9,
    speedMul: 1.0,
    staminaLight: 16,
    staminaHeavy: 30,
    poise: 8,
    special: "sweep",
  },
  dagger: {
    id: "dagger",
    name: "Thorn Shiv",
    flavor:
      "A single blackthorn, snapped from a hedge that drank too deep. Quick, mean, and barely worth the swing — until you have landed twelve.",
    reach: 34,
    arcHalf: 0.7,
    lightMul: 0.7,
    heavyMul: 1.3,
    speedMul: 0.66,
    staminaLight: 9,
    staminaHeavy: 18,
    poise: 4,
    special: "thrust",
  },
  mace: {
    id: "mace",
    name: "Knuckle of Gourd",
    flavor:
      "A dried squash gone hard as bone, hafted to a femur of fence-post. It does not cut. It convinces.",
    reach: 44,
    arcHalf: 0.95,
    lightMul: 1.5,
    heavyMul: 2.6,
    speedMul: 1.45,
    staminaLight: 26,
    staminaHeavy: 44,
    poise: 32, // staggers shields & cracks beetle shells
    special: "crush",
  },
  rapier: {
    id: "rapier",
    name: "Old Tom's Pin",
    flavor:
      "The long thin spine they used to stake the First Fruit upright so he might keep watching. He kept it. Now it keeps you.",
    reach: 56,
    arcHalf: 0.6,
    lightMul: 0.95,
    heavyMul: 1.7,
    speedMul: 0.8,
    staminaLight: 11,
    staminaHeavy: 22,
    poise: 6,
    special: "riposte",
  },
};

export const STARTING_WEAPON: WeaponKind = "whip";
export const WEAPON_ORDER: WeaponKind[] = ["whip", "dagger", "mace", "rapier"];

// ----------------------------------------------------------------------------
// Charms (passive trinkets)
// ----------------------------------------------------------------------------
export interface CharmDef {
  id: string;
  name: string;
  flavor: string;
  staminaRegenMul?: number;
  hpRegen?: number; // flat HP/sec passive regen
  damageMul?: number;
  defenseMul?: number; // <1 = tankier
  sapMul?: number;
  healPower?: number; // flat extra HP per heal
}

export const CHARMS: CharmDef[] = [
  {
    id: "salt_pouch",
    name: "Salt Pouch",
    flavor:
      "A twist of cloth gone stiff with brine. The slugs gave it up grudgingly. It teaches your skin to refuse the rot a little longer.",
    defenseMul: 0.9,
  },
  {
    id: "cracked_trellis_ring",
    name: "Cracked Trellis Ring",
    flavor:
      "A loop of split lattice that once held a vine upright. It holds you upright now, after a fashion. You tire less for the leaning.",
    staminaRegenMul: 1.25,
  },
  {
    id: "beetle_husk_brooch",
    name: "Beetle Husk Brooch",
    flavor:
      "The emptied shell of something that thought armor was enough. Pinned over the heart, it is almost a promise. It is not a promise.",
    defenseMul: 0.84,
    staminaRegenMul: 0.92,
  },
  {
    id: "thirsty_root",
    name: "Thirsty Root",
    flavor:
      "A hairnet of fine roots that drinks whatever it touches, including you. It will mend a wound slowly and ask for nothing — yet.",
    hpRegen: 0.6,
  },
  {
    id: "hollow_seed",
    name: "Hollow Seed",
    flavor:
      "A pip that never quickened, light as a held breath. It remembers every fruit that fell and skims a little sap from each in tribute.",
    sapMul: 1.2,
  },
  {
    id: "first_fruits_pith",
    name: "First Fruit's Pith",
    flavor:
      "A sliver of Old Tom, kept against your better judgement. It lends his old ferocity and a measure of his old thirst. Both will cost you.",
    damageMul: 1.15,
    healPower: 14,
    defenseMul: 1.08,
  },
];

export const getCharm = (id: string | null): CharmDef | null =>
  id ? CHARMS.find((c) => c.id === id) ?? null : null;

// ----------------------------------------------------------------------------
// Player progression (numbers preserved from v1's balance pass)
// ----------------------------------------------------------------------------
export const BASE_STATS: PlayerStats = {
  vigor: 1,
  strength: 1,
  vitality: 1,
  agility: 1,
};

export const deriveMaxHp = (s: PlayerStats) => 90 + (s.vigor - 1) * 24;
export const deriveAttack = (s: PlayerStats) => 20 + (s.strength - 1) * 6;
export const deriveMaxStamina = (s: PlayerStats) => 100 + (s.vitality - 1) * 18;
export const deriveSpeed = (s: PlayerStats) => 168 + (s.agility - 1) * 8;

export const totalLevel = (s: PlayerStats) =>
  s.vigor + s.strength + s.vitality + s.agility - 4;

export const levelCost = (s: PlayerStats) => {
  const lvl = totalLevel(s);
  return Math.floor(60 + Math.pow(lvl, 1.52) * 11);
};

export const PLAYER_TINTS = [
  "#d83a2e",
  "#e8902a",
  "#c0d04a",
  "#b04ad0",
  "#4ab0d0",
  "#e0e0e0",
];

// ----------------------------------------------------------------------------
// animState resolution — single source of truth mapping (kind, AI state, move)
// to a canonical clip name. The Sim calls this every tick.
// ----------------------------------------------------------------------------

// generic enemy phases the Sim tracks internally
export type EnemyPhase =
  | "idle"
  | "chase"
  | "windup"
  | "active"
  | "recover"
  | "dead";

// Map a non-boss enemy to its canonical animState.
//   grub   : idle | move | attack | death
//   weed   : idle | attack | death          (rooted — never "move")
//   drone  : idle | attack | death
//   hornet : idle | move | attack | death
export function enemyAnim(
  kind: EnemyKind,
  phase: EnemyPhase,
  moving: boolean
): AnimState {
  if (phase === "dead") return "death";
  // windup + active + recover all read as the kind's single "attack" clip
  if (phase === "windup" || phase === "active") return "attack";
  // grub & hornet have a locomotion clip; weed & drone do not
  if ((kind === "grub" || kind === "hornet") && moving && phase === "chase")
    return "move";
  // recover/chase-without-motion/idle fall back to idle
  return "idle";
}

// Map a boss to its canonical animState given the chosen attack move index.
// bossMove indices match the per-boss AI in Sim.ts.
//   king      : idle | move | scytheSweep(0) | lunge(1) | summonRoar(2) | spinAttack(3) | death
//   oldtom    : idle | move | lungingStab(0/1) | griefNova(3) | phase2Roar | death
//   harvester : idle | charge(0) | bladeSweep(2) | poisonVolley(1) | groundSlam(3) | overdriveRoar | death
export function bossAnim(
  kind: "king" | "oldtom" | "harvester",
  phase: EnemyPhase,
  bossMove: number,
  moving: boolean,
  roaring: boolean
): AnimState {
  if (phase === "dead") return "death";
  const acting = phase === "windup" || phase === "active";
  if (kind === "king") {
    if (acting) {
      switch (bossMove) {
        case 0:
          return "scytheSweep";
        case 1:
          return "lunge";
        case 2:
          return "summonRoar";
        case 3:
          return "spinAttack";
      }
    }
    return moving && phase === "chase" ? "move" : "idle";
  }
  if (kind === "oldtom") {
    if (roaring) return "phase2Roar";
    if (acting) {
      if (bossMove === 3) return "griefNova";
      return "lungingStab"; // thrust(0) & lunge(1) share the stab clip
    }
    return moving && phase === "chase" ? "move" : "idle";
  }
  // harvester
  if (roaring) return "overdriveRoar";
  if (acting) {
    switch (bossMove) {
      case 0:
        return "charge";
      case 1:
        return "poisonVolley";
      case 2:
        return "bladeSweep";
      case 3:
        return "groundSlam";
    }
  }
  // harvester has no plain "move" — it reads as idle while repositioning
  return "idle";
}

// which enemy animStates are one-shot (play once, hold last frame)
export const isOnceAnim = (a: AnimState): boolean =>
  a === "death" ||
  a === "attack" ||
  a === "lightAttack" ||
  a === "heavyAttack" ||
  a === "hurt" ||
  a === "roll" ||
  a === "scytheSweep" ||
  a === "lunge" ||
  a === "summonRoar" ||
  a === "spinAttack" ||
  a === "lungingStab" ||
  a === "griefNova" ||
  a === "phase2Roar" ||
  a === "charge" ||
  a === "bladeSweep" ||
  a === "poisonVolley" ||
  a === "groundSlam" ||
  a === "overdriveRoar";
