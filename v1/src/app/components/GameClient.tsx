"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Link from "next/link";
import { Game } from "@/game/sim/Game";
import { Net } from "@/game/net/net";
import type { NetMsg, RosterEntry, SaveData } from "@/game/sim/types";
import { PLAYER_TINTS } from "@/game/content/world";
import HeroSprite from "./HeroSprite";

type Mode = "solo" | "host" | "client";
type Phase = "setup" | "lobby" | "playing" | "error";

// Cultivar names, indexed against PLAYER_TINTS order. Flavor only — the engine
// just wants the hex tint.
const CULTIVARS = [
  "Classic Red",
  "Ochre Heirloom",
  "Green-Shouldered",
  "Heirloom Purple",
  "Frostbit Blue",
  "The Pale One",
];

export default function GameClient({ mode }: { mode: Mode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);
  const netRef = useRef<Net | null>(null);

  const [phase, setPhase] = useState<Phase>("setup");
  const [name, setName] = useState("Tommy");
  const [tint, setTint] = useState(PLAYER_TINTS[0]);
  const [roomCode, setRoomCode] = useState("");
  const [harvestMode, setHarvestMode] = useState(false); // roguelite "Harvest Run" toggle
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [hostCode, setHostCode] = useState("");
  const [muted, setMuted] = useState(false);
  const [hasSave, setHasSave] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);

  // load saved profile for defaults
  useEffect(() => {
    const s = Game.loadSave();
    if (s) {
      setHasSave(true);
      setName(s.name || "Tommy");
      setTint(s.tint || PLAYER_TINTS[0]);
    }
  }, []);

  const cleanup = useCallback(() => {
    gameRef.current?.destroy();
    gameRef.current = null;
    netRef.current?.destroy();
    netRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const startGame = useCallback(
    (theMode: Mode, net: Net | null, profile?: SaveData, harvest = false) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const selfId = net ? net.selfId : "solo";
      const game = new Game(
        canvas,
        {
          mode: theMode,
          selfId,
          name,
          tint,
          send: net ? net.send : () => {},
          getRoster: net ? net.getRoster : () => [{ id: "solo", name, tint }],
        },
        {}
      );
      gameRef.current = game;
      game.start(profile, harvest);
      if (process.env.NODE_ENV !== "production") (window as any).__tommy = game;
      setPhase("playing");
    },
    [name, tint]
  );

  // Harvest Run launches via the harvestMode toggle (applies to solo AND co-op).

  const beginSolo = (fresh: boolean) => {
    if (fresh) Game.clearSave();
    const profile = fresh ? undefined : Game.loadSave() || undefined;
    // stamp chosen identity onto the profile
    if (profile) {
      profile.name = name;
      profile.tint = tint;
    }
    startGame("solo", null, profile, harvestMode);
  };

  const beginNet = (theMode: "host" | "client") => {
    setError("");
    if (theMode === "client" && roomCode.trim().length < 3) {
      setError("Enter the host's 4-letter room code.");
      return;
    }
    const net = new Net(
      theMode,
      name,
      tint,
      {
        onMessage: (from: string, msg: NetMsg) =>
          gameRef.current?.handleNetMessage(from, msg),
        onRoster: setRoster,
        onStatus: setStatus,
        onError: (e) => {
          setError(e);
          setPhase("error");
        },
        onOpen: () => {
          if (theMode === "host") setHostCode(net.roomCode);
          // give the canvas a tick to lay out
          requestAnimationFrame(() => startGame(theMode, net, undefined, harvestMode));
        },
      },
      theMode === "client" ? roomCode.trim().toUpperCase() : undefined
    );
    netRef.current = net;
    if (theMode === "host") setHostCode(net.roomCode);
    setPhase("lobby");
    setStatus("Opening a rift in the soil...");
    net.init();
  };

  const toggleMute = () => {
    const on = gameRef.current?.toggleMute();
    setMuted(on === false);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(hostCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const cultivarName = CULTIVARS[PLAYER_TINTS.indexOf(tint)] ?? "Cultivar";

  const setupTitle =
    mode === "solo"
      ? "Face the Harvest Alone"
      : mode === "host"
      ? "Open a Garden"
      : "Be Summoned";

  return (
    <div className="game-root">
      <canvas ref={canvasRef} className="game-canvas" />

      {/* in-game chrome */}
      {phase === "playing" && (
        <div className="game-chrome">
          <button
            className="chrome-btn"
            onClick={() => setHelpOpen((v) => !v)}
            title="Controls"
            aria-pressed={helpOpen}
          >
            ? help
          </button>
          <button className="chrome-btn" onClick={toggleMute}>
            {muted ? "♪ off" : "♪ on"}
          </button>
          <Link href="/" className="chrome-btn chrome-btn--flee" title="Abandon run">
            ✕ flee
          </Link>
        </div>
      )}

      {/* host room banner */}
      {phase === "playing" && mode === "host" && hostCode && bannerOpen && (
        <div className="room-banner">
          <span className="smallcaps">Room</span>
          <strong className="room-code">{hostCode}</strong>
          <button className="chrome-btn" onClick={copyCode}>
            {copied ? "copied!" : "copy"}
          </button>
          <span className="room-banner__count">
            {roster.length} tomato{roster.length === 1 ? "" : "es"} in the rows
          </span>
          <button
            className="chrome-btn"
            onClick={() => setBannerOpen(false)}
            aria-label="Hide room banner"
          >
            hide
          </button>
        </div>
      )}

      {/* re-open the room banner once hidden */}
      {phase === "playing" && mode === "host" && hostCode && !bannerOpen && (
        <button
          className="room-reopen chrome-btn"
          onClick={() => setBannerOpen(true)}
        >
          ⌂ room {hostCode}
        </button>
      )}

      {/* in-game help overlay (React chrome — the engine owns the live P pause) */}
      {phase === "playing" && helpOpen && (
        <div className="help-overlay" onClick={() => setHelpOpen(false)}>
          <div className="panel help-card" onClick={(e) => e.stopPropagation()}>
            <p className="smallcaps">Quick reference</p>
            <h2 className="setup-title crest">How to Survive</h2>
            <ul className="help-list">
              <li><span className="key key--wide">WASD</span> move · <span className="key key--wide">MOUSE</span> aim</li>
              <li><span className="key">LMB</span> light · <span className="key">F</span> heavy · <span className="key key--wide">SPACE</span> roll</li>
              <li><span className="key">RMB</span> guard — time it for a <b className="sap">parry → riposte</b></li>
              <li>hit from behind for a <b className="sap">backstab</b></li>
              <li><span className="key">TAB</span>/<span className="key">Q</span> lock-on · <span className="key">1</span><span className="key">2</span><span className="key">3</span><span className="key">4</span> weapons</li>
              <li><span className="key">R</span>/<span className="key">H</span> heal · <span className="key">E</span> rest &amp; charms · <span className="key">P</span> pause</li>
            </ul>
            <div className="setup-actions">
              <button className="btn" onClick={() => setHelpOpen(false)}>
                Back to it
              </button>
              <Link href="/controls" className="btn">
                Full controls
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* setup overlay */}
      {phase === "setup" && (
        <div className="overlay">
          <div className="panel setup rise">
            <p className="smallcaps">Tommy Tomato · Harvest Souls</p>
            <h1 className="setup-title crest">{setupTitle}</h1>

            <div className="setup-grid">
              <div className="setup-fields">
                <label className="lbl" htmlFor="fruit-name">
                  The name of this fruit
                </label>
                <input
                  id="fruit-name"
                  className="field"
                  value={name}
                  maxLength={14}
                  onChange={(e) => setName(e.target.value)}
                />

                <label className="lbl">Cultivar</label>
                <div className="tints">
                  {PLAYER_TINTS.map((c, i) => (
                    <button
                      key={c}
                      className={"tint " + (tint === c ? "tint--on" : "")}
                      style={{ background: c }}
                      onClick={() => setTint(c)}
                      aria-label={CULTIVARS[i] ?? "cultivar"}
                      aria-pressed={tint === c}
                      title={CULTIVARS[i]}
                    />
                  ))}
                </div>
                <p className="cultivar-name">{cultivarName}</p>

                {mode === "client" && (
                  <>
                    <label className="lbl" htmlFor="room-code">
                      Host&rsquo;s room code
                    </label>
                    <input
                      id="room-code"
                      className="field field--code"
                      value={roomCode}
                      maxLength={4}
                      placeholder="ABCD"
                      onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                    />
                  </>
                )}
              </div>

              <div className="setup-preview" aria-hidden>
                <HeroSprite tint={tint} weapon="whip" pose="idle" size={132} />
                <span className="setup-preview__name">{name || "Tommy"}</span>
              </div>
            </div>

            {error && <p className="err">{error}</p>}

            <div className="rule">
              <span className="rule__pip" />
            </div>

            <button
              className="btn"
              onClick={() => setHarvestMode((v) => !v)}
              style={
                harvestMode
                  ? { background: "#b3331f", color: "#fff", marginBottom: "0.6rem" }
                  : { marginBottom: "0.6rem" }
              }
              title="Roguelite: a fixed gauntlet through all three bosses, with boon drafts. Works solo or co-op."
            >
              {harvestMode ? "🍅 Harvest Run — ON (roguelite)" : "🍅 Harvest Run — off"}
            </button>

            {mode === "solo" && (
              <div className="setup-actions">
                {hasSave && (
                  <button className="btn btn--blood" onClick={() => beginSolo(false)}>
                    Continue
                  </button>
                )}
                <button className="btn" onClick={() => beginSolo(true)}>
                  {hasSave ? "New Sprout" : "Descend"}
                </button>
              </div>
            )}
            {mode === "host" && (
              <div className="setup-actions">
                <button className="btn btn--blood" onClick={() => beginNet("host")}>
                  Open the Garden
                </button>
              </div>
            )}
            {mode === "client" && (
              <div className="setup-actions">
                <button className="btn btn--blood" onClick={() => beginNet("client")}>
                  Cross Over
                </button>
              </div>
            )}

            <Link href="/" className="back-link">
              ← back to the title
            </Link>
          </div>
        </div>
      )}

      {/* lobby (connecting) */}
      {phase === "lobby" && (
        <div className="overlay">
          <div className="panel setup rise">
            <p className="smallcaps">{mode === "host" ? "Hosting" : "Joining"}</p>
            {mode === "host" && hostCode && (
              <>
                <h1 className="setup-title crest">Room {hostCode}</h1>
                <p className="muted">
                  Share this code. Others choose <em>Co-op → Be Summoned</em> and
                  enter it. The game begins now — they&rsquo;ll appear as
                  phantoms.
                </p>
                <button className="btn" onClick={copyCode} style={{ marginTop: "1rem" }}>
                  {copied ? "copied!" : "copy code"}
                </button>
              </>
            )}
            {mode === "client" && (
              <h1 className="setup-title crest">Crossing over…</h1>
            )}
            <p className="status">{status}</p>
            {error && <p className="err">{error}</p>}
          </div>
        </div>
      )}

      {/* error */}
      {phase === "error" && (
        <div className="overlay">
          <div className="panel setup rise">
            <h1 className="setup-title crest tomato">The rift collapsed</h1>
            <p className="err">{error}</p>
            <div className="setup-actions">
              <button
                className="btn"
                onClick={() => {
                  cleanup();
                  setError("");
                  setPhase("setup");
                }}
              >
                Try Again
              </button>
              <Link href="/" className="btn">
                Title
              </Link>
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        .game-root {
          position: fixed;
          inset: 0;
          background: #0a0706;
          overflow: hidden;
        }
        .game-canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          cursor: crosshair;
          image-rendering: optimizeQuality;
        }
        .game-chrome {
          position: absolute;
          top: 12px;
          right: 14px;
          z-index: 30;
          display: flex;
          gap: 8px;
        }
        .chrome-btn {
          font-family: var(--mono);
          font-size: 0.7rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #b9a98a;
          background: rgba(10, 7, 6, 0.72);
          border: 1px solid var(--bark-line);
          padding: 0.4rem 0.7rem;
          cursor: pointer;
          backdrop-filter: blur(3px);
          transition: color 0.15s ease, border-color 0.15s ease,
            box-shadow 0.15s ease;
        }
        .chrome-btn:hover {
          color: var(--sap-bright);
          border-color: var(--sap);
          box-shadow: 0 0 14px rgba(232, 181, 58, 0.14);
        }
        .chrome-btn--flee:hover {
          color: var(--tomato-bright);
          border-color: var(--tomato);
          box-shadow: 0 0 14px rgba(216, 58, 46, 0.18);
        }
        .room-banner {
          position: absolute;
          top: 12px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 30;
          display: flex;
          align-items: center;
          gap: 10px;
          background: rgba(10, 7, 6, 0.85);
          border: 1px solid var(--bark-line);
          padding: 0.5rem 0.9rem;
          backdrop-filter: blur(4px);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
          max-width: 92vw;
          flex-wrap: wrap;
          justify-content: center;
        }
        .room-code {
          font-family: var(--mono);
          letter-spacing: 0.3em;
          color: var(--sap-bright);
          font-size: 1.1rem;
          text-shadow: 0 0 12px rgba(232, 181, 58, 0.3);
        }
        .room-banner__count {
          font-family: var(--mono);
          font-size: 0.66rem;
          letter-spacing: 0.1em;
          color: var(--ash);
        }
        .room-reopen {
          position: absolute;
          top: 12px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 30;
        }
        .overlay {
          position: absolute;
          inset: 0;
          z-index: 40;
          display: grid;
          place-items: center;
          background: radial-gradient(
            ellipse at center,
            rgba(13, 10, 9, 0.86),
            rgba(5, 3, 2, 0.97)
          );
          padding: 1.5rem;
          overflow: auto;
        }
        .setup {
          width: min(560px, 95vw);
          padding: 2.2rem;
          text-align: center;
          animation: rise 0.5s ease both;
        }
        .setup-title {
          font-size: 1.9rem;
          margin: 0.4rem 0 1.4rem;
          color: var(--parchment);
          line-height: 1.15;
        }
        .setup-grid {
          display: flex;
          gap: 1.4rem;
          align-items: flex-start;
          text-align: left;
        }
        .setup-fields {
          flex: 1 1 auto;
          min-width: 0;
        }
        .setup-preview {
          flex: 0 0 auto;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.4rem;
          padding-top: 1rem;
        }
        .setup-preview__name {
          font-family: var(--mono);
          font-size: 0.68rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--sap);
          max-width: 132px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-align: center;
        }
        .lbl {
          display: block;
          text-align: left;
          font-family: var(--mono);
          font-size: 0.66rem;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--ash);
          margin: 1rem 0 0.4rem;
        }
        .setup-fields .lbl:first-child {
          margin-top: 0;
        }
        .field--code {
          letter-spacing: 0.5em;
          text-align: center;
          font-size: 1.3rem;
        }
        .tints {
          display: flex;
          gap: 10px;
          justify-content: flex-start;
          flex-wrap: wrap;
        }
        .tint {
          width: 34px;
          height: 34px;
          border-radius: 50%;
          border: 2px solid #00000080;
          cursor: pointer;
          transition: transform 0.12s, box-shadow 0.12s;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
        }
        .tint:hover {
          transform: scale(1.12);
        }
        .tint--on {
          border-color: var(--sap-bright);
          box-shadow: 0 0 0 2px var(--sap), 0 0 14px var(--sap);
        }
        .cultivar-name {
          font-family: var(--serif);
          font-style: italic;
          color: var(--parchment-dim);
          font-size: 0.9rem;
          margin-top: 0.5rem;
        }
        .setup-actions {
          display: flex;
          gap: 0.8rem;
          justify-content: center;
          flex-wrap: wrap;
          margin-top: 0.4rem;
        }
        .status {
          color: var(--sap);
          font-family: var(--mono);
          font-size: 0.8rem;
          margin-top: 1.2rem;
          animation: flicker 2s infinite;
        }
        .err {
          color: var(--tomato-bright);
          font-family: var(--mono);
          font-size: 0.78rem;
          margin-top: 0.8rem;
        }
        .back-link {
          display: inline-block;
          margin-top: 1.4rem;
          font-family: var(--mono);
          font-size: 0.72rem;
          letter-spacing: 0.1em;
          color: var(--ash);
        }
        .back-link:hover {
          color: var(--parchment);
        }
        /* in-game help */
        .help-overlay {
          position: absolute;
          inset: 0;
          z-index: 45;
          display: grid;
          place-items: center;
          background: rgba(5, 3, 2, 0.7);
          backdrop-filter: blur(3px);
          padding: 1.5rem;
        }
        .help-card {
          width: min(440px, 94vw);
          padding: 1.8rem 2rem;
          text-align: center;
        }
        .help-card .setup-title {
          font-size: 1.5rem;
          margin: 0.3rem 0 1.2rem;
        }
        .help-list {
          list-style: none;
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
          margin-bottom: 1.4rem;
          color: var(--parchment-dim);
          font-size: 0.92rem;
        }
        .help-list .key {
          font-family: var(--mono);
          font-size: 0.66rem;
          min-width: 22px;
          display: inline-block;
          text-align: center;
          padding: 0.2rem 0.4rem;
          background: linear-gradient(180deg, #2c2018, #16100d);
          border: 1px solid var(--bark-line);
          border-bottom-width: 3px;
          border-radius: 4px;
          color: var(--sap-bright);
          margin: 0 1px;
        }
        .help-list .key--wide {
          min-width: 46px;
        }
        @media (max-width: 480px) {
          .setup {
            padding: 1.6rem 1.3rem;
          }
          .setup-grid {
            flex-direction: column;
            align-items: center;
          }
          .setup-fields {
            width: 100%;
          }
          .setup-preview {
            order: -1;
            padding-top: 0;
          }
        }
      `}</style>
    </div>
  );
}
