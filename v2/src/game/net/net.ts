"use client";
// PeerJS host/join transport for Tommy Tomato v2 co-op.
//
// Fits a static deploy: signaling + STUN are handled by the free PeerJS cloud,
// so there is no server of our own. The host is the hub — clients connect only
// to the host. The host relays player snapshots between clients (a mesh emulated
// through the host) and is authoritative for world state.
//
// SSR-safe: `peerjs` is imported dynamically inside `init()`, so nothing touches
// `window`/`navigator` at module load. Safe to import from a server component
// tree as long as `init()` only runs in the browser.

import type { DataConnection, Peer as PeerType } from "peerjs";
import { PREFIX, makeRoomCode, validateNetMsg, sanitizeName, sanitizeTint } from "./protocol";
import type { NetMsg, RosterEntry } from "./protocol";

export type { NetMsg, RosterEntry } from "./protocol";
export { PREFIX, makeRoomCode } from "./protocol";

export type NetMode = "host" | "client";

export interface NetEvents {
  /** A message arrived from peer `fromId`. */
  onMessage: (fromId: string, msg: NetMsg) => void;
  /** The roster (self + connected peers) changed. */
  onRoster: (roster: RosterEntry[]) => void;
  /** Human-readable status update for the lobby UI. */
  onStatus: (status: string) => void;
  /** A recoverable/fatal error to surface to the player. */
  onError: (err: string) => void;
  /** Transport is ready: host room is live, or client reached the host. */
  onOpen: () => void;
}

/** Metadata a client attaches to its connection so the host learns its identity. */
interface ConnMeta {
  name?: string;
  tint?: string;
}

export class Net {
  readonly mode: NetMode;
  peer: PeerType | null = null;
  selfId = "";
  roomCode: string;
  name: string;
  tint: string;

  /** Open data connections, keyed by remote peer id. */
  private conns = new Map<string, DataConnection>();
  /** Identity of each connected remote peer, keyed by peer id. */
  private peerInfo = new Map<string, { name: string; tint: string }>();

  private ev: NetEvents;
  private opened = false;
  private destroyed = false;

  constructor(
    mode: NetMode,
    name: string,
    tint: string,
    events: NetEvents,
    roomCode?: string,
  ) {
    this.mode = mode;
    this.name = name;
    this.tint = tint;
    this.ev = events;
    // Host mints a code if none given; client must be handed one to join.
    this.roomCode = (roomCode || (mode === "host" ? makeRoomCode() : "")).toUpperCase();
  }

  /** Boot the PeerJS peer and wire up signaling. Browser-only. */
  async init(): Promise<void> {
    const { Peer } = await import("peerjs");
    if (this.destroyed) return;

    // Host claims a deterministic id from the room code so clients can find it.
    // Clients use a random id; they only need to reach the host.
    const id =
      this.mode === "host"
        ? PREFIX + this.roomCode
        : PREFIX + "guest-" + Math.random().toString(36).slice(2, 9);

    this.peer = new Peer(id, { debug: 1 });
    this.selfId = id;

    this.peer.on("open", (pid: string) => {
      if (this.destroyed) return;
      this.selfId = pid;
      if (this.mode === "host") {
        this.opened = true;
        this.ev.onStatus("Room live. Share the code.");
        this.ev.onOpen();
        this.emitRoster();
      } else {
        this.connectToHost();
      }
    });

    this.peer.on("error", (err: { type?: string; message?: string }) => {
      if (this.destroyed) return;
      const type = err?.type || "";
      if (type === "peer-unavailable") {
        // Client tried to reach a host id that isn't registered.
        this.ev.onError("No room found with that code. Check it and retry.");
      } else if (type === "unavailable-id") {
        // Host's chosen id (the room code) is already taken on the broker.
        this.ev.onError("That room code is taken. Try another.");
      } else {
        this.ev.onError("Connection trouble: " + (err?.message || type || "unknown"));
      }
    });

    if (this.mode === "host") {
      this.peer.on("connection", (conn: DataConnection) => {
        this.setupConn(conn, true);
      });
    }
  }

  private connectToHost(): void {
    if (!this.peer || this.destroyed) return;
    this.ev.onStatus("Reaching into the host's world...");
    const conn = this.peer.connect(PREFIX + this.roomCode, {
      // Unreliable/unordered: snapshots are fire-and-forget; latest wins.
      reliable: false,
      metadata: { name: this.name, tint: this.tint } satisfies ConnMeta,
    });
    this.setupConn(conn, false);
  }

  /**
   * Wire up a single connection.
   * @param isHostSide true when *we* are the host accepting an inbound client.
   */
  private setupConn(conn: DataConnection, isHostSide: boolean): void {
    conn.on("open", () => {
      if (this.destroyed) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        return;
      }
      this.conns.set(conn.peer, conn);

      if (isHostSide) {
        // Connection metadata is peer-supplied and untrusted — sanitize it.
        const meta = (conn.metadata || {}) as ConnMeta;
        this.peerInfo.set(conn.peer, {
          name: sanitizeName(meta.name),
          tint: sanitizeTint(meta.tint),
        });
        this.ev.onStatus("A tomato was summoned.");
      } else {
        // We (the client) just reached the host.
        if (!this.opened) {
          this.opened = true;
          this.ev.onStatus("Summoned into the host's world.");
          this.ev.onOpen();
        }
      }
      this.emitRoster();
    });

    conn.on("data", (data: unknown) => {
      if (this.destroyed) return;
      // Single trust boundary: validate + clamp every inbound packet from this
      // (untrusted) peer before it reaches the relay or the sim. Malformed or
      // out-of-bounds payloads are dropped.
      const msg = validateNetMsg(data);
      if (!msg) return;

      // Host is the hub: relay player snapshots to every *other* client so the
      // mesh is emulated through the host. World/area/sap/etc. are authored by
      // the host and are not relayed (clients don't originate them).
      if (isHostSide && msg.t === "ps") {
        for (const [pid, c] of this.conns) {
          if (pid !== conn.peer) this.safeSend(c, msg);
        }
      }

      this.ev.onMessage(conn.peer, msg);
    });

    conn.on("close", () => {
      if (this.destroyed) return;
      this.conns.delete(conn.peer);
      this.peerInfo.delete(conn.peer);
      // Synthesize a "bye" so the sim can despawn the peer's avatar.
      this.ev.onMessage(conn.peer, { t: "bye", id: conn.peer });
      this.emitRoster();
      if (!isHostSide) {
        // Losing our one connection (to the host) ends the session.
        this.ev.onError("Lost the host. The world dissolves.");
      }
    });

    // Connection-level errors are non-fatal here; the broker-level "error"
    // handler on the peer surfaces the cases players care about.
    conn.on("error", () => {
      /* ignore */
    });
  }

  private safeSend(conn: DataConnection, msg: NetMsg): void {
    try {
      if (conn.open) conn.send(msg);
    } catch {
      /* drop: a transient send failure shouldn't crash the game loop */
    }
  }

  /**
   * Broadcast a message. Host -> all connected clients; client -> the host
   * (its only connection). Fire-and-forget; safe to call every tick.
   */
  send = (msg: NetMsg): void => {
    for (const conn of this.conns.values()) this.safeSend(conn, msg);
  };

  /** Self first, then connected peers — convenient for lobby rendering. */
  getRoster = (): RosterEntry[] => {
    const list: RosterEntry[] = [
      { id: this.selfId, name: this.name, tint: this.tint },
    ];
    for (const [pid, info] of this.peerInfo) {
      list.push({ id: pid, name: info.name, tint: info.tint });
    }
    return list;
  };

  private emitRoster(): void {
    this.ev.onRoster(this.getRoster());
  }

  /** Tear everything down. Idempotent. */
  destroy(): void {
    this.destroyed = true;
    for (const c of this.conns.values()) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.peerInfo.clear();
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
  }
}
