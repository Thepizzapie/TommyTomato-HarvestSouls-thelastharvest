# 🍅 Tommy Tomato: Harvest Souls — v2

A tomato soulslike, rebuilt on a **WebGL renderer (PixiJS v8)** for real dynamic
lighting, bloom, GPU particles, post-FX, and sprite/skeletal animation — the
visual ceiling the v1 Canvas2D build couldn't reach. Same gameplay design as v1
(stamina combat, dodge-roll i-frames, weapons + movesets, parry/riposte,
backstab, poise, poison, bonfires, Sap economy, bosses, optional Sodden Mire +
Old Tom), ported onto the new renderer.

**Stack:** Next.js 14 · React 18 · TypeScript · **PixiJS v8** · PeerJS co-op.
Fully static-deployable (no game server).

## Run
```bash
npm install
npm run dev      # http://localhost:3000  → / then "Enter the Rows"
```

## Status — scaffold
- ✅ Next + PixiJS v8 boot, SSR-safe (`/play` loads the renderer client-only)
- ✅ Game loop, WASD input, placeholder Tommy, dynamic light glow + ember particles
- ✅ `public/assets/` drop-zones wired and documented (`public/assets/README.md`)
- ⏳ Next: load generated sprites → animation system → tilemap + lighting pass →
  entities/combat (port v1 sim) → HUD → PeerJS co-op

## Layout
```
src/app/                 routes (title, /play) + globals
src/app/components/PixiStage.tsx   the WebGL stage (boot + loop + scene)
public/assets/           drop Ludo exports here (see its README)
```
Drop generated art in `public/assets/<group>/` and the engine loads it — no
binary churn in source.
