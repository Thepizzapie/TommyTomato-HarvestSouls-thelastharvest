import type { EnemyKind, WeaponKind } from "../core/art";

export type Mode = "solo" | "host" | "client";

export interface RosterEntry {
  id: string;
  name: string;
  tint: string;
}

// ---- Net protocol ----
export type NetMsg =
  | { t: "ps"; p: PlayerSnap } // a player's state (broadcast)
  | { t: "snap"; s: HostSnap } // host -> clients full world snapshot
  | { t: "edmg"; id: number; amt: number; kx: number; ky: number; poise?: number } // client -> host
  | { t: "area"; area: string } // host -> clients area change
  | { t: "sap"; pid: string; amt: number } // host -> a player: you earned sap
  | { t: "fx"; kind: string; x: number; y: number } // cosmetic effect broadcast
  | { t: "bye"; id: string };

export interface PlayerSnap {
  id: string;
  name: string;
  tint: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  moving: boolean;
  rolling: boolean;
  attacking: number;
  blocking: boolean;
  invuln: boolean;
  dead: boolean;
  walkPhase: number;
  weapon?: WeaponKind;
}

export interface EnemySnap {
  id: number;
  kind: EnemyKind;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  phase: number;
  attacking: number;
  windup: boolean;
  hurt: number;
  big: number;
  dead?: boolean;
}

export interface ProjSnap {
  id: number;
  x: number;
  y: number;
  r: number;
  hostile: boolean;
}

export interface HostSnap {
  area: string;
  time: number;
  enemies: EnemySnap[];
  projectiles: ProjSnap[];
  boss: { name: string; hp01: number; active: boolean } | null;
}

export interface NetHooks {
  mode: Mode;
  selfId: string;
  name: string;
  tint: string;
  send: (msg: NetMsg) => void;
  getRoster: () => RosterEntry[];
}

export interface SaveData {
  name: string;
  tint: string;
  stats: { vigor: number; strength: number; vitality: number; agility: number };
  sap: number;
  estusMax: number;
  area: string;
  bonfireArea: string;
  bossesDead: string[];
  playtime: number;
}
