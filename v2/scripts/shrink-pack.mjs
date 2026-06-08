// shrink-pack.mjs
//
// The Ludo atlases ship at ~3438x3204 / 2865x2670 — each decodes to 30–42 MB of
// VRAM, so loading a room (~28 sheets) costs ~1.2 GB and OOM-crashes the tab.
// The sprites are displayed at a tiny fraction of that. This rescales every
// atlas (PNG) AND its TexturePacker JSON by the same factor so frames stay
// aligned, cutting VRAM ~10x.
//
//   creatures + vfx -> 1/3  (573x534 cell -> 191x178, exact integers)
//   bosses          -> 2/3  (-> 382x356, exact)  — they render large, keep detail
//
// In-place. Render scales (BASE_SCALE in manifest.ts) are bumped to compensate.
// Run: npm i --no-save sharp && node scripts/shrink-pack.mjs

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve("public/assets/anim");
const BOSSES = new Set(["king", "oldtom", "harvester"]);
const factorFor = (creature) => (BOSSES.has(creature) ? 2 / 3 : 1 / 3);

function scaleJson(j, F) {
  for (const key of Object.keys(j.frames)) {
    const fr = j.frames[key];
    for (const part of ["frame", "spriteSourceSize"]) {
      if (!fr[part]) continue;
      fr[part].x = Math.round(fr[part].x * F);
      fr[part].y = Math.round(fr[part].y * F);
      fr[part].w = Math.round(fr[part].w * F);
      fr[part].h = Math.round(fr[part].h * F);
    }
    if (fr.sourceSize) {
      fr.sourceSize.w = Math.round(fr.sourceSize.w * F);
      fr.sourceSize.h = Math.round(fr.sourceSize.h * F);
    }
  }
  if (j.meta?.size) {
    j.meta.size.w = Math.round(j.meta.size.w * F);
    j.meta.size.h = Math.round(j.meta.size.h * F);
  }
  return j;
}

let before = 0, after = 0;
const creatures = fs
  .readdirSync(ROOT)
  .filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory());

for (const c of creatures) {
  const F = factorFor(c);
  const dir = path.join(ROOT, c);
  const files = fs.readdirSync(dir);

  for (const file of files.filter((f) => f.endsWith(".json"))) {
    const fp = path.join(dir, file);
    const j = scaleJson(JSON.parse(fs.readFileSync(fp, "utf8")), F);
    fs.writeFileSync(fp, JSON.stringify(j, null, 2));
  }

  for (const file of files.filter((f) => f.endsWith(".png"))) {
    const fp = path.join(dir, file);
    const m = await sharp(fp).metadata();
    const nw = Math.round(m.width * F);
    const nh = Math.round(m.height * F);
    before += m.width * m.height * 4;
    after += nw * nh * 4;
    const buf = await sharp(fp)
      .resize(nw, nh, { kernel: "lanczos3" })
      .png({ compressionLevel: 9 })
      .toBuffer();
    fs.writeFileSync(fp, buf);
  }
  console.log(`  ${c.padEnd(10)} x${F.toFixed(3)}`);
}

console.log(
  `\nVRAM if all resident: ${(before / 1048576).toFixed(0)} MB -> ${(after / 1048576).toFixed(0)} MB`
);
