// src/game/render/weapon.ts
//
// Procedural held-weapon renderer for the weaponless player sprite.
//
// The animation pack ships Tommy with EMPTY HANDS and there are no weapon art
// assets, so the armament he swings is drawn entirely in code here and animated
// per-frame: an anticipation pull-back, a sweep/thrust through the arc, and a
// recovery, with a fading additive trail along the blade path for juice.
//
// GEOMETRY CONTRACT
// -----------------
// Everything is authored "pointing along +X from the origin", where the origin
// is the player's HAND / center. The integrator positions and orients the whole
// view in the world:
//
//     weaponView.x = player.x;
//     weaponView.y = player.y;
//     weaponView.rotation = facingAngle;   // radians, 0 = facing right
//     weaponView.update(swing, heavy, t);  // per frame
//
// So "right is forward". This module never reads facing — `update()` layers the
// swing motion ON TOP of that container rotation (it rotates an inner blade
// group and extends reach within local space).
//
// PERFORMANCE
// -----------
// Static geometry is built ONCE per weapon kind in `setWeapon` (skipped if the
// kind is unchanged). `update()` is transform/alpha only — no Graphics are
// rebuilt per frame — except the trail, which redraws a tiny pooled ring of
// arc ghosts. Sized for an ~85px-tall player.

import { Container, Graphics } from "pixi.js";

import type { WeaponKind } from "@/game/sim/types";

// ---------------------------------------------------------------------------
// Palette (harvest gothic — matches src/game/render/worldfx.ts tones)
// ---------------------------------------------------------------------------
const OUTLINE = 0x140d0a;
const VINE = 0x4e8b3a;
const LEAF = 0x8fbf5a;
const THORN = 0xcfe6a0;
const BARK = 0x5a3b22; // haft / bone post
const GOURD = 0xc97b3a;
const IRON = 0xcfd2d8;
const SAP = 0xffd56b;

// derived shades (kept few — these are baked once per kind, not per frame)
const VINE_DK = 0x35602a;
const GOURD_DK = 0x8e4f22;
const GOURD_LT = 0xe5a35e;
const IRON_LT = 0xeef0f4;
const IRON_DK = 0x8d929c;
const BARK_LT = 0x7a5436;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Per-kind tuning. `reach` = local +X extent of the resting blade tip; the
// motion profiles in update() read `arc`/`thrust`/`speed` to shape the swing.
// ---------------------------------------------------------------------------
interface WeaponTune {
  reach: number; // px the weapon extends along +X at rest
  arc: number; // radians the blade group rotates through on a light swing
  thrust: number; // px of forward lunge added at the strike apex
  restAngle: number; // local rotation of the blade group when idle (held low)
  restDrop: number; // px the whole rig hangs below the hand at rest
}

const TUNE: Record<WeaponKind, WeaponTune> = {
  // long, wide cracking sweep; coils low at rest
  whip: { reach: 75, arc: 2.5, thrust: 6, restAngle: 0.85, restDrop: 7 },
  // short fast stab; almost no arc, lots of in/out
  dagger: { reach: 32, arc: 0.55, thrust: 18, restAngle: 0.6, restDrop: 6 },
  // heavy overhead-to-forward smash with weight
  mace: { reach: 46, arc: 2.15, thrust: 9, restAngle: 0.95, restDrop: 8 },
  // long crisp straight lunge; minimal arc
  rapier: { reach: 60, arc: 0.42, thrust: 22, restAngle: 0.5, restDrop: 5 },
};

// ---------------------------------------------------------------------------
// Easing helpers
// ---------------------------------------------------------------------------
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
const easeInCubic = (x: number): number => x * x * x;
const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

/**
 * Decompose raw swing progress (0..1) into the three phases of a strike and a
 * single signed "pose" value used to drive rotation/reach:
 *
 *   anticipation  (early)  -> pose pulls NEGATIVE (wind back)
 *   strike        (middle) -> pose drives toward +1 (sweep/thrust forward)
 *   recovery      (late)   -> pose settles back toward rest with a little
 *                             overshoot wobble
 *
 * `pose` is roughly -1..+1.2. `extend` is 0..1 forward-lunge amount (peaks at
 * the strike apex). `wind` is 0..1 anticipation amount (for squash/lift tells).
 */
interface Phase {
  pose: number;
  extend: number;
  wind: number;
  strike: number; // 0..1 within the active strike window (for the trail)
}

function phaseOf(swing: number): Phase {
  const s = clamp01(swing);
  if (s <= 0) return { pose: 0, extend: 0, wind: 0, strike: 0 };

  // window split: 0..0.30 anticipate, 0.30..0.62 strike, 0.62..1 recover
  const ANT = 0.3;
  const STR = 0.62;

  if (s < ANT) {
    const k = easeOutCubic(s / ANT);
    return { pose: -k, extend: 0, wind: k, strike: 0 };
  }
  if (s < STR) {
    const k = (s - ANT) / (STR - ANT); // 0..1 across the strike
    const drive = easeOutCubic(k); // fast snap forward
    return {
      pose: -1 + drive * 2, // -1 -> +1
      extend: Math.sin(k * Math.PI), // 0 -> 1 -> 0, peak mid-strike
      wind: 1 - k,
      strike: k,
    };
  }
  // recovery: ease from +1 back toward 0 with a soft settle wobble
  const k = (s - STR) / (1 - STR); // 0..1
  const settle = 1 - easeOutBack(k); // 1 -> ~0 with slight overshoot < 0
  return { pose: settle, extend: (1 - k) * 0.25, wind: 0, strike: 0 };
}

// ---------------------------------------------------------------------------
// Trail — a small pooled ring of additive arc ghosts swept along the blade.
// Lives in its own container with blendMode "add" so overlaps read as light.
// ---------------------------------------------------------------------------
const TRAIL_SEGMENTS = 7;

class Trail extends Container {
  private ghosts: Graphics[] = [];

  constructor() {
    super();
    this.blendMode = "add";
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const g = new Graphics();
      g.visible = false;
      this.addChild(g);
      this.ghosts.push(g);
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    for (const g of this.ghosts) g.visible = false;
  }

  /**
   * Draw a fading wedge from the hand out to `radius`, fanning BACKWARD from the
   * current blade angle `angle` by `spread` radians (the path the tip just
   * carved). `intensity` (0..1) scales alpha & width; `color`/`tip` theme it.
   */
  show(
    angle: number,
    radius: number,
    spread: number,
    intensity: number,
    color: number,
    tip: number
  ): void {
    this.visible = true;
    const n = this.ghosts.length;
    const inner = radius * 0.32;
    for (let i = 0; i < n; i++) {
      const g = this.ghosts[i];
      g.clear();
      // i=0 is the leading (current) edge, trailing ghosts lag further back
      const lag = i / (n - 1); // 0..1
      const a = angle - spread * lag;
      const fade = (1 - lag) * intensity;
      if (fade <= 0.02) {
        g.visible = false;
        continue;
      }
      g.visible = true;
      const r = radius * (1 - lag * 0.12);
      const x0 = Math.cos(a) * inner;
      const y0 = Math.sin(a) * inner;
      const x1 = Math.cos(a) * r;
      const y1 = Math.sin(a) * r;
      // a thin tapering streak from inner to tip
      const nx = -Math.sin(a);
      const ny = Math.cos(a);
      const w0 = 3.2 * fade;
      const w1 = 1.0 * fade;
      g.poly([
        x0 + nx * w0,
        y0 + ny * w0,
        x1 + nx * w1,
        y1 + ny * w1,
        x1 - nx * w1,
        y1 - ny * w1,
        x0 - nx * w0,
        y0 - ny * w0,
      ]).fill({ color, alpha: 0.18 * fade });
      // bright core line + a hot dot at the leading tip
      g.moveTo(x0, y0)
        .lineTo(x1, y1)
        .stroke({ color: tip, width: 1.4 * fade, alpha: 0.5 * fade, cap: "round" });
      if (i === 0) g.circle(x1, y1, 2.6 * intensity).fill({ color: tip, alpha: 0.6 * intensity });
    }
  }
}

// ---------------------------------------------------------------------------
// Whip joints — the vine is a chain of nodes posed along a curve every frame
// (transform-only; the leaf/segment Graphics themselves are built once).
// ---------------------------------------------------------------------------
const WHIP_JOINTS = 6;

// ---------------------------------------------------------------------------
// WeaponView
// ---------------------------------------------------------------------------
export class WeaponView extends Container {
  private kind: WeaponKind | null = null;

  /** The posed armament (rotated/scaled by update). Children built per kind. */
  private blade = new Container();
  /** Additive sweep trail, drawn under nothing (it sits behind the blade). */
  private trail = new Trail();

  /** For non-whip weapons: the static silhouette built once in setWeapon. */
  private gfx = new Graphics();

  /** Whip-only: per-joint containers posed along a curve each frame. */
  private whipNodes: Container[] = [];

  /** Cached previous strike angle, to size the trail spread by angular speed. */
  private prevAngle = 0;

  constructor() {
    super();
    // trail behind the solid blade so the metal/vine reads on top of its glow
    this.addChild(this.trail);
    this.blade.addChild(this.gfx);
    this.addChild(this.blade);
  }

  /**
   * Rebuild the weapon graphic for `kind`. No-op if the kind is unchanged, so
   * the integrator can call this every frame cheaply and only pays the rebuild
   * cost on an actual weapon swap.
   */
  setWeapon(kind: WeaponKind): void {
    if (kind === this.kind) return;
    this.kind = kind;

    // tear down any whip chain from a previous kind
    for (const n of this.whipNodes) n.destroy({ children: true });
    this.whipNodes.length = 0;
    this.gfx.clear();
    this.gfx.visible = kind !== "whip";

    switch (kind) {
      case "whip":
        this.buildWhip();
        break;
      case "dagger":
        this.buildDagger(this.gfx);
        break;
      case "mace":
        this.buildMace(this.gfx);
        break;
      case "rapier":
        this.buildRapier(this.gfx);
        break;
    }
  }

  /**
   * Per-frame animation. `swing` 0..1 is attack-clip progress (0 = idle/at-rest,
   * >0 = mid-attack). `heavy` widens & weights the arc. `t` is seconds (idle
   * bob). Transforms only — never rebuilds geometry (except the pooled trail).
   */
  update(swing: number, heavy: boolean, t: number): void {
    const kind = this.kind;
    if (!kind) return;
    const tune = TUNE[kind];
    const ph = phaseOf(swing);

    // heavy: bigger arc, more lunge, a touch slower-feeling (handled by caller's
    // clip length) — here it just amplifies the spatial pose.
    const arc = tune.arc * (heavy ? 1.32 : 1);
    const lunge = tune.thrust * (heavy ? 1.45 : 1) * ph.extend;

    // idle breathing: a slow bob + a tiny sway so the held weapon feels alive
    const idle = clamp01(1 - swing * 3); // only near rest
    const bob = Math.sin(t * 2) * 1.2 * idle;
    const sway = Math.sin(t * 1.6 + 0.7) * 0.05 * idle;

    // rest pose: weapon hangs low/back near the hand, angled down toward +X
    const restAngle = tune.restAngle + sway;
    // strike pose: blade group rotates from wound-back (-) up & forward (+),
    // sweeping through the arc. pose runs ~ -1..+1.2.
    const swungAngle = restAngle - ph.pose * arc;

    this.blade.rotation = swungAngle;
    this.blade.position.set(0, tune.restDrop * idle + bob);

    // forward lunge: push the whole blade group out along its own +X
    const lx = Math.cos(swungAngle) * lunge;
    const ly = Math.sin(swungAngle) * lunge;
    this.blade.position.x += lx;
    this.blade.position.y += ly;

    // per-kind extra flavor (heavy impact shudder, whip curl, etc.)
    this.poseKind(kind, ph, swing, t, heavy);

    // ---- trail along the blade path during the active strike ----
    const tipR = tune.reach + lunge;
    if (ph.strike > 0.001) {
      // angular speed -> trail spread (whip & mace fan wide; rapier stays tight)
      const dA = swungAngle - this.prevAngle;
      const baseSpread =
        kind === "rapier" || kind === "dagger" ? 0.18 : heavy ? 0.95 : 0.7;
      const spread = baseSpread + Math.min(0.6, Math.abs(dA) * 6);
      const inten = clamp01(ph.strike * 1.4) * (heavy ? 1 : 0.85);
      const themeCol = kind === "rapier" ? SAP : kind === "mace" ? GOURD_LT : LEAF;
      const themeTip = kind === "rapier" ? IRON_LT : kind === "dagger" ? IRON_LT : THORN;
      this.trail.show(swungAngle, tipR, spread, inten, themeCol, themeTip);
    } else {
      this.trail.hide();
    }
    this.prevAngle = swungAngle;
  }

  // -------------------------------------------------------------------------
  // Per-kind per-frame posing (transform/scale only)
  // -------------------------------------------------------------------------
  private poseKind(
    kind: WeaponKind,
    ph: Phase,
    swing: number,
    t: number,
    heavy: boolean
  ): void {
    switch (kind) {
      case "whip":
        this.poseWhip(ph, swing, t);
        break;
      case "mace": {
        // heavy weapon: weighty squash on the head as it loads, and an impact
        // SHUDDER near the end of the strike when the gourd "lands".
        const head = this.blade.getChildAt(0) as Graphics; // gfx (all parts)
        // load: how far the head has wound overhead toward the apex
        const land = clamp01((ph.pose - 0.55) / 0.45);
        // impact shudder window: a brief buzz as the gourd "lands" late in swing
        const hit = swing > 0.5 && swing < 0.72 ? Math.sin((swing - 0.5) / 0.22 * Math.PI) : 0;
        const shud = hit * (heavy ? 2.6 : 1.8);
        head.rotation = Math.sin(t * 60) * 0.04 * hit; // brief high-freq buzz
        head.position.set(Math.sin(t * 55) * shud, 0);
        // slight anticipatory stretch of the haft as it winds overhead
        const sx = 1 + land * 0.04;
        head.scale.set(1, sx);
        break;
      }
      case "dagger": {
        // dagger is rigid; just a faint blade-flash scale on the stab apex
        const g = this.blade.getChildAt(0) as Graphics;
        const flash = ph.extend;
        g.scale.set(1 + flash * 0.06, 1);
        break;
      }
      case "rapier": {
        // rapier stays straight; a tiny tip-lengthening on the lunge sells reach
        const g = this.blade.getChildAt(0) as Graphics;
        g.scale.set(1 + ph.extend * 0.1, 1);
        break;
      }
    }
  }

  /**
   * Pose the whip chain along a curve. At rest the vine coils low and inward;
   * during the strike it cracks out into a wide, whipping arc with the tip
   * snapping last (lag propagates down the joints).
   */
  private poseWhip(ph: Phase, swing: number, _t: number): void {
    const n = this.whipNodes.length;
    if (n === 0) return;

    // total length the whip spans, growing as it cracks out
    const baseLen = 13; // px per segment at rest
    const reach = TUNE.whip.reach;

    // crack factor: 0 coiled, 1 fully extended (peaks mid-strike)
    const crack = clamp01(ph.extend * 1.15 + Math.max(0, ph.pose) * 0.35);
    const segLen = baseLen * (0.78 + crack * 0.55); // segments lengthen on crack

    // base curvature: at rest the vine curls back on itself (high curl);
    // extended, it straightens out into the arc.
    const curlRest = 0.55; // radians of bend per joint at rest (coiled)
    const curl = curlRest * (1 - crack * 0.92);

    // a travelling whip wave so the tail lashes after the hand
    const wavePhase = swing * Math.PI * 2.2;

    // walk the chain placing each node relative to the previous, accumulating
    // angle. Local space: chain runs out along +X from the hand.
    let x = 0;
    let y = 0;
    let ang = 0;
    for (let i = 0; i < n; i++) {
      const node = this.whipNodes[i];
      const tt = i / (n - 1); // 0..1 down the chain
      // lag: outer joints trail the motion -> the tip snaps last
      const lash = Math.sin(wavePhase - tt * 3.4) * (0.18 + crack * 0.22) * (0.4 + tt);
      const segAng = -curl + lash; // bend (sign curls it downward at rest)
      ang += segAng;
      node.rotation = ang;
      node.position.set(x, y);
      // gentle taper as it extends
      const sc = 1 - tt * 0.34;
      node.scale.set(sc, sc);
      // advance to the next joint's base
      const adv = segLen;
      x += Math.cos(ang) * adv;
      y += Math.sin(ang) * adv;
    }
    // keep the rig length roughly within `reach` (visual only; no clamp needed
    // for hit logic — that lives in the sim). reach referenced to silence lint.
    void reach;
  }

  // -------------------------------------------------------------------------
  // Geometry builders (run ONCE per kind in setWeapon)
  // -------------------------------------------------------------------------

  /**
   * Whip: a segmented living vine. We build a chain of joint Containers, each
   * holding a baked segment + leaf Graphics, parented end-to-end so posing only
   * sets each node's rotation/position. The thorn tip caps the last joint.
   */
  private buildWhip(): void {
    this.gfx.visible = false;
    let parent: Container = this.blade;
    for (let i = 0; i < WHIP_JOINTS; i++) {
      const tt = i / (WHIP_JOINTS - 1);
      const node = new Container();
      const g = new Graphics();

      const segLen = 13;
      const w = 4.2 * (1 - tt * 0.55); // vine tapers toward the tip

      // segment body: a tapered vine link drawn from local origin out along +X
      g.moveTo(0, -w)
        .quadraticCurveTo(segLen * 0.5, -w * 1.15, segLen, -w * 0.55)
        .lineTo(segLen, w * 0.55)
        .quadraticCurveTo(segLen * 0.5, w * 1.15, 0, w)
        .fill({ color: VINE });
      // darker underside crease for volume
      g.moveTo(0, w * 0.2)
        .quadraticCurveTo(segLen * 0.5, w * 0.9, segLen, w * 0.35)
        .stroke({ color: VINE_DK, width: 1.2, alpha: 0.7 });
      // bright top rim
      g.moveTo(0, -w * 0.5)
        .quadraticCurveTo(segLen * 0.5, -w, segLen, -w * 0.4)
        .stroke({ color: LEAF, width: 1.1, alpha: 0.8 });
      // outline
      g.moveTo(0, -w)
        .quadraticCurveTo(segLen * 0.5, -w * 1.15, segLen, -w * 0.55)
        .lineTo(segLen, w * 0.55)
        .quadraticCurveTo(segLen * 0.5, w * 1.15, 0, w)
        .stroke({ color: OUTLINE, width: 1.4 });

      // a leaf sprouting off alternating sides of inner/mid joints
      if (i > 0 && i < WHIP_JOINTS - 1) {
        const side = i % 2 === 0 ? 1 : -1;
        this.drawLeaf(g, segLen * 0.5, side * w * 0.7, side, 9 - i, 0.9 - tt * 0.2);
      }

      // thorn tip on the final joint
      if (i === WHIP_JOINTS - 1) {
        const tipX = segLen;
        // a clawed thorn bud
        g.circle(tipX - 1, 0, 3.6).fill({ color: THORN });
        g.circle(tipX - 1, 0, 3.6).stroke({ color: OUTLINE, width: 1.4 });
        // three little barbs splaying forward
        for (const da of [-0.5, 0, 0.5]) {
          const bx = tipX - 1 + Math.cos(da) * 7;
          const by = Math.sin(da) * 7;
          g.moveTo(tipX - 1, 0)
            .lineTo(bx, by)
            .stroke({ color: VINE_DK, width: 1.6, cap: "round" });
          g.circle(bx, by, 1.3).fill({ color: SAP, alpha: 0.9 });
        }
      } else {
        // a small thorn nub on the segment joint
        g.poly([segLen - 2, -w, segLen, -w - 4, segLen + 2, -w]).fill({ color: VINE_DK });
      }

      node.addChild(g);
      parent.addChild(node);
      this.whipNodes.push(node);
      parent = node; // chain the next joint onto this one's tip
    }
  }

  /**
   * Dagger: a short black-thorn shiv on a stubby bark grip. Built pointing +X.
   */
  private buildDagger(g: Graphics): void {
    // grip / bark wrap near the hand
    g.roundRect(0, -2.4, 9, 4.8, 2).fill({ color: BARK });
    g.roundRect(0, -2.4, 9, 4.8, 2).stroke({ color: OUTLINE, width: 1.3 });
    g.moveTo(2, -1).lineTo(7, -1).stroke({ color: BARK_LT, width: 1, alpha: 0.6 });
    // small guard knot
    g.circle(9, 0, 2.6).fill({ color: VINE_DK });
    g.circle(9, 0, 2.6).stroke({ color: OUTLINE, width: 1.2 });

    // black-thorn blade: a dark organic spike with a pale honed edge, tip at +32
    const baseX = 11;
    const tipX = 32;
    g.moveTo(baseX, -3.2)
      .quadraticCurveTo((baseX + tipX) * 0.5, -3.4, tipX, 0)
      .quadraticCurveTo((baseX + tipX) * 0.5, 2.0, baseX, 3.2)
      .fill({ color: 0x241a12 }); // near-black thorn body
    // honed inner edge catches light
    g.moveTo(baseX + 1, -2.2)
      .quadraticCurveTo((baseX + tipX) * 0.5, -2.4, tipX - 1, -0.2)
      .stroke({ color: THORN, width: 1.2, alpha: 0.85 });
    // a couple of barbs along the spine
    for (const bx of [17, 23]) {
      g.poly([bx, -2.6, bx + 3, -6, bx + 4, -2.4]).fill({ color: 0x1a120c });
    }
    // outline
    g.moveTo(baseX, -3.2)
      .quadraticCurveTo((baseX + tipX) * 0.5, -3.4, tipX, 0)
      .quadraticCurveTo((baseX + tipX) * 0.5, 2.0, baseX, 3.2)
      .stroke({ color: OUTLINE, width: 1.4 });
    // sharp tip glint
    g.circle(tipX - 1, 0, 1.2).fill({ color: IRON_LT, alpha: 0.9 });
  }

  /**
   * Mace: a dried-gourd / beet head studded on a bone haft. Head sits ~30px out
   * along +X; the strike profile swings it overhead-to-forward with weight.
   */
  private buildMace(g: Graphics): void {
    const haftEnd = 26;
    // bone haft with a couple of knuckle-rings
    g.moveTo(0, -3)
      .lineTo(haftEnd, -2.4)
      .lineTo(haftEnd, 2.4)
      .lineTo(0, 3)
      .fill({ color: BARK });
    g.moveTo(0, -3)
      .lineTo(haftEnd, -2.4)
      .lineTo(haftEnd, 2.4)
      .lineTo(0, 3)
      .stroke({ color: OUTLINE, width: 1.5 });
    g.moveTo(2, -1.4).lineTo(haftEnd - 2, -1).stroke({ color: BARK_LT, width: 1, alpha: 0.55 });
    for (const rx of [9, 17]) {
      g.moveTo(rx, -3.2).lineTo(rx, 3.2).stroke({ color: 0x3c2715, width: 1.6 });
    }

    // the gourd head, centered ~30px out
    const cx = 31;
    g.circle(cx, 0, 11).fill({ color: GOURD });
    g.circle(cx, 0, 11).stroke({ color: OUTLINE, width: 1.8 });
    // lobed gourd ribs (a few darker vertical creases)
    for (const off of [-5.5, 0, 5.5]) {
      g.moveTo(cx + off, -10)
        .quadraticCurveTo(cx + off * 1.5, 0, cx + off, 10)
        .stroke({ color: GOURD_DK, width: 1.4, alpha: 0.7 });
    }
    // top-left bloom of light
    g.circle(cx - 3.5, -3.5, 4.5).fill({ color: GOURD_LT, alpha: 0.55 });
    // studded knuckles — bony nubs ringing the head
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU;
      const sx = cx + Math.cos(a) * 11;
      const sy = Math.sin(a) * 11;
      g.circle(sx, sy, 2.4).fill({ color: 0xe9dcc0 });
      g.circle(sx, sy, 2.4).stroke({ color: OUTLINE, width: 1.1 });
    }
    // a dried leafy stub crowning the gourd
    this.drawLeaf(g, cx + 1, -11, -1, 8, 0.8);
    // sap weeping at the base of the head
    g.circle(cx - 8, 6, 1.6).fill({ color: SAP, alpha: 0.8 });
  }

  /**
   * Rapier: a long thin thorn rapier with a sap-gold swept guard. Tip at ~60px;
   * the strike profile is a crisp straight lunge with almost no arc.
   */
  private buildRapier(g: Graphics): void {
    // grip
    g.roundRect(0, -2, 7, 4, 1.6).fill({ color: BARK });
    g.roundRect(0, -2, 7, 4, 1.6).stroke({ color: OUTLINE, width: 1.2 });
    // sap-gold swept guard: a basket curl around the hand
    const gx = 8;
    g.arc(gx, 0, 5, -Math.PI * 0.5, Math.PI * 0.5).stroke({ color: SAP, width: 2.6, cap: "round" });
    g.arc(gx, 0, 5, -Math.PI * 0.5, Math.PI * 0.5).stroke({
      color: OUTLINE,
      width: 1,
      alpha: 0.5,
    });
    // crossbar + a forward quillon
    g.moveTo(gx, -6).lineTo(gx, 6).stroke({ color: SAP, width: 2.4, cap: "round" });
    g.moveTo(gx + 2, -5).lineTo(gx + 7, -7).stroke({ color: SAP, width: 1.8, cap: "round" });
    // gold pommel bead behind the hand
    g.circle(-1.5, 0, 2.2).fill({ color: SAP });
    g.circle(-1.5, 0, 2.2).stroke({ color: OUTLINE, width: 1 });

    // long thorn blade: a narrow iron-pale needle from the guard to +60
    const baseX = gx + 2;
    const tipX = 60;
    g.moveTo(baseX, -2.1)
      .lineTo(tipX - 3, -0.7)
      .lineTo(tipX, 0)
      .lineTo(tipX - 3, 0.7)
      .lineTo(baseX, 2.1)
      .fill({ color: IRON });
    // central fuller sheen
    g.moveTo(baseX + 2, -0.5).lineTo(tipX - 4, -0.2).stroke({ color: IRON_LT, width: 1, alpha: 0.8 });
    g.moveTo(baseX + 2, 0.6).lineTo(tipX - 5, 0.3).stroke({ color: IRON_DK, width: 0.8, alpha: 0.6 });
    // a scatter of tiny thorn barbs hint it's grown, not forged
    for (const bx of [22, 33, 44]) {
      g.moveTo(bx, -1.6).lineTo(bx - 3, -4).stroke({ color: VINE_DK, width: 1.2, cap: "round" });
    }
    // outline
    g.moveTo(baseX, -2.1)
      .lineTo(tipX - 3, -0.7)
      .lineTo(tipX, 0)
      .lineTo(tipX - 3, 0.7)
      .lineTo(baseX, 2.1)
      .stroke({ color: OUTLINE, width: 1.3 });
    // tip glint
    g.circle(tipX - 1, 0, 1.3).fill({ color: IRON_LT, alpha: 0.95 });
  }

  /**
   * A single pointed leaf sprouting from (ox,oy) toward `side` (+1 down / -1
   * up), baked once. `len` controls size, `alpha` its translucency.
   */
  private drawLeaf(
    g: Graphics,
    ox: number,
    oy: number,
    side: number,
    len: number,
    alpha: number
  ): void {
    const tipX = ox + len * 0.7;
    const tipY = oy + side * len;
    const w = len * 0.42;
    const mx = (ox + tipX) * 0.5;
    const my = (oy + tipY) * 0.5;
    // leaf body: a pointed almond from base to tip
    g.moveTo(ox, oy)
      .quadraticCurveTo(mx - side * w, my - w * 0.2, tipX, tipY)
      .quadraticCurveTo(mx + side * w, my + w * 0.2, ox, oy)
      .fill({ color: LEAF, alpha });
    g.moveTo(ox, oy)
      .quadraticCurveTo(mx - side * w, my - w * 0.2, tipX, tipY)
      .quadraticCurveTo(mx + side * w, my + w * 0.2, ox, oy)
      .stroke({ color: OUTLINE, width: 1.1, alpha });
    // midrib
    g.moveTo(ox, oy).lineTo(tipX, tipY).stroke({ color: VINE_DK, width: 0.9, alpha: 0.6 * alpha });
  }
}
