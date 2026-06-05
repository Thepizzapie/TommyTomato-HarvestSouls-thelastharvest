"use client";

import dynamic from "next/dynamic";

// Pixi touches the DOM/WebGL — load it client-only, no SSR.
const PixiStage = dynamic(() => import("../components/PixiStage"), {
  ssr: false,
  loading: () => (
    <div className="stage-root">
      <div className="stage-hud">waking the rows…</div>
    </div>
  ),
});

export default function PlayPage() {
  return <PixiStage />;
}
