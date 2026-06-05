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

/**
 * Generate a fresh 4-letter room code (host side).
 *
 * Uses a CSPRNG (`crypto.getRandomValues`), not `Math.random()`: the room code
 * is the only thing gating who can join a session, so it must not be predictable
 * from PRNG state. The 32-char alphabet is a power of two, so `% length` carries
 * no modulo bias.
 */
export function makeRoomCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += ROOM_ALPHABET[buf[i] % ROOM_ALPHABET.length];
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

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------
//
// Everything arriving over a DataConnection is from an UNTRUSTED peer — a static
// P2P game has no server to vouch for it. `validateNetMsg` is the single trust
// boundary: it shape-checks the discriminated union and clamps every numeric
// field to a sane range, so a crafted packet (`amount: Infinity`, a 100k-char
// name, a 50k-entity snapshot) can't crash the sim, corrupt world state with
// NaN coordinates, or wedge the renderer. Consumers should treat a `null`
// return as "drop this packet" and only ever act on the validated object.

const isFiniteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const clampNum = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

const TINT_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * True for code points that corrupt Canvas/DOM text layout and are never
 * legitimate in a display name: C0/C1 controls, zero-width + bidi marks,
 * bidi overrides, invisible format chars, and the BOM. Tested by code point
 * (not a regex literal) so the source stays pure-ASCII.
 */
function isUnsafeNameChar(c: number): boolean {
  return (
    c <= 0x1f || // C0 controls
    (c >= 0x7f && c <= 0x9f) || // DEL + C1 controls
    (c >= 0x200b && c <= 0x200f) || // zero-width + LRM/RLM
    (c >= 0x202a && c <= 0x202e) || // bidi embeddings/overrides
    (c >= 0x2060 && c <= 0x206f) || // word joiner + invisible/deprecated format
    c === 0xfeff // zero-width no-break space / BOM
  );
}

/** Clamp a peer-supplied display name: length-capped, control/bidi chars stripped. */
export function sanitizeName(v: unknown): string {
  const raw = String(v ?? "").slice(0, 16);
  let out = "";
  for (const ch of raw) {
    if (!isUnsafeNameChar(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out.trim() || "Phantom";
}

/** Clamp a peer-supplied tint to a strict #rrggbb, or a safe default. */
export function sanitizeTint(v: unknown): string {
  return typeof v === "string" && TINT_RE.test(v) ? v : "#d83a2e";
}

/** Max replicated entities/projectiles in a single world snapshot (DoS guard). */
const MAX_SNAP_ITEMS = 300;

/**
 * Validate + normalize an inbound wire payload. Returns a safe `NetMsg`, or
 * `null` if the payload is malformed/out-of-bounds and should be dropped.
 */
export function validateNetMsg(data: unknown): NetMsg | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case "ps": {
      const p = m.p as Record<string, unknown> | undefined;
      if (!p || typeof p.id !== "string") return null;
      if (
        !isFiniteNum(p.x) ||
        !isFiniteNum(p.y) ||
        !isFiniteNum(p.facing) ||
        !isFiniteNum(p.hp) ||
        !isFiniteNum(p.maxHp)
      )
        return null;
      const snap: PlayerSnap = {
        id: p.id.slice(0, 64),
        name: sanitizeName(p.name),
        tint: sanitizeTint(p.tint),
        x: p.x,
        y: p.y,
        facing: p.facing,
        hp: clampNum(p.hp, 0, 1e6),
        maxHp: clampNum(p.maxHp, 1, 1e6),
        animState:
          typeof p.animState === "string" ? p.animState.slice(0, 32) : "idle",
        dead: !!p.dead,
        weapon: typeof p.weapon === "string" ? p.weapon.slice(0, 32) : undefined,
      };
      return { t: "ps", p: snap };
    }
    case "edmg": {
      if (!isFiniteNum(m.enemyId) || !isFiniteNum(m.amount)) return null;
      if (!isFiniteNum(m.kx) || !isFiniteNum(m.ky)) return null;
      if (m.amount <= 0 || m.amount > 9999) return null;
      return {
        t: "edmg",
        enemyId: m.enemyId | 0,
        amount: clampNum(m.amount, 1, 9999),
        kx: clampNum(m.kx, -2000, 2000),
        ky: clampNum(m.ky, -2000, 2000),
        poise: isFiniteNum(m.poise) ? clampNum(m.poise, 0, 500) : undefined,
      };
    }
    case "world": {
      const s = m.s as Record<string, unknown> | undefined;
      if (!s || typeof s.area !== "string") return null;
      if (!Array.isArray(s.entities) || !Array.isArray(s.projectiles)) return null;
      if (
        s.entities.length > MAX_SNAP_ITEMS ||
        s.projectiles.length > MAX_SNAP_ITEMS
      )
        return null;
      // host -> client, host-authoritative: shape is trusted past the size cap.
      return { t: "world", s: m.s as WorldSnap };
    }
    case "area":
      return typeof m.area === "string"
        ? { t: "area", area: m.area.slice(0, 64) }
        : null;
    case "sap":
      return typeof m.pid === "string" && isFiniteNum(m.amount)
        ? { t: "sap", pid: m.pid.slice(0, 64), amount: clampNum(m.amount, 0, 1e7) }
        : null;
    case "bye":
      return typeof m.id === "string" ? { t: "bye", id: m.id.slice(0, 64) } : null;
    default:
      return null;
  }
}
