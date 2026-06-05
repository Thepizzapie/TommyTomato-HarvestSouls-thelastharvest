"use client";

import { useEffect, useRef } from "react";
import { drawHero, type HeroVisual, type WeaponKind } from "@/game/core/art";

// A small looping portrait of Tommy himself — used for the cultivar picker
// preview (so a chosen tint is shown on the actual hero) and the weapons
// gallery (each armament demonstrated mid-swing). Pure decoration.

type Pose = "idle" | "swing" | "guard";

export default function HeroSprite({
  tint = "#d83a2e",
  weapon = "whip",
  pose = "idle",
  heavy = false,
  size = 96,
}: {
  tint?: string;
  weapon?: WeaponKind;
  pose?: Pose;
  heavy?: boolean;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size;
    const H = size;
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let t = 0;
    let last = performance.now();

    const v: HeroVisual = {
      facing: 0,
      walkPhase: 0,
      moving: false,
      rolling: false,
      attacking: 0,
      hurt: 0,
      invuln: false,
      blocking: pose === "guard",
      tint,
      weapon,
      heavy,
    };

    const CYCLE = 3.2;
    const scale = size / 64; // art is authored around a ~64px hero box

    const render = (now: number) => {
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1;
      const speed = reduce ? 0.3 : 1;
      t += dt * speed;

      // a slow, watchful look so the eyes drift
      v.facing = -0.35 + Math.sin(t * 0.8) * 0.5;

      if (pose === "swing") {
        // repeating wind-up → strike → settle on a loop
        const c = t % CYCLE;
        if (c < 0.5) v.attacking = 0; // idle beat
        else if (c < 1.4) v.attacking = (c - 0.5) / 0.9; // 0 → 1 wind back
        else if (c < 2.0) v.attacking = 1 - (c - 1.4) / 0.6; // 1 → 0 release
        else v.attacking = 0; // follow-through settle
        v.facing = -0.2;
      } else {
        v.attacking = 0;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // warm ground pool
      const g = ctx.createRadialGradient(
        W / 2,
        H * 0.66,
        2,
        W / 2,
        H * 0.66,
        W * 0.55
      );
      g.addColorStop(0, "rgba(255,150,70,0.08)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(W / 2, H * 0.6);
      ctx.scale(scale, scale);
      drawHero(ctx, 0, 0, v, t);
      ctx.restore();

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [tint, weapon, pose, heavy, size]);

  return (
    <canvas
      ref={ref}
      className="hero-sprite-canvas"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
