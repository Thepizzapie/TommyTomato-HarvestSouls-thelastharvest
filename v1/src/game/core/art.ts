// Procedural art. Stylized vector creatures + tiles, drawn each frame.
// One consistent "harvest gothic" palette, chunky outlines, squash/stretch,
// anticipation & follow-through — hand-crafted, not generic.
//
// Drawn every frame for ~30 entities, so helpers stay cheap: a couple of
// gradients per draw is fine, but nothing huge in tight inner loops.

type Ctx = CanvasRenderingContext2D;

// ---------- Palette (harvest gothic) ----------
const SOIL = "#0d0a09";
const TOMATO = "#d83a2e";
const DEEP = "#9e2018";
const BRIGHT = "#ff5742";
const ROT = "#6b7d3a";
const ROT_BRIGHT = "#9fb24e";
const SAP = "#e8b53a";
const SAP_BRIGHT = "#ffd56b";
const PARCH = "#e9dcc0";
const BLOOD = "#7a1414";
const OUTLINE = "#140d0a";

// ---------- Low-level helpers ----------
function blob(
  ctx: Ctx,
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill: string,
  outline = OUTLINE,
  lw = 3
) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (lw > 0) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = outline;
    ctx.stroke();
  }
}

// A shaded round body: base fill + radial depth + offset rim light, all
// clipped to the silhouette. The single workhorse for "3D-ish" creatures.
function orb(
  ctx: Ctx,
  x: number,
  y: number,
  rx: number,
  ry: number,
  base: string,
  opts: { lw?: number; rim?: string; light?: number; lightY?: number } = {}
) {
  const lw = opts.lw ?? 3;
  const lx = opts.light ?? -0.42;
  const ly = opts.lightY ?? -0.5;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = base;
  ctx.fill();
  ctx.clip();
  // core shadow (opposite the light)
  blob(ctx, x - lx * rx * 0.7, y - ly * ry * 0.7, rx * 0.95, ry * 0.95, "rgba(0,0,0,0.22)", OUTLINE, 0);
  // soft highlight toward the light
  blob(ctx, x + lx * rx * 0.7, y + ly * ry * 0.7, rx * 0.5, ry * 0.45, "rgba(255,255,255,0.20)", OUTLINE, 0);
  ctx.restore();
  if (lw > 0) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.lineWidth = lw;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    // crisp rim-light arc on the lit edge
    if (opts.rim) {
      ctx.beginPath();
      const a0 = Math.atan2(ly, lx) - 0.9;
      ctx.ellipse(x, y, rx, ry, 0, a0, a0 + 1.8);
      ctx.lineWidth = Math.max(1.2, lw - 1.3);
      ctx.strokeStyle = opts.rim;
      ctx.stroke();
    }
  }
}

function softShadow(ctx: Ctx, x: number, y: number, w: number, h: number, a = 0.32) {
  ctx.save();
  const g = ctx.createRadialGradient(x, y, 0, x, y, w);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function eye(ctx: Ctx, x: number, y: number, r: number, look = 0, lookY = 0) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#f6f0e0";
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(20,13,10,0.5)";
  ctx.stroke();
  const px = x + look * r * 0.45;
  const py = y + lookY * r * 0.45;
  ctx.beginPath();
  ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = OUTLINE;
  ctx.fill();
  // catchlight
  ctx.beginPath();
  ctx.arc(px - r * 0.18, py - r * 0.18, r * 0.18, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
}

// ---------- Menacing eyes (no big white sclera — that read "cute") ----------
// A small predatory eye: a dark socket, a saturated glowing iris that can flare,
// and a single hard glint. Cheap: one optional shadowBlur, a few arcs.
function feralEye(
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  iris: string,
  opts: { glint?: number; glow?: number; lookX?: number; lookY?: number; flash?: boolean } = {}
) {
  const lx = (opts.lookX ?? 0) * r * 0.35;
  const ly = (opts.lookY ?? 0) * r * 0.35;
  // dark wet socket
  ctx.beginPath();
  ctx.arc(x, y, r * 1.25, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8,4,3,0.85)";
  ctx.fill();
  // iris (optionally emissive so it stays alive on a black floor)
  const g = opts.glow ?? 0;
  if (g > 0) { ctx.save(); ctx.shadowColor = iris; ctx.shadowBlur = g; }
  ctx.beginPath();
  ctx.arc(x + lx, y + ly, r, 0, Math.PI * 2);
  ctx.fillStyle = opts.flash ? "#fff" : iris;
  ctx.fill();
  if (g > 0) ctx.restore();
  // constricted pupil
  ctx.beginPath();
  ctx.arc(x + lx, y + ly, r * 0.42, 0, Math.PI * 2);
  ctx.fillStyle = OUTLINE;
  ctx.fill();
  // hard predator glint
  const gl = opts.glint ?? 0.85;
  if (gl > 0) {
    ctx.beginPath();
    ctx.arc(x + lx - r * 0.3, y + ly - r * 0.34, r * 0.26, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${gl})`;
    ctx.fill();
  }
}

// A cluster of tiny insect eyes (compound), packed around a center, all the
// same blood/amber tone with one shared glint. Reads buggy and wrong, not cute.
function compoundEye(
  ctx: Ctx,
  cx: number,
  cy: number,
  r: number,
  iris: string,
  glow = 0,
  flash = false
) {
  if (glow > 0) { ctx.save(); ctx.shadowColor = iris; ctx.shadowBlur = glow; }
  ctx.fillStyle = flash ? "#fff" : iris;
  // center facet + a ring of smaller facets
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  const fr = r * 0.55;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, fr, 0, Math.PI * 2);
    ctx.fill();
  }
  if (glow > 0) ctx.restore();
  // dark rim seam + a couple of dark facet pupils
  ctx.fillStyle = "rgba(8,4,3,0.5)";
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2); ctx.fill();
  // single sharp glint over the whole cluster
  ctx.beginPath();
  ctx.arc(cx - r * 0.7, cy - r * 0.7, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fill();
}

// A single hungry vertical slit-eye (reptile/vermin). Glows when fed `glow`.
function slitEye(ctx: Ctx, x: number, y: number, r: number, iris: string, glow = 0, flash = false) {
  ctx.beginPath();
  ctx.arc(x, y, r * 1.15, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8,4,3,0.85)";
  ctx.fill();
  if (glow > 0) { ctx.save(); ctx.shadowColor = iris; ctx.shadowBlur = glow; }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = flash ? "#fff" : iris;
  ctx.fill();
  if (glow > 0) ctx.restore();
  // vertical slit pupil
  ctx.beginPath();
  ctx.ellipse(x, y, r * 0.28, r * 0.95, 0, 0, Math.PI * 2);
  ctx.fillStyle = OUTLINE;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.fill();
}

// Stitched X eye that flares ember when `flare`>0 (scarecrow / king).
function stitchX(ctx: Ctx, cx: number, cy: number, sz: number, flare: number, flash: boolean) {
  const col = flash ? "#fff" : flare > 0 ? BRIGHT : "#241008";
  if (flare > 0.01) { ctx.save(); ctx.shadowColor = BRIGHT; ctx.shadowBlur = 6 + flare * 12; }
  ctx.strokeStyle = col;
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - sz, cy - sz); ctx.lineTo(cx + sz, cy + sz);
  ctx.moveTo(cx + sz, cy - sz); ctx.lineTo(cx - sz, cy + sz);
  ctx.stroke();
  // stitch ticks across each stroke
  ctx.lineWidth = 1.2;
  for (const [ax, ay] of [[-sz * 0.4, -sz * 0.4], [sz * 0.4, sz * 0.4], [sz * 0.4, -sz * 0.4], [-sz * 0.4, sz * 0.4]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(cx + ax - 1.6, cy + ay + 1.6);
    ctx.lineTo(cx + ax + 1.6, cy + ay - 1.6);
    ctx.stroke();
  }
  if (flare > 0.01) ctx.restore();
}

// a triangular fang/spine pointing up from (x,y); cheap reusable menace bit
function fang(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string) {
  ctx.beginPath();
  ctx.moveTo(x - w, y);
  ctx.lineTo(x, y - h);
  ctx.lineTo(x + w, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

// glow dot — used for embers, sap motes, telegraph cores
function glowDot(ctx: Ctx, x: number, y: number, r: number, color: string, blur = 10) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// a tapering limb (vine / tentacle / arm) drawn as a smooth quad
function limb(
  ctx: Ctx,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  w: number,
  color: string
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.stroke();
}

function leaf(ctx: Ctx, len: number, w: number, fill: string) {
  // a single pointed leaf along +y from origin, with a midrib
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-w, -len * 0.5, 0, -len);
  ctx.quadraticCurveTo(w, -len * 0.5, 0, 0);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -2);
  ctx.lineTo(0, -len * 0.85);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(20,13,10,0.45)";
  ctx.stroke();
}

// leafy crown used by the hero and a couple of tomato kin
function tomatoCrown(ctx: Ctx, cy: number, scale = 1, fill = "#4e8b3a", sway = 0) {
  ctx.save();
  ctx.translate(0, cy);
  for (const a of [-0.95, -0.34, 0.34, 0.95]) {
    ctx.save();
    ctx.rotate(a + sway * (a > 0 ? 1 : -1));
    ctx.scale(scale, scale);
    leaf(ctx, 13, 4.2, fill);
    ctx.restore();
  }
  // stem nub
  ctx.fillStyle = "#6b3b1f";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-1.8 * scale, -8 * scale, 3.6 * scale, 8 * scale, 1.5) : ctx.rect(-1.8 * scale, -8 * scale, 3.6 * scale, 8 * scale);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ---------- The hero: Tommy ----------
export type WeaponKind = "whip" | "dagger" | "mace" | "rapier";

export interface HeroVisual {
  facing: number; // radians
  walkPhase: number; // for leg bob
  moving: boolean;
  rolling: boolean; // squash
  attacking: number; // 0..1 swing progress, 0 = idle
  hurt: number; // 0..1 flash
  invuln: boolean;
  blocking: boolean;
  tint: string; // body color (co-op variants)
  dead?: boolean;
  ghost?: boolean; // remote phantom rendering
  // --- optional extensions (callers may omit; safe defaults below) ---
  weapon?: WeaponKind; // which armament to render during attacks (default "whip")
  heavy?: boolean; // heavy/charged swing -> wider, slower arc & follow-through
  charging?: number; // 0..1 charge-up of a heavy strike (anticipation pose + aura)
  parrying?: number; // 0..1 active parry flick (brief shield punch + spark)
  riposte?: number; // 0..1 critical riposte lunge (forward stab pose)
  staggered?: boolean; // poise-broken: slumped, wobbling
}

export function drawHero(ctx: Ctx, x: number, y: number, v: HeroVisual, t: number) {
  const weapon = v.weapon ?? "whip";
  ctx.save();
  ctx.translate(x, y);
  if (v.ghost) ctx.globalAlpha = 0.55;

  const atk = v.attacking;
  // anticipation(early) -> swing(mid) -> follow-through(late) eased from atk(1->0)
  const swingT = 1 - atk; // 0 at start of attack, 1 at end
  const charge = v.charging ?? 0;
  const stagWob = v.staggered ? Math.sin(t * 22) * 0.12 : 0;

  const bob = v.moving ? Math.sin(v.walkPhase) * 2.2 : Math.sin(t * 2) * 1.2;
  const lean = v.moving ? Math.cos(v.walkPhase) * 0.07 : 0;

  // squash/stretch: roll squashes, hurt squashes harder, charge stretches up a touch
  let squashX = 1, squashY = 1;
  if (v.rolling) { squashX = 1.28; squashY = 0.74; }
  else if (v.hurt > 0) { squashX = 1.18; squashY = 0.84; }
  else if (charge > 0) { squashX = 1 - charge * 0.06; squashY = 1 + charge * 0.06; }
  // attack anticipation = slight crouch, follow-through = slight overstretch
  if (atk > 0 && !v.rolling) {
    const ant = Math.max(0, atk - 0.6) / 0.4; // last 40% before swing
    const fol = Math.max(0, 0.5 - atk) / 0.5; // after swing
    squashY *= 1 - ant * 0.08 + fol * 0.05;
    squashX *= 1 + ant * 0.05 - fol * 0.03;
  }

  // ---- drop shadow (squashes wide & faint during roll, tight when staggered) ----
  softShadow(ctx, 0, 17, 16 * squashX, 5.4 * (v.rolling ? 1.15 : 1), v.rolling ? 0.22 : 0.34);

  // ---- motion trail during roll (i-frame ghosting) ----
  if (v.rolling) {
    ctx.save();
    ctx.globalAlpha = (v.ghost ? 0.3 : 0.5) * 0.4;
    const tdx = -Math.cos(v.facing) * 10;
    const tdy = -Math.sin(v.facing) * 10;
    blob(ctx, tdx, bob, 15 * squashX, 14 * squashY, v.tint, OUTLINE, 0);
    ctx.globalAlpha = (v.ghost ? 0.3 : 0.5) * 0.22;
    blob(ctx, tdx * 1.8, bob, 14 * squashX, 13 * squashY, v.tint, OUTLINE, 0);
    ctx.restore();
  }

  // ---- charge aura (anticipation tell) ----
  if (charge > 0 && !v.dead) {
    ctx.save();
    ctx.globalAlpha = 0.25 + charge * 0.35 + Math.sin(t * 24) * 0.08;
    glowDot(ctx, 0, bob, 20 + charge * 6, v.heavy ? BRIGHT : SAP_BRIGHT, 18);
    ctx.restore();
  }

  ctx.save();
  ctx.translate(0, bob);
  ctx.rotate(lean + stagWob);
  ctx.scale(squashX, squashY);

  // ---- weapon BEHIND body during wind-up / heavy backswing (drawn under) ----
  if (!v.dead && (charge > 0 || (atk > 0.65))) {
    drawWeapon(ctx, weapon, v, atk, charge, true);
  }

  // ---- leaf legs with believable walk cycle ----
  ctx.strokeStyle = "#3c6b2f";
  ctx.lineWidth = 4.2;
  ctx.lineCap = "round";
  const legSwing = v.moving ? Math.sin(v.walkPhase) * 6 : 0;
  const legLift = v.moving ? Math.max(0, Math.cos(v.walkPhase)) * 3 : 0;
  const stance = v.blocking ? 9 : 6;
  ctx.beginPath();
  ctx.moveTo(-stance, 11);
  ctx.lineTo(-stance - legSwing, 20 - legLift);
  ctx.moveTo(stance, 11);
  ctx.lineTo(stance + legSwing, 20 - (v.moving ? Math.max(0, -Math.cos(v.walkPhase)) * 3 : 0));
  ctx.stroke();
  // little foot leaves
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * stance + sx * legSwing * 0.5, 20);
    ctx.rotate(sx * 0.5);
    leaf(ctx, 6, 2.4, "#3c6b2f");
    ctx.restore();
  }

  // ---- body (tomato) with rich shading ----
  const lookSrc = v.facing;
  const lightX = -0.42 + Math.cos(lookSrc) * 0.12;
  const body = v.hurt > 0 ? "#ffffff" : v.tint;
  orb(ctx, 0, 0, 16, 15, body, {
    rim: v.hurt > 0 ? "#fff" : BRIGHT,
    light: lightX,
    lightY: -0.5,
  });
  // subtle tomato ribs
  if (v.hurt <= 0) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 0, 16, 15, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = "rgba(20,13,10,0.12)";
    ctx.lineWidth = 1.5;
    for (const rx of [-7, 0, 7]) {
      ctx.beginPath();
      ctx.moveTo(rx, -14);
      ctx.quadraticCurveTo(rx * 1.6, 0, rx, 14);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---- leafy crown ----
  const crownSway = Math.sin(t * 3) * 0.05 + (v.moving ? Math.cos(v.walkPhase) * 0.06 : 0);
  tomatoCrown(ctx, -14, 1, "#4e8b3a", crownSway);

  // ---- face — eyes track facing, expressions per state ----
  const lx = Math.cos(v.facing) * 0.8;
  const ly = Math.sin(v.facing) * 0.8;
  if (v.dead) {
    drawXEyes(ctx, -5, -1, 5, 3.2);
    drawXEyes(ctx, 5, -1, 5, 3.2);
    // slack frown
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-4, 9);
    ctx.quadraticCurveTo(0, 6, 4, 9);
    ctx.stroke();
  } else if (v.staggered) {
    // dizzy spirals -> simplified swirly eyes
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    for (const ex of [-5, 5]) {
      ctx.beginPath();
      ctx.arc(ex, -1, 3, 0, Math.PI * 1.6);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(0, 8, 3, 2.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#5a1410";
    ctx.fill();
  } else {
    const wide = charge > 0.2 || atk > 0.6; // determined/wide during anticipation
    const r = wide ? 3.8 : 3.4;
    eye(ctx, -5, -1, r, lx, ly);
    eye(ctx, 5, -1, r, lx, ly);
    // brow furrow when charging/attacking
    if (wide) {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-8, -5.5); ctx.lineTo(-2, -4);
      ctx.moveTo(8, -5.5); ctx.lineTo(2, -4);
      ctx.stroke();
    }
    // mouth
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    if (atk > 0 && atk < 0.7) {
      // open battle-shout during the swing
      ctx.ellipse(0, 7, 4.2, 3.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = "#5a1410";
      ctx.fill();
    } else if (v.blocking) {
      ctx.moveTo(-3.5, 8); ctx.lineTo(3.5, 8); // flat braced
    } else {
      ctx.moveTo(-4, 7); ctx.quadraticCurveTo(0, 9, 4, 7); // tiny set frown
    }
    ctx.stroke();
  }
  ctx.restore(); // end body transform

  // ---- weapon in FRONT (normal case) ----
  // Drawn here unless it was already drawn BEHIND the body above (deep
  // anticipation / charge wind-up). Riposte is always a forward stab.
  const drewBehind = charge > 0 || atk > 0.65;
  if (!v.dead && ((v.riposte ?? 0) > 0 || (atk > 0 && !drewBehind))) {
    drawWeapon(ctx, weapon, v, atk, charge, false);
  }

  // ---- guard: leafy shield braced toward facing ----
  if (v.blocking && !v.dead) {
    ctx.save();
    ctx.rotate(v.facing);
    const punch = (v.parrying ?? 0) * 8; // parry flick pushes shield out
    ctx.translate(15 + punch, 0);
    // shield body
    ctx.save();
    ctx.scale(1, 1.0);
    orb(ctx, 0, 0, 7, 13, "#5e9b3f", { lw: 2.6, rim: ROT_BRIGHT, light: -0.3 });
    ctx.restore();
    // central vein boss
    blob(ctx, 0, 0, 2.4, 6, "#3c6b2f", OUTLINE, 1.5);
    if ((v.parrying ?? 0) > 0) {
      ctx.globalAlpha = v.parrying!;
      glowDot(ctx, 4, 0, 5, SAP_BRIGHT, 14);
      // spark burst
      ctx.strokeStyle = SAP_BRIGHT;
      ctx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI - Math.PI / 2;
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.lineTo(4 + Math.cos(a) * 12, Math.sin(a) * 12);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  // ---- riposte flash ----
  if ((v.riposte ?? 0) > 0 && !v.dead) {
    ctx.save();
    ctx.globalAlpha = (v.riposte ?? 0) * 0.6;
    glowDot(ctx, Math.cos(v.facing) * 30, Math.sin(v.facing) * 30 + bob, 8, SAP_BRIGHT, 16);
    ctx.restore();
  }

  // ---- invuln shimmer (roll i-frames) ----
  if (v.invuln && !v.dead) {
    ctx.save();
    ctx.globalAlpha = 0.35 + Math.sin(t * 30) * 0.18;
    ctx.lineWidth = 2;
    ctx.strokeStyle = ROT_BRIGHT;
    ctx.beginPath();
    ctx.ellipse(0, bob, 20, 19, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

function drawXEyes(ctx: Ctx, cx: number, cy: number, sz: number, off: number) {
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(cx - off, cy - off + 1);
  ctx.lineTo(cx + off, cy + off - 1);
  ctx.moveTo(cx + off, cy - off + 1);
  ctx.lineTo(cx - off, cy + off - 1);
  ctx.stroke();
}

// ---------- Weapons (rendered relative to body origin; rotates to facing) ----------
function drawWeapon(
  ctx: Ctx,
  kind: WeaponKind,
  v: HeroVisual,
  atk: number,
  charge: number,
  behind: boolean
) {
  const heavy = v.heavy ?? false;
  const riposte = v.riposte ?? 0;
  ctx.save();
  ctx.rotate(v.facing);

  if (riposte > 0 && atk <= 0) {
    // straight forward thrust pose used for all weapons on riposte
    const reach = 14 + riposte * 22;
    ctx.translate(reach, 0);
  }

  // swing arc: anticipation (atk~1) pulls back, release sweeps forward,
  // follow-through (atk~0) overshoots slightly then settles.
  const arcWide = heavy ? 2.4 : 1.7;
  let swing: number;
  if (atk > 0.7) swing = -arcWide * 0.6 - charge * 0.5; // wind back
  else if (atk > 0.15) swing = (0.7 - atk) / 0.55 * arcWide - arcWide * 0.6; // sweep through
  else swing = arcWide * 0.4 + Math.sin(atk * 20) * 0.08; // follow-through + jitter settle

  switch (kind) {
    case "dagger": {
      // short fast blade: quick, low arc
      ctx.rotate(swing * 0.7);
      ctx.strokeStyle = "#6b4a2a";
      ctx.lineWidth = 3.2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(15, 0);
      ctx.stroke();
      // blade
      ctx.beginPath();
      ctx.moveTo(15, -2.4);
      ctx.lineTo(27, 0);
      ctx.lineTo(15, 2.4);
      ctx.closePath();
      ctx.fillStyle = "#d7dbe2";
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = OUTLINE;
      ctx.stroke();
      glowDot(ctx, 27, 0, 1.5, "rgba(255,255,255,0.8)", 6);
      break;
    }
    case "mace": {
      // heavy beet-on-a-stick: big head, slow wide arc
      ctx.rotate(swing);
      ctx.strokeStyle = "#6b4a2a";
      ctx.lineWidth = 4.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(6, 0);
      ctx.lineTo(30, 0);
      ctx.stroke();
      // beet head (deep red root)
      orb(ctx, 34, 0, 9, 10, "#8e1f3a", { lw: 2.6, rim: "#c8456a", light: -0.3 });
      // leafy tuft on the beet
      ctx.save();
      ctx.translate(34, -9);
      ctx.scale(0.7, 0.7);
      leaf(ctx, 9, 3, "#3c6b2f");
      ctx.restore();
      // stubby root tip
      ctx.strokeStyle = "#5a1226";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(40, 6);
      ctx.lineTo(45, 11);
      ctx.stroke();
      break;
    }
    case "rapier": {
      // thin thorn rapier: long straight precise
      ctx.rotate(swing * 0.55);
      ctx.strokeStyle = "#3c2a18";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(9, 0, 4, -Math.PI / 2, Math.PI / 2); // basket guard
      ctx.stroke();
      // long thorn blade
      ctx.strokeStyle = "#caa0d8";
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(40, 0);
      ctx.stroke();
      // tiny thorn barbs
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "#8a5fa0";
      for (const tx of [18, 26, 34]) {
        ctx.beginPath();
        ctx.moveTo(tx, 0);
        ctx.lineTo(tx - 3, -3);
        ctx.stroke();
      }
      glowDot(ctx, 40, 0, 1.6, "rgba(220,200,255,0.9)", 6);
      break;
    }
    case "whip":
    default: {
      // default vine-whip: lashing organic curve, thorn tip
      ctx.rotate(swing * 0.5);
      const lash = Math.sin((1 - atk) * Math.PI) * 6;
      ctx.strokeStyle = "#8fbf5a";
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.quadraticCurveTo(22, -4 - lash, 34, 2 + lash);
      ctx.stroke();
      // thorns along the vine
      ctx.fillStyle = "#3c6b2f";
      for (const tx of [16, 24]) {
        ctx.beginPath();
        ctx.moveTo(tx, -2);
        ctx.lineTo(tx + 2, -6);
        ctx.lineTo(tx + 4, -2);
        ctx.closePath();
        ctx.fill();
      }
      blob(ctx, 34, 2 + lash, 4, 4, "#cfe6a0", "#3c6b2f", 2);
      break;
    }
  }
  ctx.restore();
}

// ---------- Enemies ----------
export type EnemyKind =
  | "aphid"
  | "crow"
  | "slug"
  | "weed"
  | "scarecrow"
  | "drone"
  | "grub"
  | "king" // boss: Scarecrow King
  | "harvester" // boss: combine-beast
  // --- new roster ---
  | "mite" // tiny hopping speck-swarm
  | "beetle" // armored, front carapace
  | "hornet" // fast wasp w/ stinger
  | "spore" // rooted puffball, releases gas
  | "oldtom"; // boss: Old Tom, the First Fruit

export interface EnemyVisual {
  kind: EnemyKind;
  facing: number;
  phase: number;
  hurt: number;
  attacking: number; // telegraph/active 0..1
  hp01: number; // health fraction (boss bars etc.)
  windup: boolean; // glowing telegraph
  big?: number; // size multiplier
  // --- optional extensions ---
  staggered?: boolean; // poise broken: limbs slump, guard drops (beetle exposes back)
  poisoned?: boolean; // sickly green overlay + drip motes
  variant?: number; // small per-instance look variation (0..n), keeps swarms from twinning
}

export function drawEnemy(ctx: Ctx, x: number, y: number, v: EnemyVisual, t: number) {
  ctx.save();
  ctx.translate(x, y);
  const s = v.big || 1;
  ctx.scale(s, s);
  const flash = v.hurt > 0;

  // telegraph ring (skip for kinds that telegraph their own way)
  if (v.windup && v.kind !== "harvester" && v.kind !== "oldtom" && v.kind !== "spore") {
    ctx.save();
    const pr = 26 + Math.sin(t * 18) * 3;
    ctx.globalAlpha = 0.5 + Math.sin(t * 18) * 0.2;
    ctx.beginPath();
    ctx.arc(0, 0, pr, 0, Math.PI * 2);
    ctx.strokeStyle = BRIGHT;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  }

  switch (v.kind) {
    case "aphid": drawAphid(ctx, v, t, flash); break;
    case "crow": drawCrow(ctx, v, t, flash); break;
    case "slug": drawSlug(ctx, v, t, flash); break;
    case "weed": drawWeed(ctx, v, t, flash); break;
    case "scarecrow": drawScarecrow(ctx, v, t, flash, false); break;
    case "drone": drawDrone(ctx, v, t, flash); break;
    case "grub": drawGrub(ctx, v, t, flash); break;
    case "king": drawScarecrow(ctx, v, t, flash, true); break;
    case "harvester": drawHarvester(ctx, v, t, flash); break;
    case "mite": drawMite(ctx, v, t, flash); break;
    case "beetle": drawBeetle(ctx, v, t, flash); break;
    case "hornet": drawHornet(ctx, v, t, flash); break;
    case "spore": drawSpore(ctx, v, t, flash); break;
    case "oldtom": drawOldTom(ctx, v, t, flash); break;
  }

  // poison overlay (cheap, on top of any kind)
  if (v.poisoned) {
    ctx.save();
    ctx.globalAlpha = 0.18 + Math.sin(t * 5) * 0.06;
    blob(ctx, 0, 0, 16, 15, "#7bd13a", OUTLINE, 0);
    ctx.globalAlpha = 0.8;
    for (let i = 0; i < 3; i++) {
      const dy = ((t * 18 + i * 9) % 22) - 6;
      glowDot(ctx, Math.sin(t * 3 + i) * 8, dy, 1.4, "#9fe04e", 6);
    }
    ctx.restore();
  }

  ctx.restore();
}

function shadow(ctx: Ctx, w: number, yy = 14) {
  softShadow(ctx, 0, yy, w, w * 0.34, 0.32);
}

function drawAphid(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // Bloated sap-tick: a swollen translucent abdomen with guts pulsing inside,
  // a small armored head with a needle proboscis it stabs into fruit.
  shadow(ctx, 12);
  const va = v.variant ?? 0;
  const bob = Math.sin(v.phase * 2 + va) * 1.4;
  ctx.translate(0, bob);
  ctx.rotate((va % 3 - 1) * 0.06); // slight per-instance tilt so swarms differ
  const fx = Math.cos(v.facing), fy = Math.sin(v.facing);

  // skittering legs — 3 per side, jointed, twitchy
  ctx.strokeStyle = flash ? "#fff" : "#2c3d17";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (const sx of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      const tw = Math.sin(v.phase * 5 + i * 1.4 + (sx > 0 ? 1.5 : 0)) * 2.2;
      const ky = i * 4 - 1; // hip
      const kx = sx * 7, kn = sx * 11; // knee, foot
      ctx.beginPath();
      ctx.moveTo(sx * 4, ky);
      ctx.lineTo(kx, ky - 2 + tw * 0.4);
      ctx.lineTo(kn, ky + 4 + tw);
      ctx.stroke();
    }
  }

  // swollen translucent abdomen (rear/back) — sap-distended, sickly green
  const abC = flash ? "#fff" : "#86b84a";
  orb(ctx, -2, 1, 11, 10, abC, { lw: 2.6, rim: "#cdef8c", light: -0.42 });
  // guts pulsing through the translucent skin
  if (!flash) {
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(-2, 1, 11, 10, 0, 0, Math.PI * 2);
    ctx.clip();
    const pulse = 0.5 + Math.sin(v.phase * 3 + va) * 0.5;
    // dark sap sacs
    blob(ctx, -3, 3, 5 + pulse * 1.5, 5, "rgba(60,40,16,0.45)", OUTLINE, 0);
    blob(ctx, 1, -2, 3, 3, "rgba(40,55,20,0.5)", OUTLINE, 0);
    // veins
    ctx.strokeStyle = "rgba(30,45,15,0.45)";
    ctx.lineWidth = 1;
    for (const a of [0.6, 2.0, 3.6, 5.0]) {
      ctx.beginPath();
      ctx.moveTo(-2, 1);
      ctx.lineTo(-2 + Math.cos(a) * 10, 1 + Math.sin(a) * 9);
      ctx.stroke();
    }
    ctx.restore();
  }
  // dorsal segment seams
  ctx.strokeStyle = "rgba(20,30,8,0.35)";
  ctx.lineWidth = 1;
  for (const ox of [-6, -1, 4]) {
    ctx.beginPath();
    ctx.ellipse(ox - 2, 1, 2, 8, 0, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }
  // back cornicles (paired exhaust tubes leaking sap)
  ctx.strokeStyle = flash ? "#fff" : "#2c3d17";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-9, -5); ctx.lineTo(-12, -10);
  ctx.moveTo(-5, -7); ctx.lineTo(-6, -12);
  ctx.stroke();

  // small armored head toward facing
  ctx.save();
  ctx.rotate(v.facing);
  orb(ctx, 8, 0, 4.5, 4, flash ? "#fff" : "#3f5520", { lw: 2.2, rim: "#7a9a3a", light: -0.4 });
  // needle proboscis — stabs forward on attack
  const reach = 6 + v.attacking * 7;
  ctx.strokeStyle = flash ? "#fff" : "#1c1208";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(11, 0); ctx.lineTo(11 + reach, 0);
  ctx.stroke();
  if (v.windup || v.attacking > 0) glowDot(ctx, 11 + reach, 0, 1.3, "#cdef8c", 6);
  // antennae
  ctx.lineWidth = 1.2;
  const aw = Math.sin(v.phase * 4) * 1.4;
  ctx.beginPath();
  ctx.moveTo(9, -3); ctx.lineTo(13 + aw, -7);
  ctx.moveTo(9, 3); ctx.lineTo(13 + aw, 7);
  ctx.stroke();
  ctx.restore();

  // compound eyes on the head, blood-amber, faint glow on windup
  const ex = 8 * fx, ey = 8 * fy;
  const px = -fy, py = fx; // perpendicular to facing
  compoundEye(ctx, ex + px * 2.4, ey + py * 2.4, 1.7, "#b8341e", v.windup ? 6 : 0, flash);
  compoundEye(ctx, ex - px * 2.4, ey - py * 2.4, 1.7, "#b8341e", v.windup ? 6 : 0, flash);
}

function drawGrub(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // Fat pale cutworm: glossy bloated segments, a ring of tiny hooked prolegs,
  // and a round rasping mouth full of little teeth that dilates to feed.
  shadow(ctx, 14);
  const sick = v.poisoned ? "#b9c87a" : "#ddc99a";
  const wig = Math.sin(v.phase * 2.6) * 3.4;

  // grub curls UP toward facing when winding up (rearing to bite)
  const rear = v.windup ? 0.35 : v.attacking * 0.2;

  // body segments, each shaded, trailing the head (head at +x)
  for (let i = 4; i >= 0; i--) {
    const segC = flash ? "#fff" : i <= 1 ? "#ede0bc" : sick;
    const segX = -i * 6 + 11;
    const segY = wig * (i / 5) - rear * (4 - i) * 2;
    const rr = 8.5 - i * 0.9;
    orb(ctx, segX, segY, rr, rr - 1.2, segC, { lw: 2.4, rim: "#fff7e2", light: -0.3 });
    // glossy wet highlight band on each segment
    if (!flash) blob(ctx, segX - 1.5, segY - rr * 0.5, rr * 0.45, rr * 0.25, "rgba(255,255,255,0.35)", OUTLINE, 0);
  }
  // deep creases between segments
  ctx.strokeStyle = "rgba(40,24,12,0.3)";
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 4; i++) {
    const sx = -i * 6 + 8;
    const sy = wig * (i / 5) - rear * (4 - i) * 2;
    ctx.beginPath();
    ctx.ellipse(sx, sy, 2.2, 6.5 - i * 0.7, 0, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  }
  // ring of tiny hooked prolegs along the underside
  ctx.strokeStyle = flash ? "#fff" : "#8a6a3a";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const sx = -i * 6 + 6;
    const sy = wig * (i / 5) - rear * (4 - i) * 2 + 6;
    const tw = Math.sin(v.phase * 5 + i) * 1.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 2); ctx.lineTo(sx - 2 + tw, sy + 2);
    ctx.moveTo(sx + 2, sy - 2); ctx.lineTo(sx + 4 + tw, sy + 2);
    ctx.stroke();
  }

  // head segment
  const hx = 11, hy = wig * 0 - rear * 8;
  // round rasping maw — dilates with attack
  const open = 1.4 + v.attacking * 3.2;
  ctx.beginPath();
  ctx.arc(hx + 4, hy + 1, open + 1.6, 0, Math.PI * 2);
  ctx.fillStyle = "#1a0a08";
  ctx.fill();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  // ring of inward rasping teeth
  ctx.fillStyle = "#e6d6a8";
  const teeth = 8;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const tr = open + 1.4;
    const txx = hx + 4 + Math.cos(a) * tr;
    const tyy = hy + 1 + Math.sin(a) * tr;
    ctx.beginPath();
    ctx.moveTo(txx, tyy);
    ctx.lineTo(txx - Math.cos(a) * 2.2 - Math.sin(a) * 1.2, tyy - Math.sin(a) * 2.2 + Math.cos(a) * 1.2);
    ctx.lineTo(txx - Math.cos(a) * 2.2 + Math.sin(a) * 1.2, tyy - Math.sin(a) * 2.2 - Math.cos(a) * 1.2);
    ctx.closePath();
    ctx.fill();
  }
  // tiny hungry slit eyes flanking the maw (no white)
  slitEye(ctx, hx, hy - 4, 1.6, "#7a1d12", v.windup ? 5 : 0, flash);
  slitEye(ctx, hx + 6, hy - 4, 1.6, "#7a1d12", v.windup ? 5 : 0, flash);
}

function drawCrow(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // Gaunt carrion crow: ragged moulting feathers, a hunched neck, a cruel ajar
  // beak, and cold dead pinpoint eyes. Lunges (beak forward) on attack.
  shadow(ctx, 14, 16);
  const flap = Math.sin(v.phase * 6) * 26 - 6;
  const c = flash ? "#fff" : "#23212a";
  const bx = Math.cos(v.facing), by = Math.sin(v.facing);
  const lunge = v.attacking; // pitch forward when striking
  ctx.translate(bx * lunge * 4, by * lunge * 4);

  // ragged wings (behind, flapping) — uneven, gappy quills
  ctx.lineCap = "round";
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * 8, -2);
    ctx.rotate((sx * flap * Math.PI) / 180);
    for (let f = 0; f < 4; f++) {
      const miss = f === 2; // a missing/short feather -> moulting
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(
        sx * (9 + f * 3), -3 - f,
        sx * (14 + f * (miss ? 1.5 : 4)), 2 + f * 3
      );
      ctx.lineWidth = (5 - f) * (miss ? 0.6 : 1);
      ctx.strokeStyle = flash ? "#fff" : "#15131b";
      ctx.stroke();
      // split feather tips (frayed)
      if (!miss && f < 3) {
        const tx = sx * (14 + f * 4), ty = 2 + f * 3;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(tx, ty); ctx.lineTo(tx + sx * 3, ty + 3);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // hunched body — slightly egg-shaped, leaning toward facing
  orb(ctx, -bx * 2, -by * 2 + 1, 11, 12, c, { lw: 2.8, rim: "#46435a", light: -0.42 });
  // breast feather texture (a few V-ticks)
  if (!flash) {
    ctx.strokeStyle = "rgba(70,67,90,0.5)";
    ctx.lineWidth = 1;
    for (const [vx, vy] of [[-3, 2], [3, 3], [0, 6], [-2, 8]] as [number, number][]) {
      ctx.beginPath();
      ctx.moveTo(vx - 2, vy); ctx.lineTo(vx, vy + 2); ctx.lineTo(vx + 2, vy);
      ctx.stroke();
    }
  }
  // ragged tail (split into separate ratty feathers)
  ctx.strokeStyle = flash ? "#fff" : "#15131b";
  ctx.lineWidth = 3;
  for (const sp of [-3, 0, 3]) {
    ctx.beginPath();
    ctx.moveTo(-bx * 7, -by * 7);
    ctx.lineTo(-bx * 20 + sp * by, -by * 20 - sp * bx);
    ctx.stroke();
  }

  // head + neck, thrust toward facing
  orb(ctx, bx * 7, by * 7 - 2, 6, 6, c, { lw: 2.4, rim: "#46435a", light: -0.4 });
  // beak — open (caw/peck) wider during attack
  const gap = 1.6 + lunge * 3;
  ctx.fillStyle = flash ? "#fff" : "#caa24a";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.4;
  // upper mandible
  ctx.beginPath();
  ctx.moveTo(bx * 10 - by * gap, by * 10 + bx * gap);
  ctx.lineTo(bx * 22, by * 22 - 1);
  ctx.lineTo(bx * 12, by * 12);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // lower mandible
  ctx.beginPath();
  ctx.moveTo(bx * 10 + by * gap, by * 10 - bx * gap);
  ctx.lineTo(bx * 20, by * 20 + 1);
  ctx.lineTo(bx * 12, by * 12);
  ctx.closePath();
  ctx.fillStyle = flash ? "#fff" : "#a07d2c";
  ctx.fill(); ctx.stroke();

  // cold dead eyes — pale pinpoint, no warmth, faint sickly glow
  const px = -by, py = bx;
  for (const s of [-1, 1]) {
    const ex = bx * 6 + px * s * 2.6, ey = by * 6 - 2 + py * s * 2.6;
    // pale ring
    ctx.beginPath();
    ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = flash ? "#fff" : "#cfcabf";
    ctx.fill();
    // tiny black pinpoint pupil (no catchlight -> lifeless)
    ctx.beginPath();
    ctx.arc(ex, ey, 0.9, 0, Math.PI * 2);
    ctx.fillStyle = OUTLINE;
    ctx.fill();
  }
}

function drawSlug(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // Bloated salt-weeping slug: a glistening swollen mantle, a corrosive slime
  // wake, luminous eye-stalks, and a slick body that oozes. Head leads +x.
  shadow(ctx, 19);
  const c = flash ? "#fff" : "#6f4f96";
  const dark = flash ? "#fff" : "#4e3370";

  // corrosive slime trail behind (greenish, eats the soil)
  ctx.save();
  ctx.globalAlpha = 0.35;
  const g = ctx.createLinearGradient(-26, 0, 10, 0);
  g.addColorStop(0, "rgba(120,170,90,0)");
  g.addColorStop(1, "rgba(150,200,110,0.5)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(-8, 12, 24, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // pitted/bubbling slime spots in the wake
  for (let i = 0; i < 3; i++) {
    const sx = -6 - i * 7 + Math.sin(t * 2 + i) * 1.5;
    ctx.save();
    ctx.globalAlpha = 0.4;
    glowDot(ctx, sx, 12, 1.6, "rgba(170,210,110,0.7)", 5);
    ctx.restore();
  }

  // long low body (foot) trailing behind the mantle
  orb(ctx, -7, 5, 16, 8, dark, { lw: 3, rim: "#9a7fc0", light: -0.4 });
  // swollen mantle hump (front)
  orb(ctx, 3, 0, 14, 12, c, { lw: 3, rim: "#c2acdc", light: -0.42 });
  // wet glistening sheen + slick highlights, clipped to mantle
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(3, 0, 14, 12, 0, 0, Math.PI * 2);
  ctx.clip();
  blob(ctx, -1, -5, 8, 3.5, "rgba(255,255,255,0.35)", OUTLINE, 0);
  blob(ctx, 7, 3, 3, 2, "rgba(255,255,255,0.25)", OUTLINE, 0);
  // mantle pustules (salt-blisters)
  ctx.fillStyle = "rgba(40,24,60,0.4)";
  for (const [mx, my] of [[-2, -2], [6, -1], [2, 5], [9, 4]] as [number, number][]) {
    ctx.beginPath(); ctx.arc(mx, my, 1.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // weeping salt drips off the underside
  for (let i = 0; i < 2; i++) {
    const dy = 6 + ((t * 16 + i * 8) % 12);
    ctx.save(); ctx.globalAlpha = Math.max(0, 1 - (dy - 6) / 12);
    glowDot(ctx, -2 + i * 8, dy, 1.4, "rgba(200,220,150,0.8)", 5);
    ctx.restore();
  }

  // eye-stalks rising from the head, luminous sickly tips
  const wob = Math.sin(v.phase * 2) * 2;
  const wob2 = Math.cos(v.phase * 2.3) * 2;
  const ext = v.windup ? -3 : 0; // stalks crane higher when it winds up to lunge
  ctx.strokeStyle = c;
  ctx.lineWidth = 3.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(7, -7); ctx.quadraticCurveTo(12, -14, 13 + wob, -20 + ext);
  ctx.moveTo(12, -5); ctx.quadraticCurveTo(17, -10, 19 + wob2, -16 + ext);
  ctx.stroke();
  // luminous bioluminescent stalk tips (replace googly eyes)
  const tipGlow = v.windup ? 12 : 7;
  glowDot(ctx, 13 + wob, -20 + ext, 2.2, "#aef07a", tipGlow);
  glowDot(ctx, 19 + wob2, -16 + ext, 2.2, "#aef07a", tipGlow);
  // dark pupil specks in the glowing tips
  ctx.fillStyle = OUTLINE;
  ctx.beginPath(); ctx.arc(13 + wob, -20 + ext, 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(19 + wob2, -16 + ext, 0.8, 0, Math.PI * 2); ctx.fill();

  // rasping mouth on the front underside, opens with attack
  const mo = 1 + v.attacking * 3;
  ctx.beginPath();
  ctx.ellipse(15, 4, 3, mo, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#2a1230";
  ctx.fill();
}

function drawWeed(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // A carnivorous plant: a writhing knot of thorned vines coiling around a
  // fanged maw. No real eyes — just a few wet glints lurking among the vines.
  shadow(ctx, 16);
  const c = flash ? "#fff" : "#37601f";
  const cd = flash ? "#fff" : "#234212";

  // writhing thorned vines, each a tapering limb that lashes with phase
  ctx.lineCap = "round";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + v.phase * 0.8;
    const writhe = Math.sin(v.phase * 2.4 + i * 1.3);
    const r = 17 + writhe * 6 + v.attacking * 4;
    const cx = Math.cos(a + writhe * 0.4) * 11;
    const cy = Math.sin(a + writhe * 0.4) * 9 + 4;
    const ex = Math.cos(a) * r, ey = Math.sin(a) * r + 2;
    // dark underside vine first, lighter on top -> rounded look
    limb(ctx, 0, 4, cx, cy, ex, ey, 6, cd);
    limb(ctx, 0, 4, cx, cy, ex, ey, 3.4, c);
    // thorns jutting along the vine
    ctx.fillStyle = cd;
    for (const tt of [0.45, 0.72]) {
      const mx = ex * tt;          // point along the vine toward its tip
      const my = 4 * (1 - tt) + ey * tt;
      const nx = Math.cos(a + Math.PI / 2), ny = Math.sin(a + Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(mx - nx * 1.5, my - ny * 1.5);
      ctx.lineTo(mx + nx * 4 + Math.cos(a) * 2, my + ny * 4 + Math.sin(a) * 2);
      ctx.lineTo(mx + nx * 1.5, my + ny * 1.5);
      ctx.closePath();
      ctx.fill();
    }
    // a wet glint lurking among a couple of the vines (eyes "optional")
    if (i % 3 === 0) {
      const gx = Math.cos(a) * (r * 0.55), gy = Math.sin(a) * (r * 0.55) + 3;
      glowDot(ctx, gx, gy, 1.3, v.windup ? "#cdef6a" : "#9fb24e", v.windup ? 7 : 3);
      ctx.fillStyle = OUTLINE;
      ctx.beginPath(); ctx.arc(gx, gy, 0.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  // central fleshy bulb (the throat) — bulbous, mottled
  orb(ctx, 0, 4, 12, 11, cd, { lw: 3, rim: ROT_BRIGHT, light: -0.4 });
  // mottling
  if (!flash) {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(0, 4, 12, 11, 0, 0, Math.PI * 2); ctx.clip();
    blob(ctx, -4, 8, 5, 4, "rgba(60,90,30,0.5)", OUTLINE, 0);
    blob(ctx, 5, 1, 4, 3, "rgba(20,40,12,0.5)", OUTLINE, 0);
    ctx.restore();
  }

  // the maw — a vertical gash that gapes wide on attack, lined with fangs
  const gw = 5 + v.attacking * 3;      // half-width
  const gh = 4 + v.attacking * 8;      // half-height
  ctx.beginPath();
  ctx.ellipse(0, 5, gw, gh, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#3a0a08";
  ctx.fill();
  // throat depth
  ctx.beginPath();
  ctx.ellipse(0, 6, gw * 0.5, gh * 0.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#1a0404";
  ctx.fill();
  // interlocking fangs around the maw rim
  ctx.fillStyle = flash ? "#fff" : "#e4d6b0";
  const nf = 5;
  for (let i = 0; i < nf; i++) {
    const a = (i / nf) * Math.PI * 2 + 0.3;
    const rx = Math.cos(a) * gw, ry = 5 + Math.sin(a) * gh;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx - Math.cos(a) * 3 - Math.sin(a) * 1.4, ry - Math.sin(a) * 3 + Math.cos(a) * 1.4);
    ctx.lineTo(rx - Math.cos(a) * 3 + Math.sin(a) * 1.4, ry - Math.sin(a) * 3 - Math.cos(a) * 1.4);
    ctx.closePath();
    ctx.fill();
  }
  // a drip of digestive sap from the lower lip when feeding
  if (v.attacking > 0.2 || v.windup) {
    const dy = 5 + gh + ((t * 16) % 8);
    ctx.save(); ctx.globalAlpha = 0.8;
    glowDot(ctx, 0, dy, 1.5, "#aef06a", 6);
    ctx.restore();
  }
}

function drawDrone(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // Rusted agricultural pesticide quad-rotor. A cracked tank sloshing glowing
  // poison, a cold targeting lens for a face, and a nozzle that drips toxin.
  shadow(ctx, 13, 20);
  const hover = Math.sin(t * 4) * 3;
  ctx.translate(0, hover - 6);
  const metal = flash ? "#fff" : "#8f8579"; // rusted dull steel, not shiny
  const rust = flash ? "#fff" : "#6b4a2e";

  // 4 rotor arms (X) with blurred discs
  ctx.save();
  const rspin = t * 40;
  for (const [sx, sy] of [[-15, -9], [15, -9], [-15, 3], [15, 3]] as [number, number][]) {
    // arm strut
    ctx.strokeStyle = rust;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx * 0.35, -4); ctx.lineTo(sx, sy);
    ctx.stroke();
    // motor nub
    ctx.fillStyle = "#3a3026";
    ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
    // blurred rotor disc
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = "rgba(190,190,200,0.6)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(sx, sy - 1, 8, 2 + Math.abs(Math.sin(rspin + sx)) * 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // central frame plate
  ctx.fillStyle = rust;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-9, -7, 18, 6, 2) : ctx.rect(-9, -7, 18, 6);
  ctx.fill(); ctx.stroke();

  // cracked pesticide tank body
  orb(ctx, 0, 2, 11, 12, metal, { lw: 3, rim: "#cfc6b6", light: -0.45 });
  // glowing poison sloshing inside, seen through a cracked window
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 2, 11, 12, 0, 0, Math.PI * 2);
  ctx.clip();
  const slosh = Math.sin(t * 3) * 2;
  ctx.save();
  ctx.shadowColor = "#9fe04e"; ctx.shadowBlur = 10;
  ctx.fillStyle = "rgba(130,220,90,0.6)";
  ctx.beginPath();
  ctx.moveTo(-12, 4 + slosh);
  ctx.lineTo(12, 4 - slosh);
  ctx.lineTo(12, 16); ctx.lineTo(-12, 16);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // rising toxin bubbles
  for (let i = 0; i < 3; i++) {
    const by = 8 - ((t * 14 + i * 5) % 12);
    glowDot(ctx, -3 + i * 3, by, 1.1, "rgba(190,255,150,0.9)", 4);
  }
  // crack lines across the tank
  ctx.strokeStyle = "rgba(20,13,10,0.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-6, -6); ctx.lineTo(-2, 0); ctx.lineTo(-5, 6);
  ctx.moveTo(7, -4); ctx.lineTo(3, 3);
  ctx.stroke();
  ctx.restore();
  // rust streaks on the shell
  if (!flash) {
    ctx.strokeStyle = "rgba(90,50,20,0.4)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-7, -4); ctx.lineTo(-6, 6);
    ctx.moveTo(8, -2); ctx.lineTo(7, 8);
    ctx.stroke();
  }

  // targeting lens (the "face") toward facing — a cold red optic, not eyes
  ctx.save();
  ctx.rotate(v.facing);
  // nozzle arm
  ctx.fillStyle = "#3a3026";
  ctx.fillRect(8, -2, 12, 4);
  ctx.fillStyle = "#241c14";
  ctx.fillRect(18, -2.6, 3, 5.2);
  // dripping toxin from the nozzle (always a little, more on windup)
  const dn = v.windup ? 3 : 1;
  for (let i = 0; i < dn; i++) {
    const dy = ((t * 18 + i * 6) % 14);
    ctx.save(); ctx.globalAlpha = Math.max(0, 1 - dy / 14);
    glowDot(ctx, 21, dy, 1.4, "#9fe04e", 6);
    ctx.restore();
  }
  if (v.windup) glowDot(ctx, 21, 0, 2.6, "#bdf06a", 12);
  ctx.restore();
  // the lens itself, unrotated so it reads as a staring optic, tracks facing
  const lx = Math.cos(v.facing), ly = Math.sin(v.facing);
  // housing ring
  ctx.beginPath();
  ctx.arc(lx * 4, ly * 4 - 1, 4, 0, Math.PI * 2);
  ctx.fillStyle = "#241c14";
  ctx.fill();
  ctx.lineWidth = 1.4; ctx.strokeStyle = OUTLINE; ctx.stroke();
  // glowing aperture
  ctx.save();
  ctx.shadowColor = "#ff5742"; ctx.shadowBlur = v.windup ? 12 : 7;
  ctx.beginPath();
  ctx.arc(lx * 4, ly * 4 - 1, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = flash ? "#fff" : v.windup ? "#ff7a4a" : "#d83a2e";
  ctx.fill();
  ctx.restore();
  // lens glint
  ctx.beginPath();
  ctx.arc(lx * 4 - 1, ly * 4 - 2, 0.8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
}

function drawScarecrow(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean, king: boolean) {
  // Grim sackcloth effigy lashed to a post: rotting burlap, straw guts spilling
  // from torn seams, a stitched sack face with ember X-eyes that flare to life
  // when it winds up. The King is taller, husk-crowned, dragging a scythe.
  shadow(ctx, king ? 26 : 15, king ? 28 : 18);
  const slump = v.staggered ? 0.24 : 0;
  const sway = Math.sin(t * 1.5) * 0.06 + slump + (v.staggered ? Math.sin(t * 9) * 0.05 : 0);
  ctx.rotate(sway);
  const flare = v.windup ? 1 : v.attacking * 0.6;
  const cloth = flash ? "#fff" : king ? "#5a241a" : "#6e5530"; // darker, rotted
  const clothDk = flash ? "#fff" : king ? "#3e150f" : "#4a3820";
  const headH = king ? 34 : 24;

  // post (weathered, with grain)
  ctx.fillStyle = "#4a2f1a";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.fillRect(-2.6, 0, 5.2, headH);
  ctx.strokeRect(-2.6, 0, 5.2, headH);
  ctx.strokeStyle = "rgba(20,13,10,0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(0, headH - 2); ctx.stroke();

  // crossbar arms (sagging, with rope-bound wrists)
  ctx.strokeStyle = "#4a2f1a";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-18, -4); ctx.quadraticCurveTo(0, -2, 18, -4);
  ctx.stroke();
  // dangling straw hands
  ctx.strokeStyle = "#c8a64e";
  ctx.lineWidth = 1.6;
  for (const sx of [-18, 18]) {
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(sx, -3);
      ctx.lineTo(sx + i * 2.5, 3 + Math.sin(v.phase + sx + i) * 1.5);
      ctx.stroke();
    }
  }

  // raggy cloth torso, shaded
  orb(ctx, 0, 2, king ? 18 : 13, king ? 20 : 15, cloth, { lw: 3, rim: king ? "#9a3a28" : "#9a7a48", light: -0.4 });
  // torn seams + patch stitching across the chest
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, 2, king ? 18 : 13, king ? 20 : 15, 0, 0, Math.PI * 2); ctx.clip();
  // a darker rotted gash with straw showing through
  ctx.fillStyle = clothDk;
  ctx.beginPath();
  ctx.moveTo(-6, -4); ctx.lineTo(2, 0); ctx.lineTo(-4, 10); ctx.lineTo(-9, 4);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  // straw guts spilling from the gash
  ctx.strokeStyle = flash ? "#fff" : "#d8b65a";
  ctx.lineWidth = 1.6;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(-3 + i, 2);
    ctx.lineTo(-5 + i * 2, 9 + Math.sin(v.phase * 1.2 + i) * 2);
    ctx.stroke();
  }
  // cross-stitch repair marks
  ctx.strokeStyle = "rgba(30,18,8,0.6)";
  ctx.lineWidth = 1.2;
  for (const [px, py] of [[6, -4], [8, 2], [5, 8]] as [number, number][]) {
    ctx.beginPath();
    ctx.moveTo(px - 2, py - 2); ctx.lineTo(px + 2, py + 2);
    ctx.moveTo(px + 2, py - 2); ctx.lineTo(px - 2, py + 2);
    ctx.stroke();
  }

  // tattered hem (jagged torn cloth)
  ctx.fillStyle = cloth;
  const hw = king ? 18 : 13;
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(i * (hw / 3.5), king ? 18 : 13);
    ctx.lineTo(i * (hw / 3.5) + 3, (king ? 27 : 21) + Math.sin(v.phase + i) * 2);
    ctx.lineTo(i * (hw / 3.5) - 3, king ? 18 : 13);
    ctx.closePath();
    ctx.fill();
  }
  // straw poking from the hem
  ctx.strokeStyle = "#c8a64e";
  ctx.lineWidth = 2;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 3, (king ? 15 : 12));
    ctx.lineTo(i * 4, (king ? 25 : 23) + Math.sin(v.phase + i) * 2.5);
    ctx.stroke();
  }

  // burlap sack head — lumpy, cinched at the neck
  const hr = king ? 13 : 10;
  orb(ctx, 0, -16, hr, hr, flash ? "#fff" : "#b89a60", { lw: 3, rim: "#dcc188", light: -0.4 });
  // neck cinch (rope)
  ctx.strokeStyle = "#5a3b22";
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.ellipse(0, -16 + hr - 1, hr * 0.6, 2, 0, 0, Math.PI);
  ctx.stroke();
  // coarse burlap weave texture (cheap cross-hatch, clipped)
  ctx.save();
  ctx.beginPath(); ctx.arc(0, -16, hr, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = "rgba(60,40,20,0.25)";
  ctx.lineWidth = 0.8;
  for (let i = -hr; i <= hr; i += 3) {
    ctx.beginPath(); ctx.moveTo(i, -16 - hr); ctx.lineTo(i, -16 + hr); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hr, -16 + i); ctx.lineTo(hr, -16 + i); ctx.stroke();
  }
  // a mildew blotch on the sack
  blob(ctx, hr * 0.4, -16 + hr * 0.3, 3, 2.5, "rgba(70,80,40,0.4)", OUTLINE, 0);
  ctx.restore();
  // seam stitches around head rim
  ctx.strokeStyle = "rgba(40,24,10,0.6)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.arc(0, -16, hr - 1.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // stitched ember X eyes — dead by default, flare red on windup/attack
  const exOff = king ? 5 : 4;
  stitchX(ctx, -exOff, -16, king ? 3 : 2.6, flare, flash);
  stitchX(ctx, exOff, -16, king ? 3 : 2.6, flare, flash);
  // crude stitched mouth — a jagged sewn line, opens to a void on attack
  ctx.strokeStyle = "#2a1408";
  ctx.lineWidth = 1.6;
  if (v.attacking > 0.3) {
    // gaping sack mouth
    ctx.fillStyle = "#160604";
    ctx.beginPath();
    ctx.ellipse(0, -11, 3.5, 1.5 + v.attacking * 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // stitch ties at the corners
    ctx.beginPath();
    ctx.moveTo(-5, -12); ctx.lineTo(-3, -11);
    ctx.moveTo(5, -12); ctx.lineTo(3, -11);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(-4, -11);
    for (let i = -3; i <= 3; i++) ctx.lineTo(i * 1.4, -11 + (i % 2 ? 1 : -1));
    ctx.stroke();
    // vertical stitch ties
    ctx.lineWidth = 1;
    for (const sx of [-3, 0, 3]) {
      ctx.beginPath(); ctx.moveTo(sx, -12.4); ctx.lineTo(sx, -9.6); ctx.stroke();
    }
  }

  if (king) {
    // a blackened iron crown of bent nails + husk spikes, ember-lit on windup
    if (flare > 0.01) { ctx.save(); ctx.shadowColor = BRIGHT; ctx.shadowBlur = 4 + flare * 10; }
    ctx.strokeStyle = flash ? "#fff" : "#241712";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    // crown band
    ctx.beginPath();
    ctx.ellipse(0, -27, 11, 3.2, 0, Math.PI, 0);
    ctx.stroke();
    // jagged spikes around the band
    ctx.fillStyle = flash ? "#fff" : "#2a1c14";
    for (const [a, h] of [[-0.85, 9], [-0.42, 13], [0, 15], [0.42, 13], [0.85, 9]] as [number, number][]) {
      ctx.save();
      ctx.translate(Math.sin(a) * 10, -28);
      ctx.rotate(a * 0.6);
      ctx.beginPath();
      ctx.moveTo(-2.4, 0); ctx.lineTo(0, -h); ctx.lineTo(2.4, 0);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.4; ctx.strokeStyle = OUTLINE; ctx.stroke();
      // ember bead at the spike tip when flaring
      if (flare > 0.2) { ctx.fillStyle = BRIGHT; ctx.beginPath(); ctx.arc(0, -h, 1.2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = flash ? "#fff" : "#2a1c14"; }
      ctx.restore();
    }
    if (flare > 0.01) ctx.restore();

    // great rusted scythe, hauled back then swept with attack
    ctx.save();
    ctx.translate(19, -4);
    ctx.rotate(-0.35 + v.attacking * 1.8);
    // worn wooden haft
    ctx.strokeStyle = flash ? "#fff" : "#4a3320";
    ctx.lineWidth = 4.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(0, 20);
    ctx.stroke();
    // binding wraps
    ctx.strokeStyle = "#2a1c12";
    ctx.lineWidth = 1.4;
    for (const wy of [-2, 4, 10]) { ctx.beginPath(); ctx.moveTo(-2.4, wy); ctx.lineTo(2.4, wy + 1.5); ctx.stroke(); }
    // pitted blade
    ctx.strokeStyle = flash ? "#fff" : "#9aa0a8";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(-5, -18, 16, -0.45, 1.25); ctx.stroke();
    // dark spine + outline of the blade
    ctx.lineWidth = 1.6; ctx.strokeStyle = OUTLINE;
    ctx.beginPath(); ctx.arc(-5, -18, 16, -0.45, 1.25); ctx.stroke();
    // cutting edge catches ember light when winding up
    if (v.windup) {
      ctx.save(); ctx.shadowColor = BRIGHT; ctx.shadowBlur = 10;
      ctx.strokeStyle = SAP_BRIGHT; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(-5, -18, 18, -0.4, 1.15); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }
}

function drawHarvester(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  // The combine-beast: a derelict harvester possessed by the rot. Rust-eaten
  // hull, a roaring furnace eye, and a maw of spinning thresher blades that
  // chew anything in front of it. Phase looks tied to hp01.
  shadow(ctx, 46, 34);
  const wounded = v.hp01 < 0.5;
  const c = flash ? "#fff" : wounded ? "#6a1a14" : "#7a2018";
  const rumble = Math.sin(t * 30) * (v.windup ? 2 : 0.5);
  ctx.translate(rumble, 0);

  // treads (heavy, grimed)
  ctx.fillStyle = "#1c140e";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;
  for (const sy of [-1, 1]) {
    const ty = sy * 22;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-40, ty - 7, 64, 14, 5) : ctx.rect(-40, ty - 7, 64, 14);
    ctx.fill();
    ctx.stroke();
    // tread links scrolling
    ctx.fillStyle = "#33251a";
    for (let i = 0; i < 8; i++) {
      const lx = -38 + ((i * 9 + t * 30) % 60);
      ctx.fillRect(lx, ty - 6, 3.4, 12);
    }
    // wheel bogies
    ctx.fillStyle = "#0e0a07";
    for (const wx of [-28, -10, 8]) { ctx.beginPath(); ctx.arc(wx, ty, 3.4, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#1c140e";
  }

  // rear hopper (dented box of harvested gore)
  ctx.fillStyle = "#2e2016";
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-42, -30, 52, 52, 6) : ctx.rect(-42, -30, 52, 52);
  ctx.fill(); ctx.stroke();
  // hopper slats + overflow of mashed produce
  ctx.strokeStyle = "rgba(20,13,10,0.5)"; ctx.lineWidth = 1.4;
  for (const hx of [-34, -24, -14]) { ctx.beginPath(); ctx.moveTo(hx, -28); ctx.lineTo(hx, 20); ctx.stroke(); }
  ctx.fillStyle = flash ? "#fff" : "#5a1a14";
  for (const [gx, gy] of [[-30, -30], [-20, -32], [-10, -30]] as [number, number][]) {
    blob(ctx, gx, gy + Math.sin(t * 3 + gx) * 0.5, 4, 3, flash ? "#fff" : "#6b2018", OUTLINE, 1.2);
  }

  // rusted main hull with depth
  orb(ctx, 0, 0, 35, 31, c, { lw: 3.4, rim: "#c8564a", light: -0.4 });
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 35, 31, 0, 0, Math.PI * 2);
  ctx.clip();
  // riveted armor plates
  ctx.fillStyle = "rgba(40,20,10,0.4)";
  for (let i = 0; i < 6; i++) ctx.fillRect(-32 + i * 11, -32, 4, 64);
  // rust corrosion blooms
  for (const [rx, ry, rr] of [[-18, 14, 9], [20, -12, 8], [-22, -10, 6], [16, 16, 7]] as [number, number, number][]) {
    blob(ctx, rx, ry, rr, rr * 0.8, "rgba(120,60,24,0.4)", OUTLINE, 0);
    blob(ctx, rx, ry, rr * 0.5, rr * 0.4, "rgba(60,30,12,0.5)", OUTLINE, 0);
  }
  // bolts
  ctx.fillStyle = "rgba(20,13,10,0.6)";
  for (const [bx, by] of [[-20, -16], [18, -14], [-16, 16], [16, 14], [0, -22], [0, 22]] as [number, number][]) {
    ctx.beginPath(); ctx.arc(bx, by, 2, 0, Math.PI * 2); ctx.fill();
  }
  // battle damage cracks if wounded, leaking fire
  if (wounded) {
    ctx.strokeStyle = "rgba(20,8,4,0.8)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(12, -20); ctx.lineTo(20, -6); ctx.lineTo(14, 8); ctx.stroke();
    ctx.save(); ctx.shadowColor = "#ff7a3a"; ctx.shadowBlur = 10;
    ctx.strokeStyle = "rgba(255,120,50,0.7)"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(13, -18); ctx.lineTo(19, -6); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // furnace eye — recessed iron socket with a roaring fire inside
  const eyeC = v.windup ? SAP_BRIGHT : wounded ? "#ff5a2a" : "#ff7a3a";
  // dark socket housing
  ctx.beginPath();
  ctx.arc(0, -2, 11, 0, Math.PI * 2);
  ctx.fillStyle = "#1a0e08";
  ctx.fill();
  ctx.lineWidth = 2.4; ctx.strokeStyle = OUTLINE; ctx.stroke();
  // grate bars over the furnace
  glowDot(ctx, 0, -2, 8 + (v.windup ? Math.sin(t * 12) * 1.5 : 0), eyeC, v.windup ? 26 : 16);
  ctx.save();
  ctx.beginPath(); ctx.arc(0, -2, 8, 0, Math.PI * 2); ctx.clip();
  // inner fire flicker
  ctx.fillStyle = "rgba(255,210,90,0.5)";
  ctx.beginPath();
  ctx.ellipse(Math.sin(t * 9) * 1.5, -2 + Math.cos(t * 11) * 1.5, 4, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // iron grate bars (the menacing slit pupil)
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.8;
  for (const gy of [-5, -2, 1]) { ctx.beginPath(); ctx.moveTo(-7, gy); ctx.lineTo(7, gy); ctx.stroke(); }

  // front thresher reel — a maw of jagged blades
  ctx.save();
  ctx.rotate(v.facing);
  ctx.translate(34, 0);
  const spin = t * (v.windup ? 26 : 7);
  // dark blade housing behind the reel
  ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(10,6,4,0.5)"; ctx.fill();
  // jagged thresher teeth (triangles, not plain spokes)
  for (let i = 0; i < 6; i++) {
    const a = spin + (i / 6) * Math.PI * 2;
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    ctx.moveTo(4, -3.5);
    ctx.lineTo(20, 0);
    ctx.lineTo(4, 3.5);
    ctx.closePath();
    ctx.fillStyle = flash ? "#fff" : "#b6bcc4";
    ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = OUTLINE; ctx.stroke();
    // blood/sap on the blades
    if (!flash && i % 2 === 0) { ctx.fillStyle = "rgba(120,20,16,0.6)"; ctx.beginPath(); ctx.arc(14, 0, 1.4, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  // hub
  blob(ctx, 0, 0, 6, 6, "#7a7a80", OUTLINE, 2);
  ctx.fillStyle = "#2a2a2e";
  ctx.beginPath(); ctx.arc(0, 0, 2.4, 0, Math.PI * 2); ctx.fill();
  if (v.windup) {
    glowDot(ctx, 0, 0, 4, BRIGHT, 12);
    // motion-blur ring when spun up
    ctx.save(); ctx.globalAlpha = 0.3; ctx.strokeStyle = "rgba(220,220,230,0.7)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, 19, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }
  ctx.restore();

  // exhaust stack — bent pipe belching dark diesel smoke + embers
  ctx.fillStyle = "#241a14"; ctx.strokeStyle = OUTLINE; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-34, -40, 7, 14, 2) : ctx.rect(-34, -40, 7, 14);
  ctx.fill(); ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const yy = -42 - i * 9 - ((t * 22) % 9);
    ctx.globalAlpha = 0.4 - i * 0.08;
    blob(ctx, -30 + Math.sin(t * 1.5 + i) * 3, yy, 5 + i * 2.2, 5 + i * 2.2, "rgba(40,36,32,1)", OUTLINE, 0);
  }
  ctx.globalAlpha = 1;
  // a few sparks from the stack
  for (let i = 0; i < 2; i++) {
    const yy = -42 - ((t * 30 + i * 12) % 24);
    ctx.globalAlpha = Math.max(0, 0.9 + (yy + 42) / 24);
    glowDot(ctx, -30 + Math.sin(t * 4 + i) * 4, yy, 1.2, "#ff9a4a", 6);
  }
  ctx.globalAlpha = 1;
}

// ===================== NEW ENEMY KINDS =====================

// mite — tiny aggressive speck: a dark bristled tick-body on too many legs,
// crowned by a single seething red eye-cluster. Varies per `variant` so a
// swarm reads as many distinct vermin, not clones.
function drawMite(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  const va = (v.variant ?? 0);
  ctx.rotate((va % 4 - 1.5) * 0.12); // per-instance tilt
  // skitter: jitter + small hops, phase-offset by variant
  const hop = Math.abs(Math.sin(v.phase * 3 + va)) * 4;
  const jit = Math.sin(v.phase * 11 + va * 2) * 0.6;
  shadow(ctx, 6 + (4 - hop) * 0.2, 7);
  ctx.translate(jit, -hop);
  const sz = 0.85 + (va % 3) * 0.12; // size variation
  ctx.scale(sz, sz);
  const c = flash ? "#fff" : va % 2 ? "#4a2418" : "#3a1c12"; // dark vermin, not red blob

  // too many legs — 4 per side, splayed and scrabbling
  ctx.strokeStyle = flash ? "#fff" : "#1a0e08";
  ctx.lineWidth = 1.4;
  ctx.lineCap = "round";
  const spl = hop > 0.5 ? 2 : 0;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const ly = -3 + i * 2.4;
      const sc = Math.sin(v.phase * 8 + i * 1.6 + (sx > 0 ? 1 : 0)) * 1.6;
      ctx.beginPath();
      ctx.moveTo(sx * 3, ly);
      ctx.lineTo(sx * (7 + spl), ly + sc - 1);
      ctx.stroke();
    }
  }
  // bristled tick body
  orb(ctx, 0, 1, 6, 5.5, c, { lw: 2, rim: "#6b3a24", light: -0.4 });
  // dorsal bristles (spiky silhouette)
  ctx.strokeStyle = flash ? "#fff" : "#1a0e08";
  ctx.lineWidth = 1;
  for (const a of [-1.0, -0.5, 0.5, 1.0]) {
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * 4, 1 - Math.cos(a) * 4);
    ctx.lineTo(Math.sin(a) * 7, 1 - Math.cos(a) * 7);
    ctx.stroke();
  }
  // single seething red eye-cluster up front (faint glow keeps it readable)
  const fx = Math.cos(v.facing), fy = Math.sin(v.facing);
  compoundEye(ctx, fx * 3, fy * 3 - 1, 2, v.windup ? "#ff4a2e" : "#c8301a", v.windup ? 7 : 3, flash);
}

// beetle — a heavy armored tank: a thick segmented carapace it hunkers behind,
// a horned head that lowers to charge. The shell splits to reveal a soft,
// glowing underbelly + grinding maw when it attacks or is staggered.
function drawBeetle(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  shadow(ctx, 16);
  const fx = Math.cos(v.facing), fy = Math.sin(v.facing);
  const walk = Math.sin(v.phase * 4) * 2;

  // 6 thick jointed legs
  ctx.strokeStyle = flash ? "#fff" : "#160d08";
  ctx.lineCap = "round";
  for (const sx of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      const lw = walk * (i === 0 ? 1 : -0.6) * sx;
      const ky = i * 5;
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(sx * 8, ky);
      ctx.lineTo(sx * 12, ky + 2 + lw * 0.4);
      ctx.lineTo(sx * 16, ky + 6 + lw);
      ctx.stroke();
      // clawed foot
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sx * 16, ky + 6 + lw); ctx.lineTo(sx * 18, ky + 8 + lw);
      ctx.stroke();
    }
  }

  // soft chitinous body underneath
  orb(ctx, 0, 1, 12, 11, flash ? "#fff" : "#4a2a18", { lw: 2.6, rim: "#7a4a2a", light: -0.4 });

  if (v.staggered) {
    // flipped onto its back: soft segmented belly exposed, legs flailing, the
    // soft innards glowing — clearly the moment to strike.
    ctx.save();
    ctx.shadowColor = "#ff7a4a"; ctx.shadowBlur = 8;
    orb(ctx, 0, 1, 9, 8, flash ? "#fff" : "#caa36a", { lw: 2, rim: "#ffd9a0", light: -0.3 });
    ctx.restore();
    // belly segment seams
    ctx.strokeStyle = "rgba(40,20,10,0.5)";
    ctx.lineWidth = 1.4;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(-7, i * 3); ctx.lineTo(7, i * 3);
      ctx.stroke();
    }
    // exposed glowing maw, dazed
    glowDot(ctx, 0, 1, 2.4, "#ff8a4a", 8);
    ctx.fillStyle = "#3a0a08";
    ctx.beginPath(); ctx.ellipse(0, 1, 2.4, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    // dizzy little eyes peeking over the rim (dark, no white sclera)
    feralEye(ctx, -4, -3, 1.6, "#7a1d12", { glint: 0.6, lookY: 0.7 });
    feralEye(ctx, 4, -3, 1.6, "#7a1d12", { glint: 0.6, lookY: 0.7 });
    return;
  }

  // glossy thick carapace shell, split down the spine. Halves crack open on
  // windup/attack to bare the soft glowing core.
  const open = (v.windup ? 0.3 : 0) + v.attacking * 0.7;
  const shellC = flash ? "#fff" : "#241510";
  // soft glowing core revealed in the gap
  if (open > 0.12) {
    ctx.save();
    ctx.shadowColor = "#ff7a3a"; ctx.shadowBlur = 6 + open * 8;
    ctx.fillStyle = flash ? "#fff" : "#c8703a";
    ctx.beginPath();
    ctx.ellipse(0, -1, 2 + open * 2, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // grinding maw inside
    ctx.fillStyle = "#2a0808";
    ctx.beginPath();
    ctx.ellipse(0, 2, 2, 1.5 + v.attacking * 2.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.translate(sx * open * 7, 0);
    ctx.rotate(sx * open * 0.25); // wings lift as they open
    ctx.beginPath();
    ctx.ellipse(sx * 5.5, -1, 8.5, 11.5, sx * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = shellC;
    ctx.fill();
    ctx.lineWidth = 2.8;
    ctx.strokeStyle = OUTLINE;
    ctx.stroke();
    ctx.save();
    ctx.clip();
    // iridescent oily sheen
    blob(ctx, sx * 3, -5, 4.5, 5.5, "rgba(70,150,110,0.45)", OUTLINE, 0);
    blob(ctx, sx * 7, 2, 3.5, 4.5, "rgba(110,80,160,0.35)", OUTLINE, 0);
    // hard rim highlight along the spine ridge
    blob(ctx, sx * 2, -7, 2.5, 6, "rgba(255,255,255,0.25)", OUTLINE, 0);
    // pitting / scars
    ctx.fillStyle = "rgba(10,6,4,0.4)";
    ctx.beginPath(); ctx.arc(sx * 7, -3, 1.2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(sx * 4, 4, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.restore();
  }

  // horned head toward facing — lowered/thrust on attack
  ctx.save();
  ctx.rotate(v.facing);
  ctx.translate(v.attacking * 3, 0);
  // head capsule
  orb(ctx, 11, 0, 5, 4.5, flash ? "#fff" : "#1c120c", { lw: 2.2, rim: "#5a3a22", light: -0.4 });
  // great central horn (rhino-beetle), curving up
  ctx.fillStyle = flash ? "#fff" : "#2a1a10";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(13, -2);
  ctx.quadraticCurveTo(22, -3, 24, -7);
  ctx.quadraticCurveTo(21, -1, 15, 1);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // serrated pincer mandibles that gape on attack
  const gape = 2 + v.attacking * 4;
  ctx.lineCap = "round";
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = flash ? "#fff" : "#160d08";
  ctx.beginPath();
  ctx.moveTo(14, -gape); ctx.quadraticCurveTo(20, -gape - 1, 23, -2);
  ctx.moveTo(14, gape); ctx.quadraticCurveTo(20, gape + 1, 23, 2);
  ctx.stroke();
  // pincer teeth
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(19, -gape - 0.5); ctx.lineTo(19, -gape - 3);
  ctx.moveTo(19, gape + 0.5); ctx.lineTo(19, gape + 3);
  ctx.stroke();
  ctx.restore();

  // small hard eyes flanking the horn base — dark amber, glint, glow on windup
  const ex = fx * 9, ey = fy * 9 - 6;
  const px = -fy, py = fx;
  feralEye(ctx, ex + px * 2.4, ey + py * 2.4, 1.7, "#c8641e", { glow: v.windup ? 6 : 0, glint: 0.9, lookX: fx, lookY: fy, flash });
  feralEye(ctx, ex - px * 2.4, ey - py * 2.4, 1.7, "#c8641e", { glow: v.windup ? 6 : 0, glint: 0.9, lookX: fx, lookY: fy, flash });
}

// hornet — a sleek armored wasp. Banded abdomen that curls its barbed,
// venom-glowing stinger forward like a scorpion to strike. Hard, mean, fast.
function drawHornet(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  shadow(ctx, 11, 18);
  const hover = Math.sin(t * 5) * 2.5;
  ctx.translate(0, hover - 4);
  const jab = v.attacking;
  ctx.save();
  ctx.rotate(v.facing);

  // blurred wings (fast, motion-smeared)
  ctx.save();
  ctx.globalAlpha = 0.3 + Math.abs(Math.sin(t * 42)) * 0.22;
  for (const sy of [-1, 1]) {
    ctx.save();
    ctx.translate(-1, sy * 5);
    ctx.rotate(sy * (0.4 + Math.sin(t * 42) * 0.25));
    // two membranes per side -> denser wing
    ctx.fillStyle = "rgba(210,225,255,0.6)";
    ctx.strokeStyle = "rgba(40,40,60,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(-7, 0, 11, 4, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(-5, 2, 7, 2.6, 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  // segmented, banded abdomen — curls forward (over the back) to strike
  ctx.save();
  ctx.translate(-8, 0);
  // the whole tail arcs: rest curls slightly down; attack whips it overhead +x
  const curl = -jab * 1.5 + Math.sin(t * 3) * 0.05;
  ctx.rotate(curl);
  const seg = 4;
  let sxp = 0, syp = 0, ang = 0;
  for (let i = 0; i < seg; i++) {
    ang += 0.32; // progressive curve -> hooked tail
    const len = 4.2;
    const nx = sxp - Math.cos(ang) * len;
    const ny = syp - Math.sin(ang) * len;
    const rr = 5.5 - i * 0.9;
    const band = i % 2 === 0;
    orb(ctx, (sxp + nx) / 2, (syp + ny) / 2, rr, rr - 0.5, flash ? "#fff" : band ? "#e0a82e" : "#1c130d",
      { lw: 2, rim: band ? "#ffe08a" : "#4a3320", light: -0.4 });
    sxp = nx; syp = ny;
  }
  // barbed stinger at the tail tip, venom glowing
  const tipx = sxp - Math.cos(ang) * (4 + jab * 4);
  const tipy = syp - Math.sin(ang) * (4 + jab * 4);
  ctx.strokeStyle = flash ? "#fff" : "#1c120c";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(sxp, syp); ctx.lineTo(tipx, tipy);
  ctx.stroke();
  // barb hooks
  ctx.lineWidth = 1.3;
  const bnx = Math.sin(ang), bny = -Math.cos(ang);
  ctx.beginPath();
  ctx.moveTo(tipx + Math.cos(ang) * 2, tipy + Math.sin(ang) * 2);
  ctx.lineTo(tipx + Math.cos(ang) * 2 + bnx * 2, tipy + Math.sin(ang) * 2 + bny * 2);
  ctx.stroke();
  // venom bead (glows on windup/attack, drips otherwise faintly)
  glowDot(ctx, tipx, tipy, v.windup || jab > 0 ? 2 : 1.2, "#9fe04e", v.windup || jab > 0 ? 9 : 4);
  ctx.restore();

  // armored thorax (segmented, hard sheen)
  orb(ctx, 0, 0, 6, 6, flash ? "#fff" : "#4a2c18", { lw: 2.4, rim: "#8a5a3a", light: -0.4 });
  // thorax band
  ctx.strokeStyle = "rgba(20,13,10,0.4)"; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(-4, -3); ctx.lineTo(-3, 3); ctx.stroke();

  // head + serrated mandibles toward +x
  orb(ctx, 7, 0, 4.5, 4.5, flash ? "#fff" : "#241710", { lw: 2.2, rim: "#5a3320", light: -0.4 });
  const md = 1 + jab * 2;
  ctx.strokeStyle = flash ? "#fff" : "#0e0805";
  ctx.lineWidth = 1.8; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(11, -1.5); ctx.lineTo(14, -md);
  ctx.moveTo(11, 1.5); ctx.lineTo(14, md);
  ctx.stroke();
  // antennae (kinked, alert)
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(9, -2.5); ctx.lineTo(12, -5); ctx.lineTo(15, -5 + Math.sin(t * 8) * 1.5);
  ctx.moveTo(9, 2.5); ctx.lineTo(12, 5); ctx.lineTo(15, 5 + Math.sin(t * 8 + 1) * 1.5);
  ctx.stroke();
  ctx.restore();

  // mean wraparound compound eyes (dark amber/red, no white), drawn to read facing
  const fx = Math.cos(v.facing), fy = Math.sin(v.facing);
  const ex = fx * 7, ey = fy * 7;
  const px = -fy, py = fx;
  compoundEye(ctx, ex + px * 2.4, ey + py * 2.4, 1.7, v.windup ? "#ff4a2e" : "#b8341e", v.windup ? 6 : 0, flash);
  compoundEye(ctx, ex - px * 2.4, ey - py * 2.4, 1.7, v.windup ? "#ff4a2e" : "#b8341e", v.windup ? 6 : 0, flash);
}

// spore — a rooted fungal puffball. No eyes: just a straining, blistered cap
// over dark gills and a puckered sporing maw. It INHALES (swells) on windup,
// then BURSTS a cloud of toxic spores on attack. Sickly bioluminescent.
function drawSpore(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  shadow(ctx, 16);
  // gas cloud release on attack (drawn under cap so cap stays readable)
  if (v.attacking > 0) {
    ctx.save();
    const rr = (1 - v.attacking) * 28;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + v.attacking;
      ctx.globalAlpha = v.attacking * 0.5 * (1 - (1 - v.attacking) * 0.4);
      glowDot(ctx, Math.cos(a) * rr, -6 + Math.sin(a) * rr * 0.7, 5 + (1 - v.attacking) * 3, "#9fe04e", 8);
    }
    ctx.restore();
  }
  // roots / mycelium gripping the soil
  ctx.strokeStyle = flash ? "#fff" : "#3e2c18";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const a of [-2.5, -1.9, -1.4, 2.5, 1.9, 1.4] as number[]) {
    ctx.beginPath();
    ctx.moveTo(0, 8);
    ctx.quadraticCurveTo(Math.cos(a) * 9, 13, Math.cos(a) * 17, 15);
    ctx.stroke();
  }

  // swell: idle breath, big inhale on windup, deflate as it bursts
  const swell = 1
    + (v.windup ? Math.abs(Math.sin(t * 5)) * 0.22 : 0)
    + (v.attacking > 0 ? (1 - v.attacking) * 0.28 : Math.sin(v.phase) * 0.04);

  // fleshy stalk
  ctx.fillStyle = flash ? "#fff" : "#cdbd94";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-6, 8);
  ctx.quadraticCurveTo(-4 * swell, -1, -3, -4);
  ctx.lineTo(3, -4);
  ctx.quadraticCurveTo(4 * swell, -1, 6, 8);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // gills under the cap (dark radiating slats) — only show where they peek out
  ctx.strokeStyle = "rgba(20,13,10,0.5)";
  ctx.lineWidth = 1.2;
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 2.2, -4);
    ctx.lineTo(i * 3.4, -8);
    ctx.stroke();
  }

  // straining puffball cap
  const capC = flash ? "#fff" : v.windup ? "#9aae4a" : "#7f8f3e";
  orb(ctx, 0, -11, 13 * swell, 11 * swell, capC, { lw: 3, rim: ROT_BRIGHT, light: -0.4 });
  // bioluminescent blisters straining across the cap (these are the "glow markings")
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, -11, 13 * swell, 11 * swell, 0, 0, Math.PI * 2); ctx.clip();
  const blPulse = v.windup ? 8 : 4;
  for (const [px, py, pr] of [[-6, -13, 2.4], [4, -15, 2], [-2, -9, 1.8], [7, -10, 1.6], [-8, -8, 1.4]] as [number, number, number][]) {
    glowDot(ctx, px * swell, py * swell, pr, v.windup ? "#cdef6a" : "#9fb24e", blPulse);
    // dark center
    ctx.fillStyle = "rgba(20,30,8,0.5)";
    ctx.beginPath(); ctx.arc(px * swell, py * swell, pr * 0.5, 0, Math.PI * 2); ctx.fill();
  }
  // cracks straining open during the inhale
  if (swell > 1.12) {
    ctx.strokeStyle = `rgba(180,240,120,${(swell - 1.12) * 3})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-8, -14); ctx.lineTo(-3, -10); ctx.lineTo(-6, -6);
    ctx.moveTo(8, -12); ctx.lineTo(4, -9);
    ctx.stroke();
  }
  ctx.restore();
  // overall ready-glow halo on windup
  if (v.windup) {
    ctx.save();
    ctx.globalAlpha = 0.3 + Math.sin(t * 8) * 0.15;
    glowDot(ctx, 0, -11, 15 * swell, "#9fe04e", 16);
    ctx.restore();
  }

  // the sporing maw — a puckered hole under the cap, dilates to vent
  const mo = 1.6 + (v.attacking > 0 ? v.attacking * 3 : (swell - 1) * 6);
  ctx.beginPath();
  ctx.ellipse(0, -6, mo + 1, mo * 0.8 + 0.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#16240a";
  ctx.fill();
  ctx.lineWidth = 1.4; ctx.strokeStyle = OUTLINE; ctx.stroke();
  // venting spores from the maw when not full-bursting
  if (v.windup || (v.attacking > 0 && v.attacking < 0.3)) {
    glowDot(ctx, 0, -6, mo, "#aef06a", 8);
  }
}

// ===================== NEW BOSS: Old Tom, the First Fruit =====================
// A huge, half-rotten, hollowed-out ancestral tomato — a tragic mirror of Tommy.
function drawOldTom(ctx: Ctx, v: EnemyVisual, t: number, flash: boolean) {
  softShadow(ctx, 0, 36, 48, 16, 0.4);
  const breathe = Math.sin(t * 1.2) * 1.5;
  const phase2 = v.hp01 < 0.5;
  ctx.translate(0, breathe);

  // --- vestigial vine-arms (behind body), reaching, sway with phase ---
  ctx.lineCap = "round";
  for (const sx of [-1, 1]) {
    const reach = (v.attacking > 0 ? (1 - v.attacking) : 0.3) * 0.5;
    const baseA = sx * (2.1 - reach) ;
    ctx.save();
    ctx.translate(sx * 26, 4);
    // gnarled vine arm
    const sway = Math.sin(v.phase * 1.5 + sx) * 6;
    limb(ctx, 0, 0, sx * 22, -10 + sway, sx * (34 + v.attacking * 16), 6 + sway, 7, flash ? "#fff" : "#5a4a22");
    // withered claw-leaves at the end
    ctx.translate(sx * (34 + v.attacking * 16), 6 + sway);
    for (const da of [-0.5, 0, 0.5]) {
      ctx.save();
      ctx.rotate(baseA + da);
      ctx.scale(0.7, 0.7);
      leaf(ctx, 11, 3.5, flash ? "#fff" : "#6b5a2a");
      ctx.restore();
    }
    ctx.restore();
  }

  // --- main body: cracked rind, hollowed ---
  const bodyC = flash ? "#fff" : "#7a2a22";
  orb(ctx, 0, 0, 34, 33, bodyC, { lw: 3.5, rim: "#a8463a", light: -0.4 });
  // rot patches (sickly) clipped inside
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, 34, 33, 0, 0, Math.PI * 2);
  ctx.clip();
  // mottled rot
  for (const [mx, my, mr] of [[14, 12, 12], [-16, 16, 10], [20, -6, 8], [-20, -8, 7]]) {
    blob(ctx, mx, my, mr, mr * 0.9, "rgba(70,80,40,0.55)", OUTLINE, 0);
    blob(ctx, mx, my, mr * 0.5, mr * 0.45, "rgba(40,50,20,0.6)", OUTLINE, 0);
  }
  // dark hollow interior showing through cracks
  blob(ctx, 4, 6, 16, 18, "rgba(10,6,4,0.5)", OUTLINE, 0);
  // bright tomato youth still clinging at the top (the "mirror of hero")
  blob(ctx, -8, -16, 12, 8, "rgba(216,58,46,0.5)", OUTLINE, 0);
  ctx.restore();

  // --- cracks in the rind ---
  ctx.strokeStyle = "rgba(20,10,6,0.7)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  const cracks = [
    [[-30, -4], [-14, 2], [-6, 14], [2, 30]],
    [[30, -8], [16, -2], [12, 8], [18, 26]],
    [[-2, -32], [2, -18], [-4, -8]],
  ];
  for (const path of cracks) {
    ctx.beginPath();
    ctx.moveTo(path[0][0], path[0][1]);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
    ctx.stroke();
  }

  // --- leaking sap from the cracks (animated drips) ---
  for (const [sx, sy] of [[2, 28], [16, 22], [-12, 18]]) {
    const drip = ((t * 22 + sx * 3) % 18);
    ctx.save();
    ctx.globalAlpha = 0.85;
    // wet streak
    ctx.strokeStyle = SAP;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx, sy + 6);
    ctx.stroke();
    // falling droplet
    glowDot(ctx, sx, sy + 6 + drip, 2.2, SAP_BRIGHT, 8);
    ctx.restore();
  }

  // --- withered crown, drooping ---
  ctx.save();
  ctx.translate(0, -30);
  for (const a of [-1.0, -0.4, 0.3, 0.95]) {
    ctx.save();
    ctx.rotate(a + Math.sin(t * 1.5 + a) * 0.05);
    ctx.scale(1.5, 1.5);
    leaf(ctx, 12, 4, flash ? "#fff" : "#5a5024"); // brown, dying
    ctx.restore();
  }
  ctx.restore();

  // --- the single grieving eye (a fallen hero's last spark) ---
  const eyeY = -2;
  // deep bruised socket
  blob(ctx, 0, eyeY, 14, 13, "rgba(10,6,4,0.7)", OUTLINE, 0);
  blob(ctx, 0, eyeY + 1, 13, 11, "rgba(40,16,12,0.4)", OUTLINE, 0); // bruised purple-red rim
  // sclera — yellowed and tired
  ctx.beginPath();
  ctx.arc(0, eyeY, 9, 0, Math.PI * 2);
  ctx.fillStyle = flash ? "#fff" : "#ddcfa6";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  // bloodshot veins creeping across the sclera
  if (!flash) {
    ctx.save();
    ctx.beginPath(); ctx.arc(0, eyeY, 9, 0, Math.PI * 2); ctx.clip();
    ctx.strokeStyle = "rgba(150,30,24,0.4)";
    ctx.lineWidth = 0.8;
    for (const a of [0.4, 2.2, 3.4, 5.2]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 9, eyeY + Math.sin(a) * 9);
      ctx.quadraticCurveTo(Math.cos(a) * 4, eyeY + Math.sin(a) * 4 + 1, Math.cos(a) * 3, eyeY + Math.sin(a) * 3);
      ctx.stroke();
    }
    ctx.restore();
  }
  // iris tracks the player; glows when winding up / phase 2
  const ix = Math.cos(v.facing) * 4;
  const iy = Math.sin(v.facing) * 4;
  if (v.windup || phase2) { ctx.save(); ctx.shadowColor = phase2 ? BRIGHT : SAP_BRIGHT; ctx.shadowBlur = 16; }
  // outer iris
  ctx.beginPath();
  ctx.arc(ix, eyeY + iy, 5, 0, Math.PI * 2);
  ctx.fillStyle = v.windup ? BRIGHT : phase2 ? "#d83a2e" : "#7a1d14";
  ctx.fill();
  if (v.windup || phase2) ctx.restore();
  // clouded cataract ring (dying eye) — a pale film over part of the iris
  if (!flash && !v.windup) {
    ctx.beginPath();
    ctx.arc(ix, eyeY + iy, 5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(200,200,180,0.35)";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  // pupil
  ctx.beginPath();
  ctx.arc(ix, eyeY + iy, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = OUTLINE;
  ctx.fill();
  // faint inner ember in the pupil (the last spark of the hero he was)
  glowDot(ctx, ix, eyeY + iy, 0.9, phase2 ? "#ff7a4a" : "#9a3a2a", phase2 ? 6 : 3);
  // catchlight
  ctx.beginPath();
  ctx.arc(ix - 1.6, eyeY + iy - 1.6, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
  // heavy grieving upper lid drooping over the eye
  ctx.beginPath();
  ctx.moveTo(-9.5, eyeY - 1);
  ctx.quadraticCurveTo(0, eyeY - 7, 9.5, eyeY - 1);
  ctx.quadraticCurveTo(0, eyeY - 4, -9.5, eyeY - 1);
  ctx.closePath();
  ctx.fillStyle = flash ? "#fff" : "#5a221a";
  ctx.fill();
  // grieving brow, knitted
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  ctx.moveTo(-12, eyeY - 12); ctx.quadraticCurveTo(0, eyeY - 7, 12, eyeY - 12);
  ctx.stroke();
  // a slow tear of sap welling and falling
  const tear = (t * 14) % 30;
  if (tear < 22) glowDot(ctx, ix - 2, eyeY + 9 + tear, 1.9, SAP_BRIGHT, 6);

  // --- hollow mouth (a sorrowful, jagged maw), opens with attack ---
  const gape = 3 + v.attacking * 9;
  ctx.beginPath();
  ctx.moveTo(-12, 16);
  ctx.quadraticCurveTo(0, 16 + gape, 12, 16);
  ctx.quadraticCurveTo(0, 16 + gape * 1.6, -12, 16);
  ctx.closePath();
  ctx.fillStyle = "#1a0a08";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  // jagged seed-teeth
  if (gape > 5) {
    ctx.fillStyle = "#d8c89a";
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 4, 16);
      ctx.lineTo(i * 4 + 1.5, 16 + 4);
      ctx.lineTo(i * 4 - 1.5, 16 + 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // --- phase 2: an aura of grief-rot ---
  if (phase2) {
    ctx.save();
    ctx.globalAlpha = 0.12 + Math.sin(t * 4) * 0.05;
    glowDot(ctx, 0, 0, 42, BRIGHT, 24);
    ctx.restore();
    // rising rot motes
    ctx.save();
    for (let i = 0; i < 5; i++) {
      const my = 20 - ((t * 16 + i * 13) % 60);
      ctx.globalAlpha = Math.max(0, 0.6 - Math.abs(my) / 60);
      glowDot(ctx, Math.sin(t * 2 + i) * 30, my, 2, ROT_BRIGHT, 8);
    }
    ctx.restore();
  }
}

// ---------- Props & tiles ----------
export function drawCompostHeap(ctx: Ctx, x: number, y: number, t: number, lit: boolean) {
  ctx.save();
  ctx.translate(x, y);
  softShadow(ctx, 0, 13, 28, 9, 0.36);
  // mound, layered for depth
  orb(ctx, 0, 6, 24, 14, "#3a2a18", { lw: 3, rim: "#5a4226", light: -0.4 });
  blob(ctx, 0, 4, 22, 12, "#4a3520", OUTLINE, 0);
  // peels & scraps around the rim
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    blob(ctx, Math.cos(a) * 15, 6 + Math.sin(a) * 6, 4, 2.5, i % 2 ? "#8a5a2a" : "#5e7d2a", OUTLINE, 1.5);
  }
  // a couple of buried tomato husks
  blob(ctx, -8, 3, 4, 3.4, "#9e2018", OUTLINE, 1.2);
  blob(ctx, 9, 5, 3.5, 3, "#6b2018", OUTLINE, 1.2);

  // pitchfork planted (the bonfire "coiled sword")
  ctx.strokeStyle = "#9a9a9a";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 4); ctx.lineTo(0, -26);
  ctx.stroke();
  ctx.lineWidth = 2.6;
  ctx.beginPath();
  for (const px of [-5, 0, 5]) { ctx.moveTo(px, -20); ctx.lineTo(px, -32); }
  ctx.stroke();
  // crossbar of the tines
  ctx.beginPath();
  ctx.moveTo(-5, -20); ctx.lineTo(5, -20);
  ctx.stroke();

  if (lit) {
    // layered glow: base heat pool
    ctx.save();
    const g = ctx.createRadialGradient(0, -4, 2, 0, -4, 42);
    g.addColorStop(0, `rgba(255,180,80,${0.32 + Math.sin(t * 6) * 0.05})`);
    g.addColorStop(0.5, "rgba(255,120,60,0.12)");
    g.addColorStop(1, "rgba(255,120,60,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -4, 42, 34, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // flame tongues
    ctx.save();
    for (let i = 0; i < 5; i++) {
      const sway = Math.sin(t * 5 + i * 1.3) * 4;
      const h = 16 + Math.sin(t * 7 + i) * 5;
      const fx = (i - 2) * 4 + sway;
      const grd = ctx.createLinearGradient(fx, 4, fx, 4 - h);
      grd.addColorStop(0, "rgba(255,210,100,0.9)");
      grd.addColorStop(0.6, "rgba(255,110,50,0.7)");
      grd.addColorStop(1, "rgba(180,40,20,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(fx - 4, 4);
      ctx.quadraticCurveTo(fx - 2, 4 - h * 0.6, fx, 4 - h);
      ctx.quadraticCurveTo(fx + 2, 4 - h * 0.6, fx + 4, 4);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // embers rising with heat-shimmer drift
    for (let i = 0; i < 12; i++) {
      const fy = -2 - ((t * 28 + i * 7) % 30);
      const fx = Math.sin(t * 3 + i * 1.7) * (5 + (-fy) * 0.18);
      const c = i % 3 === 0 ? SAP_BRIGHT : "#ff7a3a";
      ctx.globalAlpha = Math.max(0, 0.9 + fy / 32);
      glowDot(ctx, fx, fy, Math.max(0.6, 2.2 + fy * 0.04), c, 6);
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

export function drawHusk(ctx: Ctx, x: number, y: number, t: number) {
  // your dropped sap — a withered tomato husk with a soft beacon glow
  ctx.save();
  ctx.translate(x, y);
  // ground beacon
  ctx.save();
  ctx.globalAlpha = 0.4 + Math.sin(t * 3) * 0.18;
  const g = ctx.createRadialGradient(0, 0, 1, 0, 0, 22);
  g.addColorStop(0, "rgba(255,213,107,0.6)");
  g.addColorStop(1, "rgba(232,181,58,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 2, 20, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // rising sap motes
  for (let i = 0; i < 3; i++) {
    const my = 2 - ((t * 12 + i * 8) % 24);
    ctx.globalAlpha = Math.max(0, 0.7 + my / 24);
    glowDot(ctx, Math.sin(t * 2 + i) * 4, my, 1.4, SAP_BRIGHT, 6);
  }
  ctx.globalAlpha = 1;
  // the husk itself
  orb(ctx, 0, 2, 10, 9, "#5a3a2a", { lw: 2.6, rim: "#8a5a3a", light: -0.4 });
  // collapsed/hollow top
  blob(ctx, 0, -1, 5, 3, "rgba(10,6,4,0.5)", OUTLINE, 0);
  ctx.fillStyle = "#3a2418";
  ctx.fillRect(-1.4, -8, 2.8, 5);
  ctx.restore();
}

export function drawPickup(
  ctx: Ctx,
  x: number,
  y: number,
  t: number,
  kind: "estus" | "sap" | "key" | "soul" | "weapon" | "charm"
) {
  ctx.save();
  ctx.translate(x, y + Math.sin(t * 3) * 3);
  // shared ground glint
  ctx.save();
  ctx.globalAlpha = 0.3;
  glowDot(ctx, 0, 6, 8, kind === "soul" ? ROT_BRIGHT : SAP_BRIGHT, 8);
  ctx.restore();

  if (kind === "estus") {
    // watering-can flask
    orb(ctx, 0, 1, 6, 9, "#3a8bd8", { lw: 2.4, rim: "#9fd0ff", light: -0.4 });
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(0, 1, 6, 9, 0, 0, Math.PI * 2);
    ctx.clip();
    blob(ctx, 0, 4, 5, 5, "rgba(120,200,255,0.6)", OUTLINE, 0);
    ctx.restore();
    ctx.fillStyle = "#7ac0ff";
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.fillRect(-2.4, -11, 4.8, 4);
    ctx.strokeRect(-2.4, -11, 4.8, 4);
  } else if (kind === "sap") {
    glowDot(ctx, 0, 0, 5, SAP_BRIGHT, 10);
    orb(ctx, 0, 0, 5, 5, SAP, { lw: 2, rim: "#fff0c0", light: -0.4 });
  } else if (kind === "key") {
    ctx.fillStyle = SAP;
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-1.6, -8, 3.2, 12, 1) : ctx.rect(-1.6, -8, 3.2, 12);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, -8, 4, 0, Math.PI * 2);
    ctx.fillStyle = SAP_BRIGHT;
    ctx.fill(); ctx.stroke();
    // bit teeth
    ctx.fillStyle = SAP;
    ctx.fillRect(1.2, 1, 3, 2);
    ctx.fillRect(1.2, 4, 2, 2);
  } else if (kind === "weapon") {
    // a planted blade — sword-in-the-ground silhouette
    ctx.save();
    ctx.rotate(Math.sin(t * 1.5) * 0.05);
    // blade
    ctx.fillStyle = "#d7dbe2";
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(2.4, -8);
    ctx.lineTo(2, 4);
    ctx.lineTo(-2, 4);
    ctx.lineTo(-2.4, -8);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // crossguard
    ctx.strokeStyle = SAP;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-6, 4); ctx.lineTo(6, 4);
    ctx.stroke();
    // grip + pommel
    ctx.strokeStyle = "#6b4a2a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 4); ctx.lineTo(0, 10);
    ctx.stroke();
    glowDot(ctx, 0, -12, 2, "rgba(255,255,255,0.9)", 8);
    ctx.restore();
  } else if (kind === "charm") {
    // a ringed talisman — beaded loop with a tomato-seed gem
    glowDot(ctx, 0, 0, 6, BRIGHT, 12);
    ctx.strokeStyle = SAP;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.stroke();
    // beads
    ctx.fillStyle = SAP_BRIGHT;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + t;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 6, Math.sin(a) * 6, 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    // central gem
    orb(ctx, 0, 0, 3, 3.4, TOMATO, { lw: 1.5, rim: BRIGHT, light: -0.4 });
  } else {
    // soul — wisp
    ctx.globalAlpha = 0.8;
    glowDot(ctx, 0, 0, 6, ROT_BRIGHT, 12);
    orb(ctx, 0, 0, 7, 7, "#cfe6a0", { lw: 1.5, rim: "#fff", light: -0.4 });
    // tail flicker
    ctx.globalAlpha = 0.5;
    blob(ctx, Math.sin(t * 4) * 2, 8, 3, 5, "rgba(159,178,78,0.6)", OUTLINE, 0);
  }
  ctx.restore();
}

// ===================== NEW ATMOSPHERE PROPS =====================
// All shaped (ctx, x, y, t, ...opts) and self-contained. Cheap enough to
// scatter many per area. Most take an optional `seed` so identical props
// placed at different spots don't animate in lockstep.

export function drawMushroom(ctx: Ctx, x: number, y: number, t: number, seed = 0, glow = false) {
  ctx.save();
  ctx.translate(x, y);
  softShadow(ctx, 0, 6, 10, 3.5, 0.3);
  const sway = Math.sin(t * 1.2 + seed) * 0.05;
  ctx.rotate(sway);
  // stalk
  ctx.fillStyle = "#e3d6b6";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-3, 6);
  ctx.quadraticCurveTo(-2, -2, -2.5, -6);
  ctx.lineTo(2.5, -6);
  ctx.quadraticCurveTo(2, -2, 3, 6);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // cap
  const capC = seed % 2 ? "#9e2018" : "#7b5fa0";
  ctx.beginPath();
  ctx.ellipse(0, -7, 9, 6, 0, Math.PI, 0);
  ctx.fillStyle = capC;
  ctx.fill();
  ctx.lineWidth = 2.4;
  ctx.stroke();
  // spots
  ctx.fillStyle = "rgba(233,220,192,0.9)";
  for (const [sx, sy] of [[-4, -8], [3, -9], [0, -6]]) {
    ctx.beginPath(); ctx.arc(sx, sy, 1.3, 0, Math.PI * 2); ctx.fill();
  }
  if (glow) {
    ctx.save();
    ctx.globalAlpha = 0.4 + Math.sin(t * 3 + seed) * 0.15;
    glowDot(ctx, 0, -7, 12, ROT_BRIGHT, 14);
    ctx.restore();
  }
  ctx.restore();
}

export function drawFlower(ctx: Ctx, x: number, y: number, t: number, seed = 0) {
  ctx.save();
  ctx.translate(x, y);
  softShadow(ctx, 0, 4, 7, 2.5, 0.25);
  const sway = Math.sin(t * 1.6 + seed) * 0.12;
  ctx.rotate(sway);
  // stem
  ctx.strokeStyle = "#4e8b3a";
  ctx.lineWidth = 2.4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.quadraticCurveTo(2, -2, 0, -8);
  ctx.stroke();
  // leaf
  ctx.save();
  ctx.translate(1, 0);
  ctx.rotate(0.6);
  ctx.scale(0.6, 0.6);
  leaf(ctx, 8, 3, "#4e8b3a");
  ctx.restore();
  // petals
  const petC = [TOMATO, SAP_BRIGHT, "#caa0d8", "#ff9fb0"][seed % 4];
  ctx.fillStyle = petC;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + t * 0.3;
    ctx.save();
    ctx.translate(0, -9);
    ctx.rotate(a);
    ctx.beginPath();
    ctx.ellipse(0, -4, 2.4, 4, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // center
  ctx.beginPath();
  ctx.arc(0, -9, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = SAP;
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

export function drawLantern(ctx: Ctx, x: number, y: number, t: number, seed = 0) {
  ctx.save();
  ctx.translate(x, y);
  const swing = Math.sin(t * 1.8 + seed) * 0.12;
  // pole
  ctx.strokeStyle = "#3a2a1f";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 14); ctx.lineTo(0, -22);
  ctx.quadraticCurveTo(0, -28, -8, -28);
  ctx.stroke();
  // chain
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-8, -28); ctx.lineTo(-8 + Math.sin(swing) * 4, -20);
  ctx.stroke();
  // lantern body swings under the hook
  ctx.translate(-8, -20);
  ctx.rotate(swing);
  // halo
  ctx.save();
  ctx.globalAlpha = 0.5 + Math.sin(t * 4 + seed) * 0.12;
  const g = ctx.createRadialGradient(0, 4, 1, 0, 4, 24);
  g.addColorStop(0, "rgba(255,200,90,0.7)");
  g.addColorStop(1, "rgba(255,180,60,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 4, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // cage
  ctx.fillStyle = "#3a2a1f";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-6, -2); ctx.lineTo(6, -2); ctx.lineTo(5, 12); ctx.lineTo(-5, 12);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // glass with flame
  blob(ctx, 0, 5, 4, 6, "rgba(255,220,140,0.85)", OUTLINE, 0);
  glowDot(ctx, 0, 6, 2.4 + Math.sin(t * 8 + seed) * 0.6, SAP_BRIGHT, 10);
  // top cap
  ctx.fillStyle = "#3a2a1f";
  ctx.beginPath();
  ctx.moveTo(-6, -2); ctx.lineTo(0, -8); ctx.lineTo(6, -2);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

export function drawBones(ctx: Ctx, x: number, y: number, t: number, seed = 0) {
  ctx.save();
  ctx.translate(x, y);
  softShadow(ctx, 0, 4, 14, 4, 0.28);
  ctx.rotate((seed % 4) * 0.4);
  const bone = "#d8ccb0";
  ctx.fillStyle = bone;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  // a couple of long bones crossed
  for (const [ang, len] of [[0.3, 16], [-0.5, 13]] as [number, number][]) {
    ctx.save();
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(-len / 2, -2, len, 4, 2) : ctx.rect(-len / 2, -2, len, 4);
    ctx.fill(); ctx.stroke();
    // knobby ends
    for (const ex of [-len / 2, len / 2]) {
      ctx.beginPath(); ctx.arc(ex, -1.5, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, 1.5, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  // a little skull (tomato-shaped, cracked — harvest gothic)
  ctx.save();
  ctx.translate(-6, 2);
  orb(ctx, 0, 0, 6, 5.5, bone, { lw: 2, rim: "#fff", light: -0.4 });
  ctx.fillStyle = OUTLINE;
  ctx.beginPath(); ctx.arc(-2, -0.5, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(2, -0.5, 1.6, 0, Math.PI * 2); ctx.fill();
  // jagged crack
  ctx.strokeStyle = "rgba(20,13,10,0.5)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -5); ctx.lineTo(1, -2); ctx.lineTo(-1, 0);
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

export function drawBanner(ctx: Ctx, x: number, y: number, t: number, seed = 0, color = DEEP) {
  ctx.save();
  ctx.translate(x, y);
  softShadow(ctx, 0, 18, 8, 3, 0.3);
  // pole
  ctx.fillStyle = "#3a2a1f";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.fillRect(-2, -44, 4, 62);
  ctx.strokeRect(-2, -44, 4, 62);
  // finial
  ctx.beginPath();
  ctx.arc(0, -46, 3, 0, Math.PI * 2);
  ctx.fillStyle = SAP;
  ctx.fill(); ctx.stroke();
  // hanging cloth with wind ripple
  ctx.beginPath();
  ctx.moveTo(2, -40);
  const segs = 6;
  const w = 26;
  for (let i = 0; i <= segs; i++) {
    const fy = -40 + (i / segs) * 44;
    const ripple = Math.sin(t * 2 + i * 0.6 + seed) * (2 + i * 0.6);
    ctx.lineTo(2 + w + ripple, fy);
  }
  // bottom notch (swallowtail)
  ctx.lineTo(2 + w * 0.5 + Math.sin(t * 2 + seed) * 3, 0);
  for (let i = segs; i >= 0; i--) {
    const fy = -40 + (i / segs) * 44;
    ctx.lineTo(2 + Math.sin(t * 2 + i * 0.6 + seed) * 1.5, fy);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.stroke();
  // emblem: a tomato sigil
  ctx.save();
  ctx.translate(2 + w * 0.55, -20);
  blob(ctx, 0, 0, 6, 6, TOMATO, OUTLINE, 1.8);
  ctx.fillStyle = "#3c6b2f";
  for (const a of [-0.5, 0, 0.5]) {
    ctx.save(); ctx.translate(0, -6); ctx.rotate(a); ctx.scale(0.4, 0.4); leaf(ctx, 8, 3, "#3c6b2f"); ctx.restore();
  }
  ctx.restore();
  ctx.restore();
}

export function drawTorch(ctx: Ctx, x: number, y: number, t: number, seed = 0) {
  ctx.save();
  ctx.translate(x, y);
  // bracket post
  ctx.strokeStyle = "#3a2a1f";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 16); ctx.lineTo(0, -10);
  ctx.stroke();
  // wrapped head
  ctx.fillStyle = "#5a3b22";
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(-3.5, -16, 7, 8, 2) : ctx.rect(-3.5, -16, 7, 8);
  ctx.fill(); ctx.stroke();
  // glow pool
  ctx.save();
  ctx.globalAlpha = 0.5 + Math.sin(t * 6 + seed) * 0.12;
  const g = ctx.createRadialGradient(0, -20, 1, 0, -20, 26);
  g.addColorStop(0, "rgba(255,200,90,0.7)");
  g.addColorStop(1, "rgba(255,160,50,0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, -20, 26, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // flame
  for (let i = 0; i < 3; i++) {
    const sway = Math.sin(t * 6 + i * 1.5 + seed) * 3;
    const h = 14 + Math.sin(t * 8 + i) * 4;
    const fx = (i - 1) * 2 + sway;
    const grd = ctx.createLinearGradient(fx, -16, fx, -16 - h);
    grd.addColorStop(0, "rgba(255,210,100,0.95)");
    grd.addColorStop(0.6, "rgba(255,110,50,0.75)");
    grd.addColorStop(1, "rgba(180,40,20,0)");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(fx - 3, -16);
    ctx.quadraticCurveTo(fx - 1.5, -16 - h * 0.6, fx, -16 - h);
    ctx.quadraticCurveTo(fx + 1.5, -16 - h * 0.6, fx + 3, -16);
    ctx.closePath();
    ctx.fill();
  }
  // ember
  glowDot(ctx, Math.sin(t * 4 + seed) * 3, -24 - ((t * 20) % 8), 1.2, SAP_BRIGHT, 6);
  ctx.restore();
}

export function drawGrassTuft(ctx: Ctx, x: number, y: number, t: number, seed = 0, dead = false) {
  ctx.save();
  ctx.translate(x, y);
  const base = dead ? "#8a7a3a" : "#4e8b3a";
  const tip = dead ? "#a89a4a" : "#6ea84a";
  ctx.lineCap = "round";
  const blades = 5;
  for (let i = 0; i < blades; i++) {
    const off = (i - (blades - 1) / 2);
    const a = off * 0.3 + Math.sin(t * 1.8 + seed + i) * 0.12;
    const len = 12 + (i % 2) * 4;
    ctx.strokeStyle = i % 2 ? tip : base;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(off * 2, 2);
    ctx.quadraticCurveTo(off * 2 + Math.sin(a) * len * 0.5, -len * 0.6, off * 2 + Math.sin(a) * len, -len);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawVinePatch(ctx: Ctx, x: number, y: number, t: number, seed = 0) {
  ctx.save();
  ctx.translate(x, y);
  // a creeping ground vine with leaves and a couple of cherry tomatoes
  ctx.strokeStyle = "#3c6b2f";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  const n = 4;
  let px = -18, py = 4;
  ctx.beginPath();
  ctx.moveTo(px, py);
  const pts: [number, number][] = [[px, py]];
  for (let i = 1; i <= n; i++) {
    const nx = -18 + (36 / n) * i;
    const ny = 4 + Math.sin(i * 1.3 + seed) * 6;
    ctx.quadraticCurveTo((px + nx) / 2, ny - 6, nx, ny);
    pts.push([nx, ny]);
    px = nx; py = ny;
  }
  ctx.stroke();
  // leaves along the vine, gently breathing
  for (let i = 0; i < pts.length; i++) {
    const [lx, ly] = pts[i];
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate((i % 2 ? 1 : -1) * (0.8 + Math.sin(t * 1.5 + seed + i) * 0.1));
    ctx.scale(0.6, 0.6);
    leaf(ctx, 11, 4, "#4e8b3a");
    ctx.restore();
  }
  // ripe cherry tomatoes
  for (const [bi, c] of [[1, TOMATO], [3, "#b6402e"]] as [number, string][]) {
    if (pts[bi]) {
      const [bx, by] = pts[bi];
      orb(ctx, bx, by + 4, 3.4, 3.4, c, { lw: 1.6, rim: BRIGHT, light: -0.4 });
    }
  }
  ctx.restore();
}

// quadraticCurve shim (typo-safe alias kept for back-compat with any callers)
declare global {
  interface CanvasRenderingContext2D {
    quadraticCurve(cpx: number, cpy: number, x: number, y: number): void;
  }
}
if (typeof CanvasRenderingContext2D !== "undefined") {
  CanvasRenderingContext2D.prototype.quadraticCurve = function (
    cpx: number,
    cpy: number,
    x: number,
    y: number
  ) {
    this.quadraticCurveTo(cpx, cpy, x, y);
  };
}
