"use client";

import { useEffect, useRef } from "react";
import { drawEnemy, type EnemyKind, type EnemyVisual } from "@/game/core/art";

// A tiny looping field-guide portrait of a single creature. It paces through a
// little behaviour loop (idle → telegraph → strike → recover) so each beast
// reads as alive, and the player learns its "tell" by watching it once.
//
// Pure decoration: no game state, no net. One rAF per thumb, cleaned up on
// unmount. Kept cheap (one creature, ~14px outline art) so a full grid of these
// stays smooth even on a phone.

// Per-kind framing: bosses are large, so they sit lower and smaller in the box.
const FRAME: Partial<
  Record<EnemyKind, { scale: number; y: number; rate?: number }>
> = {
  king: { scale: 0.62, y: 0.66 },
  harvester: { scale: 0.42, y: 0.6 },
  oldtom: { scale: 0.6, y: 0.64 },
  beetle: { scale: 1.05, y: 0.62 },
  slug: { scale: 1.05, y: 0.62 },
  scarecrow: { scale: 0.9, y: 0.66 },
  weed: { scale: 1.0, y: 0.64 },
  spore: { scale: 1.0, y: 0.66 },
  mite: { scale: 1.5, y: 0.62, rate: 1.3 },
  aphid: { scale: 1.35, y: 0.62, rate: 1.2 },
  hornet: { scale: 1.3, y: 0.58 },
  crow: { scale: 1.15, y: 0.56 },
  grub: { scale: 1.25, y: 0.64 },
  drone: { scale: 1.15, y: 0.6 },
};

export default function BeastThumb({
  kind,
  size = 96,
}: {
  kind: EnemyKind;
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

    const frame = FRAME[kind] ?? { scale: 1, y: 0.62 };
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let t = 0;
    let last = performance.now();
    const v: EnemyVisual = {
      kind,
      facing: 0,
      phase: 0,
      hurt: 0,
      attacking: 0,
      hp01: 1,
      windup: false,
      variant: 1,
    };

    // a ~4.4s behaviour loop: settle, glare (windup), strike, then flinch
    const CYCLE = 4.4;

    const render = (now: number) => {
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1; // tab-switch guard
      const speed = reduce ? 0.25 : 1;
      t += dt * speed;
      v.phase += dt * 4 * (frame.rate ?? 1) * speed;

      const c = t % CYCLE;
      // gentle look-around so the eyes track and it feels aware
      v.facing = Math.sin(t * 0.7) * 0.9 - 0.4;

      // telegraph then strike then recover
      if (c > 1.6 && c < 2.2) {
        v.windup = true;
        v.attacking = 0;
      } else if (c >= 2.2 && c < 2.8) {
        v.windup = false;
        v.attacking = Math.max(0, 1 - (c - 2.2) / 0.6); // 1 → 0 swing
      } else if (c >= 3.4 && c < 3.7) {
        v.windup = false;
        v.attacking = 0;
        v.hurt = 1 - (c - 3.4) / 0.3; // brief flinch flash
      } else {
        v.windup = false;
        v.attacking = 0;
        v.hurt = 0;
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // soft soil pool the creature stands on
      const g = ctx.createRadialGradient(
        W / 2,
        H * frame.y + 6,
        2,
        W / 2,
        H * frame.y + 6,
        W * 0.55
      );
      g.addColorStop(0, "rgba(255,150,70,0.07)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(W / 2, H * frame.y);
      ctx.scale(frame.scale, frame.scale);
      drawEnemy(ctx, 0, 0, v, t);
      ctx.restore();

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [kind, size]);

  return (
    <canvas
      ref={ref}
      className="beast-thumb-canvas"
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}
