"use client";

import { useState } from "react";
import PortalNav from "../components/PortalNav";
import GameClient from "../components/GameClient";

export default function CoopPage() {
  const [mode, setMode] = useState<"choose" | "host" | "client">("choose");

  if (mode === "host") return <GameClient mode="host" />;
  if (mode === "client") return <GameClient mode="client" />;

  return (
    <main className="page">
      <PortalNav active="/coop" />

      <header className="page-head">
        <h1>Summon &amp; Be Summoned</h1>
        <p>
          Co-op runs directly between browsers — no servers to think about. One
          tomato <em>opens a garden</em> and shares a four-letter room code.
          Others <em>cross over</em> as green phantoms into that world, to fight
          and fall together. The host&rsquo;s progress is the world you share.
        </p>
      </header>

      <div className="coop-grid">
        <button
          className="panel coop-card"
          type="button"
          onClick={() => setMode("host")}
        >
          <div className="ico" aria-hidden>
            🌱
          </div>
          <h2>Open a Garden</h2>
          <p>
            Host the world. You play immediately and receive a room code to
            share. A small band of phantoms may join you against the harvest.
          </p>
          <span className="coop-card__cta">Host →</span>
        </button>

        <button
          className="panel coop-card"
          type="button"
          onClick={() => setMode("client")}
        >
          <div className="ico" aria-hidden>
            👻
          </div>
          <h2>Be Summoned</h2>
          <p>
            Have a friend&rsquo;s code? Cross into their world as a phantom.
            Their bonfires, their bosses, their rows — your blade.
          </p>
          <span className="coop-card__cta">Join →</span>
        </button>
      </div>

      <div className="coop-how">
        <div className="rule">
          <span className="rule__pip" />
        </div>
        <p className="coop-how__tip">
          <b>Testing solo?</b> Open this site in two browser windows — host in
          one, then join with the code in the other.
        </p>
      </div>
    </main>
  );
}
