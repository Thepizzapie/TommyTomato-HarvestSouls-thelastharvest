import type { EnemyKind } from "../core/art";
import type { Rect } from "../core/math";

// ---------- Enemy archetypes ----------
export type AIRole =
  | "chaser" // walks at you, contact + melee swing
  | "swarm" // fast, erratic, contact
  | "flyer" // hovers, dive attacks
  | "ranged" // keeps distance, shoots
  | "rooted" // stationary, lunges/grabs when near
  | "shielded" // blocks frontally, heavy telegraphed swing
  | "boss_king"
  | "boss_harvester"
  | "boss_oldtom"; // the First Fruit — custom AI lives in the integrator

export interface EnemyDef {
  kind: EnemyKind;
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
  big?: number;
  projectile?: boolean;
  knockback?: number;
  // ---- optional extensions (all read by the integrator; safe to ignore) ----
  poison?: number; // if set, this enemy's hit/projectile applies poison-over-time (dmg/sec budget)
  armor?: number; // flat damage soaked per hit before HP loss (frontal/all per integrator)
  staggerHp?: number; // poise pool; depleting it interrupts/stuns (for shielded & bosses)
}

export const ENEMIES: Record<string, EnemyDef> = {
  // ---- swarm / fodder tier ----
  mite: {
    kind: "mite",
    name: "Soil Mite",
    role: "swarm",
    hp: 14,
    speed: 138,
    radius: 8,
    contactDmg: 4,
    attackDmg: 0,
    attackRange: 0,
    attackCooldown: 0,
    windup: 0,
    sap: 5,
    knockback: 40,
  },
  aphid: {
    kind: "aphid",
    name: "Aphid Drone",
    role: "swarm",
    hp: 28,
    speed: 104,
    radius: 11,
    contactDmg: 6,
    attackDmg: 0,
    attackRange: 0,
    attackCooldown: 0,
    windup: 0,
    sap: 8,
    knockback: 60,
  },
  grub: {
    kind: "grub",
    name: "Cutworm Grub",
    role: "chaser",
    hp: 46,
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
    kind: "crow",
    name: "Gallows Crow",
    role: "flyer",
    hp: 32,
    speed: 78,
    radius: 12,
    contactDmg: 8,
    attackDmg: 13,
    attackRange: 220,
    attackCooldown: 2.4,
    windup: 0.6,
    sap: 16,
    knockback: 80,
  },
  hornet: {
    kind: "hornet",
    name: "Husk Hornet",
    role: "flyer",
    hp: 30,
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
    kind: "slug",
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
  },
  weed: {
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
    kind: "spore",
    name: "Bloatspore",
    role: "ranged", // lobs poison; projectile applies poison via the `poison` field
    hp: 48,
    speed: 38,
    radius: 14,
    contactDmg: 8,
    attackDmg: 12,
    attackRange: 280,
    attackCooldown: 2.6,
    windup: 0.7,
    sap: 27,
    projectile: true,
    poison: 18, // ~18 dmg over the poison duration the integrator chooses
    knockback: 30,
  },
  drone: {
    kind: "drone",
    name: "Pesticide Sprayer",
    role: "ranged",
    hp: 40,
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
    kind: "beetle",
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
  },
  scarecrow: {
    kind: "scarecrow",
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
  },
  king: {
    kind: "king",
    name: "The Scarecrow King, Hollow of the Husk",
    role: "boss_king",
    hp: 720,
    speed: 64,
    radius: 24,
    contactDmg: 5,
    attackDmg: 26,
    attackRange: 120,
    attackCooldown: 2.0,
    windup: 1.0,
    sap: 1800,
    big: 1.5,
    knockback: 140,
  },
  oldtom: {
    kind: "oldtom",
    name: "Old Tom, the First Fruit",
    role: "boss_oldtom", // NEEDS CUSTOM AI from the integrator
    hp: 1050, // between king (720) and harvester (1500)
    speed: 72,
    radius: 22,
    contactDmg: 6,
    attackDmg: 28,
    attackRange: 130,
    attackCooldown: 1.9,
    windup: 0.95,
    sap: 3200, // generous — gates a level spike before the Harvester
    big: 1.35,
    knockback: 160,
    staggerHp: 120, // he can be poise-broken at the apex of a combo
  },
  harvester: {
    kind: "harvester",
    name: "THE HARVESTER",
    role: "boss_harvester",
    hp: 1500,
    speed: 78,
    radius: 40,
    contactDmg: 8,
    attackDmg: 34,
    attackRange: 150,
    attackCooldown: 1.7,
    windup: 0.9,
    sap: 6000,
    big: 1.0,
    knockback: 220,
  },
};

// ---------- Areas ----------
export interface SpawnDef {
  kind: keyof typeof ENEMIES;
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
  locked?: boolean; // requires all enemies cleared
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
    // ---- new prop types (art agent draws these; integrator maps them) ----
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
  tint: string; // ambient overlay
  walls: Rect[];
  spawns: SpawnDef[];
  props: PropDef[];
  gates: GateDef[];
  compost?: { x: number; y: number };
  spawnPoint: { x: number; y: number };
  boss?: keyof typeof ENEMIES;
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

export const AREAS: Record<string, AreaDef> = {
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
      { x: 700, y: 0, w: 36, h: 300 },
      { x: 700, y: 560, w: 36, h: 340 },
      { x: 1080, y: 260, w: 36, h: 420 },
    ],
    props: [
      { type: "sign", x: 330, y: 380, text: "ROLL: Spacebar.\nThe harvest fears the nimble." },
      { type: "stalk", x: 520, y: 200 },
      { type: "stalk", x: 560, y: 700 },
      { type: "stalk", x: 480, y: 760 },
      { type: "crate", x: 900, y: 300, w: 44, h: 44 },
      { type: "crate", x: 940, y: 340, w: 44, h: 44 },
      { type: "puddle", x: 1200, y: 600, w: 120, h: 70 },
      { type: "fence", x: 400, y: 140, w: 200, h: 14 },
      { type: "fence", x: 1180, y: 760, w: 240, h: 14 },
      { type: "grass", x: 300, y: 620 },
      { type: "grass", x: 360, y: 660 },
      { type: "grass", x: 1380, y: 200 },
      { type: "flower", x: 250, y: 250 },
      { type: "flower", x: 620, y: 820 },
      { type: "bones", x: 980, y: 720, w: 30, h: 20 },
    ],
    spawns: [
      { kind: "mite", x: 500, y: 340 },
      { kind: "mite", x: 540, y: 300 },
      { kind: "aphid", x: 560, y: 360 },
      { kind: "aphid", x: 600, y: 460 },
      { kind: "aphid", x: 540, y: 520 },
      { kind: "grub", x: 900, y: 500 },
      { kind: "grub", x: 980, y: 240 },
      { kind: "crow", x: 1300, y: 250 },
      { kind: "mite", x: 1320, y: 620 },
      { kind: "aphid", x: 1300, y: 650 },
      { kind: "aphid", x: 1360, y: 600 },
    ],
    gates: [
      {
        rect: { x: 1560, y: 380, w: 40, h: 140 },
        to: "greenhouse",
        toX: 120,
        toY: 480,
        label: "The Greenhouse of Glass",
      },
    ],
  },

  greenhouse: {
    id: "greenhouse",
    name: "The Greenhouse of Glass",
    subtitle: "a cathedral of condensation and rot",
    w: 1700,
    h: 1000,
    floor: "glass",
    tint: "rgba(60,90,80,0.16)",
    spawnPoint: { x: 120, y: 480 },
    compost: { x: 220, y: 480 },
    walls: [
      ...border(1700, 1000),
      { x: 520, y: 0, w: 30, h: 360 },
      { x: 520, y: 640, w: 30, h: 360 },
      { x: 980, y: 200, w: 30, h: 600 },
      { x: 1300, y: 0, w: 30, h: 420 },
    ],
    props: [
      { type: "glass", x: 300, y: 200, w: 60, h: 200 },
      { type: "glass", x: 700, y: 650, w: 200, h: 60 },
      { type: "crate", x: 1100, y: 700, w: 44, h: 44 },
      { type: "stalk", x: 640, y: 300 },
      { type: "stalk", x: 1450, y: 700 },
      { type: "puddle", x: 800, y: 300, w: 140, h: 80 },
      { type: "sign", x: 300, y: 560, text: "GUARD: hold Right-click.\nBLOCK what you cannot dodge." },
      { type: "mushroom", x: 420, y: 720 },
      { type: "mushroom", x: 460, y: 760 },
      { type: "mushroom", x: 1240, y: 880 },
      { type: "flower", x: 880, y: 760 },
      { type: "flower", x: 740, y: 760 },
      { type: "vines", x: 1300, y: 470, w: 30, h: 120 },
      { type: "vines", x: 980, y: 560, w: 30, h: 110 },
      { type: "lantern", x: 1500, y: 120 },
      { type: "grass", x: 600, y: 880 },
      // signpost for the new bog branch
      { type: "sign", x: 360, y: 880, text: "South: a stink of standing water.\nThe SODDEN MIRE. Old roots wait there." },
    ],
    spawns: [
      { kind: "slug", x: 680, y: 400 },
      { kind: "weed", x: 760, y: 220 },
      { kind: "weed", x: 760, y: 760 },
      { kind: "drone", x: 1150, y: 300 },
      { kind: "drone", x: 1450, y: 500 },
      { kind: "spore", x: 700, y: 560 },
      { kind: "aphid", x: 1200, y: 800 },
      { kind: "aphid", x: 1260, y: 760 },
      { kind: "hornet", x: 1500, y: 360 },
      { kind: "scarecrow", x: 1500, y: 250 },
    ],
    gates: [
      {
        rect: { x: 1660, y: 440, w: 40, h: 140 },
        to: "catacombs",
        toX: 120,
        toY: 520,
        label: "The Compost Catacombs",
      },
      {
        rect: { x: 0, y: 440, w: 30, h: 120 },
        to: "rows",
        toX: 1500,
        toY: 450,
        label: "back to the Rows",
      },
      // NEW: branch south into the optional bog side-area
      {
        rect: { x: 360, y: 970, w: 160, h: 30 },
        to: "sodden",
        toX: 650,
        toY: 120,
        label: "The Sodden Mire",
      },
    ],
  },

  // ---- NEW optional side-area: a rain-drowned bog. Old Tom waits at its heart. ----
  // Mirrors the `yard` pattern: a compost heap up by the entrance, then the boss
  // spawns center-top (Game.loadArea places bosses at w/2, h/2-200 => 650,450).
  // Spacious 1300x1300 so the fight has room and the fodder gauntlet earns the rest.
  sodden: {
    id: "sodden",
    name: "The Sodden Mire",
    subtitle: "where the first to ripen went to rot",
    w: 1300,
    h: 1300,
    floor: "bog",
    tint: "rgba(30,45,40,0.40)",
    spawnPoint: { x: 650, y: 120 },
    compost: { x: 650, y: 240 }, // heap by the mouth of the mire, before the descent
    walls: [
      ...border(1300, 1300),
      // sunken raised beds framing the lower arena — leave the center column open
      // (x 540..760) so the boss at (650,450) and the heap at (650,240) are clear
      { x: 300, y: 560, w: 220, h: 30 },
      { x: 780, y: 560, w: 220, h: 30 },
      { x: 220, y: 880, w: 30, h: 260 },
      { x: 1050, y: 880, w: 30, h: 260 },
      { x: 420, y: 1040, w: 240, h: 30 },
      { x: 640, y: 1040, w: 240, h: 30 },
    ],
    props: [
      { type: "sign", x: 650, y: 320, text: "POISON clings here.\nWhat the spore spits, lingers." },
      { type: "puddle", x: 360, y: 700, w: 220, h: 150 },
      { type: "puddle", x: 940, y: 700, w: 220, h: 150 },
      { type: "puddle", x: 650, y: 980, w: 280, h: 140 },
      { type: "mushroom", x: 320, y: 640 },
      { type: "mushroom", x: 360, y: 680 },
      { type: "mushroom", x: 980, y: 660 },
      { type: "mushroom", x: 940, y: 700 },
      { type: "mushroom", x: 650, y: 1160 },
      { type: "vines", x: 0, y: 500, w: 30, h: 200 },
      { type: "vines", x: 1270, y: 500, w: 30, h: 200 },
      { type: "grass", x: 240, y: 460 },
      { type: "grass", x: 1060, y: 480 },
      { type: "grass", x: 460, y: 960 },
      { type: "grass", x: 840, y: 960 },
      { type: "bones", x: 380, y: 800, w: 40, h: 26 },
      { type: "bones", x: 900, y: 1080, w: 40, h: 26 },
      { type: "lantern", x: 650, y: 200 },
      // the hollowed husk of the hero who came before
      { type: "sign", x: 650, y: 1180, text: "Here a fruit stood where you stand.\nHe did not leave. He grew roots and a grudge." },
    ],
    spawns: [
      // a poison-and-pressure gauntlet before the old hero stirs
      { kind: "spore", x: 360, y: 640 },
      { kind: "spore", x: 940, y: 660 },
      { kind: "mite", x: 560, y: 720 },
      { kind: "mite", x: 620, y: 760 },
      { kind: "mite", x: 700, y: 720 },
      { kind: "hornet", x: 460, y: 860 },
      { kind: "slug", x: 650, y: 860 },
      { kind: "weed", x: 360, y: 980 },
      { kind: "weed", x: 940, y: 980 },
      { kind: "beetle", x: 650, y: 1120 },
    ],
    boss: "oldtom",
    bossName: "Old Tom, the First Fruit",
    music: "boss",
    gates: [
      // single, always-open return north to the Greenhouse (area is escapable)
      {
        rect: { x: 570, y: 0, w: 160, h: 30 },
        to: "greenhouse",
        toX: 430,
        toY: 920,
        label: "back to the Greenhouse",
      },
    ],
  },

  catacombs: {
    id: "catacombs",
    name: "The Compost Catacombs",
    subtitle: "where last season's failures ferment",
    w: 1500,
    h: 1100,
    floor: "stone",
    tint: "rgba(20,15,25,0.34)",
    spawnPoint: { x: 120, y: 520 },
    compost: { x: 230, y: 520 },
    walls: [
      ...border(1500, 1100),
      { x: 420, y: 0, w: 34, h: 460 },
      { x: 420, y: 720, w: 34, h: 380 },
      { x: 820, y: 300, w: 34, h: 800 },
      { x: 820, y: 0, w: 34, h: 120 },
      { x: 1120, y: 400, w: 380, h: 34 },
    ],
    props: [
      { type: "stone", x: 600, y: 250, w: 60, h: 60 },
      { type: "stone", x: 600, y: 820, w: 60, h: 60 },
      { type: "crate", x: 300, y: 800, w: 44, h: 44 },
      { type: "puddle", x: 1000, y: 700, w: 160, h: 100 },
      { type: "sign", x: 300, y: 420, text: "LOCK-ON: Tab / Q.\nFix your gaze. Circle. Punish." },
      { type: "bones", x: 560, y: 620, w: 44, h: 28 },
      { type: "bones", x: 900, y: 200, w: 44, h: 28 },
      { type: "torch", x: 430, y: 200 },
      { type: "torch", x: 830, y: 200 },
      { type: "torch", x: 1130, y: 520 },
      { type: "banner", x: 600, y: 120, w: 24, h: 90 },
      { type: "mushroom", x: 1000, y: 760 },
      { type: "vines", x: 820, y: 460, w: 34, h: 140 },
    ],
    spawns: [
      { kind: "grub", x: 600, y: 400 },
      { kind: "grub", x: 660, y: 700 },
      { kind: "weed", x: 560, y: 560 },
      { kind: "slug", x: 980, y: 500 },
      { kind: "drone", x: 1200, y: 250 },
      { kind: "spore", x: 980, y: 820 },
      { kind: "beetle", x: 660, y: 880 },
      { kind: "scarecrow", x: 1100, y: 850 },
      { kind: "crow", x: 1250, y: 600 },
    ],
    gates: [
      {
        rect: { x: 1300, y: 60, w: 40, h: 160 },
        to: "kingarena",
        toX: 480,
        toY: 850,
        label: "Throne of Straw",
        fog: true,
      },
      {
        rect: { x: 0, y: 480, w: 30, h: 120 },
        to: "greenhouse",
        toX: 1600,
        toY: 500,
        label: "back to the Greenhouse",
      },
    ],
  },

  kingarena: {
    id: "kingarena",
    name: "Throne of Straw",
    subtitle: "The Scarecrow King, Hollow of the Husk",
    w: 1000,
    h: 1000,
    floor: "stone",
    tint: "rgba(30,10,10,0.3)",
    spawnPoint: { x: 480, y: 850 },
    walls: [...border(1000, 1000)],
    props: [
      { type: "stone", x: 120, y: 120, w: 50, h: 50 },
      { type: "stone", x: 830, y: 120, w: 50, h: 50 },
      { type: "stone", x: 120, y: 830, w: 50, h: 50 },
      { type: "stone", x: 830, y: 830, w: 50, h: 50 },
      { type: "torch", x: 120, y: 500 },
      { type: "torch", x: 880, y: 500 },
      { type: "banner", x: 500, y: 60, w: 28, h: 110 },
      { type: "bones", x: 300, y: 760, w: 50, h: 30 },
      { type: "bones", x: 680, y: 760, w: 50, h: 30 },
    ],
    spawns: [],
    boss: "king",
    bossName: "The Scarecrow King",
    music: "boss",
    gates: [
      {
        rect: { x: 460, y: 0, w: 80, h: 30 },
        to: "yard",
        toX: 700,
        toY: 1200,
        label: "The Harvest Yard",
        locked: true,
        oneWay: true,
      },
    ],
  },

  yard: {
    id: "yard",
    name: "The Harvest Yard",
    subtitle: "where all rows end",
    w: 1400,
    h: 1300,
    floor: "yard",
    tint: "rgba(50,20,10,0.28)",
    spawnPoint: { x: 700, y: 1200 },
    compost: { x: 700, y: 1230 },
    walls: [...border(1400, 1300)],
    props: [
      { type: "stalk", x: 200, y: 300 },
      { type: "stalk", x: 1200, y: 300 },
      { type: "stalk", x: 200, y: 900 },
      { type: "stalk", x: 1200, y: 900 },
      { type: "sign", x: 700, y: 1130, text: "Beyond lies the blade.\nRipen, or be paste." },
      { type: "bones", x: 500, y: 500, w: 60, h: 34 },
      { type: "bones", x: 880, y: 760, w: 60, h: 34 },
      { type: "torch", x: 240, y: 1100 },
      { type: "torch", x: 1160, y: 1100 },
      { type: "banner", x: 700, y: 120, w: 30, h: 120 },
    ],
    spawns: [],
    boss: "harvester",
    bossName: "The Harvester",
    music: "boss",
    gates: [],
  },
};

export const FIRST_AREA = "rows";

// ---------- Weapons ----------
export type WeaponKind = "whip" | "dagger" | "mace" | "rapier";

export interface WeaponDef {
  id: WeaponKind;
  name: string;
  flavor: string;
  reach: number; // px — melee hitbox length
  arcHalf: number; // radians — half-angle of the swing arc
  lightMul: number; // damage multiplier vs base attack (light)
  heavyMul: number; // damage multiplier vs base attack (heavy)
  speedMul: number; // scales swing duration (>1 = slower)
  staminaLight: number; // stamina per light attack
  staminaHeavy: number; // stamina per heavy attack
  poise?: number; // stagger dealt to staggerHp pools (mace high)
  special?: string; // integrator hook: "thrust" | "sweep" | "crush" | "riposte"
}

// Light/heavy multipliers are tuned around the engine's current 1.0 / 1.9
// so the whip reads as "the baseline you started with".
export const WEAPONS: Record<WeaponKind, WeaponDef> = {
  whip: {
    id: "whip",
    name: "Vine Whip",
    flavor:
      "A length of your own creeper, cured stiff. It remembers being part of you and strikes like it resents the separation.",
    reach: 72, // long
    arcHalf: 1.15, // wide sweep
    lightMul: 1.0,
    heavyMul: 1.9,
    speedMul: 1.0, // medium
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
    reach: 34, // short
    arcHalf: 0.7, // narrow
    lightMul: 0.7,
    heavyMul: 1.3,
    speedMul: 0.66, // fast
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
    reach: 44, // short-mid
    arcHalf: 0.95,
    lightMul: 1.5,
    heavyMul: 2.6,
    speedMul: 1.45, // slow
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
    reach: 56, // medium
    arcHalf: 0.6, // thrust, narrow
    lightMul: 0.95,
    heavyMul: 1.7,
    speedMul: 0.8, // brisk
    staminaLight: 11, // low stamina — riposte-friendly
    staminaHeavy: 22,
    poise: 6,
    special: "riposte",
  },
};

export const STARTING_WEAPON: WeaponKind = "whip";

// ---------- Charms (passive trinkets) ----------
export interface CharmDef {
  id: string;
  name: string;
  flavor: string;
  staminaRegenMul?: number; // multiplier on stamina regen rate
  hpRegen?: number; // flat HP/sec passive regen
  damageMul?: number; // outgoing damage multiplier
  defenseMul?: number; // incoming damage multiplier (<1 = tankier)
  sapMul?: number; // sap gain multiplier
  healPower?: number; // flat extra HP per watering-can heal
}

export const CHARMS: CharmDef[] = [
  {
    id: "salt_pouch",
    name: "Salt Pouch",
    flavor:
      "A twist of cloth gone stiff with brine. The slugs gave it up grudgingly. It teaches your skin to refuse the rot a little longer.",
    defenseMul: 0.9, // take 10% less
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
    defenseMul: 0.84, // tankier, but...
    staminaRegenMul: 0.92, // ...heavier to carry
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
    defenseMul: 1.08, // glassier — you hit harder and heal more, but bruise easier
  },
];

// ---------- Player progression ----------
export interface PlayerStats {
  vigor: number; // HP
  strength: number; // attack damage
  vitality: number; // stamina
  agility: number; // move speed + roll
}

export const BASE_STATS: PlayerStats = {
  vigor: 1,
  strength: 1,
  vitality: 1,
  agility: 1,
};

// BALANCE (changed for the longer run with Old Tom + 4 new enemy kinds):
//   deriveMaxHp:      per-vigor 22 -> 24   (survive the added bog gauntlet)
//   deriveMaxStamina: per-vitality 16 -> 18 (mace/heavy playstyles stay viable)
//   deriveAttack & deriveSpeed: UNCHANGED (curve felt right; raising both would
//     trivialize fodder and break the i-frame/roll tuning respectively)
export const deriveMaxHp = (s: PlayerStats) => 90 + (s.vigor - 1) * 24;
export const deriveAttack = (s: PlayerStats) => 20 + (s.strength - 1) * 6;
export const deriveMaxStamina = (s: PlayerStats) => 100 + (s.vitality - 1) * 18;
export const deriveSpeed = (s: PlayerStats) => 168 + (s.agility - 1) * 8;

export const totalLevel = (s: PlayerStats) =>
  s.vigor + s.strength + s.vitality + s.agility - 4;

// souls cost to buy the next point (scales with total level)
// BALANCE: exponent 1.6 -> 1.52 and coefficient 12 -> 11. The run is longer now,
// so the late-game wall was too steep; this keeps early levels near-identical
// (lvl 1: 60 vs old 60) while shaving ~15-20% off high-level costs so the two
// boss sap payouts (Old Tom 3200, Harvester 6000) translate into real growth.
export const levelCost = (s: PlayerStats) => {
  const lvl = totalLevel(s);
  return Math.floor(60 + Math.pow(lvl, 1.52) * 11);
};

export const PLAYER_TINTS = [
  "#d83a2e", // classic Tommy red
  "#e8902a", // ochre
  "#c0d04a", // green tomato
  "#b04ad0", // heirloom purple
  "#4ab0d0", // frostbit blue
  "#e0e0e0", // albino
];
