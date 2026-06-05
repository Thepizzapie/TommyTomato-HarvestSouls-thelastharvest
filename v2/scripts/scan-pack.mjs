import fs from "fs";
import path from "path";

const dir = path.resolve("public/assets/animation-pack");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
const rows = [];
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const img = j.meta?.image || "?";
    const isArr = Array.isArray(j.frames);
    const frames = j.frames ? (isArr ? j.frames.length : Object.keys(j.frames).length) : 0;
    const anims = j.animations ? Object.keys(j.animations) : null;
    const firstFrameKey = j.frames ? (isArr ? j.frames[0]?.filename : Object.keys(j.frames)[0]) : "";
    const size = j.meta?.size ? `${j.meta.size.w}x${j.meta.size.h}` : "?";
    const imgExists = fs.existsSync(path.join(dir, img));
    rows.push({ json: f, img, imgExists, frames, framesArray: isArr, size, anims: anims ? anims.join("|") : "-", firstFrameKey });
  } catch (e) {
    rows.push({ json: f, err: String(e) });
  }
}
rows.sort((a, b) => String(a.img).localeCompare(String(b.img)));
for (const r of rows) console.log(JSON.stringify(r));
console.log("TOTAL_JSON", rows.length);
// list pngs with no matching json image reference
const pngs = fs.readdirSync(dir).filter((f) => f.endsWith(".png"));
const referenced = new Set(rows.map((r) => r.img));
console.log("ORPHAN_PNGS", pngs.filter((p) => !referenced.has(p)));
console.log("MISSING_IMAGES", rows.filter((r) => r.imgExists === false).map((r) => `${r.json} -> ${r.img}`));
