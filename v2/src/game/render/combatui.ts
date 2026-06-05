// combatui.ts — WORLD-space combat feedback layer for Tommy Tomato: Harvest
// Souls (Pixi v8 / WebGL). The sim ships rich combat EVENTS and per-enemy vitals
// but nothing on screen tells you a hit landed: no damage numbers, no enemy
// health bars, no lock-on reticle. This layer draws exactly those three things.
//
// It is the combat-readability sibling of the SCREEN-space `Hud` (hud.ts): the
// HUD owns the player's vitals + the boss bar; THIS layer owns the diegetic,
// in-world feedback that floats over enemies where the action is.
//
// ----------------------------------------------------------------------------
// COORDINATE SPACE & INTEGRATION
//   * CombatUiLayer is a Container in WORLD space. Add it UNDER the camera/world
//     container, ABOVE the entity layer, so its coordinates line up 1:1 with
//     entities (which are CENTER-anchored at their (x,y)) and it draws on top of
//     them. In PixiStage that means:  world.addChild(combatUi)  after the
//     entityLayer is added (a sibling just above it).
//   * Call init(renderer) once after the Pixi renderer exists. It bakes a soft
//     glow texture and captures the renderer resolution so world-zoomed Text
//     stays crisp.
//   * Call pushEvent(ev) for every combat SimEvent the integrator drains (the
//     same loop that already routes events to fx/audio). Unknown event types
//     are ignored, so it is safe to forward the whole stream.
//   * Call update(state, dt, t) EVERY frame. `dt` is SECONDS (the sim frame
//     delta, clamped like the rest of the pipeline). `t` is the running clock in
//     seconds (drives the reticle spin / pulses). It advances + redraws every
//     live floating number, every enemy bar, and the reticle.
//
// PERFORMANCE: every Text/Graphics/Container is created ONCE and REUSED. Floats
// live in a fixed pool (cap 64) recycled via a free-list — the steady state
// allocates nothing. Enemy bars are pooled per visible enemy and parked (not
// destroyed) when an enemy leaves, so churn is bounded by the active roster.
// ----------------------------------------------------------------------------

import {
  Container,
  Graphics,
  Text,
  TextStyle,
  Sprite,
  Texture,
  type Renderer,
  type TextStyleFontWeight,
} from "pixi.js";

import type { WorldState, Entity, SimEvent, EnemyKind } from "@/game/sim/types";

// ============================================================================
// Palette (from the brief). Numbers are 0xRRGGBB.
// ============================================================================

const C = {
  white: 0xf6f0e0, // normal damage / neutral text
  gold: 0xffd56b, // crit + sap + riposte/stagger
  red: 0xff5742, // damage TO the player
  green: 0xcfe6a0, // parry
  orange: 0xff7a3a, // backstab
  poison: 0x9fd44e, // poison tick
  heal: 0x7ac0ff, // heal
  barBg: 0x1a0606, // enemy bar trough
  barFill: 0xb21f1f, // enemy bar fill (base / threat 0)
  outline: 0x140d0a, // text + bar outline so things read on any ground
} as const;

const MONO = "'Courier New', ui-monospace, monospace";
const SERIF = "Georgia, 'Times New Roman', serif";

// ============================================================================
// Small math helpers (module-local; no deps on the rest of the game)
// ============================================================================

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a: number, b: number, x: number): number {
  return a + (b - a) * x;
}

/** Blend two 0xRRGGBB colors by t in [0,1]. */
function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff;
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff;
  const r = (lerp(ar, br, t) + 0.5) | 0;
  const g = (lerp(ag, bg, t) + 0.5) | 0;
  const bl = (lerp(ab, bb, t) + 0.5) | 0;
  return (r << 16) | (g << 8) | bl;
}

/** Frame-rate-independent exponential approach toward `target`. */
function damp(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-rate * dt));
}

/** smoothstep-ish ease-out for fades (1 - (1-x)^2). */
function easeOut(x: number): number {
  const u = 1 - clamp(x, 0, 1);
  return 1 - u * u;
}

// ============================================================================
// THREAT MODEL — tints + body radius by enemy kind. Tougher creatures read as
// redder / more ornate bars and get a wider bar + reticle. `big` (the per-
// entity visual scale multiplier) widens everything on top of this so summoned
// big variants and minibosses still bracket correctly.
// ============================================================================

interface ThreatDef {
  threat: number; // 0..1 — drives fill tint (toward a hotter red) + ornateness
  radius: number; // approx body half-width in world px at big=0 (for bar/reticle sizing)
}

const THREAT: Record<EnemyKind, ThreatDef> = {
  grub: { threat: 0.05, radius: 16 },
  weed: { threat: 0.2, radius: 20 },
  hornet: { threat: 0.28, radius: 16 },
  drone: { threat: 0.4, radius: 20 },
  // bosses (skipped for bars, but reticle/sizing may still reference them)
  king: { threat: 0.95, radius: 64 },
  oldtom: { threat: 1.0, radius: 70 },
  harvester: { threat: 1.0, radius: 76 },
};

function threatOf(kind: string): ThreatDef {
  return THREAT[kind as EnemyKind] ?? { threat: 0.5, radius: 22 };
}

/** Visible body half-width for an entity, in world px. */
function bodyRadius(e: Entity): number {
  const base = threatOf(e.kind).radius;
  // `big` scales the sprite; widen the bracket/bar to match. big is ~0 for
  // normal mobs, larger for summoned-big variants. The +1 keeps base intact.
  return base * (1 + (e.big || 0) * 0.5);
}

// ============================================================================
// FLOATING NUMBER / CALLOUT
// Each is a single Text (in the normal OR additive container) plus a little
// kinematic state. Recycled via a free-list; never destroyed in the hot path.
// ============================================================================

interface Float {
  txt: Text;
  alive: boolean;
  add: boolean; // true => parented under the additive (glow) container
  age: number; // seconds since spawn
  life: number; // total lifetime in seconds
  x: number; // world origin (rises from here)
  y: number;
  vx: number; // horizontal drift (px/s)
  vy: number; // upward speed (px/s, negative = up)
  rise: number; // total extra rise applied over the ease curve (px)
  baseSize: number; // font size at rest
  pop: number; // crit/callout pop scalar that decays to 1 (1 = none)
  color: number;
}

const FLOAT_CAP = 64;

// ============================================================================
// ENEMY HEALTH BAR
// One pooled record per currently-relevant enemy, keyed by entity id. Owns a
// single Graphics redrawn each frame. Carries a "chip" (lagging damage ghost)
// and a relevance timer so the bar lingers ~1s after it was last meaningful
// then fades out.
// ============================================================================

interface EnemyBar {
  g: Graphics;
  hpShown: number; // smoothed real fraction (snappy)
  hpChip: number; // lagging "chip" fraction (drains slowly toward hpShown)
  relevance: number; // seconds of remaining visibility (refreshed when relevant)
  alpha: number; // smoothed alpha for fade in/out
  seenThisFrame: boolean;
}

// ============================================================================
// THE LAYER
// ============================================================================

export class CombatUiLayer extends Container {
  // ---- sub-containers (z-order: bars under reticle under floats) ----
  private barLayer = new Container(); // enemy health bars
  private reticleLayer = new Container(); // lock-on bracket (additive)
  private floatNorm = new Container(); // normal-blend floats (plain damage)
  private floatAdd = new Container(); // additive floats (crit/callout glow)

  // ---- reticle ----
  private gReticle = new Graphics();

  // ---- floating numbers ----
  private floats: Float[] = [];
  private freeFloats: Float[] = []; // recycled Float records ready to reuse

  // ---- enemy bars ----
  private bars = new Map<number, EnemyBar>();
  private barFree: EnemyBar[] = []; // parked bar records ready to rebind

  // ---- baked assets ----
  private glow: Texture = Texture.WHITE; // soft dot for reticle / float halos
  private res = 1; // renderer resolution (keeps world-zoomed text crisp)
  private ready = false;

  // ---- shared text style (mutated per draw; one object, never per-float) ----
  // Each Float owns its own TextStyle so we can tune size/weight independently;
  // this template just supplies defaults at construction time.

  constructor() {
    super();
    // We position/scale our own children in world coords; no sorting needed
    // (draw order is fixed by add order below).
    this.reticleLayer.addChild(this.gReticle);
    this.gReticle.blendMode = "add";
    this.reticleLayer.blendMode = "add";
    this.floatAdd.blendMode = "add";

    // bars (bottom) -> reticle -> normal floats -> additive floats (top glow)
    this.addChild(this.barLayer, this.reticleLayer, this.floatNorm, this.floatAdd);

    // This layer never needs pointer hits.
    this.eventMode = "none";
    this.barLayer.eventMode = "none";
    this.reticleLayer.eventMode = "none";
    this.floatNorm.eventMode = "none";
    this.floatAdd.eventMode = "none";
  }

  // --------------------------------------------------------------------------
  // init — bake the soft glow dot + capture resolution. Idempotent-ish: a second
  // call just re-bakes (cheap) and updates resolution.
  // --------------------------------------------------------------------------
  init(renderer: Renderer): void {
    this.res = Math.max(1, (renderer as { resolution?: number }).resolution ?? 1);

    // Soft radial dot (white core -> transparent), used as a glow behind the
    // reticle diamond and (faintly) behind callouts so they pop off dark soil.
    const R = 48;
    const g = new Graphics();
    const steps = 14;
    for (let i = steps; i >= 1; i--) {
      const f = i / steps;
      g.circle(R, R, R * f).fill({ color: 0xffffff, alpha: 0.1 });
    }
    const tex = renderer.generateTexture({ target: g, resolution: 1, antialias: true });
    g.destroy();
    if (this.glow !== Texture.WHITE) this.glow.destroy(true);
    this.glow = tex;

    this.ready = true;
  }

  // --------------------------------------------------------------------------
  // pushEvent — spawn a floating number / callout for a combat SimEvent. The
  // sim emits many event types; we only react to the combat-readability subset
  // and silently ignore the rest, so the integrator can forward everything.
  // --------------------------------------------------------------------------
  pushEvent(ev: SimEvent): void {
    switch (ev.type) {
      case "hit": {
        const dmg = Math.max(1, Math.round(ev.amount ?? 0));
        if (ev.crit) {
          // gold, bigger, with a pop; additive so it reads as a flash.
          this.spawn(`${dmg}`, ev.x, ev.y, {
            color: C.gold,
            size: 26,
            weight: "bold",
            add: true,
            pop: 1.7,
            life: 0.95,
            rise: 46,
            font: MONO,
          });
        } else {
          this.spawn(`${dmg}`, ev.x, ev.y, {
            color: C.white,
            size: 18,
            weight: "bold",
            life: 0.8,
            rise: 38,
            font: MONO,
          });
        }
        break;
      }

      case "playerHit": {
        // Damage TO the player: red, biased low + toward the hit point so it
        // reads as "you got hit here" rather than "you dealt damage".
        const dmg = Math.max(1, Math.round(ev.amount ?? 0));
        this.spawn(`-${dmg}`, ev.x, ev.y + 6, {
          color: C.red,
          size: 22,
          weight: "bold",
          add: true,
          pop: 1.3,
          life: 0.95,
          rise: 30,
          drift: 0, // straight up — feels like a wince, not a flourish
          font: MONO,
        });
        break;
      }

      case "parry":
        this.spawn("PARRY!", ev.x, ev.y, {
          color: C.green,
          size: 22,
          weight: "bold",
          add: true,
          pop: 1.5,
          life: 1.0,
          rise: 34,
          font: SERIF,
        });
        break;

      case "riposte":
        this.spawn("RIPOSTE!", ev.x, ev.y, {
          color: C.gold,
          size: 30,
          weight: "bold",
          add: true,
          pop: 1.9,
          life: 1.15,
          rise: 50,
          font: SERIF,
        });
        break;

      case "backstab":
        this.spawn("BACKSTAB!", ev.x, ev.y, {
          color: C.orange,
          size: 26,
          weight: "bold",
          add: true,
          pop: 1.7,
          life: 1.1,
          rise: 46,
          font: SERIF,
        });
        break;

      case "stagger":
        this.spawn("STAGGERED", ev.x, ev.y, {
          color: C.gold,
          size: 20,
          weight: "bold",
          add: true,
          pop: 1.4,
          life: 1.0,
          rise: 34,
          font: SERIF,
        });
        break;

      case "poison": {
        // Poison TICK number in sickly green; small + a touch faster so a DoT
        // reads as a stream of little ticks, not a headline.
        const amt = Math.max(1, Math.round(ev.amount ?? 0));
        this.spawn(`${amt}`, ev.x, ev.y, {
          color: C.poison,
          size: 15,
          weight: "bold",
          life: 0.7,
          rise: 30,
          font: MONO,
        });
        break;
      }

      case "heal": {
        const amt = ev.amount != null ? Math.max(1, Math.round(ev.amount)) : 0;
        this.spawn(amt > 0 ? `+${amt}` : "+heal", ev.x, ev.y, {
          color: C.heal,
          size: 18,
          weight: "bold",
          add: true,
          pop: 1.2,
          life: 1.0,
          rise: 40,
          font: MONO,
        });
        break;
      }

      case "sap":
      case "sapReclaim": {
        const amt = Math.max(0, Math.round(ev.amount ?? 0));
        this.spawn(`+${amt} sap`, ev.x, ev.y, {
          color: C.gold,
          size: 16,
          weight: "bold",
          add: true,
          pop: 1.2,
          life: 1.0,
          rise: 36,
          font: MONO,
        });
        break;
      }

      // Everything else (block, death, bossDeath, swing, footstep, ui*, …) is
      // handled elsewhere (fx/audio/HUD) and has no floating-number form here.
      default:
        break;
    }
  }

  // --------------------------------------------------------------------------
  // update — advance + redraw every live float, every enemy bar, the reticle.
  // --------------------------------------------------------------------------
  update(state: WorldState, dt: number, t: number): void {
    this.updateFloats(dt);
    this.updateBars(state, dt, t);
    this.updateReticle(state, t);
  }

  // ==========================================================================
  // FLOATS
  // ==========================================================================

  /** Per-event spawn options. */
  private spawn(
    text: string,
    x: number,
    y: number,
    opts: {
      color: number;
      size: number;
      weight?: TextStyleFontWeight;
      add?: boolean;
      pop?: number; // initial pop scalar (>1 => pop in); default 1 (none)
      life?: number; // seconds
      rise?: number; // total px to rise over life
      drift?: number; // explicit horizontal drift (px/s); default randomized
      font?: string;
    }
  ): void {
    const f = this.acquireFloat(!!opts.add);

    // (Re)style the reused Text. We only touch properties that change between
    // event kinds; the Text object + its style object persist in the pool.
    const st = f.txt.style;
    st.fontFamily = opts.font ?? MONO;
    st.fontSize = opts.size;
    st.fontWeight = opts.weight ?? "bold";
    st.fill = opts.color;
    // Dark outline so the number reads on bright glass / dark catacombs alike.
    st.stroke = { color: C.outline, width: Math.max(3, opts.size * 0.18), join: "round" };

    f.txt.text = text;
    f.txt.visible = true;

    // kinematics
    f.alive = true;
    f.age = 0;
    f.life = opts.life ?? 0.85;
    f.x = x;
    f.y = y;
    f.rise = opts.rise ?? 38;
    f.baseSize = opts.size;
    f.color = opts.color;
    f.pop = Math.max(1, opts.pop ?? 1);

    // Drift: a small deterministic-ish lateral wander unless pinned (drift:0).
    if (opts.drift !== undefined) {
      f.vx = opts.drift;
    } else {
      f.vx = (Math.random() * 2 - 1) * 14;
    }
    f.vy = 0; // rise is curve-driven (see updateFloats), not a constant velocity

    // Center the anchor so scaling/pop happens about the text's middle.
    f.txt.anchor.set(0.5, 0.5);
    f.txt.x = x;
    f.txt.y = y;
    f.txt.scale.set(f.pop);
    f.txt.alpha = 1;
  }

  /** Pull a Float record (and its Text) from the right pool, creating lazily up
   *  to FLOAT_CAP; past the cap, recycle the OLDEST live float so a burst never
   *  drops the most recent, most relevant numbers. */
  private acquireFloat(add: boolean): Float {
    // 1) a parked record we can rebind (cheapest).
    const recycled = this.freeFloats.pop();
    if (recycled) {
      this.reparentFloat(recycled, add);
      return recycled;
    }

    // 2) room to grow the pool.
    if (this.floats.length < FLOAT_CAP) {
      const txt = new Text({
        text: "",
        style: new TextStyle({
          fontFamily: MONO,
          fontSize: 18,
          fontWeight: "bold",
          fill: C.white,
          align: "center",
          stroke: { color: C.outline, width: 3, join: "round" },
        }),
      });
      txt.anchor.set(0.5, 0.5);
      txt.resolution = this.res; // crisp under world zoom
      txt.visible = false;
      txt.eventMode = "none";
      const f: Float = {
        txt,
        alive: false,
        add,
        age: 0,
        life: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        rise: 0,
        baseSize: 18,
        pop: 1,
        color: C.white,
      };
      this.floats.push(f);
      (add ? this.floatAdd : this.floatNorm).addChild(txt);
      return f;
    }

    // 3) at cap: steal the oldest live float.
    let oldest = this.floats[0];
    for (let i = 1; i < this.floats.length; i++) {
      if (this.floats[i].age > oldest.age) oldest = this.floats[i];
    }
    this.reparentFloat(oldest, add);
    return oldest;
  }

  /** Move a Float's Text into the additive or normal container if its blend
   *  mode changed since last use. No-op when already in the right parent. */
  private reparentFloat(f: Float, add: boolean): void {
    if (f.add === add && f.txt.parent) return;
    f.add = add;
    (add ? this.floatAdd : this.floatNorm).addChild(f.txt); // addChild reparents
  }

  private updateFloats(dt: number): void {
    const list = this.floats;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f.alive) continue;

      f.age += dt;
      const u = f.age / f.life; // 0..1 normalized life
      if (u >= 1) {
        f.alive = false;
        f.txt.visible = false;
        this.freeFloats.push(f);
        continue;
      }

      // RISE: ease-out so numbers shoot up then settle (heavier than linear).
      const riseE = easeOut(u);
      const y = f.y - f.rise * riseE;
      // DRIFT: lateral wander integrated simply.
      const x = f.x + f.vx * (f.age);

      // POP: scale decays from f.pop -> 1 over the first ~25% of life.
      const popT = clamp(f.age / (f.life * 0.25), 0, 1);
      const scale = lerp(f.pop, 1, easeOut(popT));

      // FADE: hold full alpha for the first ~45%, then ease out to 0.
      const fadeStart = 0.45;
      const fade = u <= fadeStart ? 1 : 1 - easeOut((u - fadeStart) / (1 - fadeStart));

      const tx = f.txt;
      tx.x = x;
      tx.y = y;
      tx.scale.set(scale);
      tx.alpha = fade;
    }
  }

  // ==========================================================================
  // ENEMY HEALTH BARS
  // ==========================================================================

  private updateBars(state: WorldState, dt: number, t: number): void {
    const bossId = state.boss?.id ?? -1;
    const lockId = state.player.lockTarget;

    // mark all parked
    for (const bar of this.bars.values()) bar.seenThisFrame = false;

    for (const e of state.entities) {
      if (e.flags.dead) continue; // dead enemies: their bar fades via timeout below
      if (e.id === bossId) continue; // boss bar is the HUD's job — skip entirely

      const maxHp = e.maxHp > 0 ? e.maxHp : 1;
      const frac = clamp(e.hp / maxHp, 0, 1);

      // Relevance: show when damaged, recently hit, or the lock target.
      const damaged = e.hp < e.maxHp;
      const recentlyHit = e.hurtT > 0;
      const isLock = lockId === e.id;
      const relevant = damaged || recentlyHit || isLock;

      let bar = this.bars.get(e.id);
      if (!bar && !relevant) continue; // no bar and nothing to show — skip

      if (!bar) {
        bar = this.acquireBar();
        bar.hpShown = frac;
        bar.hpChip = frac;
        bar.alpha = 0;
        bar.relevance = 0;
        this.bars.set(e.id, bar);
      }
      bar.seenThisFrame = true;

      // refresh the linger timer whenever relevant; otherwise it counts down.
      if (relevant) bar.relevance = 1.0; // ~1s linger after last relevant frame
      else bar.relevance = Math.max(0, bar.relevance - dt);

      // smoothed fill (snappy) + lagging chip (slow drain when damage is taken).
      bar.hpShown = damp(bar.hpShown, frac, 18, dt);
      if (bar.hpChip < bar.hpShown) bar.hpChip = bar.hpShown; // healing snaps chip up
      else bar.hpChip = damp(bar.hpChip, bar.hpShown, 4.5, dt); // damage: chip lags

      // fade alpha toward visible (relevance>0) or invisible.
      const wantA = bar.relevance > 0 ? 1 : 0;
      bar.alpha = damp(bar.alpha, wantA, wantA > 0 ? 16 : 6, dt);

      this.drawBar(bar, e, frac, isLock, recentlyHit, t);
    }

    // sweep: anything not seen + faded out -> park for reuse; keep fading others.
    for (const [id, bar] of this.bars) {
      if (bar.seenThisFrame) continue;
      // entity gone (dead/despawned): drain relevance + fade then release.
      bar.relevance = Math.max(0, bar.relevance - dt);
      bar.alpha = damp(bar.alpha, 0, 6, dt);
      bar.g.alpha = bar.alpha;
      if (bar.alpha < 0.02) {
        bar.g.visible = false;
        this.bars.delete(id);
        this.barFree.push(bar);
      }
    }
  }

  private acquireBar(): EnemyBar {
    const recycled = this.barFree.pop();
    if (recycled) {
      recycled.g.visible = true;
      return recycled;
    }
    const g = new Graphics();
    g.eventMode = "none";
    this.barLayer.addChild(g);
    return {
      g,
      hpShown: 1,
      hpChip: 1,
      relevance: 0,
      alpha: 0,
      seenThisFrame: false,
    };
  }

  /**
   * Draw one enemy's bar above its body. The body is CENTER-anchored at (e.y),
   * so we float the bar at  e.y - (40 + e.big*26)  (tuned for the centered
   * sprite — see the layer's exported note). Width scales with body size; tint
   * shifts toward a hotter red with threat; a thin chip ghost trails recent
   * damage. The lock target gets brighter framing.
   */
  private drawBar(
    bar: EnemyBar,
    e: Entity,
    frac: number,
    isLock: boolean,
    recentlyHit: boolean,
    t: number
  ): void {
    const g = bar.g;
    g.clear();
    g.visible = true;
    g.alpha = bar.alpha;

    const td = threatOf(e.kind);
    const rad = bodyRadius(e);

    // ---- geometry ----
    // Width tracks body width so big/elite enemies get a wider bar. Height
    // grows a touch with threat for a slightly more ornate read.
    const w = clamp(rad * 1.9, 30, 96);
    const h = 5 + td.threat * 2; // 5..7 px
    const x = e.x - w / 2;
    // VERTICAL OFFSET — per the brief, tuned for center-anchored sprites:
    const y = e.y - (40 + (e.big || 0) * 26);
    const r = Math.min(3, h / 2);

    // ---- trough / backing plate ----
    // subtle drop shadow for legibility on bright ground
    g.roundRect(x - 1, y - 1, w + 2, h + 3, r + 1).fill({ color: 0x000000, alpha: 0.4 });
    g.roundRect(x, y, w, h, r).fill({ color: C.barBg, alpha: 0.92 });

    // ---- chip / lag ghost (recent damage, drains behind the fill) ----
    const chip = clamp(bar.hpChip, 0, 1);
    const fill = clamp(bar.hpShown, 0, 1);
    if (chip > fill + 0.001) {
      g.roundRect(x, y, w * chip, h, r).fill({ color: 0xffb08a, alpha: 0.55 });
    }

    // ---- main fill, tinted by threat (base red -> hotter/brighter red) ----
    const fillColor = mixColor(C.barFill, 0xff3a24, td.threat);
    if (fill > 0.001) {
      g.roundRect(x, y, Math.max(1, w * fill), h, r).fill({ color: fillColor, alpha: 1 });
      // top sheen so the fill isn't flat
      g.roundRect(x, y, Math.max(1, w * fill), Math.max(1, h * 0.4), r).fill({
        color: 0xffffff,
        alpha: 0.18,
      });
    }

    // recent-hit flash: a bright wash across the whole fill that the hurt tint
    // already implies on the sprite — keeps eye on who just got tagged.
    if (recentlyHit) {
      g.roundRect(x, y, w, h, r).fill({ color: 0xffffff, alpha: 0.12 * clamp(e.hurtT, 0, 1) });
    }

    // ---- outline / frame ----
    g.roundRect(x, y, w, h, r).stroke({ color: C.outline, width: 1, alpha: 0.95 });

    // Threat ornament: tougher enemies get end-cap ticks + a thin gilt rule,
    // so a king's minion reads as more dangerous than a grub at a glance.
    if (td.threat >= 0.3) {
      const tickC = mixColor(0x8a3a2a, C.gold, td.threat);
      g.moveTo(x - 1.5, y - 1).lineTo(x - 1.5, y + h + 1).stroke({ color: tickC, width: 1.4 });
      g.moveTo(x + w + 1.5, y - 1).lineTo(x + w + 1.5, y + h + 1).stroke({ color: tickC, width: 1.4 });
    }
    if (td.threat >= 0.6) {
      // a faint pulsing gilt underline for elites/bosses-adjacent
      const pulse = 0.4 + 0.25 * Math.sin(t * 4 + e.id);
      g.moveTo(x, y + h + 2).lineTo(x + w, y + h + 2).stroke({ color: C.gold, width: 1, alpha: pulse });
    }

    // Lock target: brighten the frame so the focused enemy is obvious.
    if (isLock) {
      g.roundRect(x - 1.5, y - 1.5, w + 3, h + 3, r + 1).stroke({
        color: C.gold,
        width: 1.4,
        alpha: 0.9,
      });
    }
  }

  // ==========================================================================
  // LOCK-ON RETICLE
  // ==========================================================================

  private updateReticle(state: WorldState, t: number): void {
    const g = this.gReticle;
    const lockId = state.player.lockTarget;

    if (lockId == null) {
      if (g.visible) {
        g.visible = false;
        g.clear();
      }
      return;
    }

    // Resolve the live, non-dead target.
    let target: Entity | null = null;
    for (const e of state.entities) {
      if (e.id === lockId) {
        target = e;
        break;
      }
    }
    if (!target || target.flags.dead) {
      if (g.visible) {
        g.visible = false;
        g.clear();
      }
      return;
    }

    g.visible = true;
    g.clear();

    const cx = target.x;
    const cy = target.y;
    const rad = clamp(bodyRadius(target) * 1.35 + 6, 22, 130);
    const spin = t * 0.9; // slow rotation
    const pulse = 1 + 0.06 * Math.sin(t * 5); // gentle breathing
    const R = rad * pulse;

    // soft glow ring (additive) behind the brackets
    g.circle(cx, cy, R * 1.02).stroke({ color: C.gold, width: 2, alpha: 0.22 });

    // Rotating diamond — four points (sap-gold), drawn as a thin stroked poly.
    const dpts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * Math.PI) / 2;
      dpts.push(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
    g.poly(dpts, true).stroke({ color: C.gold, width: 2, alpha: 0.85 });

    // Corner BRACKETS at the diamond points (a short L at each vertex) for that
    // "target acquired" reticle read. They sit just outside the diamond and
    // counter-rotate slightly so the whole thing feels mechanical.
    const armW = Math.max(6, R * 0.26);
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * Math.PI) / 2;
      const px = cx + Math.cos(a) * R;
      const py = cy + Math.sin(a) * R;
      // tangent direction at this vertex
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      // outward (radial) direction
      const rx = Math.cos(a);
      const ry = Math.sin(a);
      const ox = px + rx * 3;
      const oy = py + ry * 3;
      g.moveTo(ox - tx * armW, oy - ty * armW)
        .lineTo(ox, oy)
        .lineTo(ox + tx * armW, oy + ty * armW)
        .stroke({ color: C.gold, width: 2.4, alpha: 0.95 });
    }

    // tiny center pip
    g.circle(cx, cy, 2).fill({ color: C.gold, alpha: 0.7 });
  }

  // --------------------------------------------------------------------------
  // destroy — release baked GPU resources. (Pixi destroys children for us.)
  // --------------------------------------------------------------------------
  override destroy(
    options?: Parameters<Container["destroy"]>[0]
  ): void {
    if (this.glow !== Texture.WHITE) {
      this.glow.destroy(true);
      this.glow = Texture.WHITE;
    }
    super.destroy(options);
  }
}

// Keep a reference to the soft-glow Sprite import alive for tree-shake-safe
// builds even though the reticle currently draws its glow with Graphics. (If a
// future tweak wants a sprite-based halo, `this.glow` is already baked.)
void Sprite;
