# Drop your Ludo exports here

Group by folder. Names are suggestions — whatever you use, just tell me the
format (single PNG, sprite-sheet strip, or sheet + JSON) and I'll write the loader.

```
characters/   tommy_idle, tommy_run, tommy_roll, tommy_attack, tommy_hurt, tommy_death
enemies/      <kind>_idle, <kind>_move, <kind>_attack, <kind>_death   (kind: aphid, mite, grub, crow, slug, weed, drone, hornet, spore, beetle, scarecrow)
bosses/       king_*, oldtom_*, harvester_*  (idle, move, attacks, roar, death)
weapons/      whip, dagger, mace, rapier        (static PNGs, handle pointing down)
tiles/        rows, greenhouse, catacombs, bog, yard   (ground textures) + wall_block, fence, etc.
props/        compost_heap, crate, mushroom, torch, lantern, sign, husk
vfx/          hit_spark, pulp_splat, dust, sap_glint, poison_gas, splash, heal, parry, levelup
ui/           bar_hp, bar_boss, panel_scroll, panel_sheet, frame_corner, ring_gauge, icon_sap, icon_eye
projectiles/  poison_orb, spore_bomb
audio/        music_explore, music_combat, music_boss, amb_*, sfx_*
```

## Sprite-sheet notes
- Animation exports (idle/run/etc.): a **PNG sprite-sheet strip** is easiest — tell me
  the **frame count** and **frame size** (or that it's an even horizontal strip) and I'll
  slice it. Ludo's sheet export with a known columns/rows count is ideal.
- Keep each character's frames the **same canvas size** so they align.
- Transparent background on everything except ground tiles.
- One facing direction (right) — the engine flips for left.
