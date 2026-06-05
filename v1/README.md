# 🍅 Tommy Tomato: Harvest Souls

A Temu-budget soulslike. You are **Tommy**, a tomato who ripened at the worst
possible moment. The farmer is gone but the harvest is not — it has become a
hunger the land can't unlearn. Roll, parry, and ripen your way through the
agricultural hellscape, alone or with summoned phantoms.

Built with **Next.js 14 + React 18 + TypeScript**. The game itself is a custom
HTML5 Canvas engine (no game framework). **Online co-op is peer-to-peer** via
PeerJS — there is no game server to run or deploy. The whole thing builds to
static output.

## Run it

```bash
npm install
npm run dev      # http://localhost:3000
```

Production:

```bash
npm run build
npm start
```

> Tip: don't run `npm run build` and `npm run dev` at the same time — they share
> the `.next` folder and will trip over each other. If the dev server ever
> throws "Cannot find module './xxx.js'", delete `.next` and restart `dev`.

Deploy anywhere that hosts a Next.js app (e.g. Vercel). Co-op needs no extra
infrastructure — signaling and STUN are handled by the public PeerJS cloud.

## The portal

| Route        | What                                                        |
| ------------ | ----------------------------------------------------------- |
| `/`          | Title screen                                                |
| `/play`      | Solo descent (progress saved to `localStorage`)             |
| `/coop`      | Host a room or be summoned into someone else's world        |
| `/bestiary`  | Field guide to everything trying to harvest you             |
| `/lore`      | Cryptic fragments from the rows                             |
| `/controls`  | How to survive                                              |

## How co-op works

- One player **Opens a Garden** → gets a 4-letter room code, plays immediately.
- Others **Be Summoned** → enter the code, cross over as green phantoms.
- The **host is authoritative** for enemies, bosses, loot and area transitions
  and broadcasts world snapshots (~16 Hz). Each player simulates their own
  tomato locally (20 Hz state sync) for responsiveness; the host relays player
  snapshots so everyone sees everyone. You share the host's world — their
  bonfires, their bosses, their rows.
- To try it solo: open the site in two browser windows, host in one, join in
  the other.

## Controls

**Keyboard & mouse:** `WASD` move · `MOUSE` aim · `LMB` light attack · `F` heavy ·
`SPACE` dodge roll (i-frames) · `RMB` guard · `TAB`/`Q` lock-on · `1`–`4` equip
weapon · `R`/`H` heal (Watering Can) · `E` rest at a Compost Heap · `P` pause.

**Controller (Xbox layout):** left stick move · right stick aim · `RB` light ·
`RT` heavy · `A` dodge roll · `LB`/`LT` guard · `Y`/`R3` lock-on · `D-pad` equip
weapon · `X` heal · `B` rest / interact / revive. Plug in and play — keyboard and
pad work simultaneously.

## The loop

Slay the field for **sap** → rest at a **Compost Heap** to spend it on Vigor /
Strength / Vitality / Agility → fall and your sap spills into a **husk** where
you died (reclaim it, but die again first and it's gone forever) → push through
**The Rotting Rows → The Greenhouse of Glass → The Compost Catacombs** to the
**Scarecrow King**, and beyond him, **THE HARVESTER**.

## Project layout

```
src/
  app/                 Next.js routes + React components (portal, game client)
  game/
    core/              engine primitives: math, rng, input, audio, art (all procedural)
    content/world.ts   areas, enemy archetypes, progression curves
    sim/Game.ts        the engine — player, enemy AI, combat, bosses, render, HUD
    net/net.ts         PeerJS host/join + relay
  data/codex.ts        bestiary & lore text
```

Art and audio are generated at runtime (canvas vector sprites, WebAudio
synthesis) — there are no binary assets to ship.
