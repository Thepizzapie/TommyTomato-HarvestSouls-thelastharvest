// Sim — the pure, framework-agnostic gameplay engine for Tommy Tomato v2.
//
// NO rendering, NO Pixi, NO DOM. The only thing flowing in is an InputState
// snapshot (aim already in world coords). Everything the renderer / audio / net
// layers need flows out via getState(), snapshot(), and drainEvents().
//
// Ported from v1 src/game/sim/Game.ts: the player state machine, stamina,
// dodge-roll i-frames, weapon-driven light/heavy attacks, parry->riposte,
// backstab, poise/stagger, armor, poison DoT, lock-on, the six enemy AI roles,
// the three boss AIs (king / oldtom / harvester) with phase-2, projectiles,
// pickups, husk/sap death+recovery, leveling, and charms. Audio/VFX side-effects
// became SimEvents; the integrator turns those into sound and particles.

import {
  clamp,
  lerp,
  dist,
  dist2,
  norm,
  angleTo,
  angleDiff,
  inArc,
  approach,
  resolveCircleRect,
  type Rect,
} from "./math";
import { RNG, hashSeed } from "./rng";
import {
  AREAS,
  ENEMIES,
  WEAPONS,
  CHARMS,
  FIRST_AREA,
  BASE_STATS,
  STARTING_WEAPON,
  WEAPON_ORDER,
  getCharm,
  deriveMaxHp,
  deriveAttack,
  deriveMaxStamina,
  deriveSpeed,
  totalLevel,
  levelCost,
  enemyAnim,
  bossAnim,
  isOnceAnim,
  type AreaDef,
  type EnemyDef,
  type EnemyId,
  type CharmDef,
  type EnemyPhase,
} from "./content";
import type {
  InputState,
  Entity,
  EntityFlags,
  EntityKind,
  EnemyKind,
  WeaponKind,
  Projectile,
  Pickup,
  Husk,
  PlayerStats,
  PlayerView,
  WorldState,
  BossView,
  Screen,
  SimEvent,
  SimEventType,
  SimSnapshot,
  EntitySnap,
  SaveData,
  AnimState,
} from "./types";

// ----------------------------------------------------------------------------
// Internal enemy: a public Entity plus the AI bookkeeping the sim needs.
// (The renderer only reads the documented Entity fields; the rest is private
//  to the sim but lives on the same object to keep the hot loop allocation-free.)
// ----------------------------------------------------------------------------
interface SimEnemy extends Entity {
  kind: EnemyKind; // narrowed: enemies are never the "player" kind
  def: EnemyDef;
  phase: EnemyPhase; // AI state machine (distinct from Entity.animPhase)
  timer: number; // state timer (windup/active/recover)
  cd: number; // attack cooldown
  atkId: number; // increments each committed attack (hit dedup)
  homeX: number;
  homeY: number;
  bossMove: number; // chosen boss attack index
  bossPhase2: boolean;
  staggerVal: number; // poise accumulator
  staggerT: number; // >0 while poise-broken/stunned
  roarT: number; // >0 while a boss is doing a phase/roar beat
}

export interface SimOptions {
  seed?: number;
  save?: SaveData | null;
  // authoritative-friendly: "client" sims don't run AI/world (host sends snaps)
  authority?: "host" | "client";
}

const HEAL_BASE = 52;
const POISON_TICK_DMG = 4;
const POISON_TICK_INTERVAL = 0.5;
const POISON_MAX = 48;

export class Sim {
  // ---- world ----
  areaId = FIRST_AREA;
  private area!: AreaDef;
  private enemies: SimEnemy[] = [];
  private projectiles: Projectile[] = [];
  private pickups: Pickup[] = [];
  private husks: Husk[] = [];
  private rng: RNG;
  private idSeq = 1; // shared id sequence for enemies/projectiles/pickups

  time = 0;
  playtime = 0;
  screen: Screen = "play";
  private authority: "host" | "client";

  // ---- player core state (kept flat for the hot loop, mirrored into playerEnt) ----
  private px = 0;
  private py = 0;
  private pvx = 0;
  private pvy = 0;
  private facing = 0;
  stats: PlayerStats = { ...BASE_STATS };
  hp = 90;
  maxHp = 90;
  stamina = 100;
  maxStamina = 100;
  sap = 0;
  estus = 4;
  estusMax = 4;

  private pstate: "idle" | "roll" | "attack" | "heal" | "hurt" | "dead" = "idle";
  private pstateTimer = 0;
  private invuln = 0;
  private attackProg = 0;
  private attackId = 0;
  private attackHeavy = false;
  private attackHitSet = new Set<number>();
  private hurtCd = 0;
  private rollDirX = 0;
  private rollDirY = 0;
  private blocking = false;
  private walkPhase = 0;
  private moving = false;
  private lockTarget: number | null = null;
  private exhausted = false;
  private respawnTimer = 0;
  private hurtT = 0; // player hit-flash timer

  // combat depth
  private poison = 0;
  private poisonTick = 0;
  private parryWindow = 0;
  private riposteReady = 0;
  private riposteActive = false;
  private hpRegenAcc = 0;

  // weapons & charms
  weapon: WeaponKind = STARTING_WEAPON;
  ownedWeapons: WeaponKind[] = [STARTING_WEAPON];
  charmId: string | null = null;
  ownedCharms: string[] = [];
  bonfireSel = 0;

  // progression / meta
  private bonfireArea = FIRST_AREA;
  private bossesDead: string[] = [];

  // boss
  private boss: SimEnemy | null = null;
  bossIntro = 0;

  // the player as a public Entity (synced each tick)
  private playerEnt: Entity;

  // event queue (drained by the integrator for VFX/audio)
  private events: SimEvent[] = [];

  // hit dedup: enemyId -> last atkId that hit the player
  private enemyHitAtk = new Map<number, number>();

  constructor(opts: SimOptions = {}) {
    this.authority = opts.authority ?? "host";
    this.rng = new RNG(opts.seed ?? 12345);
    if (opts.save) this.applySave(opts.save);
    this.recompute();
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    this.playerEnt = this.makePlayerEntity();
    this.loadArea(this.areaId, true);
    this.syncPlayerEntity();
  }

  // ---------------------------------------------------------------- save/meta
  applySave(s: SaveData) {
    this.stats = { ...s.stats };
    this.sap = s.sap;
    this.estusMax = s.estusMax;
    this.areaId = s.areaId || FIRST_AREA;
    this.bonfireArea = s.bonfireArea || FIRST_AREA;
    this.bossesDead = s.bossesDead ? [...s.bossesDead] : [];
    this.ownedWeapons = s.ownedWeapons?.length ? [...s.ownedWeapons] : [STARTING_WEAPON];
    this.ownedCharms = s.ownedCharms ? [...s.ownedCharms] : [];
    this.weapon = s.weapon || STARTING_WEAPON;
    this.charmId = s.charmId ?? null;
    this.playtime = s.playtime || 0;
  }

  toSave(): SaveData {
    return {
      stats: { ...this.stats },
      sap: this.sap,
      estusMax: this.estusMax,
      areaId: this.areaId,
      bonfireArea: this.bonfireArea,
      bossesDead: [...this.bossesDead],
      ownedWeapons: [...this.ownedWeapons],
      ownedCharms: [...this.ownedCharms],
      weapon: this.weapon,
      charmId: this.charmId,
      playtime: this.playtime,
    };
  }

  recompute() {
    this.maxHp = deriveMaxHp(this.stats);
    this.maxStamina = deriveMaxStamina(this.stats);
  }

  private get charm(): CharmDef | null {
    return getCharm(this.charmId);
  }

  // ------------------------------------------------------------ entity factory
  private makeFlags(): EntityFlags {
    return {
      windup: false,
      attacking: false,
      staggered: false,
      dead: false,
      hurt: false,
      invuln: false,
      blocking: false,
    };
  }

  private makePlayerEntity(): Entity {
    return {
      id: 0,
      kind: "player",
      x: this.px,
      y: this.py,
      vx: 0,
      vy: 0,
      facing: this.facing,
      hp: this.hp,
      maxHp: this.maxHp,
      animState: "idle",
      animOnce: false,
      animPhase: 0,
      big: 1,
      facingFlip: false,
      flags: this.makeFlags(),
      hurtT: 0,
    };
  }

  // ---------------------------------------------------------------- area load
  loadArea(id: string, atSpawn: boolean, fromX?: number, fromY?: number) {
    const area = AREAS[id];
    if (!area) return;
    this.areaId = id;
    this.area = area;
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.boss = null;
    this.bossIntro = 0;
    this.lockTarget = null;
    this.enemyHitAtk.clear();
    // deterministic per-area seed (matches v1)
    this.rng = new RNG(hashSeed(id) ^ 0x9e3779b9);

    if (fromX !== undefined && fromY !== undefined) {
      this.px = fromX;
      this.py = fromY;
    } else {
      this.px = area.spawnPoint.x;
      this.py = area.spawnPoint.y;
    }

    if (this.authority !== "client") {
      const bossDefeated = area.boss && this.bossesDead.includes(id);
      if (!bossDefeated) {
        for (const sp of area.spawns) this.spawnEnemy(sp.kind, sp.x, sp.y);
        if (area.boss) {
          this.boss = this.spawnEnemy(area.boss, area.w / 2, area.h / 2 - 200);
          this.bossIntro = 2.5;
          this.push("bossRoar", this.boss.x, this.boss.y, { kind: this.boss.kind });
        }
      }
      // a findable second weapon, once, in the greenhouse
      if (id === "greenhouse" && !this.ownedWeapons.includes("dagger")) {
        this.dropPickup(360, 620, "weapon", 1, "dagger");
      }
    }

    this.push("areaChange", this.px, this.py, {
      kind: id,
      text: area.name,
      color: area.subtitle,
    });
  }

  private spawnEnemy(id: EnemyId, x: number, y: number): SimEnemy {
    const def = ENEMIES[id];
    const e: SimEnemy = {
      id: this.idSeq++,
      kind: def.kind,
      def,
      x,
      y,
      vx: 0,
      vy: 0,
      facing: 0,
      hp: def.hp,
      maxHp: def.hp,
      animState: "idle",
      animOnce: false,
      animPhase: this.rng.range(0, 10),
      big: def.big ?? 1,
      facingFlip: false,
      flags: this.makeFlags(),
      hurtT: 0,
      // ai
      phase: "idle",
      timer: 0,
      cd: this.rng.range(0.3, 1.2),
      atkId: 0,
      homeX: x,
      homeY: y,
      bossMove: 0,
      bossPhase2: false,
      staggerVal: 0,
      staggerT: 0,
      roarT: 0,
    };
    this.enemies.push(e);
    return e;
  }

  // ----------------------------------------------------------------- main tick
  update(dt: number, input: InputState) {
    if (dt > 0.05) dt = 0.05; // clamp big stalls (matches v1)
    this.time += dt;
    this.playtime += dt;

    if (this.screen === "paused" || this.screen === "victory") {
      return;
    }
    if (this.screen === "bonfire") {
      this.updateBonfireMenu(input);
      this.syncPlayerEntity();
      return;
    }
    if (this.screen === "dead") {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0 && (input.lightPressed || input.interactPressed))
        this.respawn();
      this.syncPlayerEntity();
      return;
    }

    if (this.bossIntro > 0) this.bossIntro -= dt;

    this.updatePlayer(dt, input);

    if (this.authority !== "client") {
      for (const e of this.enemies) this.updateEnemy(e, dt);
      this.updateProjectiles(dt);
      this.checkAreaClear();
    } else {
      this.updateProjectiles(dt);
    }

    this.updateCombatVsPlayer(dt);
    this.updatePickups(dt);
    this.handleGates();

    // refresh animState / public entity mirrors
    for (const e of this.enemies) this.syncEnemyEntity(e, dt);
    this.syncPlayerEntity();
  }

  // ------------------------------------------------------------------- player
  private updatePlayer(dt: number, input: InputState) {
    if (this.pstate === "dead") return;
    if (this.hurtCd > 0) this.hurtCd -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.hurtT > 0) this.hurtT -= dt;

    // poison damage-over-time
    if (this.poison > 0) {
      this.poisonTick += dt;
      if (this.poisonTick >= POISON_TICK_INTERVAL) {
        this.poisonTick -= POISON_TICK_INTERVAL;
        const tick = Math.min(this.poison, POISON_TICK_DMG);
        this.poison -= tick;
        this.hp -= tick;
        this.push("poison", this.px, this.py, { amount: tick });
        this.push("floatText", this.px, this.py - 24, {
          text: String(tick),
          color: "#9fd44e",
        });
        if (this.hp <= 0) {
          this.die();
          return;
        }
      }
    }
    // charm passive regen (Thirsty Root)
    const charm = this.charm;
    if (charm?.hpRegen && this.hp > 0 && this.hp < this.maxHp) {
      this.hpRegenAcc += charm.hpRegen * dt;
      if (this.hpRegenAcc >= 1) {
        const g = Math.floor(this.hpRegenAcc);
        this.hpRegenAcc -= g;
        this.hp = Math.min(this.maxHp, this.hp + g);
      }
    }
    if (this.parryWindow > 0) this.parryWindow -= dt;
    if (this.riposteReady > 0) this.riposteReady -= dt;

    if (this.pstate !== "idle") this.blocking = false;

    // facing: lock-on target > aim
    const lockE = this.lockTarget !== null ? this.findEnemy(this.lockTarget) : null;
    if (this.lockTarget !== null && (!lockE || lockE.phase === "dead"))
      this.lockTarget = null;
    if (lockE && lockE.phase !== "dead") {
      this.facing = angleTo(this.px, this.py, lockE.x, lockE.y);
    } else {
      this.facing = angleTo(this.px, this.py, input.aimX, input.aimY);
    }

    // lock-on toggle
    if (input.lockOnPressed) {
      if (this.lockTarget !== null) {
        this.lockTarget = null;
      } else {
        this.lockTarget = this.nearestEnemyId(520);
        if (this.lockTarget !== null) this.push("uiSelect", this.px, this.py);
      }
    }

    // weapon switching (owned only)
    const wpress = [
      input.weapon1Pressed,
      input.weapon2Pressed,
      input.weapon3Pressed,
      input.weapon4Pressed,
    ];
    for (let i = 0; i < 4; i++) {
      if (wpress[i]) {
        const w = WEAPON_ORDER[i];
        if (this.ownedWeapons.includes(w) && w !== this.weapon) {
          this.weapon = w;
          this.push("weaponSwitch", this.px, this.py, { kind: w });
        }
      }
    }

    const speed = deriveSpeed(this.stats);
    const mvn = norm(input.moveX, input.moveY);
    this.moving = input.moveX !== 0 || input.moveY !== 0;

    // stamina regen (charm modifies rate)
    const regenMul = charm?.staminaRegenMul ?? 1;
    const acting = this.pstate === "attack" || this.pstate === "roll";
    if (!acting && !this.blocking) {
      this.stamina = approach(this.stamina, this.maxStamina, 42 * regenMul * dt);
    } else if (this.blocking) {
      this.stamina = approach(this.stamina, this.maxStamina, 10 * regenMul * dt);
    }
    if (this.exhausted && this.stamina > this.maxStamina * 0.25)
      this.exhausted = false;

    // ---- state machine ----
    if (this.pstate === "roll") {
      this.pstateTimer -= dt;
      this.pvx = this.rollDirX * speed * 2.0;
      this.pvy = this.rollDirY * speed * 2.0;
      if (this.pstateTimer <= 0) this.pstate = "idle";
    } else if (this.pstate === "attack") {
      this.pstateTimer -= dt;
      const total = (this.attackHeavy ? 0.55 : 0.36) * WEAPONS[this.weapon].speedMul;
      this.attackProg = clamp(this.pstateTimer / total, 0, 1);
      this.pvx = mvn.x * speed * 0.25;
      this.pvy = mvn.y * speed * 0.25;
      // active hit window (timer thresholds preserved from v1)
      const activeStart = this.attackHeavy ? 0.34 : 0.22;
      const activeEnd = this.attackHeavy ? 0.16 : 0.1;
      if (this.pstateTimer <= activeStart && this.pstateTimer >= activeEnd) {
        this.doMeleeHit();
      }
      if (this.pstateTimer <= 0) {
        this.pstate = "idle";
        this.attackProg = 0;
      }
    } else if (this.pstate === "heal") {
      this.pstateTimer -= dt;
      this.pvx = mvn.x * speed * 0.35;
      this.pvy = mvn.y * speed * 0.35;
      if (this.pstateTimer <= 0) {
        this.hp = Math.min(this.maxHp, this.hp + HEAL_BASE + (charm?.healPower ?? 0));
        this.push("heal", this.px, this.py);
        this.pstate = "idle";
      }
    } else {
      // idle/move — accept inputs
      const prevBlock = this.blocking;
      this.blocking = input.guardHeld && this.stamina > 0 && !this.exhausted;
      if (this.blocking && !prevBlock) {
        this.parryWindow = 0.22; // a freshly-raised guard can parry
        this.push("block", this.px, this.py);
      }

      const moveSpeed = this.blocking ? speed * 0.5 : speed;
      this.pvx = mvn.x * moveSpeed;
      this.pvy = mvn.y * moveSpeed;

      if (input.rollPressed && this.stamina >= 22 && !this.exhausted) {
        let dx = mvn.x,
          dy = mvn.y;
        if (dx === 0 && dy === 0) {
          dx = Math.cos(this.facing);
          dy = Math.sin(this.facing);
        }
        this.rollDirX = dx;
        this.rollDirY = dy;
        this.pstate = "roll";
        this.pstateTimer = 0.42;
        this.invuln = 0.3; // i-frames; the 0.12s recovery tail is vulnerable
        this.stamina -= 22;
        if (this.stamina <= 0) this.exhausted = true;
        this.push("roll", this.px, this.py);
      } else if (
        input.lightPressed &&
        this.stamina >= WEAPONS[this.weapon].staminaLight &&
        !this.exhausted
      ) {
        this.beginAttack(false);
      } else if (
        input.heavyPressed &&
        this.stamina >= WEAPONS[this.weapon].staminaHeavy &&
        !this.exhausted
      ) {
        this.beginAttack(true);
      } else if (input.healPressed && this.estus > 0 && this.hp < this.maxHp) {
        this.estus--;
        this.pstate = "heal";
        this.pstateTimer = 0.7;
      } else if (input.interactPressed) {
        this.tryInteract();
      }
    }

    if (this.moving && this.pstate === "idle") this.walkPhase += dt * 14;

    // footsteps
    if (this.moving && (this.pstate === "idle" || this.pstate === "attack")) {
      // emit roughly every 34px traveled (handled by accumulator)
      this.footAccum += Math.hypot(this.pvx, this.pvy) * dt;
      if (this.footAccum > 34) {
        this.footAccum = 0;
        this.push("footstep", this.px, this.py + 12, { kind: this.area.floor });
      }
    }

    // integrate + collide
    this.px += this.pvx * dt;
    this.py += this.pvy * dt;
    const r = this.collide(this.px, this.py, 14);
    this.px = r.x;
    this.py = r.y;
  }
  private footAccum = 0;

  private beginAttack(heavy: boolean) {
    const w = WEAPONS[this.weapon];
    this.pstate = "attack";
    this.attackHeavy = heavy;
    this.pstateTimer = (heavy ? 0.55 : 0.36) * w.speedMul;
    this.attackProg = 1;
    this.attackId++;
    this.attackHitSet.clear();
    this.riposteActive = !heavy && this.riposteReady > 0;
    if (this.riposteActive) {
      this.riposteReady = 0;
      this.push("riposte", this.px, this.py);
    } else {
      this.push("swing", this.px, this.py, { kind: this.weapon });
    }
    this.stamina -= heavy ? w.staminaHeavy : w.staminaLight;
    if (this.stamina <= 0) this.exhausted = true;
  }

  private doMeleeHit() {
    const w = WEAPONS[this.weapon];
    const reach = w.reach * (this.attackHeavy ? 1.05 : 1);
    const half = w.arcHalf;
    const charm = this.charm;
    const baseAtk = deriveAttack(this.stats) * (charm?.damageMul ?? 1);
    const dmg = baseAtk * (this.attackHeavy ? w.heavyMul : w.lightMul);
    const ox = this.px + Math.cos(this.facing) * 10;
    const oy = this.py + Math.sin(this.facing) * 10;
    for (const e of this.enemies) {
      if (e.phase === "dead") continue;
      if (this.attackHitSet.has(e.id)) continue;
      if (inArc(e.x, e.y, ox, oy, this.facing, half, reach + e.def.radius)) {
        this.attackHitSet.add(e.id);
        let d = dmg;
        let crit = false;
        let poise = (w.poise ?? 6) * (this.attackHeavy ? 2 : 1);
        const toP = angleTo(e.x, e.y, this.px, this.py);
        const back = Math.cos(e.facing - toP) < -0.5;
        if (this.riposteActive) {
          d *= 2.6;
          poise += 40;
          crit = true;
          this.riposteActive = false;
        } else if (
          back &&
          e.def.role !== "boss_king" &&
          e.def.role !== "boss_harvester"
        ) {
          d *= 1.8;
          crit = true;
          this.push("backstab", e.x, e.y);
        }
        if (e.staggerT > 0) d *= 1.5;
        const kb = this.attackHeavy ? 220 : 120;
        const kx = Math.cos(this.facing) * kb;
        const ky = Math.sin(this.facing) * kb;
        this.hitEnemy(e, d, kx, ky, poise, crit);
      }
    }
  }

  private hitEnemy(
    e: SimEnemy,
    dmg: number,
    kx: number,
    ky: number,
    poise = 0,
    forceCrit = false
  ) {
    const crit = forceCrit || this.rng.chance(0.12);
    const final = Math.round(
      dmg * (crit && !forceCrit ? 1.6 : 1) * this.rng.range(0.9, 1.1)
    );
    this.push("hit", e.x, e.y, { amount: final, crit, id: e.id, kind: e.kind });
    this.push("floatText", e.x, e.y - 20, {
      text: String(final),
      color: crit ? "#ffd56b" : "#fff",
      crit,
    });
    this.applyEnemyDamage(e, final, kx, ky, poise);
  }

  private applyEnemyDamage(
    e: SimEnemy,
    dmg: number,
    kx: number,
    ky: number,
    poise = 0
  ) {
    if (e.phase === "dead") return;
    let actual = dmg;
    if (e.def.armor && e.staggerT <= 0) actual = Math.max(1, dmg - e.def.armor);
    e.hp -= actual;
    e.hurtT = 0.14;
    e.vx += kx;
    e.vy += ky;
    // poise / stagger
    if (e.def.staggerHp && e.staggerT <= 0 && poise > 0) {
      e.staggerVal += poise;
      if (e.staggerVal >= e.def.staggerHp) {
        e.staggerVal = 0;
        e.staggerT = 1.3;
        e.phase = "recover";
        e.timer = 1.3;
        this.push("stagger", e.x, e.y, { id: e.id });
        this.push("floatText", e.x, e.y - 32, {
          text: "STAGGERED",
          color: "#ffd56b",
        });
      }
    }
    // interrupt windups on normal enemies (bosses resist)
    if (
      e.phase === "windup" &&
      e.def.role !== "boss_king" &&
      e.def.role !== "boss_harvester" &&
      e.def.role !== "boss_oldtom"
    ) {
      if (this.rng.chance(0.5)) {
        e.phase = "recover";
        e.timer = 0.3;
      }
    }
    if (e.hp <= 0) this.killEnemy(e);
  }

  private killEnemy(e: SimEnemy) {
    e.phase = "dead";
    e.hp = 0;
    e.timer = 0.6; // settle time before culling
    const isBoss = e === this.boss;
    this.push(isBoss ? "bossDeath" : "death", e.x, e.y, {
      id: e.id,
      kind: e.kind,
      big: isBoss,
    });
    if (isBoss) this.onBossDeath(e);
    this.gainSap(e.def.sap);
    if (!isBoss && this.rng.chance(0.12)) this.dropPickup(e.x, e.y, "estus", 1);
  }

  private onBossDeath(e: SimEnemy) {
    if (!this.bossesDead.includes(this.areaId)) this.bossesDead.push(this.areaId);
    this.boss = null;
    this.push("floatText", e.x, e.y - 40, {
      text: "HARVEST DENIED",
      color: "#ffd56b",
    });
    for (const g of this.area.gates) g.locked = false;
    // boss-specific spoils
    if (e.kind === "king") this.grantWeapon("mace");
    if (e.kind === "oldtom") {
      this.grantWeapon("rapier");
      this.grantCharm("first_fruits_pith");
    }
    if (e.kind === "harvester") this.grantCharm("hollow_seed");
    if (this.areaId === "yard") this.screen = "victory";
  }

  private grantWeapon(w: WeaponKind) {
    if (this.ownedWeapons.includes(w)) return;
    this.ownedWeapons.push(w);
    this.push("pickup", this.px, this.py, { kind: w });
  }
  private grantCharm(id: string) {
    if (this.ownedCharms.includes(id)) return;
    this.ownedCharms.push(id);
    this.push("pickup", this.px, this.py, { kind: id });
  }

  private gainSap(amt: number) {
    const got = Math.round(amt * (this.charm?.sapMul ?? 1));
    this.sap += got;
    this.push("sap", this.px, this.py, { amount: got });
    this.push("floatText", this.px, this.py - 30, {
      text: "+" + got + " sap",
      color: "#e8b53a",
    });
  }

  private dropPickup(
    x: number,
    y: number,
    kind: Pickup["kind"],
    amt: number,
    wid?: WeaponKind,
    cid?: string
  ) {
    this.pickups.push({ id: this.idSeq++, x, y, kind, amt, wid, cid });
  }

  // ----------------------------------------------------------------- enemy AI
  private updateEnemy(e: SimEnemy, dt: number) {
    if (e.hurtT > 0) e.hurtT -= dt;
    if (e.roarT > 0) e.roarT -= dt;
    e.animPhase += dt * 3;
    if (e.staggerVal > 0) e.staggerVal = Math.max(0, e.staggerVal - dt * 7);

    if (e.phase === "dead") {
      e.timer -= dt;
      return;
    }
    // poise-broken: stunned, just slide to rest
    if (e.staggerT > 0) {
      e.staggerT -= dt;
      e.vx *= 0.8;
      e.vy *= 0.8;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      const r = this.collide(e.x, e.y, e.def.radius);
      e.x = r.x;
      e.y = r.y;
      return;
    }
    // knockback friction
    e.vx *= 0.86;
    e.vy *= 0.86;

    const tx = this.px;
    const ty = this.py;
    const d = dist(e.x, e.y, tx, ty);
    if (e.def.role !== "rooted") e.facing = angleTo(e.x, e.y, tx, ty);

    if (e.cd > 0) e.cd -= dt;

    switch (e.def.role) {
      case "swarm":
        this.aiSwarm(e, d, tx, ty);
        break;
      case "chaser":
        this.aiChaser(e, dt, d, tx, ty);
        break;
      case "flyer":
        this.aiFlyer(e, dt, d, tx, ty);
        break;
      case "ranged":
        this.aiRanged(e, dt, d, tx, ty);
        break;
      case "rooted":
        this.aiRooted(e, dt, d, tx, ty);
        break;
      case "shielded":
        this.aiShielded(e, dt, d, tx, ty);
        break;
      case "boss_king":
        this.aiKing(e, dt, d, tx, ty);
        break;
      case "boss_harvester":
        this.aiHarvester(e, dt, d, tx, ty);
        break;
      case "boss_oldtom":
        this.aiOldTom(e, dt, d, tx, ty);
        break;
    }

    e.x += e.vx * dt;
    e.y += e.vy * dt;
    const r = this.collide(e.x, e.y, e.def.radius);
    e.x = r.x;
    e.y = r.y;
  }

  private moveTo(e: SimEnemy, tx: number, ty: number, spd: number) {
    const n = norm(tx - e.x, ty - e.y);
    e.vx += n.x * spd;
    e.vy += n.y * spd;
    const m = Math.hypot(e.vx, e.vy);
    if (m > spd) {
      e.vx = (e.vx / m) * spd;
      e.vy = (e.vy / m) * spd;
    }
  }

  private aiSwarm(e: SimEnemy, d: number, tx: number, ty: number) {
    const jitter = Math.sin(this.time * 8 + e.id) * 40;
    const n = norm(tx - e.x, ty - e.y);
    const perp = { x: -n.y, y: n.x };
    e.vx = n.x * e.def.speed + perp.x * jitter;
    e.vy = n.y * e.def.speed + perp.y * jitter;
    e.phase = "chase";
  }

  private aiChaser(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (e.phase === "windup") {
      e.timer -= dt;
      e.vx *= 0.7;
      e.vy *= 0.7;
      if (e.timer <= 0) {
        e.phase = "active";
        e.timer = 0.18;
        e.atkId++;
      }
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.phase = "chase";
      return;
    }
    if (d > e.def.attackRange) {
      this.moveTo(e, tx, ty, e.def.speed);
      e.phase = "chase";
    } else if (e.cd <= 0) {
      e.phase = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  private aiFlyer(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (e.phase === "windup") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.phase = "active";
        e.timer = 0.5;
        e.atkId++;
        const n = norm(tx - e.x, ty - e.y);
        e.vx = n.x * 460;
        e.vy = n.y * 460;
      }
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      this.moveTo(e, e.x + (e.x - tx), e.y + (e.y - ty) - 60, e.def.speed);
      if (e.timer <= 0) e.phase = "chase";
      return;
    }
    const ideal = 180;
    if (d > ideal + 40) this.moveTo(e, tx, ty, e.def.speed);
    else if (d < ideal - 40)
      this.moveTo(e, e.x - (tx - e.x), e.y - (ty - e.y), e.def.speed);
    else {
      const n = norm(tx - e.x, ty - e.y);
      e.vx = -n.y * e.def.speed * 0.6;
      e.vy = n.x * e.def.speed * 0.6;
    }
    if (e.cd <= 0 && d < e.def.attackRange) {
      e.phase = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  private aiRanged(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (e.phase === "windup") {
      e.timer -= dt;
      e.vx *= 0.8;
      e.vy *= 0.8;
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = e.def.attackCooldown;
        this.fireProjectile(e, tx, ty, 260, e.def.attackDmg, "#9fd44e", e.def.poison);
        e.atkId++;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.phase = "chase";
    }
    const ideal = 240;
    if (d > ideal + 50) this.moveTo(e, tx, ty, e.def.speed);
    else if (d < ideal - 30)
      this.moveTo(e, e.x - (tx - e.x), e.y - (ty - e.y), e.def.speed);
    if (e.cd <= 0 && e.phase === "chase") {
      e.phase = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  private aiRooted(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    e.facing = angleTo(e.x, e.y, tx, ty);
    if (e.phase === "windup") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.phase = "active";
        e.timer = 0.22;
        e.atkId++;
      }
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.phase = "idle";
      return;
    }
    if (d < e.def.attackRange && e.cd <= 0) {
      e.phase = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  private aiShielded(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (e.phase === "windup") {
      e.timer -= dt;
      e.vx *= 0.6;
      e.vy *= 0.6;
      if (e.timer <= 0) {
        e.phase = "active";
        e.timer = 0.24;
        e.atkId++;
      }
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      const n = norm(tx - e.x, ty - e.y);
      e.vx = n.x * 160;
      e.vy = n.y * 160;
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.phase = "chase";
      return;
    }
    if (d > e.def.attackRange) this.moveTo(e, tx, ty, e.def.speed);
    else if (e.cd <= 0) {
      e.phase = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  // ---- BOSS: Scarecrow King ----
  private aiKing(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (this.bossIntro > 0) {
      e.phase = "idle";
      return;
    }
    if (!e.bossPhase2 && e.hp < e.maxHp * 0.5) {
      e.bossPhase2 = true;
      e.roarT = 0.6;
      this.push("bossPhase", e.x, e.y, { id: e.id, kind: e.kind });
    }
    const aggr = e.bossPhase2 ? 1.4 : 1;

    if (e.phase === "windup") {
      e.timer -= dt;
      e.vx *= 0.8;
      e.vy *= 0.8;
      if (e.timer <= 0) this.kingExecute(e);
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      if (e.bossMove === 1) {
        const n = norm(Math.cos(e.facing), Math.sin(e.facing));
        e.vx = n.x * 520;
        e.vy = n.y * 520;
      } else if (e.bossMove === 3) {
        e.facing += dt * 10;
      }
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = 1.0 / aggr;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.phase = "chase";
      return;
    }
    if (e.cd <= 0) {
      if (d < 110) e.bossMove = e.bossPhase2 && this.rng.chance(0.4) ? 3 : 0;
      else if (d < 360) e.bossMove = 1;
      else e.bossMove = 2;
      e.phase = "windup";
      e.timer = e.def.windup / aggr;
      e.cd = (e.def.attackCooldown + e.def.windup) / aggr;
    } else {
      this.moveTo(e, tx, ty, e.def.speed * (e.bossPhase2 ? 1.2 : 1));
    }
  }

  private kingExecute(e: SimEnemy) {
    e.phase = "active";
    e.atkId++;
    if (e.bossMove === 0) {
      e.timer = 0.3; // sweep
    } else if (e.bossMove === 1) {
      e.timer = 0.4; // lunge
      this.push("swing", e.x, e.y);
    } else if (e.bossMove === 2) {
      // summon adds
      e.timer = 0.3;
      e.roarT = 0.4;
      const n = e.bossPhase2 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        this.spawnEnemy(
          this.rng.chance(0.5) ? "aphid" : "crow",
          e.x + Math.cos(a) * 80,
          e.y + Math.sin(a) * 80
        );
      }
    } else if (e.bossMove === 3) {
      e.timer = 1.2; // spin
    }
  }

  // ---- BOSS: Harvester ----
  private aiHarvester(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (this.bossIntro > 0) {
      e.phase = "idle";
      return;
    }
    if (!e.bossPhase2 && e.hp < e.maxHp * 0.45) {
      e.bossPhase2 = true;
      e.roarT = 0.7;
      this.push("bossPhase", e.x, e.y, { id: e.id, kind: e.kind });
    }
    const aggr = e.bossPhase2 ? 1.5 : 1;

    if (e.phase === "windup") {
      e.timer -= dt;
      e.facing = angleTo(e.x, e.y, tx, ty);
      if (e.timer <= 0) this.harvesterExecute(e);
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      if (e.bossMove === 0) {
        e.vx = Math.cos(e.facing) * 600 * aggr;
        e.vy = Math.sin(e.facing) * 600 * aggr;
      } else if (e.bossMove === 2) {
        e.facing += dt * 8;
      }
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = 0.9 / aggr;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      e.vx *= 0.8;
      e.vy *= 0.8;
      if (e.timer <= 0) e.phase = "chase";
      return;
    }
    if (e.cd <= 0) {
      const r = this.rng.next();
      if (d > 280) e.bossMove = 0;
      else if (r < 0.4) e.bossMove = 1;
      else if (r < 0.7) e.bossMove = 2;
      else e.bossMove = 3;
      e.phase = "windup";
      e.timer = e.def.windup / aggr;
      e.cd = (e.def.attackCooldown + e.def.windup) / aggr;
    } else {
      this.moveTo(e, tx, ty, e.def.speed);
    }
  }

  private harvesterExecute(e: SimEnemy) {
    e.phase = "active";
    e.atkId++;
    if (e.bossMove === 0) {
      e.timer = 0.6; // charge
      this.push("bossRoar", e.x, e.y, { kind: e.kind });
    } else if (e.bossMove === 1) {
      // radial pesticide volley
      e.timer = 0.3;
      const count = e.bossPhase2 ? 16 : 10;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + this.time;
        this.spawnProjectileVel(
          e.x,
          e.y,
          Math.cos(a) * 220,
          Math.sin(a) * 220,
          10,
          e.def.attackDmg * 0.7,
          "#9fd44e",
          undefined,
          e.id
        );
      }
      this.push("shoot", e.x, e.y);
    } else if (e.bossMove === 2) {
      e.timer = 1.0; // spin
    } else {
      // slam shockwave
      e.timer = 0.3;
      const count = 18;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        this.spawnProjectileVel(
          e.x,
          e.y,
          Math.cos(a) * 300,
          Math.sin(a) * 300,
          12,
          e.def.attackDmg,
          "#ff7a3a",
          undefined,
          e.id
        );
      }
      this.push("shoot", e.x, e.y, { big: true });
    }
  }

  // ---- BOSS: Old Tom, the First Fruit ----
  private aiOldTom(e: SimEnemy, dt: number, d: number, tx: number, ty: number) {
    if (this.bossIntro > 0) {
      e.phase = "idle";
      return;
    }
    if (!e.bossPhase2 && e.hp < e.maxHp * 0.45) {
      e.bossPhase2 = true;
      e.roarT = 0.7;
      this.push("bossPhase", e.x, e.y, { id: e.id, kind: e.kind });
    }
    const aggr = e.bossPhase2 ? 1.4 : 1;

    if (e.phase === "windup") {
      e.timer -= dt;
      e.vx *= 0.8;
      e.vy *= 0.8;
      e.facing = angleTo(e.x, e.y, tx, ty);
      if (e.timer <= 0) this.oldTomExecute(e);
      return;
    }
    if (e.phase === "active") {
      e.timer -= dt;
      if (e.bossMove === 1) {
        e.vx = Math.cos(e.facing) * 560 * aggr;
        e.vy = Math.sin(e.facing) * 560 * aggr;
      } else {
        e.vx *= 0.7;
        e.vy *= 0.7;
      }
      if (e.timer <= 0) {
        e.phase = "recover";
        e.timer = 0.7 / aggr;
      }
      return;
    }
    if (e.phase === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.phase = "chase";
      return;
    }
    if (e.cd <= 0) {
      if (e.bossPhase2 && this.rng.chance(0.3)) e.bossMove = 3; // grief nova
      else if (d < 130) e.bossMove = 0; // thrust
      else e.bossMove = 1; // lunge
      e.phase = "windup";
      e.timer = e.def.windup / aggr;
      e.cd = (e.def.attackCooldown + e.def.windup) / aggr;
    } else {
      this.moveTo(e, tx, ty, e.def.speed * (e.bossPhase2 ? 1.2 : 1));
    }
  }

  private oldTomExecute(e: SimEnemy) {
    e.phase = "active";
    e.atkId++;
    if (e.bossMove === 0) {
      e.timer = 0.3; // crisp thrust
      this.push("swing", e.x, e.y);
    } else if (e.bossMove === 1) {
      e.timer = 0.4; // lunge
      this.push("swing", e.x, e.y);
    } else if (e.bossMove === 3) {
      // grief nova — radial sap shards
      e.timer = 0.3;
      this.push("bossRoar", e.x, e.y, { kind: e.kind });
      const count = 14;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2;
        this.spawnProjectileVel(
          e.x,
          e.y,
          Math.cos(a) * 240,
          Math.sin(a) * 240,
          10,
          e.def.attackDmg * 0.7,
          "#ffd56b",
          undefined,
          e.id
        );
      }
    }
  }

  // ----------------------------------------------------------- projectiles
  private fireProjectile(
    e: SimEnemy,
    tx: number,
    ty: number,
    spd: number,
    dmg: number,
    color: string,
    poison?: number
  ) {
    const n = norm(tx - e.x, ty - e.y);
    this.spawnProjectileVel(e.x, e.y, n.x * spd, n.y * spd, 8, dmg, color, poison, e.id);
    this.push("shoot", e.x, e.y, { color });
  }

  private spawnProjectileVel(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r: number,
    dmg: number,
    color: string,
    poison?: number,
    ownerId?: number
  ) {
    this.projectiles.push({
      id: this.idSeq++,
      x,
      y,
      vx,
      vy,
      r,
      dmg,
      ttl: 4,
      hostile: true,
      color,
      poison,
      ownerId,
    });
  }

  private updateProjectiles(dt: number) {
    for (const p of this.projectiles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ttl -= dt;
      for (const w of this.area.walls) {
        if (p.x > w.x && p.x < w.x + w.w && p.y > w.y && p.y < w.y + w.h) {
          p.ttl = 0;
          this.push("projectileHit", p.x, p.y, { color: p.color });
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.ttl > 0);
  }

  // -------------------------------------------------- enemy attacks vs player
  private updateCombatVsPlayer(dt: number) {
    if (this.pstate === "dead") return;

    for (const e of this.enemies) {
      if (e.phase === "dead") continue;
      // contact damage
      if (e.def.contactDmg > 0) {
        if (dist2(e.x, e.y, this.px, this.py) < (e.def.radius + 13) ** 2) {
          this.tryDamagePlayer(e.def.contactDmg, e.x, e.y, e.def.knockback ?? 60, -1, e.id);
        }
      }
      // active attack hitbox
      if (e.phase === "active" && e.def.attackDmg > 0) {
        const already = this.enemyHitAtk.get(e.id) === e.atkId;
        if (!already) {
          let hit = false;
          if (e.def.role === "boss_king" && e.bossMove === 3) {
            hit = dist(e.x, e.y, this.px, this.py) < e.def.attackRange;
          } else if (e.def.role === "boss_harvester" && e.bossMove === 2) {
            hit = dist(e.x, e.y, this.px, this.py) < e.def.attackRange;
          } else if (e.def.role === "boss_harvester" && e.bossMove === 0) {
            hit = dist(e.x, e.y, this.px, this.py) < e.def.radius * e.big + 18;
          } else if (e.def.role === "boss_oldtom" && e.bossMove === 3) {
            hit = false; // nova damage is from projectiles
          } else {
            hit = inArc(this.px, this.py, e.x, e.y, e.facing, 0.9, e.def.attackRange + 8);
          }
          if (hit) {
            this.enemyHitAtk.set(e.id, e.atkId);
            this.tryDamagePlayer(
              e.def.attackDmg,
              e.x,
              e.y,
              e.def.knockback ?? 100,
              e.atkId,
              e.id
            );
          }
        }
      }
    }

    // projectiles vs player
    for (const p of this.projectiles) {
      if (!p.hostile) continue;
      if (dist2(p.x, p.y, this.px, this.py) < (p.r + 13) ** 2) {
        p.ttl = 0;
        const exposed = this.invuln <= 0 && this.pstate !== "roll";
        this.tryDamagePlayer(p.dmg, p.x, p.y, 80, -1, -2);
        if (p.poison && exposed) this.applyPoison(p.poison);
        this.push("projectileHit", p.x, p.y, { color: p.color });
      }
    }
  }

  private applyPoison(amt: number) {
    this.poison = Math.min(this.poison + amt, POISON_MAX);
    this.push("poison", this.px, this.py, { amount: amt });
    this.push("floatText", this.px, this.py - 40, {
      text: "POISONED",
      color: "#9fd44e",
    });
  }

  private tryDamagePlayer(
    dmg: number,
    sx: number,
    sy: number,
    kb: number,
    atkId: number,
    enemyId: number
  ) {
    if (this.invuln > 0) return;
    if (this.hurtCd > 0 && atkId < 0) return; // contact respects cd
    let final = dmg;
    const facingThreat =
      Math.abs(angleDiff(this.facing, angleTo(this.px, this.py, sx, sy))) < 1.1;

    if (this.blocking && facingThreat) {
      // PARRY
      if (this.parryWindow > 0) {
        const e = enemyId >= 0 ? this.findEnemy(enemyId) : null;
        if (e && e.def.role !== "boss_harvester") {
          e.staggerT = e.def.staggerHp ? 1.4 : 1.0;
          e.phase = "recover";
          e.timer = e.staggerT;
          e.staggerVal = 0;
        }
        this.riposteReady = 1.6;
        this.push("parry", this.px, this.py, { id: enemyId });
        this.push("floatText", this.px, this.py - 30, {
          text: "PARRY!",
          color: "#cfe6a0",
        });
        return;
      }
      // ordinary BLOCK
      final = Math.round(dmg * 0.25);
      this.stamina -= dmg * 1.4;
      this.push("block", this.px, this.py);
      if (this.stamina <= 0) {
        this.stamina = 0;
        this.exhausted = true;
        this.blocking = false;
        this.push("guardBreak", this.px, this.py);
        this.push("floatText", this.px, this.py - 30, {
          text: "GUARD BROKEN",
          color: "#ff5742",
        });
        // falls through and takes the reduced hit
      } else {
        this.push("floatText", this.px, this.py - 26, { text: "block", color: "#cfe6a0" });
        this.hurtCd = 0.3;
        return;
      }
    }

    final = Math.max(1, Math.round(final * (this.charm?.defenseMul ?? 1)));

    this.hp -= final;
    this.hurtCd = 0.5;
    this.invuln = 0.35;
    this.hurtT = 0.2;
    const n = norm(this.px - sx, this.py - sy);
    this.pvx += n.x * kb;
    this.pvy += n.y * kb;
    this.px += n.x * kb * 0.04;
    this.py += n.y * kb * 0.04;
    this.push("playerHit", this.px, this.py, { amount: final });
    this.push("floatText", this.px, this.py - 30, { text: String(final), color: "#ff5742" });
    if (this.pstate === "heal") this.pstate = "idle"; // interrupt heal

    if (this.hp <= 0) this.die();
  }

  private die() {
    this.hp = 0;
    this.pstate = "dead";
    this.poison = 0;
    this.blocking = false;
    this.push("death", this.px, this.py, { id: 0, kind: "player" });
    // drop husk (replaces any older one in this area)
    if (this.sap > 0) {
      this.husks = this.husks.filter((h) => h.areaId !== this.areaId);
      this.husks.push({ x: this.px, y: this.py, sap: this.sap, areaId: this.areaId });
      this.sap = 0;
    }
    this.lockTarget = null;
    this.respawnTimer = 1.6;
    this.screen = "dead";
  }

  respawn() {
    this.poison = 0;
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    this.pstate = "idle";
    this.screen = "play";
    this.loadArea(this.bonfireArea, true);
  }

  // ----------------------------------------------------------- pickups/husks
  private updatePickups(dt: number) {
    for (const h of this.husks) {
      if (h.areaId !== this.areaId) continue;
      if (dist2(h.x, h.y, this.px, this.py) < 28 * 28) {
        this.sap += h.sap;
        this.push("sapReclaim", this.px, this.py, { amount: h.sap });
        this.push("floatText", this.px, this.py - 30, {
          text: "+" + h.sap + " sap reclaimed",
          color: "#ffd56b",
        });
        h.sap = 0;
      }
    }
    this.husks = this.husks.filter((h) => h.sap > 0);

    const kept: Pickup[] = [];
    for (const p of this.pickups) {
      if (dist2(p.x, p.y, this.px, this.py) < 26 * 26) {
        if (p.kind === "estus") {
          this.estusMax += p.amt;
          this.estus += p.amt;
        } else if (p.kind === "sap") {
          this.gainSap(p.amt);
        } else if (p.kind === "weapon" && p.wid) {
          this.grantWeapon(p.wid);
        } else if (p.kind === "charm" && p.cid) {
          this.grantCharm(p.cid);
        }
        this.push("pickup", p.x, p.y, { kind: p.kind });
      } else {
        kept.push(p);
      }
    }
    this.pickups = kept;
  }

  // ------------------------------------------------------- bonfire / interact
  private tryInteract() {
    if (this.area.compost) {
      const c = this.area.compost;
      if (dist2(c.x, c.y, this.px, this.py) < 60 * 60) {
        this.restAtCompost();
      }
    }
  }

  private restAtCompost() {
    this.bonfireArea = this.areaId;
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    this.poison = 0;
    this.push("bonfire", this.px, this.py);
    // respawn fodder (souls tradition) — keep a living boss
    if (this.authority !== "client") {
      if (this.area.boss && !this.bossesDead.includes(this.areaId)) {
        this.enemies = this.boss ? this.enemies.filter((e) => e === this.boss) : [];
      } else {
        this.enemies = [];
        if (!this.area.boss) {
          for (const sp of this.area.spawns) this.spawnEnemy(sp.kind, sp.x, sp.y);
        }
      }
    }
    this.bonfireSel = 0;
    this.screen = "bonfire";
  }

  private updateBonfireMenu(input: InputState) {
    const opts = 5; // 4 stats + leave
    // reuse move axes for menu nav: up/down to change selection
    if (input.moveY > 0 && this.menuEdgeDown) {
      this.bonfireSel = (this.bonfireSel + 1) % opts;
      this.push("uiMove", this.px, this.py);
    }
    if (input.moveY < 0 && this.menuEdgeUp) {
      this.bonfireSel = (this.bonfireSel + opts - 1) % opts;
      this.push("uiMove", this.px, this.py);
    }
    this.menuEdgeDown = input.moveY <= 0;
    this.menuEdgeUp = input.moveY >= 0;

    const confirm = input.lightPressed || input.healPressed;
    if (confirm) {
      if (this.bonfireSel === 4) {
        this.push("uiSelect", this.px, this.py);
        this.screen = "play";
        return;
      }
      const cost = levelCost(this.stats);
      if (this.sap >= cost) {
        this.sap -= cost;
        const keys: (keyof PlayerStats)[] = ["vigor", "strength", "vitality", "agility"];
        this.stats[keys[this.bonfireSel]]++;
        this.recompute();
        this.hp = this.maxHp;
        this.stamina = this.maxStamina;
        this.push("levelUp", this.px, this.py);
      } else {
        this.push("uiMove", this.px, this.py, { text: "NOT ENOUGH SAP" });
      }
    }
    // cycle charm with left/right (only when owned)
    if (this.ownedCharms.length > 0) {
      if (input.moveX > 0 && this.menuEdgeRight) this.cycleCharm(1);
      if (input.moveX < 0 && this.menuEdgeLeft) this.cycleCharm(-1);
      this.menuEdgeRight = input.moveX <= 0;
      this.menuEdgeLeft = input.moveX >= 0;
    }

    if (input.interactPressed) this.screen = "play";
  }
  private menuEdgeDown = true;
  private menuEdgeUp = true;
  private menuEdgeLeft = true;
  private menuEdgeRight = true;

  private cycleCharm(dir: number) {
    const owned = this.ownedCharms
      .map((id) => CHARMS.find((c) => c.id === id))
      .filter((c): c is CharmDef => !!c);
    const list: (CharmDef | null)[] = [null, ...owned];
    let idx = list.findIndex((c) => (c?.id ?? null) === this.charmId);
    idx = (idx + dir + list.length) % list.length;
    this.charmId = list[idx]?.id ?? null;
    this.push("uiMove", this.px, this.py);
  }

  // pick a stat at the bonfire programmatically (renderer-driven menu alt path)
  levelUp(stat: keyof PlayerStats): boolean {
    const cost = levelCost(this.stats);
    if (this.sap < cost) return false;
    this.sap -= cost;
    this.stats[stat]++;
    this.recompute();
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.push("levelUp", this.px, this.py);
    return true;
  }

  setScreen(s: Screen) {
    this.screen = s;
  }
  setCharm(id: string | null) {
    if (id !== null && !this.ownedCharms.includes(id)) return;
    this.charmId = id;
  }
  leaveBonfire() {
    this.screen = "play";
  }

  // ------------------------------------------------------------- gates
  private handleGates() {
    for (const g of this.area.gates) {
      if (g.locked) continue;
      const r = g.rect;
      if (
        this.px > r.x - 10 &&
        this.px < r.x + r.w + 10 &&
        this.py > r.y - 10 &&
        this.py < r.y + r.h + 10
      ) {
        this.loadArea(g.to, false, g.toX, g.toY);
        return;
      }
    }
  }

  private checkAreaClear() {
    const aliveBoss = this.boss && this.boss.phase !== "dead";
    if (!aliveBoss) {
      for (const g of this.area.gates)
        if (g.locked && this.bossesDead.includes(this.areaId)) g.locked = false;
    }
    // cull dead enemies after settle
    this.enemies = this.enemies.filter((e) => e.phase !== "dead" || e.timer > -0.5);
  }

  // ------------------------------------------------------------- collision
  private collide(x: number, y: number, r: number) {
    let cx = x;
    let cy = y;
    for (const w of this.area.walls) {
      const res = resolveCircleRect(cx, cy, r, w);
      cx = res.x;
      cy = res.y;
    }
    return { x: cx, y: cy };
  }

  // ------------------------------------------------------------- targeting
  private findEnemy(id: number): SimEnemy | null {
    for (const e of this.enemies) if (e.id === id) return e;
    return null;
  }

  private nearestEnemyId(maxR: number): number | null {
    let best: number | null = null;
    let bd = maxR * maxR;
    for (const e of this.enemies) {
      if (e.phase === "dead") continue;
      const d = dist2(e.x, e.y, this.px, this.py);
      if (d < bd) {
        bd = d;
        best = e.id;
      }
    }
    return best;
  }

  // ------------------------------------------------------- entity mirroring
  private syncPlayerEntity() {
    const e = this.playerEnt;
    e.x = this.px;
    e.y = this.py;
    e.vx = this.pvx;
    e.vy = this.pvy;
    e.facing = this.facing;
    e.hp = this.hp;
    e.maxHp = this.maxHp;
    e.animPhase = this.walkPhase;
    e.facingFlip = Math.cos(this.facing) < 0;
    e.hurtT = this.hurtT;
    const f = e.flags;
    f.dead = this.pstate === "dead";
    f.attacking = this.pstate === "attack";
    f.invuln = this.invuln > 0;
    f.blocking = this.blocking;
    f.hurt = this.hurtT > 0;
    f.windup = false;
    f.staggered = false;
    // animState
    let a: AnimState;
    let once = false;
    switch (this.pstate) {
      case "dead":
        a = "death";
        once = true;
        break;
      case "roll":
        a = "roll";
        once = true;
        break;
      case "attack":
        a = this.attackHeavy ? "heavyAttack" : "lightAttack";
        once = true;
        break;
      case "heal":
        a = "heal";
        once = true;
        break;
      default:
        if (this.hurtT > 0.12) {
          a = "hurt";
          once = true;
        } else if (this.blocking) {
          a = "guard";
        } else if (this.moving) {
          a = "run";
        } else {
          a = "idle";
        }
    }
    e.animState = a;
    e.animOnce = once;
  }

  private syncEnemyEntity(e: SimEnemy, dt: number) {
    const f = e.flags;
    f.dead = e.phase === "dead";
    f.windup = e.phase === "windup";
    f.attacking = e.phase === "active";
    f.staggered = e.staggerT > 0;
    f.hurt = e.hurtT > 0;
    f.invuln = false;
    f.blocking = false;
    e.facingFlip = Math.cos(e.facing) < 0;

    const moving = Math.hypot(e.vx, e.vy) > 8;
    let a: AnimState;
    if (
      e.def.role === "boss_king" ||
      e.def.role === "boss_oldtom" ||
      e.def.role === "boss_harvester"
    ) {
      a = bossAnim(
        e.kind as "king" | "oldtom" | "harvester",
        e.phase,
        e.bossMove,
        moving,
        e.roarT > 0
      );
    } else {
      a = enemyAnim(e.kind, e.phase, moving);
    }
    e.animState = a;
    e.animOnce = isOnceAnim(a);
  }

  // ------------------------------------------------------------- public API
  getState(): WorldState {
    return {
      areaId: this.areaId,
      areaName: this.area.name,
      areaSubtitle: this.area.subtitle,
      areaW: this.area.w,
      areaH: this.area.h,
      player: this.getPlayerView(),
      entities: this.enemies,
      projectiles: this.projectiles,
      pickups: this.pickups,
      husks: this.husks.filter((h) => h.areaId === this.areaId),
      boss: this.getBossView(),
      bossIntro: this.bossIntro,
      time: this.time,
      screen: this.screen,
      bonfireSel: this.bonfireSel,
    };
  }

  getPlayerEntity(): Entity {
    return this.playerEnt;
  }

  private getPlayerView(): PlayerView {
    return {
      entity: this.playerEnt,
      hp: this.hp,
      maxHp: this.maxHp,
      stamina: this.stamina,
      maxStamina: this.maxStamina,
      estus: this.estus,
      estusMax: this.estusMax,
      sap: this.sap,
      poison: this.poison,
      exhausted: this.exhausted,
      weapon: this.weapon,
      ownedWeapons: this.ownedWeapons,
      charmId: this.charmId,
      ownedCharms: this.ownedCharms,
      lockTarget: this.lockTarget,
      stats: this.stats,
      level: totalLevel(this.stats),
      nextLevelCost: levelCost(this.stats),
    };
  }

  private getBossView(): BossView | null {
    if (!this.boss) return null;
    const b = this.boss;
    return {
      id: b.id,
      name: b.def.name,
      hp01: b.maxHp > 0 ? clamp(b.hp / b.maxHp, 0, 1) : 0,
      active: this.bossIntro <= 0,
      phase2: b.bossPhase2,
    };
  }

  // events: integrator drains these each frame for VFX/audio
  drainEvents(): SimEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  private push(
    type: SimEventType,
    x: number,
    y: number,
    extra?: Partial<Omit<SimEvent, "type" | "x" | "y">>
  ) {
    this.events.push({ type, x, y, ...extra });
  }

  // ----------------------------------------------------- net snapshot (data)
  snapshot(): SimSnapshot {
    return {
      areaId: this.areaId,
      time: this.time,
      rngState: this.rng.getState(),
      player: this.entitySnap(this.playerEnt),
      enemies: this.enemies.map((e) => this.entitySnap(e)),
      projectiles: this.projectiles.map((p) => ({ ...p })),
      boss: this.getBossView(),
      bossIntro: this.bossIntro,
    };
  }

  private entitySnap(e: Entity): EntitySnap {
    return {
      id: e.id,
      kind: e.kind,
      x: e.x,
      y: e.y,
      vx: e.vx,
      vy: e.vy,
      facing: e.facing,
      hp: e.hp,
      maxHp: e.maxHp,
      animState: e.animState,
      animOnce: e.animOnce,
      animPhase: e.animPhase,
      big: e.big,
      flags: { ...e.flags },
    };
  }

  // Apply a host snapshot on a client. Reconciles enemies by id, replaces
  // projectiles, and mirrors the player ghost / boss bar. AI is NOT run on
  // clients (authority === "client") so this is the source of truth there.
  applySnapshot(s: SimSnapshot) {
    if (s.areaId !== this.areaId) this.loadArea(s.areaId, true);
    this.time = s.time;
    this.rng.setState(s.rngState);
    this.bossIntro = s.bossIntro;

    const byId = new Map(this.enemies.map((e) => [e.id, e]));
    const seen = new Set<number>();
    const next: SimEnemy[] = [];
    for (const es of s.enemies) {
      seen.add(es.id);
      let e = byId.get(es.id);
      if (!e) e = this.spawnEnemyFromSnap(es);
      this.applyEntitySnap(e, es);
      next.push(e);
    }
    this.enemies = next;
    this.boss =
      this.enemies.find(
        (e) => e.kind === "king" || e.kind === "oldtom" || e.kind === "harvester"
      ) ?? null;

    this.projectiles = s.projectiles.map((p) => ({ ...p }));
  }

  private applyEntitySnap(e: SimEnemy, es: EntitySnap) {
    e.x = es.x;
    e.y = es.y;
    e.vx = es.vx;
    e.vy = es.vy;
    e.facing = es.facing;
    e.hp = es.hp;
    e.maxHp = es.maxHp;
    e.animState = es.animState;
    e.animOnce = es.animOnce;
    e.animPhase = es.animPhase;
    e.big = es.big;
    e.flags = { ...es.flags };
    e.phase = es.flags.dead
      ? "dead"
      : es.flags.attacking
        ? "active"
        : es.flags.windup
          ? "windup"
          : "chase";
  }

  private spawnEnemyFromSnap(es: EntitySnap): SimEnemy {
    // resolve a def from the rendered kind (first roster entry with this kind)
    const defKey =
      (Object.keys(ENEMIES) as EnemyId[]).find((k) => ENEMIES[k].kind === es.kind) ??
      ("grub" as EnemyId);
    const def = ENEMIES[defKey];
    const e: SimEnemy = {
      id: es.id,
      kind: es.kind as EnemyKind,
      def,
      x: es.x,
      y: es.y,
      vx: es.vx,
      vy: es.vy,
      facing: es.facing,
      hp: es.hp,
      maxHp: es.maxHp,
      animState: es.animState,
      animOnce: es.animOnce,
      animPhase: es.animPhase,
      big: es.big,
      facingFlip: false,
      flags: { ...es.flags },
      hurtT: 0,
      phase: "chase",
      timer: 0,
      cd: 0,
      atkId: 0,
      homeX: es.x,
      homeY: es.y,
      bossMove: 0,
      bossPhase2: false,
      staggerVal: 0,
      staggerT: 0,
      roarT: 0,
    };
    this.enemies.push(e);
    return e;
  }
}
