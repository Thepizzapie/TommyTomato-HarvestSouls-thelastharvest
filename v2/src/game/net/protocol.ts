// Wire protocol for Tommy Tomato v2 co-op.
//
// This module is deliberately decoupled from the sim/renderer: it only knows the
// *shape* of what crosses the wire. The sim and renderer own the meaning of the
// string-typed fields (e.g. `animState`, `weapon`, `kind`, `area`). Keeping the
// transport ignorant of sim internals lets the netcode and the gameplay code
// evolve independently.
//
// Topology (mirrors v1): the host is the hub. Clients connect only to the host.
// - Each client sends its own `PlayerSnap` ("ps") upstream to the host.
// - The host relays every "ps" it receives to all *other* clients, so every
//   peer sees every other peer (a mesh emulated through the host).
// - The host is authoritative for world state and broadcasts a `WorldSnap`
//   ("world") to all clients.
// - Clients report damage they dealt to enemies via "edmg"; the host applies it.

/** PeerJS id prefix. The full host id is `PREFIX + roomCode`. */
export const PREFIX = "tommytomato-v2-";

/** Room-code alphabet: no 0/O/1/I to avoid ambiguity when typed by hand. */
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Generate a fresh 4-letter room code (host side). */
export function makeRoomCode(): string {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return s;
}

// ---------------------------------------------------------------------------
// Snapshot shapes
// ---------------------------------------------------------------------------

/**
 * A single player's replicated state. Sent by each client (~20Hz) and relayed by
 * the host to the other clients. `animState` is an opaque string owned by the
 * sim/renderer (e.g. "idle" | "run" | "roll" | "attack" | ...).
 */
export interface PlayerSnap {
  id: string;
  name: string;
  tint: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  animState: string;
  dead: boolean;
  /** Optional equipped weapon; opaque string owned by the sim/renderer. */
  weapon?: string;
}

/**
 * One non-player entity in the host's authoritative world (enemy, NPC, etc).
 * `kind` and `animState` are opaque strings the sim/renderer interpret.
 */
export interface EntitySnap {
  id: number;
  kind: string;
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  animState: string;
  dead: boolean;
}

/** A projectile in flight, replicated host -> clients. */
export interface ProjectileSnap {
  id: number;
  x: number;
  y: number;
  /** Travel/aim angle in radians. */
  facing: number;
  /** Collision radius. */
  r: number;
  /** True if it can hurt players (enemy fire), false if player-owned. */
  hostile: boolean;
  /** Optional visual kind, opaque to the transport. */
  kind?: string;
}

/** Boss bar / state, replicated host -> clients. `null` when no boss is active. */
export interface BossSnap {
  id: number;
  name: string;
  /** Normalized health, 0..1, convenient for a health bar. */
  hp01: number;
  active: boolean;
  /** Optional phase indicator, opaque to the transport. */
  phase?: number;
}

/**
 * The host's authoritative world snapshot, broadcast host -> clients (~15Hz).
 * Players are NOT included here — those travel as individual `PlayerSnap`s so
 * the host can relay them verbatim and per-player cadence stays independent of
 * the world tick.
 */
export interface WorldSnap {
  /** Current area id the host is simulating; opaque string. */
  area: string;
  /** Monotonic host sim time (ms or ticks); useful for interpolation. */
  time: number;
  entities: EntitySnap[];
  projectiles: ProjectileSnap[];
  boss: BossSnap | null;
}

// ---------------------------------------------------------------------------
// Message union
// ---------------------------------------------------------------------------

/** Player state. Client -> host upstream; host relays to other clients. */
export interface PsMsg {
  t: "ps";
  p: PlayerSnap;
}

/** Authoritative world snapshot. Host -> clients. */
export interface WorldMsg {
  t: "world";
  s: WorldSnap;
}

/**
 * Damage a client dealt to an enemy. Client -> host. The host is authoritative
 * and decides whether/how much actually lands.
 */
export interface EdmgMsg {
  t: "edmg";
  /** Target entity id (matches `EntitySnap.id`). */
  enemyId: number;
  amount: number;
  /** Knockback impulse x/y. */
  kx: number;
  ky: number;
  /** Optional poise damage. */
  poise?: number;
}

/** Area transition. Host -> clients. */
export interface AreaMsg {
  t: "area";
  area: string;
}

/** "You earned sap" award. Host -> a specific player. */
export interface SapMsg {
  t: "sap";
  /** Recipient player id. */
  pid: string;
  amount: number;
}

/** A peer is leaving / was dropped. Either direction. */
export interface ByeMsg {
  t: "bye";
  id: string;
}

/**
 * Everything that can cross the wire. Discriminated on `t` so consumers can
 * `switch (msg.t)` with full type narrowing.
 */
export type NetMsg =
  | PsMsg
  | WorldMsg
  | EdmgMsg
  | AreaMsg
  | SapMsg
  | ByeMsg;

/** A connected participant (self + remote peers), for lobby/roster UI. */
export interface RosterEntry {
  id: string;
  name: string;
  tint: string;
}
