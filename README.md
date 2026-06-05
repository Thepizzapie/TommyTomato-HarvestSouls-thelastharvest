# 🍅 Tommy Tomato: Harvest Souls

A Dark-Souls-but-it's-a-tomato browser game, built twice — once on a shoestring,
then rebuilt as a real production. You are **Tommy**, a tomato who ripened at the
worst possible moment. The farmer is gone but the harvest is not. Roll, parry,
backstab, and ripen your way through the agricultural hellscape — solo or in
peer-to-peer co-op.

This repo holds **two complete versions** of the game.

---

## `v1/` — the Temu version

The original one-shot build.

- **Stack:** Next.js 14 · React 18 · TypeScript · a hand-written **HTML5 Canvas2D**
  engine (no game framework).
- **Everything procedural:** creatures, props, particles, and audio are all
  generated at runtime in code — there are **no binary assets**.
- Full soulslike loop: stamina, dodge-roll i-frames, light/heavy attacks, guard,
  parry→riposte, backstab, poise/stagger, poison, lock-on, Compost-Heap bonfires,
  Sap currency + bloodstain recovery, leveling, charms, weapons, multiple areas
  and bosses (the Scarecrow King, Old Tom, and THE HARVESTER).
- **Online co-op** over **PeerJS** (host a room, others join by code) — no game
  server required.

```bash
cd v1 && npm install
npm run dev      # dev server → http://localhost:3000
npm run build    # static export → v1/out/ (deploy that folder to any static host)
```

## `v2/` — the Walmart version

The glow-up. Same gameplay, rebuilt on a real renderer with real art.

- **Stack:** Next.js 14 · React 18 · TypeScript · **PixiJS v8 (WebGL)** · PeerJS.
- **Hand-painted animated sprites** (generated with Ludo.ai) for Tommy, every
  enemy, and the bosses — loaded from TexturePacker sheets in
  `v2/public/assets/anim/`.
- **WebGL everything the old build couldn't do:** dynamic 2D lighting + bloom,
  a GPU particle system, per-biome color grade + weather + vignette, screen
  shake, hit-stop.
- **Detailed procedural world** drawn in code on top of the sprites: extruded
  2.5D walls, animated bonfires/torches/props, a glowing-projectile/pickup layer,
  an ornate HUD, and a combat-feedback UI (floating damage numbers, enemy health
  bars, lock-on reticle, PARRY/RIPOSTE/BACKSTAB callouts).
- **Procedural audio** (WebAudio): adaptive explore/combat/boss music, per-biome
  ambience, and a full SFX set.
- A redesigned **7-area, 3-act, 3-boss** campaign (2 rooms → boss, 1 → boss,
  1 → boss).

```bash
cd v2 && npm install
npm run dev      # dev server → http://localhost:3000
npm run build    # static export → v2/out/ (deploy that folder to any static host)
```

> The animated sprite sheets under `v2/public/assets/anim/` are AI-generated
> (Ludo.ai). They're the only binary assets in the project; the entire
> environment, UI, VFX, lighting, and audio are still drawn/synthesized in code.

---

## Controls (both versions)

**Keyboard & mouse:** `WASD`/arrows move · **MOUSE** aim · **LMB** light attack ·
**F** heavy · **SPACE** dodge roll (i-frames) · **RMB** guard (time it = parry →
riposte) · strike from behind = backstab · **TAB**/**Q** lock-on · **1–4** equip
weapon · **R**/**H** heal · **E** rest at a Compost Heap · **P** pause.

**Controller (Xbox layout, plug-and-play):** **left stick** move · **right stick**
aim · **RB** light attack · **RT** heavy · **A** dodge roll · **LB**/**LT** guard
(time it = parry) · **Y**/**R3** lock-on · **D-pad** equip weapon (and steer the
rest menus) · **X** heal · **B** rest / interact / revive. Keyboard and controller
are live at the same time, so you can mix and match mid-fight.

## The loop

Cut the field for **Sap** → rest at a **Compost Heap** to spend it on Vigor /
Strength / Vitality / Agility and slot charms → fall, and your Sap spills into a
**husk** where you died (reclaim it, but die again first and it's gone) → push
deeper, biome by biome, to the foes that wait at the end. The blade is patient.
You should not be.

---

Both versions are configured for a fully static export (`output: "export"`):
`npm run build` emits a self-contained `out/` you can drop on any static host
(GitHub Pages, Netlify, Vercel, an S3 bucket, a USB stick). Co-op signaling runs
on the public PeerJS cloud, so there is no backend to host. Inbound peer data is
validated/clamped at the wire boundary, room codes use a CSPRNG, and the dev-only
debug hooks are stripped from the production build.
