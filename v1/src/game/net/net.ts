"use client";
// PeerJS host/join wrapper. Fits a static deploy: signaling + STUN handled by
// the free PeerJS cloud. Host is the hub; clients connect only to the host, and
// the host relays peer-to-peer player snapshots so everyone sees everyone.

import type { DataConnection, Peer as PeerType } from "peerjs";
import type { NetMsg, RosterEntry } from "../sim/types";

const PREFIX = "tommytomato-harvest-";

export type NetMode = "host" | "client";

export interface NetEvents {
  onMessage: (fromId: string, msg: NetMsg) => void;
  onRoster: (roster: RosterEntry[]) => void;
  onStatus: (status: string) => void;
  onError: (err: string) => void;
  onOpen: () => void; // ready to start the game
}

export function makeRoomCode(): string {
  // CSPRNG, not Math.random(): the code is the only thing gating who can join a
  // session, so it must not be predictable/brute-forceable from PRNG state. The
  // 32-char alphabet is a power of two, so `% length` carries no modulo bias.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[buf[i] % alphabet.length];
  return s;
}

export class Net {
  mode: NetMode;
  peer: PeerType | null = null;
  selfId = "";
  roomCode = "";
  name: string;
  tint: string;
  conns = new Map<string, DataConnection>();
  peerInfo = new Map<string, { name: string; tint: string }>();
  ev: NetEvents;
  private opened = false;

  constructor(mode: NetMode, name: string, tint: string, ev: NetEvents, roomCode?: string) {
    this.mode = mode;
    this.name = name;
    this.tint = tint;
    this.ev = ev;
    this.roomCode = roomCode || makeRoomCode();
  }

  async init() {
    const { Peer } = await import("peerjs");
    const id =
      this.mode === "host"
        ? PREFIX + this.roomCode
        : PREFIX + "guest-" + Math.random().toString(36).slice(2, 9);

    this.peer = new Peer(id, { debug: 1 });
    this.selfId = id;

    this.peer.on("open", (pid: string) => {
      this.selfId = pid;
      if (this.mode === "host") {
        this.ev.onStatus("Room live. Share the code.");
        this.opened = true;
        this.ev.onOpen();
        this.emitRoster();
      } else {
        this.connectToHost();
      }
    });

    this.peer.on("error", (err: any) => {
      const type = err?.type || "";
      if (type === "peer-unavailable") {
        this.ev.onError("No room found with that code. Check it and retry.");
      } else if (type === "unavailable-id") {
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

  private connectToHost() {
    if (!this.peer) return;
    this.ev.onStatus("Reaching into the host's world...");
    const conn = this.peer.connect(PREFIX + this.roomCode, {
      reliable: false,
      metadata: { name: this.name, tint: this.tint },
    });
    this.setupConn(conn, false);
  }

  private setupConn(conn: DataConnection, isHostSide: boolean) {
    conn.on("open", () => {
      this.conns.set(conn.peer, conn);
      if (isHostSide) {
        const meta = (conn.metadata || {}) as { name?: string; tint?: string };
        this.peerInfo.set(conn.peer, {
          name: meta.name || "Phantom",
          tint: meta.tint || "#d83a2e",
        });
        this.ev.onStatus("A tomato was summoned.");
      } else {
        // we (client) just connected to host
        if (!this.opened) {
          this.opened = true;
          this.ev.onStatus("Summoned into the host's world.");
          this.ev.onOpen();
        }
      }
      this.emitRoster();
    });

    conn.on("data", (data: any) => {
      const msg = data as NetMsg;
      // host relays player snapshots to all other clients
      if (isHostSide && msg && (msg as any).t === "ps") {
        for (const [pid, c] of this.conns) {
          if (pid !== conn.peer) this.safeSend(c, msg);
        }
      }
      this.ev.onMessage(conn.peer, msg);
    });

    conn.on("close", () => {
      this.conns.delete(conn.peer);
      this.peerInfo.delete(conn.peer);
      this.ev.onMessage(conn.peer, { t: "bye", id: conn.peer });
      this.emitRoster();
      if (!isHostSide) this.ev.onError("Lost the host. The world dissolves.");
    });
    conn.on("error", () => {});
  }

  private safeSend(conn: DataConnection, msg: NetMsg) {
    try {
      if (conn.open) conn.send(msg);
    } catch {}
  }

  // broadcast (host -> all clients; client -> host)
  send = (msg: NetMsg) => {
    for (const conn of this.conns.values()) this.safeSend(conn, msg);
  };

  getRoster = (): RosterEntry[] => {
    const list: RosterEntry[] = [{ id: this.selfId, name: this.name, tint: this.tint }];
    for (const [pid, info] of this.peerInfo)
      list.push({ id: pid, name: info.name, tint: info.tint });
    return list;
  };

  private emitRoster() {
    this.ev.onRoster(this.getRoster());
  }

  destroy() {
    for (const c of this.conns.values()) {
      try {
        c.close();
      } catch {}
    }
    this.conns.clear();
    try {
      this.peer?.destroy();
    } catch {}
    this.peer = null;
  }
}
