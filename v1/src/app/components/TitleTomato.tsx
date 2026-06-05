"use client";

import { useEffect, useRef } from "react";
import {
  drawHero,
  drawCompostHeap,
  drawTorch,
  drawMushroom,
  drawGrassTuft,
  drawVinePatch,
  drawBones,
  type HeroVisual,
} from "@/game/core/art";

// The main-menu diorama: a torch-lit dusk over the rotting rows. Tommy keeps a
// long watch by a lit compost heap while crops loom in the fog behind him and
// embers + spores drift up through the cold. A real game's title scene, drawn
// every frame on one canvas. rAF is cleaned up on unmount; honours
// prefers-reduced-motion by slowing the whole world to a crawl.

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: "ember" | "spore";
  a: number;
}

export default function TitleTomato() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // logical scene size; the canvas is letterboxed responsively in CSS
    const W = 520;
    const H = 300;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const GROUND = H - 78;

    // --- parallax silhouettes: ranks of crop stalks receding into fog ---
    type Stalk = { x: number; y: number; h: number; lean: number; depth: number };
    const stalks: Stalk[] = [];
    const rng = (() => {
      let s = 1337;
      return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    })();
    for (let layer = 0; layer < 3; layer++) {
      const depth = layer / 2; // 0 = near, 1 = far
      const count = 6 + layer * 3;
      for (let i = 0; i < count; i++) {
        stalks.push({
          x: rng() * (W + 80) - 40,
          y: GROUND - 64 + depth * 70 + rng() * 10,
          h: (58 - depth * 26) * (0.7 + rng() * 0.6),
          lean: (rng() - 0.5) * 0.5,
          depth,
        });
      }
    }
    stalks.sort((a, b) => b.depth - a.depth); // far first

    // --- drifting motes (embers + a few sickly spores) ---
    const motes: Mote[] = [];
    const MOTE_N = 34;
    for (let i = 0; i < MOTE_N; i++) {
      const spore = i % 5 === 0;
      motes.push({
        x: rng() * W,
        y: rng() * H,
        vx: (rng() - 0.5) * 6,
        vy: -(6 + rng() * 14),
        r: 0.8 + rng() * (spore ? 2.2 : 1.6),
        hue: spore ? "spore" : "ember",
        a: 0.2 + rng() * 0.6,
      });
    }

    const v: HeroVisual = {
      facing: 3.5,
      walkPhase: 0,
      moving: false,
      rolling: false,
      attacking: 0,
      hurt: 0,
      invuln: false,
      blocking: false,
      tint: "#d83a2e",
    };

    let raf = 0;
    let t = 0;
    let last = performance.now();

    const drawStalk = (s: Stalk) => {
      // a dark, leaning crop silhouette — flatter and bluer the deeper it sits
      const shade = 0.18 + (1 - s.depth) * 0.32;
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.lean + Math.sin(t * 0.6 + s.x) * 0.02 * (1 - s.depth));
      ctx.strokeStyle = `rgba(14,12,16,${shade})`;
      ctx.lineWidth = 3 + (1 - s.depth) * 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(s.lean * 8, -s.h * 0.6, s.lean * 14, -s.h);
      ctx.stroke();
      // a couple of drooping leaves
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(0, -s.h * 0.55);
        ctx.quadraticCurveTo(
          side * 12,
          -s.h * 0.5,
          side * 16,
          -s.h * 0.35
        );
        ctx.lineWidth = 2 + (1 - s.depth) * 1.5;
        ctx.stroke();
      }
      // a withered fruit hanging near the crown on the nearer ranks
      if (s.depth < 0.6) {
        ctx.beginPath();
        ctx.arc(s.lean * 12, -s.h * 0.82, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(40,16,14,${shade + 0.1})`;
        ctx.fill();
      }
      ctx.restore();
    };

    const render = (now: number) => {
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1;
      const speed = reduce ? 0.3 : 1;
      t += dt * speed;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // ---- sky: a low, bruised dusk ----
      const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
      sky.addColorStop(0, "#1a0f0c");
      sky.addColorStop(0.55, "#241310");
      sky.addColorStop(1, "#2c160f");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, GROUND);

      // sullen moon haze low on the horizon
      const moonX = W * 0.74;
      const moonY = GROUND - 92;
      const halo = ctx.createRadialGradient(moonX, moonY, 4, moonX, moonY, 90);
      halo.addColorStop(0, "rgba(232,181,58,0.22)");
      halo.addColorStop(0.4, "rgba(216,120,60,0.08)");
      halo.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, GROUND + 30);
      ctx.beginPath();
      ctx.arc(moonX, moonY, 17, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(228,196,120,0.5)";
      ctx.fill();

      // ---- ground plane ----
      const soil = ctx.createLinearGradient(0, GROUND - 20, 0, H);
      soil.addColorStop(0, "#1a120c");
      soil.addColorStop(1, "#0a0706");
      ctx.fillStyle = soil;
      ctx.fillRect(0, GROUND - 6, W, H - GROUND + 6);
      // furrow lines receding
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      for (let i = 1; i <= 5; i++) {
        const yy = GROUND + i * ((H - GROUND) / 6);
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(W, yy + 2);
        ctx.stroke();
      }

      // ---- parallax crop ranks (behind everything) ----
      for (const s of stalks) drawStalk(s);

      // ---- rolling fog band across the midground ----
      ctx.save();
      for (let band = 0; band < 3; band++) {
        const fy = GROUND - 30 - band * 14;
        const off = (t * (8 + band * 5)) % (W + 200);
        const fog = ctx.createLinearGradient(0, fy - 26, 0, fy + 26);
        fog.addColorStop(0, "rgba(120,120,110,0)");
        fog.addColorStop(0.5, `rgba(150,150,140,${0.05 + band * 0.015})`);
        fog.addColorStop(1, "rgba(120,120,110,0)");
        ctx.fillStyle = fog;
        for (let k = -1; k < 3; k++) {
          const cx = -100 + off + k * (W + 200) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, fy, 150, 22 - band * 4, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // ---- scene props on the ground line ----
      drawGrassTuft(ctx, 60, GROUND + 8, t, 2, true);
      drawGrassTuft(ctx, W - 70, GROUND + 14, t, 5, true);
      drawMushroom(ctx, W - 120, GROUND + 18, t, 1, false);
      drawBones(ctx, 120, GROUND + 24, t, 3);
      drawVinePatch(ctx, W - 40, GROUND + 26, t, 4);

      // left torch casts the warm key light
      drawTorch(ctx, 44, GROUND - 4, t, 0);

      // ---- the heap + Tommy, the heart of the scene ----
      ctx.save();
      ctx.scale(1.55, 1.55);
      const hx = W / 1.55 - 150;
      drawCompostHeap(ctx, hx + 92, GROUND / 1.55 + 6, t, true);
      // Tommy sits to the left, glancing toward the fire
      v.facing = 3.5 + Math.sin(t * 0.5) * 0.18;
      drawHero(ctx, hx, GROUND / 1.55 + 8, v, t);
      ctx.restore();

      // ---- drifting motes (in front of the scene, behind the vignette) ----
      for (const m of motes) {
        m.x += m.vx * dt * speed;
        m.y += m.vy * dt * speed;
        if (m.y < -8 || m.x < -12 || m.x > W + 12) {
          m.x = rng() * W;
          m.y = H + 8;
          m.vx = (m.hue === "spore" ? (rng() - 0.5) * 4 : (rng() - 0.5) * 8);
        }
        const flick = 0.6 + Math.sin(t * 5 + m.x) * 0.4;
        ctx.save();
        ctx.globalAlpha = m.a * flick;
        ctx.shadowBlur = 8;
        if (m.hue === "ember") {
          ctx.shadowColor = "#ffb45a";
          ctx.fillStyle = Math.sin(m.x) > 0 ? "#ffd56b" : "#ff8a3a";
        } else {
          ctx.shadowColor = "#9fb24e";
          ctx.fillStyle = "#9fe04e";
        }
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // ---- gentle scene vignette so it sits in its frame ----
      const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.75);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(5,3,2,0.55)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={ref}
      className="title-scene-canvas"
      style={{ width: 520, height: 300, maxWidth: "94vw" }}
      aria-hidden
    />
  );
}
