// fix-pack.mjs
//
// Repairs the broken Ludo "Animation Pack" export.
//
// The export under public/assets/animation-pack/ ships, per clip, one PNG + one
// TexturePacker-style JSON. Two things are wrong:
//   1. Every JSON's meta.image points at a filename that does not exist
//      (e.g. run.json -> "run.png"), while the real PNGs are orphaned under
//      descriptive names (e.g. "-playerrun.png").
//   2. JSON frames are keyed frame_000..frame_NNN with no `animations` field.
//
// Frames within a geometry group (frameCount + atlas size) are a uniform,
// untrimmed grid, so any JSON of a given geometry has byte-identical frame
// rects to any other JSON of that geometry. We verify that assumption, then
// emit a clean tree:
//
//   public/assets/anim/<creature>/<state>.png
//   public/assets/anim/<creature>/<state>.json   (meta.image -> "<state>.png")
//
// Run: node scripts/fix-pack.mjs

import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("public/assets/animation-pack");
const OUT = path.resolve("public/assets/anim");

// ---------------------------------------------------------------------------
// Authoritative PNG -> creature.state map (from the brief).
// Each entry: [realPngFilename, state]
// ---------------------------------------------------------------------------
const MAP = {
  player: [
    ["-playerrun.png", "run"],
    ["player-idle-3.png", "idle"],
    ["roll-once-fast-.png", "roll"],
    ["plauyer-light-attack-swing.png", "lightAttack"],
    ["tom-player-heavy-attack-swing.png", "heavyAttack"],
    ["tom-player-hurt-flinch.png", "hurt"],
    ["tommy-player-death-4.png", "death"],
  ],
  grub: [
    ["worm-idle-2.png", "idle"],
    ["worm crawl.png", "move"],
    ["worm-lunge-bite-attack.png", "attack"],
    ["worm-death-3.png", "death"],
  ],
  weed: [
    ["plant-idle-sway.png", "idle"],
    ["plant-attack.png", "attack"],
    ["plant-death.png", "death"],
  ],
  drone: [
    ["ddrone-hover.png", "idle"],
    ["ddrone-spray-attack.png", "attack"],
    ["drone-death-.png", "death"],
  ],
  hornet: [
    ["fly1-idle-hover.png", "idle"],
    ["fly1-skitter.png", "move"],
    ["fly1-attack.png", "attack"],
    ["fly1death-2.png", "death"],
  ],
  king: [
    ["scarecrow king-idle.png", "idle"],
    ["scarecrowkingstride.png", "move"],
    ["scythe-sweep.png", "scytheSweep"],
    ["scarecrow king-lunge.png", "lunge"],
    ["scarecrowking-summon-roar.png", "summonRoar"],
    ["scarecrowking--spin-attack.png", "spinAttack"],
    ["scarecrow king death.png", "death"],
  ],
  oldtom: [
    ["tom boss-idle-1.png", "idle"],
    ["tom-bossstride-1.png", "move"],
    ["tom-boss-lunging-stab.png", "lungingStab"],
    ["-grief-burst-nova.png", "griefNova"],
    ["tom-boss-phase-2-roar.png", "phase2Roar"],
    ["tom-death-2.png", "death"],
  ],
  harvester: [
    ["harvester-idle-standing.png", "idle"],
    ["-charge.png", "charge"],
    ["harvester- blade-sweep.png", "bladeSweep"],
    ["harvester-poison-spray-volley.png", "poisonVolley"],
    ["harvesterground-slam.png", "groundSlam"],
    ["harvesteroverdrive-roar.png", "overdriveRoar"],
    ["harvester death-1.png", "death"],
  ],
  vfx: [
    ["-big-gold-boss-death.png", "bossDeath"],
    ["golden-level-up-burs.png", "levelUp"],
    ["green-white-parry-fl.png", "parryFlash"],
    ["rising-blue-heal-mot.png", "healMotes"],
    ["water-splash.png", "waterSplash"],
    ["poison-cloud-floatin.png", "poisonCloud"],
    ["golden-sap-pickup-sp.png", "sapPickup"],
    ["tomato-pulp-splatter.png", "pulpSplatter"],
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read width/height from a PNG's IHDR chunk (bytes 16..24, big-endian). */
function pngSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    // PNG signature is 8 bytes; IHDR length(4)+type(4) follow; then w(4) h(4).
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Geometry key for grouping. */
function geomKey(frameCount, w, h) {
  return `${frameCount}@${w}x${h}`;
}

/** Stable serialization of a frames object's rects (order-independent check). */
function framesFingerprint(frames) {
  const keys = Object.keys(frames).sort();
  const parts = keys.map((k) => {
    const f = frames[k];
    const r = f.frame;
    const ss = f.spriteSourceSize || {};
    const src = f.sourceSize || {};
    return [
      k,
      r.x, r.y, r.w, r.h,
      f.rotated ? 1 : 0,
      f.trimmed ? 1 : 0,
      ss.x ?? 0, ss.y ?? 0, ss.w ?? r.w, ss.h ?? r.h,
      src.w ?? r.w, src.h ?? r.h,
    ].join(",");
  });
  return parts.join("|");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function frameCountOf(j) {
  return Array.isArray(j.frames)
    ? j.frames.length
    : Object.keys(j.frames || {}).length;
}

// ---------------------------------------------------------------------------
// STEP 1a: load every JSON, group by geometry, verify identical frame rects.
// ---------------------------------------------------------------------------
const allJsonFiles = fs
  .readdirSync(SRC)
  .filter((f) => f.toLowerCase().endsWith(".json"));

/** geomKey -> { fingerprint, sampleFile, sampleFrames, members:[], identical } */
const groups = new Map();

for (const f of allJsonFiles) {
  let j;
  try {
    j = readJson(path.join(SRC, f));
  } catch (e) {
    console.warn(`  ! could not parse ${f}: ${e.message}`);
    continue;
  }
  if (!j.frames || !j.meta?.size) continue;
  const fc = frameCountOf(j);
  const key = geomKey(fc, j.meta.size.w, j.meta.size.h);
  const fp = framesFingerprint(j.frames);
  let g = groups.get(key);
  if (!g) {
    g = {
      key,
      frameCount: fc,
      size: { w: j.meta.size.w, h: j.meta.size.h },
      fingerprint: fp,
      sampleFile: f,
      sampleFrames: j.frames,
      members: [],
      identical: true,
    };
    groups.set(key, g);
  }
  g.members.push(f);
  if (fp !== g.fingerprint) g.identical = false;
}

console.log("=== STEP 1: geometry-group frame-rect verification ===");
let allIdentical = true;
for (const g of [...groups.values()].sort((a, b) => b.frameCount - a.frameCount)) {
  if (!g.identical) allIdentical = false;
  console.log(
    `  group ${g.key.padEnd(16)} members=${String(g.members.length).padStart(2)} ` +
      `frames-identical=${g.identical ? "YES" : "NO "} (sample: ${g.sampleFile})`
  );
}
console.log(
  allIdentical
    ? "  => ALL geometry groups have byte-identical frame rects (uniform untrimmed grid)."
    : "  => WARNING: at least one group is NOT identical; will pair by basename instead."
);
console.log("");

// ---------------------------------------------------------------------------
// STEP 1b: build a corrected JSON per mapped PNG and write the clean tree.
// ---------------------------------------------------------------------------

// Index source JSON basenames (without extension) for the fallback path.
const jsonByBase = new Map();
for (const f of allJsonFiles) {
  jsonByBase.set(path.basename(f, ".json").toLowerCase(), f);
}

/** Tokenize a filename into lowercased word tokens for fuzzy basename pairing. */
function tokens(name) {
  return name
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Find the source JSON to use for a given PNG.
 * - identicalGroup === true: any JSON of the matching geometry is fine; use the
 *   group's sample (frames are guaranteed identical).
 * - identicalGroup === false: pick the JSON whose basename best matches the
 *   PNG's state/basename tokens.
 */
function pickSourceFrames(pngFile, geom, group) {
  if (group && group.identical) {
    return { frames: group.sampleFrames, via: `geom-template:${group.sampleFile}` };
  }
  // Fallback: token-overlap match against JSON basenames of the same geometry.
  const want = new Set(tokens(pngFile));
  let best = null;
  let bestScore = -1;
  for (const jf of group ? group.members : allJsonFiles) {
    const score = tokens(jf).reduce((n, t) => n + (want.has(t) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = jf;
    }
  }
  const chosen = best || group?.sampleFile || allJsonFiles[0];
  return { frames: readJson(path.join(SRC, chosen)).frames, via: `basename-match:${chosen}` };
}

// Reset output tree for a clean, deterministic result.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const summary = {}; // creature -> [{state, frames, size, png, via}]
let totalClips = 0;
const problems = [];

for (const [creature, entries] of Object.entries(MAP)) {
  summary[creature] = [];
  const destDir = path.join(OUT, creature);
  fs.mkdirSync(destDir, { recursive: true });

  for (const [pngName, state] of entries) {
    const srcPng = path.join(SRC, pngName);
    if (!fs.existsSync(srcPng)) {
      problems.push(`MISSING PNG for ${creature}.${state}: ${pngName}`);
      continue;
    }
    const { w, h } = pngSize(srcPng);

    // Determine geometry from the PNG itself, then find its group.
    let group = null;
    for (const g of groups.values()) {
      if (g.size.w === w && g.size.h === h) {
        group = g;
        break;
      }
    }
    if (!group) {
      problems.push(
        `NO TEMPLATE for ${creature}.${state}: png is ${w}x${h}, no JSON group matches`
      );
      continue;
    }

    const { frames, via } = pickSourceFrames(pngName, { w, h }, group);

    // Build corrected JSON: copy frames + a fresh meta pointing at the sibling.
    const corrected = {
      frames,
      meta: {
        app: "https://ludo.ai",
        image: `${state}.png`,
        format: "RGBA8888",
        size: { w, h },
        scale: "1",
      },
    };

    // Write png (copy) + corrected json side by side.
    fs.copyFileSync(srcPng, path.join(destDir, `${state}.png`));
    fs.writeFileSync(
      path.join(destDir, `${state}.json`),
      JSON.stringify(corrected, null, 2)
    );

    const fc = frameCountOf(corrected);
    summary[creature].push({ state, frames: fc, size: `${w}x${h}`, png: pngName, via });
    totalClips++;
  }
}

// ---------------------------------------------------------------------------
// STEP 3: summary.
// ---------------------------------------------------------------------------
console.log("=== STEP 2/3: clean tree written to public/assets/anim/ ===");
for (const [creature, clips] of Object.entries(summary)) {
  console.log(`\n  ${creature} (${clips.length} clips):`);
  for (const c of clips) {
    console.log(
      `    ${c.state.padEnd(14)} frames=${String(c.frames).padStart(2)} ` +
        `${c.size.padEnd(11)} <= ${c.png}`
    );
  }
}

console.log(`\n  TOTAL CLIPS WRITTEN: ${totalClips}`);
if (problems.length) {
  console.log("\n  PROBLEMS:");
  for (const p of problems) console.log(`    ! ${p}`);
  process.exitCode = 1;
} else {
  console.log("  No problems. Every mapped PNG paired with a corrected JSON.");
}
