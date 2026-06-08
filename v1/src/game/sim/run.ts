// run.ts — roguelite "Harvest Run" model for Tommy Tomato v1.
//
// A run is a fixed, escalating gauntlet through all three bosses:
//   Act 1: rooms -> Old Tom · Act 2: rooms -> Scarecrow King · Act 3: rooms -> The Harvester
// Clear a room and you draft 1 of 3 boons; stacked boons are the build. Death
// ends the run (permadeath), but banked Sap funds permanent meta-progression
// between runs (see meta.ts).
//
// This module is pure data + helpers — Game.ts owns the run state machine and
// reads `RunMods` in its combat/derivation math.

import { DEFAULT_SPECIAL, specialById, consumableById, MAX_ITEMS } from "./items";

// ---------------------------------------------------------------------------
// Run modifiers — the accumulated effect of every boon taken this run. Game.ts
// folds these into its existing calcs (damage, max HP/stamina, i-frames, etc.).
// Neutral defaults mean "no boon" = vanilla balance.
// ---------------------------------------------------------------------------
export interface RunMods {
  damageMul: number; // melee damage multiplier
  maxHpBonus: number; // flat max-HP added
  maxStaminaBonus: number; // flat max-stamina added
  moveSpeedMul: number; // movement speed multiplier
  estusBonus: number; // extra heal charges
  lifestealFrac: number; // heal this fraction of melee damage dealt
  critBonus: number; // added crit chance (0..1)
  reachMul: number; // weapon reach multiplier
  thornsFrac: number; // reflect this fraction of contact damage taken
  regenPerSec: number; // passive HP per second
  dmgReductionFrac: number; // incoming damage scaled by (1 - this)
  lowHpDamageMul: number; // extra damage multiplier while below 40% HP
  sapMul: number; // Sap gain multiplier (feeds meta-progression)
  iframeBonus: number; // extra seconds of roll invulnerability
  specialChargeMul: number; // special-move charge-rate multiplier
  itemDropMul: number; // consumable drop-rate multiplier
}

export function defaultRunMods(): RunMods {
  return {
    damageMul: 1,
    maxHpBonus: 0,
    maxStaminaBonus: 0,
    moveSpeedMul: 1,
    estusBonus: 0,
    lifestealFrac: 0,
    critBonus: 0,
    reachMul: 1,
    thornsFrac: 0,
    regenPerSec: 0,
    dmgReductionFrac: 0,
    lowHpDamageMul: 1,
    sapMul: 1,
    iframeBonus: 0,
    specialChargeMul: 1,
    itemDropMul: 1,
  };
}

// ---------------------------------------------------------------------------
// Boons
// ---------------------------------------------------------------------------
export type Rarity = "common" | "uncommon" | "rare";

export interface Boon {
  id: string;
  name: string;
  desc: string;
  rarity: Rarity;
  /** Some boons are one-time picks; others can stack across drafts. */
  stackable: boolean;
  /** Fold this boon's effect into the run's modifiers. */
  apply: (m: RunMods) => void;
}

export const BOONS: Boon[] = [
  // ---- common ----
  { id: "ripe_flesh", name: "Ripe Flesh", desc: "+25 Max HP", rarity: "common", stackable: true,
    apply: (m) => { m.maxHpBonus += 25; } },
  { id: "second_wind", name: "Second Wind", desc: "+20 Max Stamina", rarity: "common", stackable: true,
    apply: (m) => { m.maxStaminaBonus += 20; } },
  { id: "sharpened_thorn", name: "Sharpened Thorn", desc: "+15% damage", rarity: "common", stackable: true,
    apply: (m) => { m.damageMul *= 1.15; } },
  { id: "quick_roots", name: "Quick Roots", desc: "+8% move speed", rarity: "common", stackable: true,
    apply: (m) => { m.moveSpeedMul *= 1.08; } },
  { id: "deep_pantry", name: "Deep Pantry", desc: "+1 Watering-Can heal", rarity: "common", stackable: true,
    apply: (m) => { m.estusBonus += 1; } },

  // ---- uncommon ----
  { id: "bloodroot", name: "Bloodroot", desc: "Heal 6% of melee damage dealt", rarity: "uncommon", stackable: true,
    apply: (m) => { m.lifestealFrac += 0.06; } },
  { id: "nightshade", name: "Nightshade", desc: "+12% critical chance", rarity: "uncommon", stackable: true,
    apply: (m) => { m.critBonus += 0.12; } },
  { id: "long_vine", name: "Long Vine", desc: "+20% weapon reach", rarity: "uncommon", stackable: false,
    apply: (m) => { m.reachMul *= 1.2; } },
  { id: "briar_skin", name: "Briar Skin", desc: "Reflect 30% of contact damage", rarity: "uncommon", stackable: true,
    apply: (m) => { m.thornsFrac += 0.3; } },
  { id: "photosynthesis", name: "Photosynthesis", desc: "Regenerate 1 HP/sec", rarity: "uncommon", stackable: true,
    apply: (m) => { m.regenPerSec += 1; } },
  { id: "phantom_roll", name: "Phantom Roll", desc: "+0.12s dodge invulnerability", rarity: "uncommon", stackable: true,
    apply: (m) => { m.iframeBonus += 0.12; } },
  { id: "bountiful_harvest", name: "Bountiful Harvest", desc: "Special charges 30% faster", rarity: "uncommon", stackable: true,
    apply: (m) => { m.specialChargeMul *= 1.3; } },
  { id: "foragers_eye", name: "Forager's Eye", desc: "Find 60% more attack items", rarity: "uncommon", stackable: true,
    apply: (m) => { m.itemDropMul *= 1.6; } },

  // ---- rare ----
  { id: "overripe", name: "Overripe", desc: "+45% damage, but -15% Max HP", rarity: "rare", stackable: false,
    apply: (m) => { m.damageMul *= 1.45; m.maxHpBonus -= 14; } },
  { id: "adrenal_sap", name: "Adrenal Sap", desc: "+30% damage while below 40% HP", rarity: "rare", stackable: false,
    apply: (m) => { m.lowHpDamageMul *= 1.3; } },
  { id: "iron_rind", name: "Iron Rind", desc: "Take 20% less damage", rarity: "rare", stackable: true,
    apply: (m) => { m.dmgReductionFrac = 1 - (1 - m.dmgReductionFrac) * 0.8; } },
  { id: "harvesters_favor", name: "Harvester's Favor", desc: "+50% Sap (funds unlocks)", rarity: "rare", stackable: true,
    apply: (m) => { m.sapMul *= 1.5; } },
];

const BOON_BY_ID: Record<string, Boon> = Object.fromEntries(BOONS.map((b) => [b.id, b]));
export const boonById = (id: string): Boon | undefined => BOON_BY_ID[id];

// ---------------------------------------------------------------------------
// The gauntlet — fixed, escalating. `rooms` combat rooms then the act boss.
// `pool` is the biome set those rooms draw from; `enemyBudget` scales tension.
// ---------------------------------------------------------------------------
export interface ActDef {
  boss: string; // boss enemy id
  bossArea: string;
  bossName: string;
  rooms: number;
  biomes: string[];
  enemyBudget: number; // rough "threat points" per room, before run scaling
}

export const ACTS: ActDef[] = [
  { boss: "oldtom", bossArea: "sodden", bossName: "Old Tom, the First Fruit", rooms: 2, biomes: ["rows", "greenhouse"], enemyBudget: 18 },
  { boss: "king", bossArea: "kingarena", bossName: "The Scarecrow King", rooms: 2, biomes: ["greenhouse", "catacombs"], enemyBudget: 28 },
  { boss: "harvester", bossArea: "yard", bossName: "The Harvester", rooms: 2, biomes: ["catacombs", "rows"], enemyBudget: 40 },
];

/** Total rooms + bosses in a full run, for progress UI. */
export const RUN_LENGTH = ACTS.reduce((n, a) => n + a.rooms + 1, 0);

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------
export interface RunState {
  act: number; // 0..2
  room: number; // room index within the current act (0..rooms-1); === rooms means "at boss"
  cleared: number; // total encounters cleared this run (progress)
  mods: RunMods;
  boonIds: string[]; // boons taken, in order
  sapBanked: number; // Sap earned this run (goes to meta on death/win)
  seed: number;
  special: { id: string; charge: number }; // active ability + charge meter
  items: string[]; // consumable inventory (max MAX_ITEMS)
}

export function newRun(seed: number, specialId: string = DEFAULT_SPECIAL): RunState {
  return {
    act: 0, room: 0, cleared: 0, mods: defaultRunMods(), boonIds: [], sapBanked: 0, seed,
    special: { id: specialId, charge: 0 }, items: [],
  };
}

// ---------------------------------------------------------------------------
// Special-move charge + consumable inventory
// ---------------------------------------------------------------------------
/** Add charge from damage dealt (scaled by boons). True if it just filled. */
export function addSpecialCharge(run: RunState, dmgDealt: number): boolean {
  const def = specialById(run.special.id);
  if (!def) return false;
  const was = run.special.charge >= def.chargeMax;
  run.special.charge = Math.min(def.chargeMax, run.special.charge + dmgDealt * run.mods.specialChargeMul);
  return !was && run.special.charge >= def.chargeMax;
}
export function specialReady(run: RunState): boolean {
  const def = specialById(run.special.id);
  return !!def && run.special.charge >= def.chargeMax;
}
export function specialChargePct(run: RunState): number {
  const def = specialById(run.special.id);
  return def ? Math.max(0, Math.min(1, run.special.charge / def.chargeMax)) : 0;
}
/** Spend a full meter; returns the fired special def, or null if not ready. */
export function fireSpecial(run: RunState) {
  const def = specialById(run.special.id);
  if (!def || run.special.charge < def.chargeMax) return null;
  run.special.charge = 0;
  return def;
}
/** Pick up a consumable; false if the bag is full. */
export function addItem(run: RunState, id: string): boolean {
  if (!consumableById(id) || run.items.length >= MAX_ITEMS) return false;
  run.items.push(id);
  return true;
}
/** Use (consume) the oldest held item; returns its def, or null if empty. */
export function useItem(run: RunState) {
  const id = run.items.shift();
  return id ? consumableById(id) ?? null : null;
}

/** Apply a boon to the run (records it and folds in its modifier). */
export function takeBoon(run: RunState, id: string): void {
  const b = boonById(id);
  if (!b) return;
  run.boonIds.push(id);
  b.apply(run.mods);
}

// ---------------------------------------------------------------------------
// Boon draft — offer `count` distinct choices, weighted by rarity, excluding
// non-stackable boons already taken. `rng()` returns [0,1).
// ---------------------------------------------------------------------------
const RARITY_WEIGHT: Record<Rarity, number> = { common: 6, uncommon: 3, rare: 1.2 };

export function rollBoonChoices(
  run: RunState,
  rng: () => number,
  count = 3,
  unlockedIds?: Set<string>
): Boon[] {
  const taken = new Set(run.boonIds);
  let pool = BOONS.filter((b) => {
    if (!b.stackable && taken.has(b.id)) return false;
    if (unlockedIds && !unlockedIds.has(b.id)) return false;
    return true;
  });

  const chosen: Boon[] = [];
  while (chosen.length < count && pool.length > 0) {
    const total = pool.reduce((s, b) => s + RARITY_WEIGHT[b.rarity], 0);
    let r = rng() * total;
    let pick = pool[pool.length - 1];
    for (const b of pool) {
      r -= RARITY_WEIGHT[b.rarity];
      if (r <= 0) { pick = b; break; }
    }
    chosen.push(pick);
    pool = pool.filter((b) => b.id !== pick.id);
  }
  return chosen;
}

/** Per-room enemy scaling: tension grows with act and rooms cleared. */
export function roomThreat(run: RunState): number {
  const act = ACTS[run.act];
  const base = act ? act.enemyBudget : 18;
  return Math.round(base * (1 + run.cleared * 0.06));
}
