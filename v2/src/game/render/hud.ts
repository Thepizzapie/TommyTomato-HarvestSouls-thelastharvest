// hud.ts — the SCREEN-space HUD + menu/overlay renderer for Tommy Tomato:
// Harvest Souls (Pixi v8 / WebGL). Everything here is drawn in code — no UI art
// assets — in a harvest-gothic register: ornate iron frames, parchment text,
// watering-can estus pips, a sap coin, an ornate boss bar, and full-screen
// overlays (death / victory / pause / the COMPOST HEAP bonfire menu).
//
// This is the v2 reimplementation of v1's Game.drawHUD / drawBonfireMenu /
// drawDeathScreen (src/game/sim/Game.ts), rebuilt RICHER on Pixi and reading
// from the sim's WorldState view-model.
//
// ----------------------------------------------------------------------------
// COORDINATE SPACE & INTEGRATION
//   * The Hud is a Container in SCREEN space. Add it to the stage ON TOP of the
//     world (and on top of vignette / lighting / flash overlays).
//   * Call init(renderer) once after the Pixi app/renderer exists. It bakes a
//     couple of reused gradient/soft textures.
//   * Call resize(w, h) on viewport change (CSS pixels — the same w/h you pass
//     to update). Everything is laid out fresh from w/h, so it scales to any
//     size.
//   * Call showToast(title, sub) when the area changes (the integrator listens
//     for the sim's "areaChange" event). The banner fades over ~4 seconds.
//   * Call update(state, w, h, dt) EVERY frame. `dt` is in SECONDS (matches the
//     sim's frame delta and the "~4s" fade). It redraws all live HUD pieces and
//     swaps the active overlay to match `state.screen`.
//
// PERFORMANCE: every Text / Graphics / Container is created ONCE in init/ctor
// and REUSED. update() only mutates `.text`, re-runs `.clear()`+fluent redraws,
// toggles `.visible`, and nudges alpha/position. Nothing is allocated in the
// hot path. Off overlays are parked invisible (and skipped entirely).
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  Text,
  TextStyle,
  Sprite,
  Texture,
  FillGradient,
  type Renderer,
} from "pixi.js";

import type { WorldState, PlayerStats } from "@/game/sim/types";

// ============================================================================
// Palette (harvest-gothic) — see project brief. Numbers are 0xRRGGBB.
// ============================================================================

const C = {
  soil: 0x0d0a09,
  panel: 0x16100d,
  bark: 0x3a2a1f,
  tomato: 0xd83a2e,
  tomatoDark: 0x9e2018,
  rot: 0x9fb24e,
  sapLit: 0xffd56b,
  sap: 0xe8b53a,
  parchment: 0xe9dcc0,
  parchmentDim: 0xb9a98a,
  blood: 0x7a1414,
  ash: 0x6d6258,
  // a few derived shades used for shading/edges
  ironLight: 0x5a4636,
  ironDark: 0x241813,
  staminaExhaust: 0x7a6a1a,
  poison: 0x9fd44e,
  poisonBg: 0x1e2a12,
  black: 0x000000,
  white: 0xffffff,
} as const;

const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "'Courier New', ui-monospace, monospace";

// ============================================================================
// Small helpers (module-local; no deps on the rest of the game)
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate-independent exponential approach toward `target`. */
function damp(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** Canonical display names for weapons (kept local so the HUD owns no sim deps
 *  beyond the type-only `WeaponKind` via WorldState). Mirrors content.ts. */
const WEAPON_NAME: Record<string, string> = {
  whip: "Vine Whip",
  dagger: "Thorn Shiv",
  mace: "Knuckle of Gourd",
  rapier: "Old Tom's Pin",
};

/** Canonical display names for charms. Mirrors content.ts CHARMS. */
const CHARM_NAME: Record<string, string> = {
  salt_pouch: "Salt Pouch",
  cracked_trellis_ring: "Cracked Trellis Ring",
  beetle_husk_brooch: "Beetle Husk Brooch",
  thirsty_root: "Thirsty Root",
  hollow_seed: "Hollow Seed",
  first_fruits_pith: "First Fruit's Pith",
};

function weaponName(w: string): string {
  return WEAPON_NAME[w] ?? w;
}
function charmName(id: string | null): string {
  if (!id) return "";
  return CHARM_NAME[id] ?? id;
}

// A reusable TextStyle factory so we keep one style object per element and only
// tweak the handful of properties we animate.
function style(opts: Partial<TextStyle> & { fontSize: number }): TextStyle {
  // defaults first, then the caller's options (which always carry fontSize).
  return new TextStyle({
    fill: C.parchment as number,
    fontFamily: MONO,
    ...opts,
  });
}

// ============================================================================
// Iron-frame helper: an ornate beveled plate with corner rivets. Used to seat
// the vital bars and the boss bar so nothing reads as a flat rectangle.
// ============================================================================

/**
 * Draw a harvest-gothic iron plate into `g` (which the caller has .clear()'d).
 * Beveled fill (light top/left, dark bottom/right), a bark outline, and four
 * corner rivets. Inset content area is (x+pad, y+pad, w-2pad, h-2pad).
 */
function ironPlate(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  pad: number,
  opts?: { rivets?: boolean; alpha?: number }
): void {
  const a = opts?.alpha ?? 1;
  const r = Math.min(6, pad);
  // drop shadow
  g.roundRect(x - 2, y - 1, w + 4, h + 5, r + 2).fill({ color: C.black, alpha: 0.45 * a });
  // dark base
  g.roundRect(x, y, w, h, r).fill({ color: C.ironDark, alpha: a });
  // top bevel highlight (a thin lighter band across the top + left)
  g.roundRect(x + 1, y + 1, w - 2, Math.max(2, h * 0.42), r).fill({ color: C.ironLight, alpha: 0.5 * a });
  // panel face
  g.roundRect(x + 2, y + 2, w - 4, h - 4, Math.max(1, r - 2)).fill({ color: C.panel, alpha: a });
  // bark outline
  g.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r).stroke({ color: C.bark, width: 1.5, alpha: a });
  // inner hairline (engraved look)
  g.roundRect(x + pad - 2, y + pad - 2, w - 2 * (pad - 2), h - 2 * (pad - 2), Math.max(1, r - 3))
    .stroke({ color: C.ironDark, width: 1, alpha: 0.8 * a });
  if (opts?.rivets ?? true) {
    const rv = 2.2;
    const inset = pad - 1;
    const pts: [number, number][] = [
      [x + inset, y + inset],
      [x + w - inset, y + inset],
      [x + inset, y + h - inset],
      [x + w - inset, y + h - inset],
    ];
    for (const [px, py] of pts) {
      g.circle(px, py, rv).fill({ color: C.ironLight, alpha: 0.9 * a });
      g.circle(px - 0.4, py - 0.4, rv * 0.5).fill({ color: C.parchmentDim, alpha: 0.5 * a });
    }
  }
}

// ============================================================================
// THE HUD
// ============================================================================

export class Hud extends Container {
  // --- layout state ---
  private w = 1280;
  private h = 720;

  // --- smoothed / animated values (kept across frames) ---
  private hpChip = 1; // lagging "chip" fraction (drains toward real hp frac)
  private hpReal = 1; // last real hp fraction (to detect damage for chip)
  private stamShown = 1; // smoothed stamina fraction (so it glides)
  private exhaustFlash = 0; // 0..1 pulse when exhausted
  private pulseT = 0; // free-running clock for low-hp / cursor pulses
  private toastT = 0; // seconds remaining on the area banner (4 -> 0)
  private bossShown = 0; // smoothed boss hp01 (chip-style drain)
  private bossSeen = false; // was the boss bar visible last frame (for slide-in)
  private bossIn = 0; // 0..1 boss-bar reveal progress

  // a baked soft-dot texture for glints (sap coin sheen, estus fill glow)
  private softDot: Texture = Texture.WHITE;
  private ready = false;

  // ---- containers (z-order top to bottom is add order) ----
  private hudLayer = new Container(); // the always-on play HUD
  private overlayLayer = new Container(); // full-screen overlays (dim + panels)

  // ---- vitals (top-left) ----
  private gVitals = new Graphics(); // all the bar frames + fills + estus pips
  private txtEstus = new Text({ text: "", style: style({ fontSize: 13, fontFamily: MONO, fontWeight: "bold", fill: C.parchment, letterSpacing: 1 }) });
  private txtWeapon = new Text({ text: "", style: style({ fontSize: 13, fontFamily: SERIF, fontStyle: "italic", fill: C.rot }) });
  private txtCharm = new Text({ text: "", style: style({ fontSize: 12, fontFamily: SERIF, fontStyle: "italic", fill: 0xc79be0 }) });

  // ---- sap + level (top-right) ----
  private gSap = new Graphics(); // coin glyph + framing
  private txtSap = new Text({ text: "0", style: style({ fontSize: 18, fontFamily: MONO, fontWeight: "bold", fill: C.sapLit, letterSpacing: 1 }) });
  private txtLevel = new Text({ text: "LV 1", style: style({ fontSize: 11, fontFamily: MONO, fill: C.parchmentDim, letterSpacing: 2 }) });

  // ---- boss bar (bottom-center) ----
  private bossWrap = new Container();
  private gBoss = new Graphics();
  private txtBossName = new Text({ text: "", style: style({ fontSize: 17, fontFamily: SERIF, fontStyle: "italic", fill: C.parchment, letterSpacing: 1 }) });

  // ---- area toast (center) ----
  private toastWrap = new Container();
  private txtToastTitle = new Text({ text: "", style: style({ fontSize: 40, fontFamily: SERIF, fontStyle: "italic", fill: C.parchment, letterSpacing: 2 }) });
  private txtToastSub = new Text({ text: "", style: style({ fontSize: 17, fontFamily: SERIF, fontStyle: "italic", fill: C.parchmentDim, letterSpacing: 1 }) });
  private gToastRule = new Graphics(); // a thin parchment rule under the title

  // ---- shared overlay dimmer (reused across every screen) ----
  private gDim = new Graphics();

  // ---- DEATH overlay ----
  private deadWrap = new Container();
  private gDeadVignette = new Graphics();
  private txtDeadTitle = new Text({ text: "YOU WILTED", style: style({ fontSize: 72, fontFamily: SERIF, fontWeight: "bold", fill: C.tomatoDark, letterSpacing: 3 }) });
  private txtDeadSub = new Text({ text: "your sap spills into the soil. reclaim it where you fell.", style: style({ fontSize: 16, fontFamily: SERIF, fontStyle: "italic", fill: 0x7a5a4a }) });
  private txtDeadHint = new Text({ text: "press SPACE to rise", style: style({ fontSize: 13, fontFamily: MONO, fill: C.parchment, letterSpacing: 2 }) });

  // ---- VICTORY overlay ----
  private winWrap = new Container();
  private gWinRays = new Graphics();
  private txtWinTitle = new Text({ text: "HARVEST SURVIVED", style: style({ fontSize: 58, fontFamily: SERIF, fontWeight: "bold", fill: C.sapLit, letterSpacing: 3 }) });
  private txtWinSub = new Text({ text: "Tommy stands amid the wreckage of the blade. The rows are still.", style: style({ fontSize: 18, fontFamily: SERIF, fontStyle: "italic", fill: C.rot }) });
  private txtWinSub2 = new Text({ text: "He is not safe. He is simply not paste. For a tomato, that is enough.", style: style({ fontSize: 14, fontFamily: SERIF, fill: C.parchmentDim }) });

  // ---- PAUSE overlay ----
  private pauseWrap = new Container();
  private gPausePanel = new Graphics();
  private txtPauseTitle = new Text({ text: "PAUSED", style: style({ fontSize: 42, fontFamily: SERIF, fontStyle: "italic", fill: C.parchment, letterSpacing: 4 }) });
  private txtPauseHint = new Text({ text: "press P to resume", style: style({ fontSize: 13, fontFamily: MONO, fill: C.parchmentDim, letterSpacing: 1 }) });
  private txtPauseCtl = new Text({
    text:
      "WASD move   ·   MOUSE aim   ·   LMB light   ·   F heavy   ·   SPACE roll\nRMB guard (time it = parry)   ·   1-4 weapons   ·   TAB lock-on   ·   R heal   ·   E rest",
    style: style({ fontSize: 12, fontFamily: MONO, fill: C.ash, align: "center", lineHeight: 20 }),
  });

  // ---- BONFIRE (Compost Heap) menu ----
  private bonfireWrap = new Container();
  private gBonfirePanel = new Graphics();
  private gBonfireFlame = new Graphics(); // a little ember crest under the title
  private txtBonfireTitle = new Text({ text: "THE COMPOST HEAP", style: style({ fontSize: 30, fontFamily: SERIF, fontStyle: "italic", fill: 0xffb347, letterSpacing: 3 }) });
  private txtBonfireSub = new Text({ text: "strengthen the fruit — spend sap", style: style({ fontSize: 13, fontFamily: MONO, fill: C.ash, letterSpacing: 1 }) });
  private gBonfireCursor = new Graphics(); // the selection highlight + caret
  // four stat rows + LEAVE row — each a label / hint / value text, reused.
  private statRows: {
    name: Text;
    hint: Text;
    value: Text;
  }[] = [];
  private txtLeave = new Text({ text: "LEAVE", style: style({ fontSize: 16, fontFamily: MONO, fontWeight: "bold", fill: C.parchmentDim, letterSpacing: 2 }) });
  private txtCost = new Text({ text: "", style: style({ fontSize: 14, fontFamily: MONO, fill: C.sapLit, letterSpacing: 1 }) });
  private txtBonfireCtl = new Text({
    text: "↑ / ↓  choose   ·   ENTER  invest   ·   E  leave",
    style: style({ fontSize: 11, fontFamily: MONO, fill: C.ash, letterSpacing: 1 }),
  });

  private static readonly STAT_DEFS: { key: keyof PlayerStats; label: string; hint: string }[] = [
    { key: "vigor", label: "VIGOR", hint: "max health" },
    { key: "strength", label: "STRENGTH", hint: "attack power" },
    { key: "vitality", label: "VITALITY", hint: "stamina" },
    { key: "agility", label: "AGILITY", hint: "speed & roll" },
  ];

  constructor() {
    super();
    // The HUD never wants to intercept pointer/raycasts.
    this.eventMode = "none";
    this.interactiveChildren = false;

    // ---- assemble the always-on HUD layer ----
    this.gVitals.label = "vitals";
    this.hudLayer.addChild(this.gVitals, this.txtEstus, this.txtWeapon, this.txtCharm);
    this.hudLayer.addChild(this.gSap, this.txtSap, this.txtLevel);

    // boss bar (anchored name + bar)
    this.txtBossName.anchor.set(0.5, 1);
    this.bossWrap.addChild(this.gBoss, this.txtBossName);
    this.hudLayer.addChild(this.bossWrap);

    // toast
    this.txtToastTitle.anchor.set(0.5, 0.5);
    this.txtToastSub.anchor.set(0.5, 0.5);
    this.toastWrap.addChild(this.gToastRule, this.txtToastTitle, this.txtToastSub);
    this.hudLayer.addChild(this.toastWrap);

    // ---- overlays ----
    this.gDim.label = "dim";
    this.overlayLayer.addChild(this.gDim);

    // death
    this.txtDeadTitle.anchor.set(0.5);
    this.txtDeadSub.anchor.set(0.5);
    this.txtDeadHint.anchor.set(0.5);
    this.deadWrap.addChild(this.gDeadVignette, this.txtDeadTitle, this.txtDeadSub, this.txtDeadHint);
    this.overlayLayer.addChild(this.deadWrap);

    // victory
    this.txtWinTitle.anchor.set(0.5);
    this.txtWinSub.anchor.set(0.5);
    this.txtWinSub2.anchor.set(0.5);
    this.winWrap.addChild(this.gWinRays, this.txtWinTitle, this.txtWinSub, this.txtWinSub2);
    this.overlayLayer.addChild(this.winWrap);

    // pause
    this.txtPauseTitle.anchor.set(0.5);
    this.txtPauseHint.anchor.set(0.5);
    this.txtPauseCtl.anchor.set(0.5);
    this.pauseWrap.addChild(this.gPausePanel, this.txtPauseTitle, this.txtPauseHint, this.txtPauseCtl);
    this.overlayLayer.addChild(this.pauseWrap);

    // bonfire
    this.txtBonfireTitle.anchor.set(0.5);
    this.txtBonfireSub.anchor.set(0.5);
    this.txtLeave.anchor.set(0.5);
    this.txtCost.anchor.set(0.5);
    this.txtBonfireCtl.anchor.set(0.5);
    this.bonfireWrap.addChild(this.gBonfirePanel, this.gBonfireFlame, this.gBonfireCursor);
    this.bonfireWrap.addChild(this.txtBonfireTitle, this.txtBonfireSub);
    for (let i = 0; i < Hud.STAT_DEFS.length; i++) {
      const def = Hud.STAT_DEFS[i];
      const name = new Text({ text: def.label, style: style({ fontSize: 18, fontFamily: MONO, fontWeight: "bold", fill: C.parchment, letterSpacing: 1 }) });
      const hint = new Text({ text: def.hint, style: style({ fontSize: 11, fontFamily: MONO, fill: C.ash }) });
      const value = new Text({ text: "0", style: style({ fontSize: 20, fontFamily: MONO, fontWeight: "bold", fill: C.parchment }) });
      value.anchor.set(1, 0); // right-aligned values
      const row = { name, hint, value };
      this.statRows.push(row);
      this.bonfireWrap.addChild(name, hint, value);
    }
    this.bonfireWrap.addChild(this.txtLeave, this.txtCost, this.txtBonfireCtl);
    this.overlayLayer.addChild(this.bonfireWrap);

    // assemble root: HUD under overlays
    this.addChild(this.hudLayer);
    this.addChild(this.overlayLayer);

    // start with overlays parked
    this.deadWrap.visible = false;
    this.winWrap.visible = false;
    this.pauseWrap.visible = false;
    this.bonfireWrap.visible = false;
    this.gDim.visible = false;
    this.toastWrap.visible = false;
    this.bossWrap.visible = false;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Bake reused textures. Call once after the Pixi renderer exists. */
  init(renderer: Renderer): void {
    if (this.ready) return;
    // soft radial dot used for glints (sap sheen, estus glow, ember).
    const g = new Graphics();
    const R = 32;
    for (let i = 12; i >= 1; i--) {
      const t = i / 12;
      g.circle(R, R, R * 0.95 * t).fill({ color: 0xffffff, alpha: 0.12 });
    }
    this.softDot = renderer.generateTexture({ target: g, resolution: 1, antialias: true });
    g.destroy();
    this.ready = true;
  }

  /** Lay out for a new viewport (CSS pixels). Re-runs all static positioning. */
  resize(w: number, h: number): void {
    this.w = Math.max(320, Math.round(w));
    this.h = Math.max(240, Math.round(h));
    this.layoutStatic();
  }

  /**
   * Trigger the area-entry banner. Fades in then out over ~4 seconds (driven
   * inside update()). Call on the sim's "areaChange" event.
   */
  showToast(title: string, sub: string): void {
    this.txtToastTitle.text = title;
    this.txtToastSub.text = sub;
    this.toastT = 4;
    // re-center now that text width changed (layout reads measured width)
    this.layoutToast();
  }

  // --------------------------------------------------------------------------
  // Static layout (positions that only depend on w/h, not per-frame state)
  // --------------------------------------------------------------------------

  private layoutStatic(): void {
    const W = this.w;
    const H = this.h;

    // vitals block top-left — text rows under the bars (bars themselves are
    // drawn in gVitals each frame at fixed coords below).
    const bx = 26;
    this.txtEstus.position.set(bx, 76);
    this.txtWeapon.position.set(bx, 100);
    this.txtCharm.position.set(bx, 120);

    // sap/level top-right. The coin glyph sits left of the number.
    this.txtSap.anchor.set(1, 0);
    this.txtSap.position.set(W - 26, 24);
    this.txtLevel.anchor.set(1, 0);
    this.txtLevel.position.set(W - 26, 50);

    // overlays
    this.layoutToast();
    this.layoutOverlays();
  }

  private layoutToast(): void {
    const W = this.w;
    const H = this.h;
    const cy = H * 0.42;
    this.txtToastTitle.position.set(W / 2, cy);
    this.txtToastSub.position.set(W / 2, cy + 34);
  }

  private layoutOverlays(): void {
    const W = this.w;
    const H = this.h;
    const cx = W / 2;
    const cy = H / 2;

    // ---- death ----
    this.txtDeadTitle.position.set(cx, cy - 6);
    this.txtDeadSub.position.set(cx, cy + 34);
    this.txtDeadHint.position.set(cx, cy + 78);

    // ---- victory ----
    this.txtWinTitle.position.set(cx, cy - 34);
    this.txtWinSub.position.set(cx, cy + 8);
    this.txtWinSub2.position.set(cx, cy + 36);

    // ---- pause ----
    this.txtPauseTitle.position.set(cx, cy - 24);
    this.txtPauseHint.position.set(cx, cy + 14);
    this.txtPauseCtl.position.set(cx, cy + 56);

    // ---- bonfire: a centered iron tablet ----
    const panelW = Math.min(560, W - 80);
    const panelH = Math.min(520, H - 80);
    const px = cx - panelW / 2;
    const py = cy - panelH / 2;
    this.bonfirePanelRect = { x: px, y: py, w: panelW, h: panelH };

    this.txtBonfireTitle.position.set(cx, py + 56);
    this.txtBonfireSub.position.set(cx, py + 86);

    const rowsTop = py + 138;
    const rowGap = 56;
    const colL = px + 48; // label column
    const colR = px + panelW - 48; // value column (right-aligned)
    for (let i = 0; i < this.statRows.length; i++) {
      const ry = rowsTop + i * rowGap;
      const r = this.statRows[i];
      r.name.position.set(colL, ry);
      r.hint.position.set(colL, ry + 22);
      r.value.position.set(colR, ry - 2);
    }
    const leaveY = rowsTop + this.statRows.length * rowGap + 6;
    this.txtLeave.position.set(cx, leaveY + 8);
    this.txtCost.position.set(cx, leaveY + 42);
    this.txtBonfireCtl.position.set(cx, py + panelH - 26);
  }

  private bonfirePanelRect = { x: 0, y: 0, w: 0, h: 0 };

  // --------------------------------------------------------------------------
  // Per-frame update
  // --------------------------------------------------------------------------

  /**
   * Redraw the HUD for this frame. `dt` in SECONDS.
   * @param state the readable world snapshot
   * @param w,h   current viewport in CSS px (must match the canvas; triggers a
   *              re-layout if it changed since last resize)
   * @param dt    frame delta in seconds
   */
  update(state: WorldState, w: number, h: number, dt: number): void {
    // pick up viewport changes even if resize() wasn't called explicitly.
    if (Math.round(w) !== this.w || Math.round(h) !== this.h) {
      this.resize(w, h);
    }
    if (dt > 0.1) dt = 0.1; // clamp big stalls so chips/pulses stay sane
    this.pulseT += dt;
    if (this.toastT > 0) this.toastT -= dt;

    const screen = state.screen;
    const showVitals = screen === "play" || screen === "bonfire" || screen === "paused";

    this.hudLayer.visible = screen !== "loading";
    if (this.hudLayer.visible) {
      this.gVitals.visible = showVitals;
      this.txtEstus.visible = showVitals;
      this.txtWeapon.visible = showVitals;
      this.txtCharm.visible = showVitals;
      this.gSap.visible = showVitals;
      this.txtSap.visible = showVitals;
      this.txtLevel.visible = showVitals;
      if (showVitals) {
        this.drawVitals(state, dt);
        this.drawSap(state);
      }
      this.drawBossBar(state, dt);
      this.drawToast(screen);
    }

    this.drawOverlays(state);
  }

  // --------------------------------------------------------------------------
  // Vitals: HP (chip + pulse), stamina (leafy, exhaust flash), poison, estus
  // --------------------------------------------------------------------------

  private drawVitals(state: WorldState, dt: number): void {
    const p = state.player;
    const g = this.gVitals;
    g.clear();

    const x = 26;
    let y = 22;
    const hpW = 300;
    const hpH = 18;
    const stamW = 240;
    const stamH = 11;

    // ----- HP bar -----
    const hpFrac = p.maxHp > 0 ? clamp(p.hp / p.maxHp, 0, 1) : 0;
    // chip logic: chip snaps UP instantly on heal, lags DOWN on damage.
    if (hpFrac >= this.hpChip) this.hpChip = hpFrac;
    else this.hpChip = damp(this.hpChip, hpFrac, 4.5, dt);
    // small settle so the chip fully resolves
    if (this.hpChip - hpFrac < 0.002) this.hpChip = hpFrac;
    this.hpReal = hpFrac;

    // frame plate
    ironPlate(g, x - 6, y - 6, hpW + 12, hpH + 12, 6);
    // bar track
    const tx = x;
    const ty = y;
    g.roundRect(tx, ty, hpW, hpH, 3).fill({ color: C.ironDark });
    g.roundRect(tx, ty, hpW, hpH, 3).fill({ color: 0x2a0d0a, alpha: 0.9 });
    // chip (lighter, lagging) layer
    const chipW = hpW * this.hpChip;
    if (chipW > 1) {
      g.roundRect(tx, ty, chipW, hpH, 3).fill({ color: 0xe8b3a0, alpha: 0.55 });
    }
    // real hp fill — vertical gradient tomato -> darker, with a low-hp pulse.
    const fillW = hpW * hpFrac;
    if (fillW > 1) {
      const grad = new FillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
          { offset: 0, color: C.tomato },
          { offset: 0.55, color: C.tomatoDark },
          { offset: 1, color: 0x6e1410 },
        ],
      });
      g.roundRect(tx, ty, fillW, hpH, 3).fill(grad);
      // glossy top highlight
      g.roundRect(tx + 1, ty + 1, Math.max(0, fillW - 2), hpH * 0.4, 2).fill({ color: 0xffffff, alpha: 0.14 });
      // low-health danger pulse: a red wash + brighter rim when hp <= 30%
      if (hpFrac <= 0.3) {
        const pulse = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(this.pulseT * 7));
        g.roundRect(tx, ty, fillW, hpH, 3).fill({ color: C.tomato, alpha: pulse * 0.5 });
        g.roundRect(tx + 0.5, ty + 0.5, fillW - 1, hpH - 1, 3).stroke({ color: 0xff6a5a, width: 1.5, alpha: pulse });
      }
    }
    // segment ticks (every 25%) — engraved notches
    for (let s = 1; s < 4; s++) {
      const sx = tx + (hpW * s) / 4;
      g.moveTo(sx, ty + 2).lineTo(sx, ty + hpH - 2).stroke({ color: C.ironDark, width: 1, alpha: 0.7 });
    }
    // numeric overlay (drawn as a Graphics-free Text would need its own object;
    // we keep the bar purely graphical and put the count in the estus row).

    // ----- Stamina bar (leafy green) -----
    y = 46;
    const stamFrac = p.maxStamina > 0 ? clamp(p.stamina / p.maxStamina, 0, 1) : 0;
    this.stamShown = damp(this.stamShown, stamFrac, 14, dt);
    if (Math.abs(this.stamShown - stamFrac) < 0.002) this.stamShown = stamFrac;
    // exhaust flash envelope
    if (p.exhausted) this.exhaustFlash = 1;
    else this.exhaustFlash = Math.max(0, this.exhaustFlash - dt * 3);

    ironPlate(g, x - 5, y - 5, stamW + 10, stamH + 10, 5, { rivets: false });
    g.roundRect(x, y, stamW, stamH, 3).fill({ color: C.poisonBg });
    const sfw = stamW * this.stamShown;
    if (sfw > 1) {
      const base = p.exhausted ? C.staminaExhaust : C.rot;
      const grad = new FillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: [
          { offset: 0, color: p.exhausted ? 0xb6a23a : 0xcfe06a },
          { offset: 1, color: base },
        ],
      });
      g.roundRect(x, y, sfw, stamH, 3).fill(grad);
      g.roundRect(x + 1, y + 1, Math.max(0, sfw - 2), stamH * 0.4, 2).fill({ color: 0xffffff, alpha: 0.12 });
    }
    // exhaust flash: a warning wash across the whole track
    if (this.exhaustFlash > 0) {
      const f = this.exhaustFlash * (0.4 + 0.6 * Math.abs(Math.sin(this.pulseT * 12)));
      g.roundRect(x, y, stamW, stamH, 3).fill({ color: 0xffd56b, alpha: 0.35 * f });
      g.roundRect(x, y, stamW, stamH, 3).stroke({ color: 0xffe39a, width: 1.5, alpha: 0.8 * f });
    }
    // a couple of tiny leaf nicks on the stamina bar to sell "leafy"
    g.moveTo(x + 4, y).lineTo(x + 8, y - 3).lineTo(x + 12, y).stroke({ color: C.rot, width: 1, alpha: 0.6 });

    // ----- Poison meter (only when poison > 0) -----
    if (p.poison > 0) {
      const py = y + stamH + 5;
      const pw = 168;
      const ph = 6;
      const pf = clamp(p.poison / 48, 0, 1);
      g.roundRect(x - 1, py - 1, pw + 2, ph + 2, 2).fill({ color: C.black, alpha: 0.5 });
      g.roundRect(x, py, pw, ph, 2).fill({ color: C.poisonBg });
      const bubble = 0.5 + 0.5 * Math.sin(this.pulseT * 5);
      g.roundRect(x, py, pw * pf, ph, 2).fill({ color: C.poison });
      g.roundRect(x, py, pw * pf, ph, 2).fill({ color: 0xd6f07a, alpha: 0.25 * bubble });
      // a few rising "bubbles" hinted as dots along the fill
      for (let i = 0; i < 3; i++) {
        const bxp = x + ((this.pulseT * 18 + i * 57) % Math.max(1, pw * pf));
        g.circle(bxp, py + ph * 0.5, 1.2).fill({ color: 0xe8ffae, alpha: 0.5 * bubble });
      }
    }

    // ----- Estus pips (watering cans) -----
    // drawn into the same Graphics; the label text sits to their right.
    const estX = x + 2;
    const estY = 70;
    const pipGap = 22;
    for (let i = 0; i < p.estusMax; i++) {
      const cx = estX + i * pipGap + 7;
      const cy = estY;
      const filled = i < p.estus;
      this.drawWateringCan(g, cx, cy, filled);
    }
    // estus count label position trails after the pips
    this.txtEstus.position.set(estX + p.estusMax * pipGap + 6, estY - 6);
    this.txtEstus.text = `${p.estus} / ${p.estusMax}`;
    this.txtEstus.style.fill = p.estus > 0 ? C.sapLit : C.ash;

    // ----- weapon + charm labels -----
    this.txtWeapon.text = "⚔ " + weaponName(p.weapon);
    if (p.charmId) {
      this.txtCharm.visible = true;
      this.txtCharm.text = "❖ " + charmName(p.charmId);
      this.txtCharm.position.set(26, 120);
    } else {
      this.txtCharm.visible = false;
    }
  }

  /** A tiny watering-can estus pip (filled = a charge remaining). */
  private drawWateringCan(g: Graphics, cx: number, cy: number, filled: boolean): void {
    const body = filled ? C.sap : C.ironDark;
    const edge = filled ? C.sapLit : C.bark;
    const a = filled ? 1 : 0.7;
    // body (rounded canister)
    g.roundRect(cx - 6, cy - 3, 11, 9, 2).fill({ color: body, alpha: a });
    // spout (a slanted line out the top-left)
    g.moveTo(cx - 6, cy - 1)
      .lineTo(cx - 10, cy - 5)
      .lineTo(cx - 8, cy - 6)
      .lineTo(cx - 5, cy - 3)
      .fill({ color: body, alpha: a });
    // handle (arc over the top)
    g.moveTo(cx - 3, cy - 3)
      .quadraticCurveTo(cx, cy - 9, cx + 4, cy - 3)
      .stroke({ color: edge, width: 1.3, alpha: a });
    // rim highlight + outline
    g.roundRect(cx - 6, cy - 3, 11, 9, 2).stroke({ color: edge, width: 1, alpha: a });
    if (filled) {
      // a glint of sap at the spout
      g.circle(cx - 9, cy - 5, 1.1).fill({ color: 0xffe7a0, alpha: 0.9 });
    }
  }

  // --------------------------------------------------------------------------
  // Sap counter + level (top-right) with a coin glyph
  // --------------------------------------------------------------------------

  private drawSap(state: WorldState): void {
    const p = state.player;
    this.txtSap.text = p.sap.toLocaleString();
    this.txtLevel.text = "LV " + p.level;

    // place the coin to the LEFT of the number (txtSap is right-anchored at
    // W-26). Measure the number width to know where the coin goes.
    const numW = this.txtSap.width;
    const coinCx = this.w - 26 - numW - 14;
    const coinCy = 24 + 9;

    const g = this.gSap;
    g.clear();
    // coin body — concentric gold with a notch ring
    g.circle(coinCx, coinCy, 8).fill({ color: C.sap });
    g.circle(coinCx, coinCy, 8).stroke({ color: 0x8a6a1a, width: 1.5 });
    g.circle(coinCx, coinCy, 5.5).stroke({ color: C.sapLit, width: 1, alpha: 0.8 });
    // a stylised seed/leaf mark stamped in the middle
    g.moveTo(coinCx, coinCy - 3)
      .quadraticCurveTo(coinCx + 3.5, coinCy, coinCx, coinCy + 3)
      .quadraticCurveTo(coinCx - 3.5, coinCy, coinCx, coinCy - 3)
      .fill({ color: 0x8a6a1a, alpha: 0.8 });
    // sheen glint top-left
    g.circle(coinCx - 2.5, coinCy - 2.5, 1.6).fill({ color: 0xfff2c0, alpha: 0.9 });
  }

  // --------------------------------------------------------------------------
  // Boss bar (bottom-center): ornate frame, italic serif name, phase-2 notch
  // --------------------------------------------------------------------------

  private drawBossBar(state: WorldState, dt: number): void {
    const boss = state.boss;
    const visible =
      !!boss &&
      boss.active &&
      (state.screen === "play" || state.screen === "paused");

    if (!visible || !boss) {
      this.bossWrap.visible = false;
      this.bossSeen = false;
      this.bossIn = 0;
      return;
    }
    this.bossWrap.visible = true;

    // reveal slide-in on first appearance
    if (!this.bossSeen) {
      this.bossIn = 0;
      this.bossShown = boss.hp01;
      this.bossSeen = true;
    }
    this.bossIn = Math.min(1, this.bossIn + dt * 2.5);
    const reveal = this.bossIn;

    // chip-style drain (snaps up on heal, lags down on damage)
    const frac = clamp(boss.hp01, 0, 1);
    if (frac >= this.bossShown) this.bossShown = frac;
    else this.bossShown = damp(this.bossShown, frac, 3.2, dt);
    if (this.bossShown - frac < 0.002) this.bossShown = frac;

    const W = this.w;
    const H = this.h;
    const bw = Math.min(680, W - 120);
    const bh = 16;
    const bx = (W - bw) / 2;
    const by = H - 56;

    const g = this.gBoss;
    g.clear();
    // entrance: rise up + fade
    this.bossWrap.alpha = reveal;
    this.bossWrap.y = (1 - reveal) * 14;

    // ornate frame: an iron plate with little spikes/finials on the ends.
    ironPlate(g, bx - 10, by - 8, bw + 20, bh + 16, 7);
    // end finials (triangular barbs) for a scarecrow-iron feel
    const finial = (fx: number, dir: number) => {
      g.moveTo(fx, by - 8)
        .lineTo(fx + dir * 12, by + bh / 2)
        .lineTo(fx, by + bh + 8)
        .fill({ color: C.ironDark });
      g.moveTo(fx, by - 8)
        .lineTo(fx + dir * 12, by + bh / 2)
        .lineTo(fx, by + bh + 8)
        .stroke({ color: C.bark, width: 1.2 });
    };
    finial(bx - 10, -1);
    finial(bx + bw + 10, 1);

    // track
    g.roundRect(bx, by, bw, bh, 3).fill({ color: 0x1a0606 });
    // fill: blood gradient; phase-2 tints it hotter (toward tomato/orange)
    const fillW = bw * this.bossShown;
    if (fillW > 1) {
      const grad = new FillGradient({
        type: "linear",
        start: { x: 0, y: 0 },
        end: { x: 0, y: 1 },
        colorStops: boss.phase2
          ? [
              { offset: 0, color: 0xff5a3a },
              { offset: 0.6, color: C.tomatoDark },
              { offset: 1, color: 0x5e0c0c },
            ]
          : [
              { offset: 0, color: C.tomatoDark },
              { offset: 0.6, color: 0x7e1814 },
              { offset: 1, color: 0x4a0a0a },
            ],
      });
      g.roundRect(bx, by, fillW, bh, 3).fill(grad);
      g.roundRect(bx + 1, by + 1, Math.max(0, fillW - 2), bh * 0.38, 2).fill({ color: 0xffffff, alpha: 0.12 });
    }
    // phase-2 notch: a glowing midline divider + faint overall ember tint
    if (boss.phase2) {
      const notchX = bx + bw * 0.5;
      g.moveTo(notchX, by - 6).lineTo(notchX, by + bh + 6).stroke({ color: 0xffb347, width: 2, alpha: 0.9 });
      g.circle(notchX, by + bh / 2, 3).fill({ color: 0xffd56b, alpha: 0.9 });
      const ember = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin(this.pulseT * 6));
      g.roundRect(bx, by, bw, bh, 3).fill({ color: 0xff7a3a, alpha: ember });
    }
    // segmented tick marks across the bar (boss-bar staple)
    const segs = 16;
    for (let s = 1; s < segs; s++) {
      const sx = bx + (bw * s) / segs;
      g.moveTo(sx, by + 2).lineTo(sx, by + bh - 2).stroke({ color: C.black, width: 1, alpha: 0.4 });
    }
    // outer keyline
    g.roundRect(bx - 0.5, by - 0.5, bw + 1, bh + 1, 3).stroke({ color: C.bark, width: 1.2 });

    // name plate above the bar
    this.txtBossName.text = boss.name;
    this.txtBossName.style.fill = boss.phase2 ? 0xffcaa0 : C.parchment;
    this.txtBossName.position.set(W / 2, by - 12);
  }

  // --------------------------------------------------------------------------
  // Area toast (center): big italic serif title + subtitle, fading
  // --------------------------------------------------------------------------

  private drawToast(screen: WorldState["screen"]): void {
    // only over live play; hide while in menus/overlays
    if (this.toastT <= 0 || screen !== "play") {
      this.toastWrap.visible = false;
      return;
    }
    this.toastWrap.visible = true;
    // fade in over the first ~1s, hold, fade out over the last ~1.2s
    const t = this.toastT; // 4 -> 0
    let a: number;
    if (t > 3) a = clamp(4 - t, 0, 1); // 0..1 in
    else a = clamp(t / 1.2, 0, 1); // out
    this.toastWrap.alpha = a;
    // a slow upward drift as it fades for a touch of life
    const drift = (1 - clamp(t / 4, 0, 1)) * 6;
    this.toastWrap.y = -drift;

    // a thin parchment rule under the title, sized to the title width
    const g = this.gToastRule;
    g.clear();
    const cx = this.w / 2;
    const ty = this.txtToastTitle.y;
    const tw = Math.min(this.w - 80, this.txtToastTitle.width + 80);
    const ry = ty + 22;
    g.moveTo(cx - tw / 2, ry).lineTo(cx + tw / 2, ry).stroke({ color: C.parchmentDim, width: 1, alpha: 0.7 });
    // little diamond endcaps
    for (const ex of [cx - tw / 2, cx + tw / 2]) {
      g.moveTo(ex, ry - 3).lineTo(ex + 3, ry).lineTo(ex, ry + 3).lineTo(ex - 3, ry).fill({ color: C.sap, alpha: 0.8 });
    }
  }

  // --------------------------------------------------------------------------
  // Full-screen overlays, switched by state.screen
  // --------------------------------------------------------------------------

  private drawOverlays(state: WorldState): void {
    const s = state.screen;
    const dead = s === "dead";
    const win = s === "victory";
    const paused = s === "paused";
    const bonfire = s === "bonfire";
    const anyOverlay = dead || win || paused || bonfire;

    this.overlayLayer.visible = anyOverlay;
    if (!anyOverlay) {
      // nothing on top of the world
      this.deadWrap.visible = false;
      this.winWrap.visible = false;
      this.pauseWrap.visible = false;
      this.bonfireWrap.visible = false;
      this.gDim.visible = false;
      return;
    }

    // shared scene dimmer (tinted per screen) — dims the world behind overlays.
    this.gDim.visible = true;
    const dg = this.gDim;
    dg.clear();
    let dimColor: number = C.soil;
    let dimAlpha = 0.72;
    if (dead) {
      dimColor = 0x140202;
      dimAlpha = 0.72;
    } else if (win) {
      dimColor = 0x08050a;
      dimAlpha = 0.85;
    } else if (paused) {
      dimColor = C.soil;
      dimAlpha = 0.66;
    } else if (bonfire) {
      dimColor = 0x080504;
      dimAlpha = 0.84;
    }
    dg.rect(0, 0, this.w, this.h).fill({ color: dimColor, alpha: dimAlpha });

    this.deadWrap.visible = dead;
    this.winWrap.visible = win;
    this.pauseWrap.visible = paused;
    this.bonfireWrap.visible = bonfire;

    if (dead) this.drawDeath();
    else if (win) this.drawVictory(state);
    else if (paused) this.drawPause();
    else if (bonfire) this.drawBonfire(state);
  }

  private drawDeath(): void {
    // a blood vignette closing in from the edges + a pulsing rise prompt.
    const g = this.gDeadVignette;
    g.clear();
    const W = this.w;
    const H = this.h;
    const cx = W / 2;
    const cy = H / 2;
    const rMax = Math.hypot(cx, cy);
    const grad = new FillGradient({
      type: "radial",
      center: { x: cx, y: cy },
      innerRadius: rMax * 0.32,
      outerCenter: { x: cx, y: cy },
      outerRadius: rMax,
      textureSpace: "global",
      colorStops: [
        { offset: 0, color: [0.48, 0.08, 0.08, 0] },
        { offset: 0.7, color: [0.36, 0.05, 0.05, 0.35] },
        { offset: 1, color: [0.2, 0.02, 0.02, 0.75] },
      ],
    });
    g.rect(0, 0, W, H).fill(grad);
    // a faint engraved laurel under the title
    const ly = cy + 14;
    g.moveTo(cx - 120, ly).lineTo(cx + 120, ly).stroke({ color: C.blood, width: 1, alpha: 0.5 });

    // pulsing prompt
    const pulse = 0.55 + 0.35 * Math.sin(this.pulseT * 4);
    this.txtDeadHint.alpha = pulse;
  }

  private drawVictory(state: WorldState): void {
    // golden god-rays fanning from behind the title.
    const g = this.gWinRays;
    g.clear();
    const W = this.w;
    const H = this.h;
    const cx = W / 2;
    const cy = H / 2 - 30;
    const rays = 14;
    const len = Math.hypot(W, H);
    for (let i = 0; i < rays; i++) {
      const base = (i / rays) * Math.PI * 2;
      const a = base + this.pulseT * 0.12;
      const spread = 0.09;
      const x1 = cx + Math.cos(a - spread) * len;
      const y1 = cy + Math.sin(a - spread) * len;
      const x2 = cx + Math.cos(a + spread) * len;
      const y2 = cy + Math.sin(a + spread) * len;
      const tw = 0.06 + 0.04 * (0.5 + 0.5 * Math.sin(this.pulseT * 1.7 + i));
      g.moveTo(cx, cy).lineTo(x1, y1).lineTo(x2, y2).closePath().fill({ color: C.sapLit, alpha: tw });
    }
    // soft golden bloom disc at center
    g.circle(cx, cy, 90).fill({ color: 0xffe7a0, alpha: 0.06 });

    // the LV / time footer (built each frame since playtime/level vary)
    // We reuse txtWinSub2's position for the static line and append a dynamic
    // footer below the existing texts via the title block; to avoid an extra
    // Text object churn we keep a dedicated footer in txtWinSub2's slot only if
    // present. Instead, fold dynamic info into the subtitle line 2 is static —
    // so we render the stats line by repurposing the pause-ctl-free area:
    this.winFooter(state);
  }

  // a tiny dedicated footer Text for victory stats (created lazily once).
  private txtWinFooter: Text | null = null;
  private winFooter(state: WorldState): void {
    if (!this.txtWinFooter) {
      this.txtWinFooter = new Text({
        text: "",
        style: style({ fontSize: 12, fontFamily: MONO, fill: C.ash, letterSpacing: 1 }),
      });
      this.txtWinFooter.anchor.set(0.5);
      this.winWrap.addChild(this.txtWinFooter);
    }
    const mins = Math.floor(state.time / 60);
    this.txtWinFooter.text =
      "LV " + state.player.level + "   ·   " + mins + "m survived   ·   thank you for playing";
    this.txtWinFooter.position.set(this.w / 2, this.h / 2 + 80);
  }

  private drawPause(): void {
    // a centered iron tablet behind the PAUSED text.
    const g = this.gPausePanel;
    g.clear();
    const W = this.w;
    const H = this.h;
    const pw = Math.min(620, W - 80);
    const ph = 220;
    const px = (W - pw) / 2;
    const py = (H - ph) / 2 - 4;
    ironPlate(g, px, py, pw, ph, 10);
    // a hairline cross-rule under the title
    g.moveTo(px + 40, H / 2 - 4).lineTo(px + pw - 40, H / 2 - 4).stroke({ color: C.bark, width: 1, alpha: 0.7 });
  }

  private drawBonfire(state: WorldState): void {
    const W = this.w;
    const H = this.h;
    const r = this.bonfirePanelRect;
    const cx = W / 2;

    // ----- panel -----
    const g = this.gBonfirePanel;
    g.clear();
    ironPlate(g, r.x, r.y, r.w, r.h, 12);
    // an inner parchment-tone inlay so stat text reads warmly
    g.roundRect(r.x + 14, r.y + 110, r.w - 28, r.h - 150, 6).fill({ color: 0x100b08, alpha: 0.6 });
    g.roundRect(r.x + 14, r.y + 110, r.w - 28, r.h - 150, 6).stroke({ color: C.bark, width: 1, alpha: 0.6 });

    // ----- ember crest under the title -----
    const fg = this.gBonfireFlame;
    fg.clear();
    const fcy = r.y + 102;
    // a small heap of glowing coals with flickering flame tongues
    const flick = 0.5 + 0.5 * Math.sin(this.pulseT * 9);
    const flick2 = 0.5 + 0.5 * Math.sin(this.pulseT * 13 + 1.7);
    fg.ellipse(cx, fcy, 26, 6).fill({ color: 0x2a1206, alpha: 0.9 }); // coal bed
    for (let i = -2; i <= 2; i++) {
      fg.circle(cx + i * 9, fcy, 3.4).fill({ color: i % 2 ? 0xff7a3a : 0xffb347, alpha: 0.9 });
    }
    // flames
    const flame = (fx: number, hgt: number, c: number, al: number) => {
      fg.moveTo(fx - 4, fcy)
        .quadraticCurveTo(fx - 2, fcy - hgt * 0.6, fx, fcy - hgt)
        .quadraticCurveTo(fx + 2, fcy - hgt * 0.6, fx + 4, fcy)
        .closePath()
        .fill({ color: c, alpha: al });
    };
    flame(cx, 20 + flick * 8, 0xffd56b, 0.85);
    flame(cx - 10, 12 + flick2 * 6, 0xff9a3a, 0.7);
    flame(cx + 10, 12 + flick * 6, 0xff9a3a, 0.7);

    // ----- stat rows + cursor -----
    const sel = state.bonfireSel;
    const stats = state.player.stats;
    const rowsTop = r.y + 138;
    const rowGap = 56;

    const cg = this.gBonfireCursor;
    cg.clear();
    // highlight band + caret for the selected row (0..3 stats, 4 = LEAVE)
    const pulse = 0.5 + 0.5 * Math.sin(this.pulseT * 4);
    if (sel >= 0 && sel < 4) {
      const ry = rowsTop + sel * rowGap;
      const bandX = r.x + 28;
      const bandW = r.w - 56;
      cg.roundRect(bandX, ry - 22, bandW, 40, 5).fill({ color: C.sap, alpha: 0.1 + 0.06 * pulse });
      cg.roundRect(bandX, ry - 22, bandW, 40, 5).stroke({ color: C.sapLit, width: 1, alpha: 0.4 + 0.3 * pulse });
      // caret ›
      const caretX = r.x + 34;
      cg.moveTo(caretX, ry - 6).lineTo(caretX + 7, ry).lineTo(caretX, ry + 6).fill({ color: C.sapLit, alpha: 0.85 + 0.15 * pulse });
    }

    for (let i = 0; i < this.statRows.length; i++) {
      const def = Hud.STAT_DEFS[i];
      const row = this.statRows[i];
      const isSel = sel === i;
      row.name.style.fill = isSel ? C.sapLit : C.parchment;
      row.value.style.fill = isSel ? C.sapLit : C.parchment;
      row.value.text = String(stats[def.key]);
    }

    // ----- LEAVE row -----
    const leaveSel = sel === 4;
    this.txtLeave.text = leaveSel ? "‹  LEAVE  ›" : "LEAVE";
    this.txtLeave.style.fill = leaveSel ? C.sapLit : C.parchmentDim;
    if (leaveSel) {
      const ly = this.txtLeave.y;
      cg.roundRect(cx - 90, ly - 16, 180, 30, 5).fill({ color: C.sap, alpha: 0.1 + 0.06 * pulse });
      cg.roundRect(cx - 90, ly - 16, 180, 30, 5).stroke({ color: C.sapLit, width: 1, alpha: 0.4 + 0.3 * pulse });
    }

    // ----- cost line -----
    const cost = state.player.nextLevelCost;
    const sap = state.player.sap;
    const afford = sap >= cost;
    this.txtCost.text = "next point  " + cost + " sap   ·   you hold  " + sap;
    this.txtCost.style.fill = afford ? C.sapLit : 0x9e5040;

    // a tiny sap coin to the left of the cost line
    const coinX = this.txtCost.x - this.txtCost.width / 2 - 14;
    const coinY = this.txtCost.y;
    g.circle(coinX, coinY, 6).fill({ color: afford ? C.sap : 0x6a4a1a });
    g.circle(coinX, coinY, 6).stroke({ color: afford ? C.sapLit : 0x4a3210, width: 1 });
  }
}

export default Hud;
