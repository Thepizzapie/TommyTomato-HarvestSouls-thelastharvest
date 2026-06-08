// items.ts — special moves + one-off attack pickups for Harvest Run.
//
// Catalogs + types only. Game.ts implements the actual hit / projectile / AoE
// behavior keyed by `kind`:
//   - SPECIALS charge as you deal damage; fire at full meter (key C).
//   - CONSUMABLES are found mid-run, held (max MAX_ITEMS), used once (key X).

export type SpecialKind = "nova" | "dash" | "volley" | "field";

export interface SpecialDef {
  id: string;
  name: string;
  desc: string;
  kind: SpecialKind;
  /** Damage dealt needed to fill the charge meter. */
  chargeMax: number;
  /** Damage multiplier vs the player's base attack. */
  power: number;
  radius?: number; // nova / field / (caltrops-like)
  range?: number; // dash distance
  count?: number; // volley projectile count
  duration?: number; // field lifetime (s)
}

export const SPECIALS: SpecialDef[] = [
  { id: "pulp_nova", name: "Pulp Nova", desc: "Pulp erupts around you — heavy hit + knockback.", kind: "nova", chargeMax: 240, power: 3.2, radius: 150 },
  { id: "vine_lash", name: "Vine Lash", desc: "Dash forward, skewering everything in a line.", kind: "dash", chargeMax: 200, power: 2.6, range: 260 },
  { id: "seed_volley", name: "Seed Volley", desc: "Fire a fan of seven piercing seeds.", kind: "volley", chargeMax: 220, power: 1.4, count: 7 },
  { id: "bramble_field", name: "Bramble Field", desc: "Raise a field of thorns that grinds foes down.", kind: "field", chargeMax: 260, power: 0.6, radius: 130, duration: 4 },
];

export const DEFAULT_SPECIAL = "pulp_nova";

export type ConsumableKind = "bomb" | "poison" | "caltrops" | "buff" | "snare";

export interface ConsumableDef {
  id: string;
  name: string;
  desc: string;
  kind: ConsumableKind;
  /** Damage multiplier vs base attack (or buff strength for "buff"). */
  power: number;
  radius?: number;
  duration?: number;
}

export const CONSUMABLES: ConsumableDef[] = [
  { id: "pulp_bomb", name: "Pulp Bomb", desc: "Lob it — big explosion on impact.", kind: "bomb", power: 5, radius: 120 },
  { id: "spore_jar", name: "Spore Jar", desc: "Shatters into a lingering poison cloud.", kind: "poison", power: 1.2, radius: 110, duration: 4 },
  { id: "thorn_caltrops", name: "Thorn Caltrops", desc: "Instant ring of spikes around you.", kind: "caltrops", power: 3, radius: 120 },
  { id: "pepper_flask", name: "Ghost-Pepper Flask", desc: "Briefly +50% damage and move speed.", kind: "buff", power: 1.5, duration: 6 },
  { id: "honey_snare", name: "Honey Snare", desc: "Throw — roots foes in sticky honey.", kind: "snare", power: 0.5, radius: 120, duration: 3 },
];

/** Max consumables carried at once. */
export const MAX_ITEMS = 3;

const SPECIAL_BY_ID: Record<string, SpecialDef> = Object.fromEntries(SPECIALS.map((s) => [s.id, s]));
const CONSUMABLE_BY_ID: Record<string, ConsumableDef> = Object.fromEntries(CONSUMABLES.map((c) => [c.id, c]));
export const specialById = (id: string): SpecialDef | undefined => SPECIAL_BY_ID[id];
export const consumableById = (id: string): ConsumableDef | undefined => CONSUMABLE_BY_ID[id];

/** Consumable ids that can drop from a normal kill (bosses always drop). */
export const DROP_TABLE: string[] = ["pulp_bomb", "spore_jar", "thorn_caltrops", "pepper_flask", "honey_snare"];
