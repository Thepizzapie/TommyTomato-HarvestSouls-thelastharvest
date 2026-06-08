import { Input } from "../core/input";
import { Audio } from "../core/audio";
import {
  drawHero,
  drawEnemy,
  drawCompostHeap,
  drawHusk,
  drawPickup,
  drawMushroom,
  drawFlower,
  drawLantern,
  drawBones,
  drawBanner,
  drawTorch,
  drawGrassTuft,
  drawVinePatch,
  type HeroVisual,
  type EnemyKind,
} from "../core/art";
import {
  AREAS,
  ENEMIES,
  FIRST_AREA,
  BASE_STATS,
  PLAYER_TINTS,
  WEAPONS,
  CHARMS,
  STARTING_WEAPON,
  deriveMaxHp,
  deriveAttack,
  deriveMaxStamina,
  deriveSpeed,
  totalLevel,
  levelCost,
  type AreaDef,
  type EnemyDef,
  type PlayerStats,
  type WeaponKind,
  type CharmDef,
} from "../content/world";
import {
  defaultRunMods, newRun, takeBoon, rollBoonChoices, addSpecialCharge, specialChargePct,
  specialReady, fireSpecial, ACTS, type RunMods, type RunState, type Boon,
} from "./run";
import {
  ParticleSystem,
  renderLighting,
  drawWeather,
  colorGrade,
  vignette,
  flashScreen,
  type Light,
  type Weather,
  type GradePreset,
} from "../core/vfx";
import {
  clamp,
  lerp,
  dist,
  dist2,
  norm,
  angleTo,
  inArc,
  resolveCircleRect,
  approach,
} from "../core/math";
import { RNG, hashSeed } from "../core/rng";
import type {
  NetHooks,
  NetMsg,
  PlayerSnap,
  EnemySnap,
  SaveData,
} from "./types";

const SAVE_KEY = "tommytomato.save.v1";

// ----- entity types -----
interface FloatText {
  x: number;
  y: number;
  vy: number;
  life: number;
  text: string;
  color: string;
  size: number;
}
interface Enemy {
  id: number;
  def: EnemyDef;
  kind: EnemyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  facing: number;
  phase: number; // anim phase
  state: "idle" | "chase" | "windup" | "active" | "recover" | "dead";
  timer: number;
  cd: number;
  hurt: number;
  atkId: number;
  attackProg: number; // 0..1 for art
  windupFlag: boolean;
  big: number;
  targetId: string | null;
  bossMove?: number; // boss attack selection
  bossPhase2?: boolean;
  homeX: number;
  homeY: number;
  staggerVal: number; // poise accumulator
  staggerT: number; // >0 while poise-broken / stunned
  // client interpolation
  tx?: number;
  ty?: number;
}
interface Projectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  ttl: number;
  hostile: boolean;
  color: string;
  poison?: number; // applies poison-over-time to whoever it hits
  ownerId?: string; // for player projectiles (none currently)
}
interface Pickup {
  id: number;
  x: number;
  y: number;
  kind: "estus" | "sap" | "key" | "weapon" | "charm";
  amt: number;
  wid?: WeaponKind; // weapon pickups
  cid?: string; // charm pickups
}
interface Husk {
  x: number;
  y: number;
  sap: number;
  area: string;
}
interface RemotePlayer {
  snap: PlayerSnap;
  // interpolation
  rx: number;
  ry: number;
  lastHitAtk: Map<number, number>;
}

type Screen =
  | "play"
  | "bonfire"
  | "boon"
  | "dead"
  | "victory"
  | "paused"
  | "loading";

export interface GameCallbacks {
  onToast?: (msg: string, sub?: string) => void;
  onScreenChange?: (s: Screen) => void;
}

export class Game {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  input: Input;
  audio = new Audio();
  net: NetHooks;
  cb: GameCallbacks;

  raf = 0;
  running = false;
  lastT = 0;
  time = 0;
  cssW = 0;
  cssH = 0;
  dpr = 1;
  viewScale = 1;

  // world
  areaId = FIRST_AREA;
  area!: AreaDef;
  enemies: Enemy[] = [];
  projectiles: Projectile[] = [];
  pickups: Pickup[] = [];
  texts: FloatText[] = [];
  husks: Husk[] = [];
  rng = new RNG(12345);
  enemyIdSeq = 1;
  projIdSeq = 1;
  pickupIdSeq = 1;

  // camera
  camX = 0;
  camY = 0;
  shake = 0;

  // player
  px = 0;
  py = 0;
  pvx = 0;
  pvy = 0;
  facing = 0;
  stats: PlayerStats = { ...BASE_STATS };
  hp = 90;
  maxHp = 90;
  stamina = 100;
  maxStamina = 100;
  sap = 0;
  estus = 4;
  estusMax = 4;
  name = "Tommy";
  tint = PLAYER_TINTS[0];

  pstate: "idle" | "roll" | "attack" | "heal" | "hurt" | "dead" = "idle";
  pstateTimer = 0;
  invuln = 0;
  attackProg = 0;
  attackId = 0;
  attackHeavy = false;
  attackHitSet = new Set<number>();
  hurtCd = 0;
  rollDirX = 0;
  rollDirY = 0;
  blocking = false;
  walkPhase = 0;
  moving = false;
  lockTarget: number | null = null;
  exhausted = false;
  respawnTimer = 0;

  bonfireArea = FIRST_AREA;
  bossesDead: string[] = [];
  playtime = 0;

  screen: Screen = "loading";
  bonfireSel = 0;

  // --- Harvest Run (roguelite) state. null in the classic campaign. ---
  run: RunState | null = null;
  private _noMods = defaultRunMods();
  /** Active run modifiers, or a neutral identity in campaign mode. */
  get mods(): RunMods {
    return this.run ? this.run.mods : this._noMods;
  }
  harvest = false;
  boonChoices: Boon[] = [];
  boonSel = 0;
  private roomActive = false;
  private _baseEstus = 4;
  // boons whose effects are wired into the engine (drafted only from these)
  private readonly WIRED = new Set<string>([
    "ripe_flesh", "second_wind", "sharpened_thorn", "quick_roots", "deep_pantry",
    "bloodroot", "photosynthesis", "long_vine", "overripe", "adrenal_sap", "harvesters_favor",
  ]);
  private coopDraftWait = 0; // host: clients still drafting before the run advances
  private hostPicked = false; // host: has the host finished its own draft this round
  toastT = 0;
  toastMsg = "";
  toastSub = "";

  boss: Enemy | null = null;
  bossIntro = 0;

  // multiplayer
  others = new Map<string, RemotePlayer>();
  netSendCd = 0;
  snapCd = 0;
  enemyHitAtk = new Map<number, number>(); // enemyId -> last atkId that hit me

  // ---- v2: fx + gameplay systems ----
  ps = new ParticleSystem(1600);
  hitstop = 0; // freeze-frame timer for impact crunch
  flashColor = "";
  flashAlpha = 0; // screen flash
  footAccum = 0; // footstep distance accumulator
  musicMode: "explore" | "combat" | "boss" = "explore";
  // weapons & charms
  weapon: WeaponKind = STARTING_WEAPON;
  ownedWeapons: WeaponKind[] = [STARTING_WEAPON];
  charm: CharmDef | null = null;
  ownedCharms: string[] = [];
  charmSel = 0; // bonfire charm-menu cursor
  // combat depth
  poison = 0; // remaining poison damage budget
  poisonTick = 0; // sub-second accumulator
  parryWindow = 0; // >0 just after raising guard — a parry is possible
  parryFlash = 0; // visual pulse
  riposteReady = 0; // >0 = next light strike is an empowered riposte
  riposteActive = false; // the current swing is a riposte
  riposteAnim = 0; // visual pulse
  hpRegenAcc = 0; // charm passive-regen accumulator

  constructor(
    canvas: HTMLCanvasElement,
    net: NetHooks,
    cb: GameCallbacks = {}
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.net = net;
    this.cb = cb;
    this.input = new Input(canvas);
    this.name = net.name;
    this.tint = net.tint;
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  // ---------------- lifecycle ----------------
  resize = () => {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width || 960;
    this.cssH = r.height || 540;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(this.cssW * this.dpr);
    this.canvas.height = Math.floor(this.cssH * this.dpr);
    this.viewScale = clamp(this.cssH / 660, 0.55, 1.4);
  };

  start(profile?: SaveData, harvestMode = false) {
    if (profile) this.applyProfile(profile);
    else if (this.net.mode === "solo" && !harvestMode) {
      const saved = Game.loadSave();
      if (saved) this.applyProfile(saved);
    }
    this.running = true;
    this.lastT = performance.now();
    this.audio.resume();
    this.audio.startMusic();
    if (harvestMode) {
      this.startHarvestRun(this.net.mode !== "client");
      if (this.net.mode === "client") this.loadArea(FIRST_AREA, true); // host syncs the real area
    } else {
      this.recompute();
      this.hp = this.maxHp;
      this.stamina = this.maxStamina;
      this.estus = this.estusMax;
      this.loadArea(this.net.mode === "client" ? FIRST_AREA : this.areaId, true);
    }
    this.setScreen("play");
    this.raf = requestAnimationFrame(this.frame);
  }

  applyProfile(p: SaveData) {
    this.name = p.name || this.name;
    this.tint = p.tint || this.tint;
    this.stats = { ...p.stats };
    this.sap = p.sap;
    this.estusMax = p.estusMax;
    this.areaId = p.area || FIRST_AREA;
    this.bonfireArea = p.bonfireArea || FIRST_AREA;
    this.bossesDead = p.bossesDead || [];
    this.playtime = p.playtime || 0;
  }

  recompute() {
    const m = this.mods;
    this.maxHp = Math.max(1, Math.round(deriveMaxHp(this.stats) + m.maxHpBonus));
    this.maxStamina = Math.round(deriveMaxStamina(this.stats) + m.maxStaminaBonus);
  }

  setScreen(s: Screen) {
    this.screen = s;
    this.cb.onScreenChange?.(s);
  }

  toast(msg: string, sub = "") {
    this.toastMsg = msg;
    this.toastSub = sub;
    this.toastT = 4;
    this.cb.onToast?.(msg, sub);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.input.destroy();
    this.audio.destroy();
    window.removeEventListener("resize", this.resize);
    if (this.net.mode !== "client") this.save();
  }

  // ---------------- save ----------------
  save() {
    if (this.net.mode === "client") return;
    const data: SaveData = {
      name: this.name,
      tint: this.tint,
      stats: this.stats,
      sap: this.sap,
      estusMax: this.estusMax,
      area: this.areaId,
      bonfireArea: this.bonfireArea,
      bossesDead: this.bossesDead,
      playtime: this.playtime,
    };
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch {}
  }
  static loadSave(): SaveData | null {
    try {
      const s = localStorage.getItem(SAVE_KEY);
      return s ? (JSON.parse(s) as SaveData) : null;
    } catch {
      return null;
    }
  }
  static clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {}
  }

  // ---------------- area loading ----------------
  loadArea(id: string, atSpawn: boolean, fromGateX?: number, fromGateY?: number) {
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
    this.rng = new RNG(hashSeed(id) ^ 0x9e3779b9);

    // place player
    if (fromGateX !== undefined && fromGateY !== undefined) {
      this.px = fromGateX;
      this.py = fromGateY;
    } else {
      this.px = area.spawnPoint.x;
      this.py = area.spawnPoint.y;
    }

    // host/solo spawn enemies (unless boss already dead)
    if (this.net.mode !== "client") {
      const bossDefeated = area.boss && this.bossesDead.includes(id);
      if (!bossDefeated) {
        for (const sp of area.spawns) {
          this.spawnEnemy(sp.kind, sp.x, sp.y);
        }
        if (area.boss) {
          this.boss = this.spawnEnemy(area.boss, area.w / 2, area.h / 2 - 200);
          this.bossIntro = 2.5;
          this.audio.bossRoar();
          this.audio.bossMusicSting();
        }
      } else if (area.boss) {
        // open locked gates if boss already dead
      }
    }

    // a findable second weapon, once, in the greenhouse
    if (
      this.net.mode !== "client" &&
      id === "greenhouse" &&
      !this.ownedWeapons.includes("dagger")
    ) {
      this.dropPickup(360, 620, "weapon", 1, "dagger");
    }

    this.camX = this.px;
    this.camY = this.py;
    this.toast(area.name, area.subtitle);
    this.audio.setAmbience(this.ambienceFor());
    this.musicMode = this.boss ? "boss" : "explore";
    this.audio.setMusicMode(this.musicMode);
    if (this.net.mode === "host") this.net.send({ t: "area", area: id });
  }

  ambienceFor(): "rows" | "greenhouse" | "catacombs" | "yard" | "sodden" | "none" {
    if (this.areaId === "kingarena") return "catacombs";
    switch (this.area.floor) {
      case "rows":
        return "rows";
      case "glass":
        return "greenhouse";
      case "stone":
        return "catacombs";
      case "yard":
        return "yard";
      case "bog":
        return "sodden";
      default:
        return "none";
    }
  }

  spawnEnemy(kind: keyof typeof ENEMIES, x: number, y: number): Enemy {
    const def = ENEMIES[kind];
    const e: Enemy = {
      id: this.enemyIdSeq++,
      def,
      kind: def.kind,
      x,
      y,
      vx: 0,
      vy: 0,
      hp: def.hp,
      maxHp: def.hp,
      facing: 0,
      phase: Math.random() * 10,
      state: "idle",
      timer: 0,
      cd: this.rng.range(0.3, 1.2),
      hurt: 0,
      atkId: 0,
      attackProg: 0,
      windupFlag: false,
      big: def.big || 1,
      targetId: null,
      homeX: x,
      homeY: y,
      bossPhase2: false,
      bossMove: 0,
      staggerVal: 0,
      staggerT: 0,
    };
    this.enemies.push(e);
    return e;
  }

  // ---------------- main loop ----------------
  frame = (now: number) => {
    if (!this.running) return;
    let dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (dt > 0.05) dt = 0.05; // clamp big stalls
    // hit-stop: on big impacts the sim crawls for a few frames — that crunch
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      dt *= 0.12;
    }
    this.time += dt;
    this.playtime += dt;

    this.input.beginFrame();
    this.update(dt);
    this.render();

    this.raf = requestAnimationFrame(this.frame);
  };

  update(dt: number) {
    // global UI input
    if (this.input.pressed("KeyP") && this.screen === "play")
      this.setScreen("paused");
    else if (this.input.pressed("KeyP") && this.screen === "paused")
      this.setScreen("play");

    if (this.screen === "paused") return;
    if (this.screen === "bonfire") {
      this.updateBonfireMenu();
      this.updateParticles(dt);
      return;
    }
    if (this.screen === "boon") {
      this.updateBoonDraft();
      this.updateParticles(dt);
      return;
    }
    if (this.screen === "victory") {
      this.updateParticles(dt);
      return;
    }
    if (this.screen === "dead") {
      this.respawnTimer -= dt;
      this.updateParticles(dt);
      if (this.respawnTimer <= 0 && (this.input.pressed("Space") || this.input.lmbPressed))
        this.respawn();
      return;
    }

    if (this.toastT > 0) this.toastT -= dt;
    if (this.bossIntro > 0) this.bossIntro -= dt;

    this.updatePlayer(dt);

    // AI / world is host & solo authoritative
    if (this.net.mode !== "client") {
      for (const e of this.enemies) this.updateEnemy(e, dt);
      this.updateProjectiles(dt);
      this.checkAreaClear();
    } else {
      this.interpolateEnemies(dt);
      this.updateProjectiles(dt); // client moves projectiles locally too
    }

    this.updateCombatVsPlayer(dt);
    this.updatePickups(dt);
    this.updateParticles(dt);
    this.updateCamera(dt);
    this.updateRemotePlayers(dt);
    this.handleGates();
    this.updateMusic();
    this.netTick(dt);
  }

  // crossfade music between explore / combat / boss based on the threat around you
  updateMusic() {
    let desired: "explore" | "combat" | "boss" = "explore";
    if (this.boss && this.boss.state !== "dead") {
      desired = "boss";
    } else {
      for (const e of this.enemies) {
        if (e.state === "dead" || e.state === "idle") continue;
        if (dist2(e.x, e.y, this.px, this.py) < 600 * 600) {
          desired = "combat";
          break;
        }
      }
    }
    if (desired !== this.musicMode) {
      this.musicMode = desired;
      this.audio.setMusicMode(desired);
    }
  }

  // ---------------- player ----------------
  updatePlayer(dt: number) {
    if (this.pstate === "dead") return;
    if (this.hurtCd > 0) this.hurtCd -= dt;
    if (this.invuln > 0) this.invuln -= dt;

    // poison damage-over-time
    if (this.poison > 0) {
      this.poisonTick += dt;
      if (this.poisonTick >= 0.5) {
        this.poisonTick -= 0.5;
        const tick = Math.min(this.poison, 4);
        this.poison -= tick;
        this.hp -= tick;
        this.floatText(this.px, this.py - 24, String(tick), "#9fd44e", 12);
        this.ps.emit("poison", this.px, this.py, { count: 4 });
        if (this.hp <= 0) {
          this.die();
          return;
        }
      }
    }
    // charm passive regen (Thirsty Root)
    const regenRate = (this.charm?.hpRegen || 0) + this.mods.regenPerSec;
    if (regenRate > 0 && this.hp > 0 && this.hp < this.maxHp) {
      this.hpRegenAcc += regenRate * dt;
      if (this.hpRegenAcc >= 1) {
        const g = Math.floor(this.hpRegenAcc);
        this.hpRegenAcc -= g;
        this.hp = Math.min(this.maxHp, this.hp + g);
      }
    }
    if (this.parryWindow > 0) this.parryWindow -= dt;
    if (this.riposteReady > 0) this.riposteReady -= dt;

    if (this.pstate !== "idle") this.blocking = false;

    // facing: lock-on > mouse aim
    const lockE = this.lockTarget
      ? this.enemies.find((e) => e.id === this.lockTarget && e.state !== "dead")
      : null;
    if (this.lockTarget && !lockE) this.lockTarget = null;
    if (lockE) {
      this.facing = angleTo(this.px, this.py, lockE.x, lockE.y);
    } else {
      const m = this.screenToWorld(this.input.mouseX, this.input.mouseY);
      this.facing = angleTo(this.px, this.py, m.x, m.y);
    }

    // lock-on toggle
    if (this.input.pressed("Tab") || this.input.pressed("KeyQ")) {
      if (this.lockTarget) {
        this.lockTarget = null;
      } else {
        this.lockTarget = this.nearestEnemyId(520);
        if (this.lockTarget) this.audio.uiSelect();
      }
    }

    // weapon switching (1–4, owned only)
    const wkeys: WeaponKind[] = ["whip", "dagger", "mace", "rapier"];
    for (let i = 0; i < 4; i++) {
      if (this.input.pressed("Digit" + (i + 1))) {
        const w = wkeys[i];
        if (this.ownedWeapons.includes(w) && w !== this.weapon) {
          this.weapon = w;
          this.audio.weaponSwitch();
          this.toast(WEAPONS[w].name, "drawn");
        }
      }
    }

    const speed = deriveSpeed(this.stats) * this.mods.moveSpeedMul;
    const mv = this.input.moveVec();
    const mvn = norm(mv.x, mv.y);
    this.moving = mv.x !== 0 || mv.y !== 0;

    // stamina regen
    const acting = this.pstate === "attack" || this.pstate === "roll";
    if (!acting && !this.blocking) {
      this.stamina = approach(this.stamina, this.maxStamina, 42 * dt);
    } else if (this.blocking) {
      this.stamina = approach(this.stamina, this.maxStamina, 10 * dt);
    }
    if (this.exhausted && this.stamina > this.maxStamina * 0.25)
      this.exhausted = false;

    // state machine
    if (this.pstate === "roll") {
      this.pstateTimer -= dt;
      this.pvx = this.rollDirX * speed * 2.0;
      this.pvy = this.rollDirY * speed * 2.0;
      if (this.pstateTimer < 0.18) this.invuln = Math.max(this.invuln, 0); // i-frames already counted
      if (this.pstateTimer <= 0) this.pstate = "idle";
    } else if (this.pstate === "attack") {
      this.pstateTimer -= dt;
      const total = this.attackHeavy ? 0.55 : 0.36;
      this.attackProg = clamp(this.pstateTimer / total, 0, 1);
      // movement crawl during swing
      this.pvx = mvn.x * speed * 0.25;
      this.pvy = mvn.y * speed * 0.25;
      // active hit window
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
        this.hp = Math.min(this.maxHp, this.hp + 52 + (this.charm?.healPower || 0));
        this.ps.emit("heal", this.px, this.py, { count: 16 });
        this.audio.heal();
        this.pstate = "idle";
      }
    } else {
      // idle/move — accept inputs
      const prevBlock = this.blocking;
      this.blocking = this.input.rmbDown && this.stamina > 0 && !this.exhausted;
      if (this.blocking && !prevBlock) {
        this.parryWindow = 0.22; // a freshly-raised guard can parry
        this.audio.block();
      }

      // movement (strafe relative when locked)
      let ax = mvn.x;
      let ay = mvn.y;
      const moveSpeed = this.blocking ? speed * 0.5 : speed;
      this.pvx = ax * moveSpeed;
      this.pvy = ay * moveSpeed;

      // special move (C) — unleashed when the Harvest meter is full
      if (this.input.pressed("KeyC") && this.run && specialReady(this.run)) {
        const sdef = fireSpecial(this.run);
        if (sdef) this.fireSpecialEffect(sdef);
      }

      // roll
      if (
        this.input.pressed("Space") &&
        this.stamina >= 22 &&
        !this.exhausted
      ) {
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
        this.invuln = 0.3;
        this.stamina -= 22;
        if (this.stamina <= 0) this.exhausted = true;
        this.audio.roll();
        this.spawnParticles(this.px, this.py, 6, "#a98a5a", 60);
      }
      // attacks (stamina cost scales with the equipped weapon)
      else if (
        (this.input.lmbPressed || this.input.pressed("KeyJ")) &&
        this.stamina >= WEAPONS[this.weapon].staminaLight &&
        !this.exhausted
      ) {
        this.beginAttack(false);
      } else if (
        (this.input.pressed("KeyF") || this.input.pressed("KeyK")) &&
        this.stamina >= WEAPONS[this.weapon].staminaHeavy &&
        !this.exhausted
      ) {
        this.beginAttack(true);
      }
      // heal
      else if (
        (this.input.pressed("KeyR") || this.input.pressed("KeyH")) &&
        this.estus > 0 &&
        this.hp < this.maxHp
      ) {
        this.estus--;
        this.pstate = "heal";
        this.pstateTimer = 0.7;
      }
      // interact (bonfire)
      else if (this.input.pressed("KeyE")) {
        this.tryInteract();
      }
    }

    if (this.moving && this.pstate === "idle") this.walkPhase += dt * 14;

    // footsteps + kicked-up dust
    if (this.moving && (this.pstate === "idle" || this.pstate === "attack")) {
      this.footAccum += Math.hypot(this.pvx, this.pvy) * dt;
      if (this.footAccum > 34) {
        this.footAccum = 0;
        this.audio.footstep(this.area.floor === "bog" ? "soil" : this.area.floor);
        this.ps.emit("dust", this.px, this.py + 12, { count: 2 });
      }
    }

    // integrate + collide
    this.px += this.pvx * dt;
    this.py += this.pvy * dt;
    this.collideWalls(this.px, this.py, 14, (x, y) => {
      this.px = x;
      this.py = y;
    });
  }

  beginAttack(heavy: boolean) {
    const w = WEAPONS[this.weapon];
    this.pstate = "attack";
    this.attackHeavy = heavy;
    this.pstateTimer = (heavy ? 0.55 : 0.36) * w.speedMul;
    this.attackProg = 1;
    this.attackId++;
    this.attackHitSet.clear();
    // a light strike while primed becomes an empowered riposte
    this.riposteActive = !heavy && this.riposteReady > 0;
    if (this.riposteActive) {
      this.riposteReady = 0;
      this.riposteAnim = 0.32;
      this.audio.riposte();
    } else {
      this.audio.swing();
    }
    this.stamina -= heavy ? w.staminaHeavy : w.staminaLight;
    if (this.stamina <= 0) this.exhausted = true;
  }

  doMeleeHit() {
    const w = WEAPONS[this.weapon];
    const m = this.mods;
    const reach = w.reach * (this.attackHeavy ? 1.05 : 1) * m.reachMul;
    const half = w.arcHalf;
    const lowHp = this.hp < this.maxHp * 0.4 ? m.lowHpDamageMul : 1;
    const baseAtk = deriveAttack(this.stats) * (this.charm?.damageMul || 1) * m.damageMul * lowHp;
    const dmg = baseAtk * (this.attackHeavy ? w.heavyMul : w.lightMul);
    const ox = this.px + Math.cos(this.facing) * 10;
    const oy = this.py + Math.sin(this.facing) * 10;
    for (const e of this.enemies) {
      if (e.state === "dead") continue;
      if (this.attackHitSet.has(e.id)) continue;
      if (inArc(e.x, e.y, ox, oy, this.facing, half, reach + e.def.radius)) {
        this.attackHitSet.add(e.id);
        if (this.run) {
          if (this.mods.lifestealFrac > 0) this.hp = Math.min(this.maxHp, this.hp + dmg * this.mods.lifestealFrac);
          addSpecialCharge(this.run, dmg);
        }
        let d = dmg;
        let crit = false;
        let poise = (w.poise || 6) * (this.attackHeavy ? 2 : 1);
        // riposte > backstab > staggered bonuses
        const toP = angleTo(e.x, e.y, this.px, this.py);
        const back = Math.cos(e.facing - toP) < -0.5; // striking its back
        if (this.riposteActive) {
          d *= 2.6;
          poise += 40;
          crit = true;
          this.riposteActive = false;
        } else if (back && e.def.role !== "boss_king" && e.def.role !== "boss_harvester") {
          d *= 1.8;
          crit = true;
          this.audio.backstab();
        }
        if (e.staggerT > 0) d *= 1.5;
        const kb = this.attackHeavy ? 220 : 120;
        const kx = Math.cos(this.facing) * kb;
        const ky = Math.sin(this.facing) * kb;
        this.hitEnemy(e, d, kx, ky, poise, crit);
      }
    }
  }

  // apply damage to an enemy (host/solo applies; client requests)
  hitEnemy(e: Enemy, dmg: number, kx: number, ky: number, poise = 0, forceCrit = false) {
    const crit = forceCrit || this.rng.chance(0.12);
    const final = Math.round(
      dmg * (crit && !forceCrit ? 1.6 : 1) * this.rng.range(0.9, 1.1)
    );
    this.spawnHitFx(e.x, e.y, crit);
    this.floatText(e.x, e.y - 20, String(final), crit ? "#ffd56b" : "#fff", crit ? 22 : 16);
    this.audio.hit();
    this.addShake(this.attackHeavy ? 8 : 4);
    this.hitstop = Math.max(this.hitstop, this.attackHeavy || forceCrit ? 0.05 : 0.02);

    if (this.net.mode === "client") {
      this.net.send({ t: "edmg", id: e.id, amt: final, kx, ky, poise });
      e.hurt = 0.12; // optimistic local flash
      return;
    }
    this.applyEnemyDamage(e, final, kx, ky, this.net.selfId, poise);
  }

  applyEnemyDamage(
    e: Enemy,
    dmg: number,
    kx: number,
    ky: number,
    byId: string,
    poise = 0
  ) {
    if (e.state === "dead") return;
    // armor soaks a flat amount (beetle); staggered foes have no armor
    let actual = dmg;
    if (e.def.armor && e.staggerT <= 0) actual = Math.max(1, dmg - e.def.armor);
    e.hp -= actual;
    e.hurt = 0.14;
    e.vx += kx;
    e.vy += ky;
    // poise / stagger: build up, then break for a stun window
    if (e.def.staggerHp && e.staggerT <= 0 && poise > 0) {
      e.staggerVal += poise;
      if (e.staggerVal >= e.def.staggerHp) {
        e.staggerVal = 0;
        e.staggerT = 1.3;
        e.windupFlag = false;
        e.state = "recover";
        e.timer = 1.3;
        this.floatText(e.x, e.y - 32, "STAGGERED", "#ffd56b", 16);
        this.audio.guardBreak();
        this.ps.emit("spark", e.x, e.y, { count: 10 });
      }
    }
    // boss interrupt resistance: only stagger windup for normal enemies
    if (
      e.state === "windup" &&
      e.def.role !== "boss_king" &&
      e.def.role !== "boss_harvester" &&
      e.def.role !== "boss_oldtom"
    ) {
      if (this.rng.chance(0.5)) {
        e.state = "recover";
        e.timer = 0.3;
        e.windupFlag = false;
      }
    }
    if (e.hp <= 0) this.killEnemy(e, byId);
  }

  killEnemy(e: Enemy, byId: string) {
    e.state = "dead";
    e.hp = 0;
    this.ps.emit("death", e.x, e.y, { count: e === this.boss ? 60 : 20 });
    this.audio.splat();
    this.addShake(6);
    const isBoss = e === this.boss;
    if (isBoss) this.onBossDeath(e);
    // award sap to killer
    if (byId === this.net.selfId) {
      this.gainSap(e.def.sap);
    } else if (this.net.mode === "host") {
      this.net.send({ t: "sap", pid: byId, amt: e.def.sap });
    }
    // chance to drop estus shard
    if (!isBoss && this.rng.chance(0.12)) {
      this.dropPickup(e.x, e.y, "estus", 1);
    }
  }

  onBossDeath(e: Enemy) {
    if (!this.bossesDead.includes(this.areaId))
      this.bossesDead.push(this.areaId);
    this.boss = null;
    this.audio.death();
    this.audio.coinShower();
    this.ps.emit("death", e.x, e.y, { count: 70, speed: 220 });
    this.ps.emit("sapglow", e.x, e.y, { count: 40 });
    this.addShake(22);
    this.flash("#ffd56b", 0.4);
    this.floatText(e.x, e.y - 40, "HARVEST DENIED", "#ffd56b", 30);
    // unlock gates
    for (const g of this.area.gates) g.locked = false;
    this.toast("GREAT FOE FELLED", e.def.name);
    // boss-specific spoils
    if (e.kind === "king") this.grantWeapon("mace");
    if (e.kind === "oldtom") {
      this.grantWeapon("rapier");
      this.grantCharm("first_fruits_pith");
    }
    if (e.kind === "harvester") this.grantCharm("hollow_seed");
    if (this.areaId === "yard" && !this.harvest) {
      // final victory (campaign only; harvest advances via onEncounterClear)
      setTimeout(() => this.setScreen("victory"), 2200);
    }
    this.save();
  }

  grantWeapon(w: WeaponKind) {
    if (this.ownedWeapons.includes(w)) return;
    this.ownedWeapons.push(w);
    this.audio.pickup();
    this.toast(WEAPONS[w].name, "claimed — press " + (["whip", "dagger", "mace", "rapier"].indexOf(w) + 1) + " to wield");
  }
  grantCharm(id: string) {
    if (this.ownedCharms.includes(id)) return;
    this.ownedCharms.push(id);
    const c = CHARMS.find((x) => x.id === id);
    this.audio.pickup();
    this.toast(c ? c.name : "Charm", "found — equip it at a Compost Heap");
  }

  // Execute a special move's effect (charge already spent by fireSpecial()).
  fireSpecialEffect(def: { kind: string; power: number; radius?: number; range?: number }) {
    const base = deriveAttack(this.stats) * this.mods.damageMul * def.power;
    if (def.kind === "nova" || def.kind === "field") {
      const r = def.radius || 150;
      for (const e of this.enemies) {
        if (e.state === "dead") continue;
        if (dist2(e.x, e.y, this.px, this.py) <= (r + e.def.radius) ** 2) {
          const n = norm(e.x - this.px, e.y - this.py);
          this.hitEnemy(e, base, n.x * 320, n.y * 320, 90, true);
        }
      }
      this.spawnParticles(this.px, this.py, 36, "#ffd56b", 260, true);
      this.ps.emit("death", this.px, this.py, { count: 30, speed: 230 });
      this.addShake(16);
      this.flash("#ffd56b", 0.32);
      this.audio.splat();
    } else if (def.kind === "dash") {
      const range = def.range || 260;
      const dx = Math.cos(this.facing), dy = Math.sin(this.facing);
      this.pvx = dx * 1300;
      this.pvy = dy * 1300;
      this.invuln = Math.max(this.invuln, 0.4);
      for (const e of this.enemies) {
        if (e.state === "dead") continue;
        const along = (e.x - this.px) * dx + (e.y - this.py) * dy;
        const perp = Math.abs(-(e.x - this.px) * dy + (e.y - this.py) * dx);
        if (along > -20 && along < range && perp < 64 + e.def.radius) {
          this.hitEnemy(e, base, dx * 240, dy * 240, 60, true);
        }
      }
      this.addShake(10);
      this.audio.swing();
    } else if (def.kind === "volley") {
      const range = 380, arc = 0.55;
      for (const e of this.enemies) {
        if (e.state === "dead") continue;
        if (dist2(e.x, e.y, this.px, this.py) > range * range) continue;
        let da = Math.abs(angleTo(this.px, this.py, e.x, e.y) - this.facing) % (Math.PI * 2);
        if (da > Math.PI) da = Math.PI * 2 - da;
        if (da < arc) this.hitEnemy(e, base * 0.7, 0, 0, 30, true);
      }
      this.spawnParticles(this.px, this.py, 22, "#9fd44e", 290, true);
      this.audio.swing();
    }
  }

  gainSap(amt: number) {
    amt = Math.round(amt * this.mods.sapMul);
    if (this.run) this.run.sapBanked += amt;
    const got = Math.round(amt * (this.charm?.sapMul || 1));
    this.sap += got;
    this.floatText(this.px, this.py - 30, "+" + got + " sap", "#e8b53a", 16);
    this.audio.sap();
  }

  dropPickup(
    x: number,
    y: number,
    kind: "estus" | "sap" | "key" | "weapon" | "charm",
    amt: number,
    wid?: WeaponKind,
    cid?: string
  ) {
    this.pickups.push({ id: this.pickupIdSeq++, x, y, kind, amt, wid, cid });
  }

  // ---------------- enemy AI ----------------
  updateEnemy(e: Enemy, dt: number) {
    if (e.hurt > 0) e.hurt -= dt;
    e.phase += dt * 3;
    if (e.staggerVal > 0) e.staggerVal = Math.max(0, e.staggerVal - dt * 7);
    if (e.state === "dead") {
      // remove after settle
      e.timer -= dt;
      return;
    }
    // poise-broken: stunned, no AI, just slide to rest
    if (e.staggerT > 0) {
      e.staggerT -= dt;
      e.vx *= 0.8;
      e.vy *= 0.8;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      this.collideWalls(e.x, e.y, e.def.radius, (x, y) => {
        e.x = x;
        e.y = y;
      });
      return;
    }
    // friction on knockback
    e.vx *= 0.86;
    e.vy *= 0.86;

    // acquire nearest player target
    const tgt = this.nearestPlayerTo(e.x, e.y);
    e.targetId = tgt.id;
    const tx = tgt.x;
    const ty = tgt.y;
    const d = dist(e.x, e.y, tx, ty);
    if (e.def.role !== "rooted") e.facing = angleTo(e.x, e.y, tx, ty);

    if (e.cd > 0) e.cd -= dt;

    switch (e.def.role) {
      case "swarm":
        this.aiSwarm(e, dt, d, tx, ty);
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

    // integrate + collide
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    this.collideWalls(e.x, e.y, e.def.radius, (x, y) => {
      e.x = x;
      e.y = y;
    });
  }

  private moveTo(e: Enemy, tx: number, ty: number, spd: number) {
    const n = norm(tx - e.x, ty - e.y);
    e.vx += n.x * spd;
    e.vy += n.y * spd;
    const m = Math.hypot(e.vx, e.vy);
    if (m > spd) {
      e.vx = (e.vx / m) * spd;
      e.vy = (e.vy / m) * spd;
    }
  }

  // Boss spacing: close to a standoff just inside attack range and hold (circle a
  // little) rather than gluing to the player; back off if shoved too close. Keeps
  // fights about reading telegraphs, not eating point-blank spam.
  private bossApproach(e: Enemy, d: number, tx: number, ty: number, speedMul = 1) {
    const standoff = Math.max(e.def.radius + 46, e.def.attackRange * 0.72);
    const spd = e.def.speed * speedMul;
    if (d > standoff + 26) {
      this.moveTo(e, tx, ty, spd);
    } else if (d < standoff - 46) {
      this.moveTo(e, e.x + (e.x - tx), e.y + (e.y - ty), spd * 0.85); // too close
    } else {
      const n = norm(tx - e.x, ty - e.y); // hold range, strafe a touch
      e.vx += -n.y * spd * 0.3;
      e.vy += n.x * spd * 0.3;
    }
  }

  // Give a little ground after an attack — a brief punish window — but never flee
  // past comfortable spacing, so the boss re-engages instead of turtling at range.
  private bossBackoff(e: Enemy, tx: number, ty: number) {
    const d = Math.hypot(tx - e.x, ty - e.y);
    const want = Math.max(e.def.radius + 70, e.def.attackRange * 0.95);
    if (d < want) this.moveTo(e, e.x + (e.x - tx), e.y + (e.y - ty), e.def.speed * 0.5);
  }

  aiSwarm(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    // erratic dart toward target
    const jitter = Math.sin(this.time * 8 + e.id) * 40;
    const n = norm(tx - e.x, ty - e.y);
    const perp = { x: -n.y, y: n.x };
    e.vx = n.x * e.def.speed + perp.x * jitter;
    e.vy = n.y * e.def.speed + perp.y * jitter;
    e.state = "chase";
  }

  aiChaser(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.vx *= 0.7;
      e.vy *= 0.7;
      if (e.timer <= 0) {
        e.state = "active";
        e.timer = 0.18;
        e.atkId++;
        e.windupFlag = false;
        e.attackProg = 1;
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      e.attackProg = clamp(e.timer / 0.18, 0, 1);
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.state = "chase";
      return;
    }
    // chase
    if (d > e.def.attackRange) {
      this.moveTo(e, tx, ty, e.def.speed);
      e.state = "chase";
    } else if (e.cd <= 0) {
      e.state = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  aiFlyer(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    // hover at mid distance, periodically dive
    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      if (e.timer <= 0) {
        e.state = "active";
        e.timer = 0.5;
        e.atkId++;
        e.windupFlag = false;
        const n = norm(tx - e.x, ty - e.y);
        e.vx = n.x * 460;
        e.vy = n.y * 460;
        e.attackProg = 1;
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      e.attackProg = clamp(e.timer / 0.5, 0, 1);
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      // retreat upward-ish
      this.moveTo(e, e.x + (e.x - tx), e.y + (e.y - ty) - 60, e.def.speed);
      if (e.timer <= 0) e.state = "chase";
      return;
    }
    const ideal = 180;
    if (d > ideal + 40) this.moveTo(e, tx, ty, e.def.speed);
    else if (d < ideal - 40) this.moveTo(e, e.x - (tx - e.x), e.y - (ty - e.y), e.def.speed);
    else {
      // strafe
      const n = norm(tx - e.x, ty - e.y);
      e.vx = -n.y * e.def.speed * 0.6;
      e.vy = n.x * e.def.speed * 0.6;
    }
    if (e.cd <= 0 && d < e.def.attackRange) {
      e.state = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  aiRanged(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.vx *= 0.8;
      e.vy *= 0.8;
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = e.def.attackCooldown;
        e.windupFlag = false;
        this.fireProjectile(e, tx, ty, 260, e.def.attackDmg, "#9fd44e", e.def.poison);
        e.atkId++;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.state = "chase";
    }
    const ideal = 240;
    if (d > ideal + 50) this.moveTo(e, tx, ty, e.def.speed);
    else if (d < ideal - 30)
      this.moveTo(e, e.x - (tx - e.x), e.y - (ty - e.y), e.def.speed);
    if (e.cd <= 0 && e.state === "chase") {
      e.state = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  aiRooted(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    e.facing = angleTo(e.x, e.y, tx, ty);
    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.attackProg = 1 - e.timer / e.def.windup;
      if (e.timer <= 0) {
        e.state = "active";
        e.timer = 0.22;
        e.atkId++;
        e.windupFlag = false;
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      e.attackProg = clamp(e.timer / 0.22 + 0.3, 0, 1);
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      e.attackProg = 0;
      if (e.timer <= 0) e.state = "idle";
      return;
    }
    if (d < e.def.attackRange && e.cd <= 0) {
      e.state = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  aiShielded(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.vx *= 0.6;
      e.vy *= 0.6;
      if (e.timer <= 0) {
        e.state = "active";
        e.timer = 0.24;
        e.atkId++;
        e.windupFlag = false;
        e.attackProg = 1;
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      e.attackProg = clamp(e.timer / 0.24, 0, 1);
      // lunge forward on swing
      const n = norm(tx - e.x, ty - e.y);
      e.vx = n.x * 160;
      e.vy = n.y * 160;
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = e.def.attackCooldown;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      if (e.timer <= 0) e.state = "chase";
      return;
    }
    if (d > e.def.attackRange) this.moveTo(e, tx, ty, e.def.speed);
    else if (e.cd <= 0) {
      e.state = "windup";
      e.timer = e.def.windup;
      e.cd = e.def.attackCooldown + e.def.windup;
    }
  }

  // ---- BOSS: Scarecrow King ----
  aiKing(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    if (this.bossIntro > 0) {
      e.state = "idle";
      return;
    }
    if (!e.bossPhase2 && e.hp < e.maxHp * 0.5) {
      e.bossPhase2 = true;
      this.toast("THE HUSK SPLITS", "the King flails with abandon");
      this.audio.bossPhase();
      this.addShake(18);
    }
    const aggr = e.bossPhase2 ? 1.4 : 1;

    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.vx *= 0.8;
      e.vy *= 0.8;
      e.attackProg = 1 - e.timer / e.def.windup;
      if (e.timer <= 0) {
        e.windupFlag = false;
        this.kingExecute(e, tx, ty);
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      e.attackProg = Math.max(0, e.attackProg - dt * 2);
      if (e.bossMove === 1) {
        // lunge
        const n = norm(Math.cos(e.facing), Math.sin(e.facing));
        e.vx = n.x * 520;
        e.vy = n.y * 520;
      } else if (e.bossMove === 3) {
        // spin: keep facing rotating
        e.facing += dt * 10;
      }
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = 1.3 / aggr;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      this.bossBackoff(e, tx, ty); // give ground — opens a punish window
      if (e.timer <= 0) e.state = "chase";
      return;
    }
    // chase / choose attack
    if (e.cd <= 0) {
      const r = this.rng.next();
      if (d < 120) {
        // close: sweep, spin (p2), or a 360 straw burst that punishes hugging
        e.bossMove = e.bossPhase2 && r < 0.3 ? 3 : r < 0.55 ? 5 : 0;
      } else if (d < 360) {
        e.bossMove = r < 0.42 ? 4 : 1; // crow volley or lunge
      } else {
        e.bossMove = r < 0.5 ? 4 : 2; // crow volley or summon the swarm
      }
      e.state = "windup";
      e.timer = e.def.windup / aggr;
      e.cd = (e.def.attackCooldown + e.def.windup) / aggr;
    } else {
      this.bossApproach(e, d, tx, ty, e.bossPhase2 ? 1.2 : 1);
    }
  }

  kingExecute(e: Enemy, tx: number, ty: number) {
    e.state = "active";
    e.atkId++;
    e.attackProg = 1;
    if (e.bossMove === 0) {
      e.timer = 0.3; // sweep
      this.shake = 8;
    } else if (e.bossMove === 1) {
      e.timer = 0.4; // lunge
      this.audio.swing();
    } else if (e.bossMove === 2) {
      // summon adds
      e.timer = 0.3;
      const n = e.bossPhase2 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        this.spawnEnemy(
          this.rng.chance(0.5) ? "aphid" : "crow",
          e.x + Math.cos(a) * 80,
          e.y + Math.sin(a) * 80
        );
      }
      this.toast("STRAW STIRS", "the King calls the swarm");
    } else if (e.bossMove === 3) {
      e.timer = 1.2; // spin
      this.shake = 6;
    } else if (e.bossMove === 4) {
      // crow volley — an aimed five-shot spread (strafe to dodge)
      e.timer = 0.3;
      this.audio.swing();
      const base = angleTo(e.x, e.y, tx, ty);
      for (let i = -2; i <= 2; i++) {
        const a = base + i * 0.2;
        this.spawnProjectileVel(e.x, e.y, Math.cos(a) * 320, Math.sin(a) * 320, 9, e.def.attackDmg * 0.6, "#2e2114");
      }
    } else if (e.bossMove === 5) {
      // straw burst — a radial ring that punishes hugging (roll through a gap)
      e.timer = 0.35;
      this.addShake(10);
      this.audio.bossRoar();
      const n = e.bossPhase2 ? 16 : 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        this.spawnProjectileVel(e.x, e.y, Math.cos(a) * 240, Math.sin(a) * 240, 9, e.def.attackDmg * 0.6, "#e8c07a");
      }
    }
  }

  // ---- BOSS: Harvester ----
  aiHarvester(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    if (this.bossIntro > 0) {
      e.state = "idle";
      return;
    }
    if (!e.bossPhase2 && e.hp < e.maxHp * 0.45) {
      e.bossPhase2 = true;
      this.toast("OVERDRIVE", "the blades scream faster");
      this.audio.bossPhase();
      this.addShake(22);
    }
    const aggr = e.bossPhase2 ? 1.5 : 1;

    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.attackProg = 1 - e.timer / (e.def.windup / aggr);
      // slow turn toward target during windup (so charge can be dodged)
      e.facing = angleTo(e.x, e.y, tx, ty);
      if (e.timer <= 0) {
        e.windupFlag = false;
        this.harvesterExecute(e, tx, ty);
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      if (e.bossMove === 0) {
        // charge across arena along locked facing
        e.vx = Math.cos(e.facing) * 600 * aggr;
        e.vy = Math.sin(e.facing) * 600 * aggr;
      } else if (e.bossMove === 2) {
        // spin sweep
        e.facing += dt * 8;
      }
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = 1.2 / aggr;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      this.bossBackoff(e, tx, ty);
      if (e.timer <= 0) e.state = "chase";
      return;
    }
    if (e.cd <= 0) {
      const r = this.rng.next();
      if (d > 280) e.bossMove = r < 0.6 ? 0 : 4; // charge or blade fan
      else if (r < 0.28) e.bossMove = 1; // radial pesticide volley
      else if (r < 0.46) e.bossMove = 2; // spin
      else if (r < 0.64) e.bossMove = 3; // slam shockwave
      else if (r < 0.82) e.bossMove = 4; // blade fan (aimed cone)
      else e.bossMove = 5; // mortar burst (aimed heavy shots)
      e.state = "windup";
      e.timer = e.def.windup / aggr;
      e.cd = (e.def.attackCooldown + e.def.windup) / aggr;
    } else {
      this.bossApproach(e, d, tx, ty);
    }
  }

  harvesterExecute(e: Enemy, tx: number, ty: number) {
    e.state = "active";
    e.atkId++;
    e.attackProg = 1;
    if (e.bossMove === 0) {
      e.timer = 0.6;
      this.audio.bossRoar();
      this.shake = 10;
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
          "#9fd44e"
        );
      }
      this.audio.swing();
    } else if (e.bossMove === 2) {
      e.timer = 1.0;
      this.shake = 6;
    } else if (e.bossMove === 4) {
      // blade fan — an aimed forward cone of fast blades (dodge sideways)
      e.timer = 0.3;
      this.audio.swing();
      const base = angleTo(e.x, e.y, tx, ty);
      const n = e.bossPhase2 ? 9 : 7;
      for (let i = 0; i < n; i++) {
        const a = base + (i - (n - 1) / 2) * 0.14;
        this.spawnProjectileVel(e.x, e.y, Math.cos(a) * 360, Math.sin(a) * 360, 9, e.def.attackDmg * 0.55, "#cfe2ee");
      }
    } else if (e.bossMove === 5) {
      // mortar burst — three slow heavy shots (big, telegraphed)
      e.timer = 0.35;
      this.addShake(8);
      this.audio.splat();
      const base = angleTo(e.x, e.y, tx, ty);
      for (let i = -1; i <= 1; i++) {
        const a = base + i * 0.16;
        this.spawnProjectileVel(e.x, e.y, Math.cos(a) * 210, Math.sin(a) * 210, 16, e.def.attackDmg * 0.85, "#ff7a3a");
      }
    } else {
      // slam shockwave (ring of projectiles outward, close)
      e.timer = 0.3;
      this.shake = 16;
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
          "#ff7a3a"
        );
      }
      this.audio.splat();
    }
  }

  // ---- BOSS: Old Tom, the First Fruit (rapier mirror) ----
  aiOldTom(e: Enemy, dt: number, d: number, tx: number, ty: number) {
    if (this.bossIntro > 0) {
      e.state = "idle";
      return;
    }
    if (!e.bossPhase2 && e.hp < e.maxHp * 0.45) {
      e.bossPhase2 = true;
      this.toast("THE FIRST FRUIT REMEMBERS", "his old ferocity returns");
      this.audio.bossPhase();
      this.addShake(18);
      this.ps.emit("sapglow", e.x, e.y, { count: 30 });
    }
    const aggr = e.bossPhase2 ? 1.4 : 1;

    if (e.state === "windup") {
      e.timer -= dt;
      e.windupFlag = true;
      e.vx *= 0.8;
      e.vy *= 0.8;
      e.attackProg = 1 - e.timer / (e.def.windup / aggr);
      e.facing = angleTo(e.x, e.y, tx, ty);
      if (e.timer <= 0) {
        e.windupFlag = false;
        this.oldTomExecute(e, tx, ty);
      }
      return;
    }
    if (e.state === "active") {
      e.timer -= dt;
      e.attackProg = Math.max(0, e.attackProg - dt * 2);
      if (e.bossMove === 1) {
        e.vx = Math.cos(e.facing) * 560 * aggr;
        e.vy = Math.sin(e.facing) * 560 * aggr;
      } else {
        e.vx *= 0.7;
        e.vy *= 0.7;
      }
      if (e.timer <= 0) {
        e.state = "recover";
        e.timer = 1.0 / aggr;
      }
      return;
    }
    if (e.state === "recover") {
      e.timer -= dt;
      this.bossBackoff(e, tx, ty); // give ground — opens a punish window
      if (e.timer <= 0) e.state = "chase";
      return;
    }
    // choose attack
    if (e.cd <= 0) {
      const r = this.rng.next();
      if (e.bossPhase2 && r < 0.25) e.bossMove = 3; // grief nova
      else if (d < 140) e.bossMove = r < 0.5 ? 0 : 5; // thrust or sap burst
      else e.bossMove = r < 0.45 ? 4 : 1; // sap spread or lunge
      e.state = "windup";
      e.timer = e.def.windup / aggr;
      e.cd = (e.def.attackCooldown + e.def.windup) / aggr;
    } else {
      this.bossApproach(e, d, tx, ty, e.bossPhase2 ? 1.2 : 1);
    }
  }

  oldTomExecute(e: Enemy, tx: number, ty: number) {
    e.state = "active";
    e.atkId++;
    e.attackProg = 1;
    if (e.bossMove === 0) {
      e.timer = 0.3; // crisp thrust
      this.audio.swing();
    } else if (e.bossMove === 1) {
      e.timer = 0.4; // lunge
      this.audio.swing();
      this.addShake(6);
    } else if (e.bossMove === 3) {
      // grief nova — radial sap shards (projectile damage, not the melee box)
      e.timer = 0.3;
      this.addShake(14);
      this.audio.bossRoar();
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
          "#ffd56b"
        );
      }
    } else if (e.bossMove === 4) {
      // sap spread — aimed five-shard fan (strafe to dodge)
      e.timer = 0.3;
      this.audio.swing();
      const base = angleTo(e.x, e.y, tx, ty);
      for (let i = -2; i <= 2; i++) {
        const a = base + i * 0.16;
        this.spawnProjectileVel(e.x, e.y, Math.cos(a) * 300, Math.sin(a) * 300, 9, e.def.attackDmg * 0.6, "#ffd56b");
      }
    } else if (e.bossMove === 5) {
      // sap burst — a quick tight triple at close range
      e.timer = 0.3;
      this.addShake(8);
      this.audio.bossRoar();
      const base = angleTo(e.x, e.y, tx, ty);
      for (let i = -1; i <= 1; i++) {
        const a = base + i * 0.5;
        this.spawnProjectileVel(e.x, e.y, Math.cos(a) * 260, Math.sin(a) * 260, 10, e.def.attackDmg * 0.7, "#ffe08a");
      }
    }
  }

  fireProjectile(
    e: Enemy,
    tx: number,
    ty: number,
    spd: number,
    dmg: number,
    color: string,
    poison?: number
  ) {
    const n = norm(tx - e.x, ty - e.y);
    this.spawnProjectileVel(e.x, e.y, n.x * spd, n.y * spd, 8, dmg, color, poison);
    this.ps.emit("muzzle", e.x, e.y, { angle: Math.atan2(ty - e.y, tx - e.x), color });
  }
  spawnProjectileVel(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r: number,
    dmg: number,
    color: string,
    poison?: number
  ) {
    this.projectiles.push({
      id: this.projIdSeq++,
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
    });
  }

  updateProjectiles(dt: number) {
    for (const p of this.projectiles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.ttl -= dt;
      // wall collision
      for (const w of this.area.walls) {
        if (
          p.x > w.x &&
          p.x < w.x + w.w &&
          p.y > w.y &&
          p.y < w.y + w.h
        ) {
          p.ttl = 0;
          this.spawnParticles(p.x, p.y, 4, p.color, 50);
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.ttl > 0);
  }

  // ---------------- enemy attacks vs MY player ----------------
  updateCombatVsPlayer(dt: number) {
    if (this.pstate === "dead") return;

    for (const e of this.enemies) {
      if (e.state === "dead") continue;
      // contact damage
      if (e.def.contactDmg > 0) {
        if (
          dist2(e.x, e.y, this.px, this.py) <
          (e.def.radius + 13) * (e.def.radius + 13)
        ) {
          this.tryDamagePlayer(e.def.contactDmg, e.x, e.y, e.def.knockback || 60, -1, e.id);
        }
      }
      // active attack hitbox
      if (e.state === "active" && e.def.attackDmg > 0) {
        const already = this.enemyHitAtk.get(e.id) === e.atkId;
        if (!already) {
          let hit = false;
          if (e.def.role === "boss_king" && e.bossMove === 3) {
            // spin: radial
            hit = dist(e.x, e.y, this.px, this.py) < e.def.attackRange;
          } else if (e.def.role === "boss_harvester" && e.bossMove === 2) {
            hit = dist(e.x, e.y, this.px, this.py) < e.def.attackRange;
          } else if (e.def.role === "boss_harvester" && e.bossMove === 0) {
            hit = dist(e.x, e.y, this.px, this.py) < e.def.radius * e.big + 18;
          } else if (e.def.role === "boss_oldtom" && e.bossMove === 3) {
            hit = false; // nova damage comes from its projectiles, not the blade
          } else if (e.bossMove === 4 || e.bossMove === 5) {
            hit = false; // new ranged moves deal damage via their projectiles
          } else {
            hit = inArc(
              this.px,
              this.py,
              e.x,
              e.y,
              e.facing,
              0.9,
              e.def.attackRange + 8
            );
          }
          if (hit) {
            this.enemyHitAtk.set(e.id, e.atkId);
            this.tryDamagePlayer(
              e.def.attackDmg,
              e.x,
              e.y,
              e.def.knockback || 100,
              e.atkId,
              e.id
            );
          }
        }
      }
    }

    // projectiles vs me
    for (const p of this.projectiles) {
      if (!p.hostile) continue;
      if (dist2(p.x, p.y, this.px, this.py) < (p.r + 13) * (p.r + 13)) {
        p.ttl = 0;
        const exposed = this.invuln <= 0 && this.pstate !== "roll";
        this.tryDamagePlayer(p.dmg, p.x, p.y, 80, -1, -2);
        if (p.poison && exposed) this.applyPoison(p.poison);
        this.ps.emit("spark", p.x, p.y, { count: 6, color: p.color });
      }
    }
  }

  applyPoison(amt: number) {
    this.poison = Math.min(this.poison + amt, 48);
    this.audio.poison();
    this.floatText(this.px, this.py - 40, "POISONED", "#9fd44e", 13);
  }

  tryDamagePlayer(
    dmg: number,
    sx: number,
    sy: number,
    kb: number,
    atkId: number,
    enemyId: number
  ) {
    // i-frames come from the roll's invuln window only — the recovery tail is vulnerable
    if (this.invuln > 0) return;
    if (this.hurtCd > 0 && atkId < 0) return; // contact respects cd
    let final = dmg;
    // facing the threat?
    const facingThreat =
      Math.abs(
        ((angleTo(this.px, this.py, sx, sy) - this.facing + Math.PI) %
          (Math.PI * 2)) -
          Math.PI
      ) < 1.1;

    if (this.blocking && facingThreat) {
      // PARRY — guard raised within the parry window negates the blow and
      // staggers the attacker, opening a riposte
      if (this.parryWindow > 0) {
        const e = enemyId >= 0 ? this.enemies.find((x) => x.id === enemyId) : null;
        if (e && e.def.role !== "boss_harvester") {
          e.staggerT = e.def.staggerHp ? 1.4 : 1.0;
          e.state = "recover";
          e.timer = e.staggerT;
          e.windupFlag = false;
          e.staggerVal = 0;
        }
        this.riposteReady = 1.6;
        this.parryFlash = 0.3;
        this.audio.parryFlash();
        this.ps.emit("spark", this.px, this.py, { count: 16 });
        this.flash("#cfe6a0", 0.22);
        this.addShake(4);
        this.floatText(this.px, this.py - 30, "PARRY!", "#cfe6a0", 16);
        return;
      }
      // ordinary BLOCK — soak most of it, spend stamina
      final = Math.round(dmg * 0.25);
      this.stamina -= dmg * 1.4;
      this.audio.parry();
      this.ps.emit("spark", this.px, this.py, { count: 8, color: "#cfe6a0" });
      if (this.stamina <= 0) {
        this.stamina = 0;
        this.exhausted = true;
        this.blocking = false;
        this.audio.guardBreak();
        this.floatText(this.px, this.py - 30, "GUARD BROKEN", "#ff5742", 16);
        this.addShake(10);
        // falls through and takes the (reduced) hit
      } else {
        this.floatText(this.px, this.py - 26, "block", "#cfe6a0", 13);
        this.hurtCd = 0.3;
        return;
      }
    }

    // charm-modified incoming damage
    final = Math.max(1, Math.round(final * (this.charm?.defenseMul || 1)));

    this.hp -= final;
    this.hurtCd = 0.5;
    this.invuln = 0.35;
    const n = norm(this.px - sx, this.py - sy);
    this.pvx += n.x * kb;
    this.pvy += n.y * kb;
    this.px += n.x * kb * 0.04;
    this.py += n.y * kb * 0.04;
    this.floatText(this.px, this.py - 30, String(final), "#ff5742", 16);
    this.ps.emit("blood", this.px, this.py, { count: 9 });
    this.audio.enemyHurt();
    this.addShake(8);
    this.hitstop = Math.max(this.hitstop, 0.04);
    this.flash("#7a1414", Math.min(0.32, final / 60));
    if (this.pstate === "heal") this.pstate = "idle"; // interrupt heal

    if (this.hp <= 0) this.die();
  }

  die() {
    this.hp = 0;
    this.pstate = "dead";
    this.poison = 0;
    this.blocking = false;
    this.audio.death();
    this.ps.emit("death", this.px, this.py, { count: 44 });
    this.addShake(20);
    this.flash("#7a1414", 0.5);
    // drop husk (sap)
    if (this.sap > 0) {
      // a fresh husk replaces any older bloodstain in this area (souls tradition)
      this.husks = this.husks.filter((h) => h.area !== this.areaId);
      this.husks.push({ x: this.px, y: this.py, sap: this.sap, area: this.areaId });
      this.sap = 0;
    }
    this.lockTarget = null;
    this.respawnTimer = 1.6;
    this.setScreen("dead");
    if (this.net.mode !== "client") this.save();
  }

  respawn() {
    this.poison = 0;
    this.audio.warp();
    if (this.harvest) {
      if (this.net.mode === "solo") { this.harvestRestart(); return; } // solo: permadeath
      // co-op: forgiving — revive in place, the shared run continues
      this.hp = this.maxHp;
      this.stamina = this.maxStamina;
      this.estus = this.estusMax;
      this.pstate = "idle";
      this.px = this.area.spawnPoint.x;
      this.py = this.area.spawnPoint.y;
      this.setScreen("play");
      return;
    }
    if (this.net.mode === "client") {
      // co-op phantom: revive at current host area spawn
      this.hp = this.maxHp;
      this.stamina = this.maxStamina;
      this.px = this.area.spawnPoint.x;
      this.py = this.area.spawnPoint.y;
      this.pstate = "idle";
      this.setScreen("play");
      return;
    }
    // solo/host: reload to bonfire area, refill, respawn enemies
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    this.pstate = "idle";
    this.setScreen("play");
    const target = this.bonfireArea;
    this.loadArea(target, true);
  }

  // ---------------- pickups / husks ----------------
  updatePickups(dt: number) {
    // husks
    for (const h of this.husks) {
      if (h.area !== this.areaId) continue;
      if (dist2(h.x, h.y, this.px, this.py) < 28 * 28) {
        this.sap += h.sap;
        this.floatText(this.px, this.py - 30, "+" + h.sap + " sap reclaimed", "#ffd56b", 16);
        this.audio.coinShower();
        this.ps.emit("sapglow", this.px, this.py, { count: 18 });
        h.sap = 0;
      }
    }
    this.husks = this.husks.filter((h) => h.sap > 0);

    for (const p of this.pickups) {
      if (dist2(p.x, p.y, this.px, this.py) < 26 * 26) {
        if (p.kind === "estus") {
          this.estusMax += p.amt;
          this.estus += p.amt;
          this.toast("WATERING CAN MENDED", "+1 heal charge");
        } else if (p.kind === "sap") {
          this.gainSap(p.amt);
        } else if (p.kind === "weapon" && p.wid) {
          this.grantWeapon(p.wid);
        } else if (p.kind === "charm" && p.cid) {
          this.grantCharm(p.cid);
        }
        this.audio.pickup();
        this.ps.emit("sapglow", p.x, p.y, { count: 10 });
        (p as any)._dead = true;
      }
    }
    this.pickups = this.pickups.filter((p) => !(p as any)._dead);
  }

  // ---------------- bonfire / interact ----------------
  tryInteract() {
    if (this.area.compost) {
      const c = this.area.compost;
      if (dist2(c.x, c.y, this.px, this.py) < 60 * 60) {
        this.restAtCompost();
        return;
      }
    }
  }

  restAtCompost() {
    this.bonfireArea = this.areaId;
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    this.poison = 0;
    this.audio.bonfire();
    this.spawnParticles(
      this.area.compost!.x,
      this.area.compost!.y,
      24,
      "#ffb347",
      120,
      true
    );
    // respawn fodder enemies (souls tradition) — host/solo
    if (this.net.mode !== "client") {
      const bossDefeated = this.area.boss && this.bossesDead.includes(this.areaId);
      this.enemies = this.boss ? this.enemies.filter((e) => e === this.boss) : [];
      if (!this.area.boss) {
        this.enemies = [];
        for (const sp of this.area.spawns) this.spawnEnemy(sp.kind, sp.x, sp.y);
      }
    }
    this.bonfireSel = 0;
    this.setScreen("bonfire");
    this.save();
    this.toast("RESTED AT THE COMPOST HEAP", "the rot remembers you");
  }

  updateBonfireMenu() {
    const opts = 5; // 4 stats + leave
    if (this.input.pressed("ArrowDown") || this.input.pressed("KeyS")) {
      this.bonfireSel = (this.bonfireSel + 1) % opts;
      this.audio.uiMove();
    }
    if (this.input.pressed("ArrowUp") || this.input.pressed("KeyW")) {
      this.bonfireSel = (this.bonfireSel + opts - 1) % opts;
      this.audio.uiMove();
    }
    const confirm =
      this.input.pressed("Enter") ||
      this.input.pressed("Space") ||
      this.input.lmbPressed;
    if (confirm) {
      if (this.bonfireSel === 4) {
        this.audio.uiSelect();
        this.setScreen("play");
        return;
      }
      const cost = levelCost(this.stats);
      if (this.sap >= cost) {
        this.sap -= cost;
        const keys: (keyof PlayerStats)[] = [
          "vigor",
          "strength",
          "vitality",
          "agility",
        ];
        this.stats[keys[this.bonfireSel]]++;
        this.recompute();
        this.hp = this.maxHp;
        this.stamina = this.maxStamina;
        this.audio.levelUp();
        this.spawnParticles(this.px, this.py, 20, "#ffd56b", 120, true);
        this.save();
      } else {
        this.audio.uiMove();
        this.toast("NOT ENOUGH SAP", "the rot demands more");
      }
    }
    // cycle the equipped charm with ←/→ (only when you own some)
    if (this.ownedCharms.length > 0) {
      const owned = this.ownedCharms
        .map((id) => CHARMS.find((c) => c.id === id))
        .filter((c): c is CharmDef => !!c);
      const list: (CharmDef | null)[] = [null, ...owned];
      const cycle = (dir: number) => {
        let idx = list.findIndex(
          (c) => (c?.id || null) === (this.charm?.id || null)
        );
        idx = (idx + dir + list.length) % list.length;
        this.charm = list[idx];
        this.audio.uiMove();
      };
      if (this.input.pressed("ArrowRight") || this.input.pressed("KeyD")) cycle(1);
      if (this.input.pressed("ArrowLeft") || this.input.pressed("KeyA")) cycle(-1);
    }

    if (this.input.pressed("KeyE") || this.input.pressed("Escape")) {
      this.setScreen("play");
    }
  }

  // ============================ HARVEST RUN (roguelite) ============================
  startHarvestRun(drive = true) {
    this.harvest = true;
    this.run = newRun(Math.floor(Math.random() * 1e9));
    // fresh build — power comes from boons this run, not persistent levels
    this.stats = { ...BASE_STATS };
    this.ownedWeapons = [STARTING_WEAPON];
    this.weapon = STARTING_WEAPON;
    this.charm = null;
    this.ownedCharms = [];
    this.sap = 0;
    this.husks = [];
    this.bossesDead = [];
    this._baseEstus = 4;
    this.estusMax = this._baseEstus;
    this.recompute();
    this.hp = this.maxHp;
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    if (drive) this.enterRoom(); // host/solo drive; a co-op client follows host area sync
  }

  enterRoom() {
    if (!this.run) return;
    const act = ACTS[this.run.act];
    const atBoss = this.run.room >= act.rooms;
    const areaId = atBoss ? act.bossArea : act.biomes[this.run.room % act.biomes.length];
    this.roomActive = true;
    this.loadArea(areaId, true);
    // breathing room — no foe spawns on top of the entry point (keep the boss)
    this.enemies = this.enemies.filter(
      (e) => e === this.boss || dist2(e.x, e.y, this.px, this.py) > 210 * 210
    );
    const label = atBoss
      ? `Act ${this.run.act + 1} — ${act.bossName}`
      : `Act ${this.run.act + 1} · Room ${this.run.room + 1} of ${act.rooms}`;
    this.toast(atBoss ? "THE FOE AWAITS" : "HARVEST RUN", label);
  }

  onEncounterClear() {
    if (!this.run) return;
    this.roomActive = false;
    const act = ACTS[this.run.act];
    const wasBoss = this.run.room >= act.rooms;
    this.run.cleared++;
    this.run.sapBanked = this.sap;
    if (wasBoss) {
      this.run.act++;
      this.run.room = 0;
      if (this.run.act >= ACTS.length) { this.harvestVictory(); return; }
    } else {
      this.run.room++;
    }
    // co-op: have clients draft too, and don't advance until everyone has picked
    if (this.net.mode === "host") {
      this.hostPicked = false;
      this.coopDraftWait = Math.max(0, this.net.getRoster().length - 1);
      this.net.send({ t: "draft" });
    }
    this.openBoonDraft();
  }

  openBoonDraft() {
    if (!this.run) return;
    this.boonChoices = rollBoonChoices(this.run, () => Math.random(), 3, this.WIRED);
    this.boonSel = 0;
    if (this.boonChoices.length === 0) { this.proceedAfterBoon(); return; }
    this.audio.uiSelect();
    this.setScreen("boon");
  }

  updateBoonDraft() {
    const n = this.boonChoices.length;
    if (n === 0) { this.proceedAfterBoon(); return; }
    if (this.input.pressed("ArrowRight") || this.input.pressed("KeyD")) { this.boonSel = (this.boonSel + 1) % n; this.audio.uiMove(); }
    if (this.input.pressed("ArrowLeft") || this.input.pressed("KeyA")) { this.boonSel = (this.boonSel + n - 1) % n; this.audio.uiMove(); }
    for (let i = 0; i < n; i++) if (this.input.pressed("Digit" + (i + 1))) this.boonSel = i;
    if (this.input.pressed("Enter") || this.input.pressed("Space") || this.input.lmbPressed) this.pickBoon(this.boonSel);
  }

  pickBoon(i: number) {
    if (!this.run || !this.boonChoices[i]) return;
    takeBoon(this.run, this.boonChoices[i].id);
    this.recompute();
    this.estusMax = this._baseEstus + this.mods.estusBonus;
    this.hp = Math.min(this.maxHp, this.hp + 20); // a little reward heal
    this.stamina = this.maxStamina;
    this.estus = this.estusMax;
    this.audio.levelUp();
    this.spawnParticles(this.px, this.py, 18, "#ffd56b", 120, true);
    this.boonChoices = [];
    if (this.net.mode === "client") {
      // client doesn't drive progression — confirm and wait for the host's next room
      this.setScreen("play");
      this.net.send({ t: "draftdone", id: this.net.selfId });
      return;
    }
    if (this.net.mode === "host" && this.coopDraftWait > 0) {
      // host waits in the cleared room until every client has drafted
      this.hostPicked = true;
      this.setScreen("play");
      return;
    }
    this.proceedAfterBoon();
  }

  proceedAfterBoon() {
    this.setScreen("play");
    this.enterRoom();
  }

  harvestVictory() {
    this.bankMeta(this.sap, this.run ? this.run.act : 0, true);
    this.setScreen("victory");
  }

  harvestRestart() {
    this.bankMeta(this.sap, this.run ? this.run.act : 0, false);
    this.startHarvestRun();
    this.setScreen("play");
  }

  bankMeta(seeds: number, actReached: number, won: boolean) {
    try {
      const m = Game.loadMeta();
      m.seeds += Math.max(0, Math.round(seeds));
      m.runs += 1;
      if (won) m.wins += 1;
      m.bestAct = Math.max(m.bestAct, actReached);
      localStorage.setItem("tt_harvest_meta", JSON.stringify(m));
    } catch {
      /* ignore storage errors */
    }
  }
  static loadMeta(): { seeds: number; runs: number; wins: number; bestAct: number } {
    try {
      const raw = localStorage.getItem("tt_harvest_meta");
      if (raw) {
        const m = JSON.parse(raw);
        return { seeds: m.seeds || 0, runs: m.runs || 0, wins: m.wins || 0, bestAct: m.bestAct || 0 };
      }
    } catch {
      /* ignore */
    }
    return { seeds: 0, runs: 0, wins: 0, bestAct: 0 };
  }

  drawBoonDraft(ctx: CanvasRenderingContext2D) {
    const W = this.cssW, H = this.cssH;
    ctx.save();
    ctx.fillStyle = "rgba(10,6,4,0.84)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd56b";
    ctx.font = "700 28px ui-sans-serif, system-ui";
    ctx.fillText("CHOOSE A BOON", W / 2, H * 0.18);
    ctx.fillStyle = "#c9b89a";
    ctx.font = "500 14px ui-sans-serif, system-ui";
    ctx.fillText("← →  or  1–3   ·   Enter / click to take", W / 2, H * 0.18 + 26);

    const n = this.boonChoices.length;
    const cardW = Math.min(240, (W - 80) / Math.max(1, n) - 16);
    const cardH = 175, gap = 18;
    const totalW = n * cardW + (n - 1) * gap;
    let x = W / 2 - totalW / 2;
    const y = H / 2 - cardH / 2 + 10;
    const rarityColor: Record<string, string> = { common: "#9fd44e", uncommon: "#4ea6ff", rare: "#c77dff" };

    for (let i = 0; i < n; i++) {
      const b = this.boonChoices[i];
      const sel = i === this.boonSel;
      const col = rarityColor[b.rarity] || "#888";
      ctx.fillStyle = sel ? "#2c1c10" : "#170f09";
      ctx.fillRect(x, y, cardW, cardH);
      ctx.lineWidth = sel ? 3 : 2;
      ctx.strokeStyle = sel ? "#ffd56b" : col;
      ctx.strokeRect(x, y, cardW, cardH);
      ctx.fillStyle = col;
      ctx.font = "700 11px ui-sans-serif, system-ui";
      ctx.fillText(b.rarity.toUpperCase(), x + cardW / 2, y + 28);
      ctx.fillStyle = "#fff";
      ctx.font = "700 19px ui-sans-serif, system-ui";
      ctx.fillText(b.name, x + cardW / 2, y + 62);
      ctx.fillStyle = "#d9c9ab";
      ctx.font = "500 13px ui-sans-serif, system-ui";
      ctx.fillText(b.desc, x + cardW / 2, y + 96);
      ctx.fillStyle = sel ? "#ffd56b" : "#8a7a5a";
      ctx.font = "700 13px ui-sans-serif, system-ui";
      ctx.fillText(String(i + 1), x + cardW / 2, y + cardH - 16);
      x += cardW + gap;
    }
    ctx.restore();
  }

  drawRunHud(ctx: CanvasRenderingContext2D) {
    if (!this.run) return;
    const act = ACTS[this.run.act];
    if (!act) return;
    ctx.save();
    ctx.textAlign = "center";
    const atBoss = this.run.room >= act.rooms;
    ctx.fillStyle = "#ffd56b";
    ctx.font = "700 13px ui-sans-serif, system-ui";
    const label = atBoss
      ? `ACT ${this.run.act + 1} · BOSS`
      : `ACT ${this.run.act + 1} · ROOM ${this.run.room + 1}/${act.rooms}`;
    ctx.fillText(label, this.cssW / 2, 22);

    const pct = specialChargePct(this.run);
    const bw = 160, bh = 8, bx = this.cssW / 2 - bw / 2, by = 30;
    ctx.fillStyle = "rgba(0,0,0,0.5)"; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = pct >= 1 ? "#ffd56b" : "#c77dff"; ctx.fillRect(bx, by, bw * pct, bh);
    ctx.strokeStyle = "rgba(255,255,255,0.3)"; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, bh);
    if (pct >= 1) {
      ctx.fillStyle = "#ffd56b"; ctx.font = "700 10px ui-sans-serif, system-ui";
      ctx.fillText("SPECIAL READY (C)", this.cssW / 2, by + bh + 13);
    }
    if (this.run.items.length) {
      ctx.fillStyle = "#9fd44e"; ctx.font = "600 11px ui-sans-serif, system-ui"; ctx.textAlign = "right";
      ctx.fillText("Items " + this.run.items.length + " (X)", this.cssW - 16, 22);
    }
    ctx.restore();
  }

  // ---------------- gates / transitions ----------------
  handleGates() {
    if (this.net.mode === "client") return; // host drives transitions
    if (this.harvest) return; // a run advances by clearing rooms, not by gates
    for (const g of this.area.gates) {
      if (g.locked) continue;
      const r = g.rect;
      if (
        this.px > r.x - 10 &&
        this.px < r.x + r.w + 10 &&
        this.py > r.y - 10 &&
        this.py < r.y + r.h + 10
      ) {
        this.areaId = g.to;
        this.save();
        this.loadArea(g.to, false, g.toX, g.toY);
        return;
      }
    }
  }

  checkAreaClear() {
    // unlock 'locked' gates once non-boss enemies are gone & boss dead
    const aliveBoss = this.boss && this.boss.state !== "dead";
    if (!aliveBoss) {
      for (const g of this.area.gates)
        if (g.locked && this.bossesDead.includes(this.areaId)) g.locked = false;
    }
    // cull dead enemies after settle
    this.enemies = this.enemies.filter(
      (e) => e.state !== "dead" || e.timer > -0.5
    );
    // harvest run: clearing every foe (and the act boss) advances the run
    if (this.harvest && this.run && this.roomActive && this.screen === "play") {
      const aliveEnemies = this.enemies.some((e) => e.state !== "dead");
      const aliveBoss = this.boss && this.boss.state !== "dead";
      if (!aliveEnemies && !aliveBoss) this.onEncounterClear();
    }
  }

  // ---------------- particles / fx ----------------
  // back-compat shim: legacy call sites feed the pooled ParticleSystem
  spawnParticles(
    x: number,
    y: number,
    n: number,
    color: string,
    spd: number,
    glow = false
  ) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * spd;
      this.ps.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.4 + Math.random() * 0.5,
        size: 2 + Math.random() * 3,
        color,
        glow,
        drag: 3.4,
        shrink: true,
      });
    }
  }
  spawnHitFx(x: number, y: number, crit: boolean) {
    this.ps.emit("spark", x, y, { count: crit ? 16 : 9 });
    this.ps.emit("blood", x, y, { count: crit ? 12 : 7 });
  }
  floatText(x: number, y: number, text: string, color: string, size: number) {
    this.texts.push({ x, y, vy: -40, life: 1, text, color, size });
  }
  flash(color: string, alpha: number) {
    this.flashColor = color;
    this.flashAlpha = Math.max(this.flashAlpha, alpha);
  }
  addShake(amount: number) {
    this.shake = Math.min(this.shake + amount, 22);
  }
  updateParticles(dt: number) {
    this.ps.update(dt);
    for (const t of this.texts) {
      t.y += t.vy * dt;
      t.vy *= 0.92;
      t.life -= dt;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 40);
    // fx + combat timers
    if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - dt * 3.5);
    if (this.parryFlash > 0) this.parryFlash -= dt;
    if (this.riposteAnim > 0) this.riposteAnim -= dt;
  }

  // ---------------- camera ----------------
  updateCamera(dt: number) {
    let tx = this.px;
    let ty = this.py;
    const lockE = this.lockTarget
      ? this.enemies.find((e) => e.id === this.lockTarget)
      : null;
    if (lockE) {
      tx = lerp(this.px, lockE.x, 0.3);
      ty = lerp(this.py, lockE.y, 0.3);
    }
    this.camX = lerp(this.camX, tx, 1 - Math.pow(0.001, dt));
    this.camY = lerp(this.camY, ty, 1 - Math.pow(0.001, dt));
    // clamp to area
    const halfW = this.cssW / 2 / this.viewScale;
    const halfH = this.cssH / 2 / this.viewScale;
    if (this.area.w > halfW * 2)
      this.camX = clamp(this.camX, halfW, this.area.w - halfW);
    else this.camX = this.area.w / 2;
    if (this.area.h > halfH * 2)
      this.camY = clamp(this.camY, halfH, this.area.h - halfH);
    else this.camY = this.area.h / 2;
  }

  screenToWorld(sx: number, sy: number) {
    return {
      x: (sx - this.cssW / 2) / this.viewScale + this.camX,
      y: (sy - this.cssH / 2) / this.viewScale + this.camY,
    };
  }

  // ---------------- collision ----------------
  collideWalls(x: number, y: number, r: number, set: (x: number, y: number) => void) {
    let cx = x;
    let cy = y;
    for (const w of this.area.walls) {
      const res = resolveCircleRect(cx, cy, r, w);
      cx = res.x;
      cy = res.y;
    }
    set(cx, cy);
  }

  // ---------------- target helpers ----------------
  nearestEnemyId(maxR: number): number | null {
    let best: number | null = null;
    let bd = maxR * maxR;
    const m = this.screenToWorld(this.input.mouseX, this.input.mouseY);
    for (const e of this.enemies) {
      if (e.state === "dead") continue;
      // bias toward where you're aiming
      const d = dist2(e.x, e.y, this.px, this.py);
      if (d < bd) {
        bd = d;
        best = e.id;
      }
    }
    return best;
  }

  nearestPlayerTo(x: number, y: number): { id: string; x: number; y: number } {
    let best = { id: this.net.selfId, x: this.px, y: this.py };
    let bd = dist2(x, y, this.px, this.py);
    if (this.pstate === "dead") bd = Infinity;
    for (const [id, rp] of this.others) {
      if (rp.snap.dead) continue;
      const d = dist2(x, y, rp.rx, rp.ry);
      if (d < bd) {
        bd = d;
        best = { id, x: rp.rx, y: rp.ry };
      }
    }
    return best;
  }

  // ---------------- multiplayer ----------------
  netTick(dt: number) {
    if (this.net.mode === "solo") return;
    this.netSendCd -= dt;
    if (this.netSendCd <= 0) {
      this.netSendCd = 0.05; // 20Hz player state
      this.net.send({
        t: "ps",
        p: this.playerSnap(),
      });
    }
    if (this.net.mode === "host") {
      this.snapCd -= dt;
      if (this.snapCd <= 0) {
        this.snapCd = 0.06; // ~16Hz snapshots
        this.net.send({ t: "snap", s: this.hostSnap() });
      }
    }
  }

  playerSnap(): PlayerSnap {
    return {
      id: this.net.selfId,
      name: this.name,
      tint: this.tint,
      x: this.px,
      y: this.py,
      facing: this.facing,
      hp: this.hp,
      maxHp: this.maxHp,
      moving: this.moving,
      rolling: this.pstate === "roll",
      attacking: this.pstate === "attack" ? this.attackProg : 0,
      blocking: this.blocking,
      invuln: this.invuln > 0,
      dead: this.pstate === "dead",
      walkPhase: this.walkPhase,
      weapon: this.weapon,
    };
  }

  hostSnap() {
    const enemies: EnemySnap[] = this.enemies.map((e) => ({
      id: e.id,
      kind: e.kind,
      x: e.x,
      y: e.y,
      facing: e.facing,
      hp: e.hp,
      maxHp: e.maxHp,
      phase: e.phase,
      attacking: e.state === "active" ? 1 : e.attackProg,
      windup: e.windupFlag,
      hurt: e.hurt,
      big: e.big,
      dead: e.state === "dead",
    }));
    return {
      area: this.areaId,
      time: this.time,
      enemies,
      projectiles: this.projectiles.map((p) => ({
        id: p.id,
        x: p.x,
        y: p.y,
        r: p.r,
        hostile: p.hostile,
      })),
      boss: this.boss
        ? {
            name: this.boss.def.name,
            hp01: this.boss.hp / this.boss.maxHp,
            active: this.bossIntro <= 0,
          }
        : null,
    };
  }

  // Peer payloads are untrusted. Cap/clean a remote display name — control,
  // zero-width, and bidi code points corrupt the Canvas HUD (and an unbounded
  // string bloats GC at snapshot cadence). Tested by code point so this source
  // stays pure ASCII.
  private sanitizePeerName(v: unknown): string {
    const raw = String(v ?? "").slice(0, 16);
    let out = "";
    for (const ch of raw) {
      const c = ch.codePointAt(0) ?? 0;
      const bad =
        c <= 0x1f ||
        (c >= 0x7f && c <= 0x9f) ||
        (c >= 0x200b && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2060 && c <= 0x206f) ||
        c === 0xfeff;
      if (!bad) out += ch;
    }
    return out.trim() || "Phantom";
  }

  handleNetMessage(fromId: string, msg: NetMsg) {
    switch (msg.t) {
      case "ps": {
        // key by the player's own id so host-relayed snapshots resolve correctly
        if (msg.p.id === this.net.selfId) break;
        // sanitize untrusted peer fields before they touch render/state:
        // drop a snapshot with non-finite coords, clamp name, require #rrggbb tint
        const p = msg.p;
        if (
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          !Number.isFinite(p.facing)
        )
          break;
        p.name = this.sanitizePeerName(p.name);
        if (!/^#[0-9a-fA-F]{6}$/.test(p.tint)) p.tint = "#d83a2e";
        let rp = this.others.get(p.id);
        if (!rp) {
          rp = {
            snap: p,
            rx: p.x,
            ry: p.y,
            lastHitAtk: new Map(),
          };
          this.others.set(p.id, rp);
        }
        rp.snap = p;
        break;
      }
      case "snap": {
        if (this.net.mode === "client") this.applySnap(msg.s);
        break;
      }
      case "edmg": {
        if (this.net.mode === "host") {
          // untrusted client input: reject non-finite / out-of-range values so a
          // crafted packet can't one-shot bosses or inject NaN/Infinity into the
          // host's physics (which would desync and crash every connected peer).
          if (
            Number.isFinite(msg.amt) &&
            msg.amt > 0 &&
            msg.amt <= 9999 &&
            Number.isFinite(msg.kx) &&
            Number.isFinite(msg.ky)
          ) {
            const e = this.enemies.find((x) => x.id === msg.id);
            if (e)
              this.applyEnemyDamage(
                e,
                clamp(msg.amt, 1, 9999),
                clamp(msg.kx, -2000, 2000),
                clamp(msg.ky, -2000, 2000),
                fromId,
                Number.isFinite(msg.poise) ? clamp(msg.poise || 0, 0, 500) : 0
              );
          }
        }
        break;
      }
      case "area": {
        if (this.net.mode === "client") {
          if (msg.area !== this.areaId) this.loadArea(msg.area, true);
        }
        break;
      }
      case "sap": {
        if (msg.pid === this.net.selfId) this.gainSap(msg.amt);
        break;
      }
      case "draft": {
        // host cleared a room — open our own boon draft (harvest co-op)
        if (this.net.mode === "client" && this.harvest && this.run) this.openBoonDraft();
        break;
      }
      case "draftdone": {
        // a client finished drafting; advance once the host has too
        if (this.net.mode === "host") {
          this.coopDraftWait = Math.max(0, this.coopDraftWait - 1);
          if (this.hostPicked && this.coopDraftWait <= 0) this.proceedAfterBoon();
        }
        break;
      }
      case "bye": {
        this.others.delete(msg.id);
        // a peer leaving mid-draft shouldn't stall the run
        if (this.net.mode === "host" && this.coopDraftWait > 0) {
          this.coopDraftWait--;
          if (this.hostPicked && this.coopDraftWait <= 0) this.proceedAfterBoon();
        }
        break;
      }
    }
  }

  applySnap(s: import("./types").HostSnap) {
    // Defensive bounds on a host->client snapshot: a modified host could send a
    // huge array to spike the client's reconciliation loop, or non-finite coords
    // to wedge the camera. Drop absurd snapshots wholesale.
    if (
      !s ||
      !Array.isArray(s.enemies) ||
      !Array.isArray(s.projectiles) ||
      s.enemies.length > 300 ||
      s.projectiles.length > 300
    )
      return;
    if (s.area !== this.areaId) {
      this.loadArea(s.area, true);
    }
    // reconcile enemies (client)
    const seen = new Set<number>();
    const byId = new Map(this.enemies.map((e) => [e.id, e]));
    for (const es of s.enemies) {
      // drop a malformed entity rather than feed NaN/Infinity to the renderer
      if (
        !Number.isFinite(es.x) ||
        !Number.isFinite(es.y) ||
        !Number.isFinite(es.hp) ||
        !Number.isFinite(es.maxHp)
      )
        continue;
      seen.add(es.id);
      let e = byId.get(es.id);
      if (!e) {
        e = this.spawnEnemyFromSnap(es);
      }
      e.tx = es.x;
      e.ty = es.y;
      e.facing = es.facing;
      e.hp = es.hp;
      e.maxHp = es.maxHp;
      e.phase = es.phase;
      e.attackProg = es.attacking;
      e.windupFlag = es.windup;
      if (es.hurt > e.hurt) e.hurt = es.hurt;
      e.big = es.big;
      e.state = es.dead ? "dead" : es.attacking >= 1 ? "active" : "chase";
    }
    // remove enemies no longer in snapshot
    this.enemies = this.enemies.filter((e) => seen.has(e.id));
    // boss ref
    this.boss =
      this.enemies.find(
        (e) => e.kind === "king" || e.kind === "harvester"
      ) || null;
    if (s.boss) this.bossIntro = s.boss.active ? 0 : 1;

    // projectiles (replace)
    const pById = new Map(this.projectiles.map((p) => [p.id, p]));
    const newProj: Projectile[] = [];
    for (const ps of s.projectiles) {
      if (!Number.isFinite(ps.x) || !Number.isFinite(ps.y) || !Number.isFinite(ps.r))
        continue;
      const ex = pById.get(ps.id);
      if (ex) {
        // estimate velocity from movement for local interp
        ex.vx = (ps.x - ex.x) / 0.06;
        ex.vy = (ps.y - ex.y) / 0.06;
        ex.x = ps.x;
        ex.y = ps.y;
        ex.r = ps.r;
        newProj.push(ex);
      } else {
        newProj.push({
          id: ps.id,
          x: ps.x,
          y: ps.y,
          vx: 0,
          vy: 0,
          r: ps.r,
          dmg: 12,
          ttl: 4,
          hostile: ps.hostile,
          color: "#9fd44e",
        });
      }
    }
    this.projectiles = newProj;
  }

  spawnEnemyFromSnap(es: EnemySnap): Enemy {
    const defKey = Object.keys(ENEMIES).find(
      (k) => ENEMIES[k].kind === es.kind
    )!;
    const def = ENEMIES[defKey];
    const e: Enemy = {
      id: es.id,
      def,
      kind: es.kind,
      x: es.x,
      y: es.y,
      vx: 0,
      vy: 0,
      hp: es.hp,
      maxHp: es.maxHp,
      facing: es.facing,
      phase: es.phase,
      state: "chase",
      timer: 0,
      cd: 0,
      hurt: 0,
      atkId: 0,
      attackProg: es.attacking,
      windupFlag: es.windup,
      big: es.big,
      targetId: null,
      homeX: es.x,
      homeY: es.y,
      staggerVal: 0,
      staggerT: 0,
      tx: es.x,
      ty: es.y,
    };
    this.enemies.push(e);
    return e;
  }

  interpolateEnemies(dt: number) {
    for (const e of this.enemies) {
      if (e.tx !== undefined && e.ty !== undefined) {
        e.x = lerp(e.x, e.tx, 1 - Math.pow(0.0001, dt));
        e.y = lerp(e.y, e.ty, 1 - Math.pow(0.0001, dt));
      }
      if (e.hurt > 0) e.hurt -= dt;
      e.phase += dt * 3;
    }
  }

  updateRemotePlayers(dt: number) {
    for (const rp of this.others.values()) {
      rp.rx = lerp(rp.rx, rp.snap.x, 1 - Math.pow(0.0001, dt));
      rp.ry = lerp(rp.ry, rp.snap.y, 1 - Math.pow(0.0001, dt));
    }
  }

  // ================= RENDER =================
  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);

    // world transform with shake
    const shx = (Math.random() - 0.5) * this.shake;
    const shy = (Math.random() - 0.5) * this.shake;
    ctx.save();
    ctx.translate(this.cssW / 2 + shx, this.cssH / 2 + shy);
    ctx.scale(this.viewScale, this.viewScale);
    ctx.translate(-this.camX, -this.camY);

    if (this.area) {
      this.drawFloor(ctx);
      this.drawProps(ctx, "under");
      this.drawHusksAndPickups(ctx);
      this.drawEntities(ctx);
      this.drawProjectiles(ctx);
      this.drawParticles(ctx);
      this.drawProps(ctx, "over");
      this.drawFloatTexts(ctx);
    }
    ctx.restore();

    // ---- screen-space post stack: lighting → weather → grade → vignette → flash ----
    if (this.area) {
      const b = this.biome();
      if (b.darkness > 0.001) {
        renderLighting(ctx, {
          cssW: this.cssW,
          cssH: this.cssH,
          dpr: this.dpr,
          camX: this.camX,
          camY: this.camY,
          viewScale: this.viewScale,
          darkness: b.darkness,
          ambient: b.ambient,
          lights: this.collectLights(),
          t: this.time,
        });
      }
      if (b.weather !== "none")
        drawWeather(ctx, b.weather, this.time, {
          cssW: this.cssW,
          cssH: this.cssH,
        });
      colorGrade(ctx, this.cssW, this.cssH, b.grade);
      vignette(ctx, this.cssW, this.cssH, 0.42);
      if (this.flashAlpha > 0.01)
        flashScreen(ctx, this.cssW, this.cssH, this.flashColor, this.flashAlpha);
    }

    this.drawHUD(ctx);
  }

  // per-biome atmosphere: darkness, ambient tint, weather, color grade.
  // Even the bright outdoor fields get a golden-dusk darkness so the player,
  // compost heaps and torches cast real light — flat "noon" reads as cheap.
  biome(): {
    darkness: number;
    weather: Weather;
    grade: GradePreset;
    ambient: string;
  } {
    if (this.areaId === "kingarena")
      return { darkness: 0.74, weather: "none", grade: "kingarena", ambient: "#140406" };
    switch (this.area.floor) {
      case "rows":
        return { darkness: 0.4, weather: "pollen", grade: "rows", ambient: "#2a160c" };
      case "glass":
        return { darkness: 0.36, weather: "fog", grade: "greenhouse", ambient: "#0e1a16" };
      case "stone":
        return { darkness: 0.84, weather: "none", grade: "catacombs", ambient: "#05060a" };
      case "yard":
        return { darkness: 0.5, weather: "dust", grade: "yard", ambient: "#1e0a07" };
      case "bog":
        return { darkness: 0.64, weather: "rain", grade: "sodden", ambient: "#06100c" };
      default:
        return { darkness: 0.2, weather: "none", grade: "none", ambient: "#0a0a0e" };
    }
  }

  // gather dynamic lights (world coords) for the lighting pass
  collectLights(): Light[] {
    const lights: Light[] = [];
    if (this.pstate !== "dead")
      lights.push({ x: this.px, y: this.py, radius: 260, color: "#ffe6b0", intensity: 0.95, flicker: 0.1 });
    for (const rp of this.others.values())
      if (!rp.snap.dead)
        lights.push({ x: rp.rx, y: rp.ry, radius: 190, color: "#cfe6a0", intensity: 0.6 });
    if (this.area.compost)
      lights.push({ x: this.area.compost.x, y: this.area.compost.y, radius: 340, color: "#ffb347", intensity: 1, flicker: 0.6 });
    for (const p of this.area.props) {
      if (p.type === "torch")
        lights.push({ x: p.x, y: p.y - 12, radius: 190, color: "#ff9a3a", intensity: 0.9, flicker: 0.5 });
      else if (p.type === "lantern")
        lights.push({ x: p.x, y: p.y - 8, radius: 160, color: "#ffd56b", intensity: 0.8, flicker: 0.22 });
      else if (p.type === "mushroom")
        lights.push({ x: p.x, y: p.y, radius: 64, color: "#7fd0c0", intensity: 0.4, flicker: 0.2 });
    }
    for (const p of this.projectiles)
      lights.push({ x: p.x, y: p.y, radius: 80, color: p.color, intensity: 0.6 });
    if (this.boss && (this.boss.kind === "harvester" || this.boss.kind === "oldtom"))
      lights.push({
        x: this.boss.x,
        y: this.boss.y,
        radius: 160,
        color: this.boss.kind === "harvester" ? "#ff7a3a" : "#ffd56b",
        intensity: 0.85,
        flicker: 0.5,
      });
    return lights;
  }

  drawFloor(ctx: CanvasRenderingContext2D) {
    const a = this.area;
    const base: Record<string, string> = {
      soil: "#241712",
      rows: "#2a1c12",
      glass: "#1c2622",
      stone: "#1a1614",
      yard: "#2a1810",
      bog: "#141d18",
    };
    ctx.fillStyle = base[a.floor] || "#201510";
    ctx.fillRect(0, 0, a.w, a.h);

    // tiled texture by floor type — clipped to view for perf
    const vx0 = this.camX - this.cssW / 2 / this.viewScale - 80;
    const vy0 = this.camY - this.cssH / 2 / this.viewScale - 80;
    const vx1 = this.camX + this.cssW / 2 / this.viewScale + 80;
    const vy1 = this.camY + this.cssH / 2 / this.viewScale + 80;
    const startX = Math.max(0, Math.floor(vx0 / 64) * 64);
    const startY = Math.max(0, Math.floor(vy0 / 64) * 64);

    if (a.floor === "rows") {
      // tilled furrows
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 6;
      for (let y = startY; y < Math.min(a.h, vy1); y += 48) {
        ctx.beginPath();
        ctx.moveTo(Math.max(0, vx0), y);
        ctx.lineTo(Math.min(a.w, vx1), y);
        ctx.stroke();
      }
      ctx.strokeStyle = "rgba(120,80,40,0.08)";
      ctx.lineWidth = 2;
      for (let y = startY; y < Math.min(a.h, vy1); y += 48) {
        ctx.beginPath();
        ctx.moveTo(Math.max(0, vx0), y - 6);
        ctx.lineTo(Math.min(a.w, vx1), y - 6);
        ctx.stroke();
      }
    } else if (a.floor === "glass") {
      ctx.strokeStyle = "rgba(120,160,150,0.08)";
      ctx.lineWidth = 1.5;
      for (let x = startX; x < Math.min(a.w, vx1); x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, Math.max(0, vy0));
        ctx.lineTo(x, Math.min(a.h, vy1));
        ctx.stroke();
      }
      for (let y = startY; y < Math.min(a.h, vy1); y += 64) {
        ctx.beginPath();
        ctx.moveTo(Math.max(0, vx0), y);
        ctx.lineTo(Math.min(a.w, vx1), y);
        ctx.stroke();
      }
    } else if (a.floor === "bog") {
      // standing water: dark sheen + slow concentric ripples
      ctx.fillStyle = "rgba(40,70,60,0.18)";
      for (let y = startY; y < Math.min(a.h, vy1); y += 96) {
        for (let x = startX; x < Math.min(a.w, vx1); x += 96) {
          const r = 30 + Math.sin(this.time * 0.8 + x * 0.05 + y * 0.03) * 8;
          ctx.beginPath();
          ctx.ellipse(x + 48, y + 48, r, r * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.strokeStyle = "rgba(120,160,140,0.05)";
      ctx.lineWidth = 1.5;
      for (let y = startY; y < Math.min(a.h, vy1); y += 80) {
        ctx.beginPath();
        ctx.moveTo(Math.max(0, vx0), y + Math.sin(this.time + y) * 3);
        ctx.lineTo(Math.min(a.w, vx1), y + Math.cos(this.time + y) * 3);
        ctx.stroke();
      }
    } else {
      // stone / yard cobble
      ctx.fillStyle = "rgba(0,0,0,0.14)";
      for (let y = startY; y < Math.min(a.h, vy1); y += 64) {
        for (let x = startX; x < Math.min(a.w, vx1); x += 64) {
          if (((x / 64 + y / 64) | 0) % 2 === 0)
            ctx.fillRect(x, y, 62, 62);
        }
      }
    }

    // walls — extruded 2.5D blocks (height toward the camera)
    let topCol = "#4a3725";
    let frontCol = "#1c130c";
    let H = 26;
    if (a.floor === "stone") {
      topCol = "#403a32";
      frontCol = "#181410";
      H = 32;
    } else if (a.floor === "glass") {
      topCol = "#2c3a36";
      frontCol = "#121a18";
      H = 24;
    } else if (a.floor === "bog") {
      topCol = "#243028";
      frontCol = "#0e1612";
      H = 16;
    } else if (a.floor === "yard") {
      topCol = "#3e2a1c";
      frontCol = "#180f09";
      H = 30;
    }
    if (this.areaId === "kingarena") {
      topCol = "#3a322c";
      frontCol = "#160f0c";
      H = 32;
    }
    for (const w of a.walls) {
      if (w.x + w.w < vx0 || w.x > vx1 + 40 || w.y + w.h < vy0 - 40 || w.y > vy1)
        continue;
      this.drawBlock(ctx, w.x, w.y, w.w, w.h, H, topCol, frontCol);
    }
  }

  // an extruded box: footprint (x,y,w,h) raised by H toward the top of the screen
  drawBlock(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    H: number,
    top: string,
    front: string,
    outline = "#0e0a08"
  ) {
    const topY = y - H;
    // contact shadow at the south base
    ctx.fillStyle = "rgba(0,0,0,0.32)";
    ctx.fillRect(x - 2, y + h - 1, w + 4, 5);
    // front (south) face
    ctx.fillStyle = front;
    ctx.fillRect(x, topY + h, w, H);
    // top (cap) face
    ctx.fillStyle = top;
    ctx.fillRect(x, topY, w, h);
    // north-edge bevel highlight
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(x, topY, w, 3);
    // outlines
    ctx.strokeStyle = outline;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, topY, w, h);
    ctx.beginPath();
    ctx.moveTo(x, topY + h);
    ctx.lineTo(x, topY + h + H);
    ctx.moveTo(x + w, topY + h);
    ctx.lineTo(x + w, topY + h + H);
    ctx.moveTo(x, topY + h + H);
    ctx.lineTo(x + w, topY + h + H);
    ctx.stroke();
  }

  drawProps(ctx: CanvasRenderingContext2D, layer: "under" | "over") {
    for (const p of this.area.props) {
      const over = p.type === "stalk" || p.type === "glass";
      if ((layer === "over") !== over) continue;
      switch (p.type) {
        case "fence":
          ctx.strokeStyle = "#5a3b22";
          ctx.lineWidth = 4;
          for (let x = p.x; x < p.x + (p.w || 100); x += 24) {
            ctx.beginPath();
            ctx.moveTo(x, p.y);
            ctx.lineTo(x, p.y + 26);
            ctx.stroke();
          }
          ctx.beginPath();
          ctx.moveTo(p.x, p.y + 8);
          ctx.lineTo(p.x + (p.w || 100), p.y + 8);
          ctx.stroke();
          break;
        case "crate": {
          const cw = p.w || 44;
          const ch = p.h || 44;
          const ch2 = 28;
          this.drawBlock(ctx, p.x, p.y, cw, ch, ch2, "#6b4a2a", "#3a2616");
          // plank cross on the cap
          ctx.strokeStyle = "#2a1b10";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - ch2);
          ctx.lineTo(p.x + cw, p.y - ch2 + ch);
          ctx.moveTo(p.x + cw, p.y - ch2);
          ctx.lineTo(p.x, p.y - ch2 + ch);
          ctx.stroke();
          break;
        }
        case "glass":
          ctx.fillStyle = "rgba(150,200,190,0.10)";
          ctx.fillRect(p.x, p.y, p.w || 40, p.h || 40);
          ctx.strokeStyle = "rgba(180,220,210,0.3)";
          ctx.strokeRect(p.x, p.y, p.w || 40, p.h || 40);
          break;
        case "stone": {
          const rw = p.w || 40;
          const rh = p.h || 40;
          // cast shadow
          ctx.fillStyle = "rgba(0,0,0,0.3)";
          ctx.beginPath();
          ctx.ellipse(p.x + 4, p.y + rh / 3, rw / 2, rh / 3.4, 0, 0, Math.PI * 2);
          ctx.fill();
          // body
          ctx.fillStyle = "#3a342e";
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rw / 2, rh / 2.4, 0, 0, Math.PI * 2);
          ctx.fill();
          // lit dome
          ctx.fillStyle = "#4c463d";
          ctx.beginPath();
          ctx.ellipse(p.x - rw * 0.12, p.y - rh * 0.14, rw / 2.8, rh / 3.4, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#15110e";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, rw / 2, rh / 2.4, 0, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        case "puddle":
          ctx.fillStyle = "rgba(60,90,50,0.3)";
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, (p.w || 80) / 2, (p.h || 50) / 2, 0, 0, Math.PI * 2);
          ctx.fill();
          break;
        case "stalk":
          // tall corn stalk casting over the player
          ctx.strokeStyle = "#3c5a26";
          ctx.lineWidth = 7;
          ctx.lineCap = "round";
          const sway = Math.sin(this.time * 1.2 + p.x) * 4;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.quadraticCurveTo(p.x + sway, p.y - 40, p.x + sway, p.y - 80);
          ctx.stroke();
          ctx.fillStyle = "#4e7a2e";
          for (let i = 0; i < 4; i++) {
            ctx.save();
            ctx.translate(p.x + (sway * (i / 4)), p.y - i * 20 - 10);
            ctx.rotate((i % 2 ? 1 : -1) * 0.7);
            ctx.beginPath();
            ctx.ellipse(0, 0, 16, 5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
          break;
        case "sign":
          ctx.fillStyle = "#5a3b22";
          ctx.fillRect(p.x - 2, p.y, 4, 30);
          ctx.fillStyle = "#8a6a3a";
          ctx.fillRect(p.x - 26, p.y - 22, 52, 26);
          ctx.strokeStyle = "#2a1b10";
          ctx.lineWidth = 2;
          ctx.strokeRect(p.x - 26, p.y - 22, 52, 26);
          // glow when near
          if (dist2(p.x, p.y, this.px, this.py) < 90 * 90) {
            ctx.fillStyle = "#1a120c";
            this.drawSignTooltip(ctx, p.x, p.y - 40, p.text || "");
          }
          break;
        case "mushroom":
          drawMushroom(ctx, p.x, p.y, this.time, (p.x * 7 + p.y) | 0, this.area.floor === "stone" || this.area.floor === "bog");
          break;
        case "flower":
          drawFlower(ctx, p.x, p.y, this.time, (p.x * 13 + p.y) | 0);
          break;
        case "lantern":
          drawLantern(ctx, p.x, p.y, this.time, (p.x + p.y) | 0);
          break;
        case "bones":
          drawBones(ctx, p.x, p.y, this.time, (p.x * 5 + p.y) | 0);
          break;
        case "banner":
          drawBanner(ctx, p.x, p.y, this.time, (p.x + p.y * 3) | 0);
          break;
        case "torch":
          drawTorch(ctx, p.x, p.y, this.time, (p.x * 3 + p.y) | 0);
          break;
        case "grass":
          drawGrassTuft(
            ctx,
            p.x,
            p.y,
            this.time,
            (p.x * 11 + p.y) | 0,
            this.area.floor === "rows" || this.area.floor === "yard"
          );
          break;
        case "vines":
          drawVinePatch(ctx, p.x, p.y, this.time, (p.x + p.y * 7) | 0);
          break;
      }
    }
    // compost heap (drawn once on the under layer; prompt on over)
    if (this.area.compost && layer === "under") {
      drawCompostHeap(ctx, this.area.compost.x, this.area.compost.y, this.time, true);
    }
    if (this.area.compost) {
      if (
        layer === "over" &&
        dist2(this.area.compost.x, this.area.compost.y, this.px, this.py) <
          60 * 60 &&
        this.screen === "play"
      ) {
        this.drawInteractPrompt(ctx, this.area.compost.x, this.area.compost.y - 50, "E — REST");
      }
    }
    // fog gates
    if (layer === "over") {
      for (const g of this.area.gates) {
        if (g.fog && g.locked === undefined) {
          // not used
        }
        if (g.fog) {
          const r = g.rect;
          ctx.save();
          ctx.globalAlpha = 0.5;
          const grd = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
          grd.addColorStop(0, "rgba(220,200,180,0.1)");
          grd.addColorStop(0.5, "rgba(240,230,210,0.5)");
          grd.addColorStop(1, "rgba(220,200,180,0.1)");
          ctx.fillStyle = grd;
          ctx.fillRect(r.x - 6, r.y - 6, r.w + 12, r.h + 12);
          ctx.restore();
        }
        if (g.label && !g.locked) {
          const r = g.rect;
          if (dist2(r.x + r.w / 2, r.y + r.h / 2, this.px, this.py) < 160 * 160) {
            this.drawInteractPrompt(ctx, r.x + r.w / 2, r.y - 14, "» " + g.label);
          }
        }
      }
    }
  }

  drawSignTooltip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
    ctx.save();
    ctx.font = "12px Georgia";
    ctx.textAlign = "center";
    const lines = text.split("\n");
    const w = 220;
    const h = lines.length * 16 + 14;
    ctx.fillStyle = "rgba(10,8,6,0.9)";
    ctx.fillRect(x - w / 2, y - h, w, h);
    ctx.strokeStyle = "#5a3b22";
    ctx.strokeRect(x - w / 2, y - h, w, h);
    ctx.fillStyle = "#e8dcc0";
    lines.forEach((l, i) =>
      ctx.fillText(l, x, y - h + 18 + i * 16)
    );
    ctx.restore();
  }

  drawInteractPrompt(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
    ctx.save();
    ctx.font = "bold 13px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd56b";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  drawHusksAndPickups(ctx: CanvasRenderingContext2D) {
    for (const h of this.husks) {
      if (h.area === this.areaId) drawHusk(ctx, h.x, h.y, this.time);
    }
    for (const p of this.pickups) {
      drawPickup(ctx, p.x, p.y, this.time, p.kind === "key" ? "key" : p.kind);
    }
  }

  drawEntities(ctx: CanvasRenderingContext2D) {
    // gather drawables sorted by y
    type D = { y: number; fn: () => void };
    const list: D[] = [];

    for (const e of this.enemies) {
      if (e.state === "dead") continue;
      // lock-on reticle
      list.push({
        y: e.y,
        fn: () => {
          drawEnemy(
            ctx,
            e.x,
            e.y,
            {
              kind: e.kind,
              facing: e.facing,
              phase: e.phase,
              hurt: e.hurt,
              attacking: e.attackProg,
              hp01: e.hp / e.maxHp,
              windup: e.windupFlag,
              big: e.big,
              variant: e.id,
              staggered: e.staggerT > 0,
            },
            this.time
          );
          // hp bar for tougher foes
          if (e.def.hp >= 40 && e !== this.boss) this.drawMiniHp(ctx, e);
          if (this.lockTarget === e.id) {
            ctx.save();
            ctx.strokeStyle = "#ffd56b";
            ctx.lineWidth = 2;
            const s = 8 + Math.sin(this.time * 6) * 2;
            ctx.beginPath();
            ctx.moveTo(e.x - s, e.y - e.def.radius * e.big - 14);
            ctx.lineTo(e.x, e.y - e.def.radius * e.big - 8);
            ctx.lineTo(e.x + s, e.y - e.def.radius * e.big - 14);
            ctx.stroke();
            ctx.restore();
          }
        },
      });
    }

    // remote players
    for (const rp of this.others.values()) {
      const s = rp.snap;
      list.push({
        y: rp.ry,
        fn: () => {
          const v: HeroVisual = {
            facing: s.facing,
            walkPhase: s.walkPhase,
            moving: s.moving,
            rolling: s.rolling,
            attacking: s.attacking,
            hurt: 0,
            invuln: s.invuln,
            blocking: s.blocking,
            tint: s.tint,
            dead: s.dead,
            ghost: true,
            weapon: s.weapon,
          };
          drawHero(ctx, rp.rx, rp.ry, v, this.time);
          // name tag
          ctx.save();
          ctx.font = "11px monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = "#cfe6a0";
          ctx.fillText(s.name, rp.rx, rp.ry - 34);
          ctx.restore();
        },
      });
    }

    // self
    if (this.pstate !== "dead") {
      list.push({
        y: this.py,
        fn: () => {
          const v: HeroVisual = {
            facing: this.facing,
            walkPhase: this.walkPhase,
            moving: this.moving,
            rolling: this.pstate === "roll",
            attacking: this.pstate === "attack" ? this.attackProg : 0,
            hurt: this.hurtCd > 0.4 ? 1 : 0,
            invuln: this.invuln > 0,
            blocking: this.blocking,
            tint: this.tint,
            weapon: this.weapon,
            heavy: this.attackHeavy,
            parrying: this.parryFlash > 0 ? this.parryFlash / 0.3 : 0,
            riposte: this.riposteAnim > 0 ? this.riposteAnim / 0.32 : 0,
          };
          drawHero(ctx, this.px, this.py, v, this.time);
          if (this.pstate === "heal") {
            ctx.save();
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = "#7ac0ff";
            ctx.beginPath();
            ctx.arc(this.px, this.py, 22, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        },
      });
    }

    list.sort((a, b) => a.y - b.y);
    for (const d of list) d.fn();
  }

  drawMiniHp(ctx: CanvasRenderingContext2D, e: Enemy) {
    const w = 30;
    const x = e.x - w / 2;
    const y = e.y - e.def.radius * e.big - 18;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = "#b21f1f";
    ctx.fillRect(x, y, w * (e.hp / e.maxHp), 4);
  }

  drawProjectiles(ctx: CanvasRenderingContext2D) {
    const lift = 13; // float the orb above its ground shadow for 2.5D depth
    for (const p of this.projectiles) {
      // ground shadow at the true (collision) position
      ctx.fillStyle = "rgba(0,0,0,0.32)";
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r * 0.95, p.r * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      // glowing orb, raised
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y - lift, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.arc(p.x - p.r * 0.3, p.y - lift - p.r * 0.3, p.r * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawParticles(ctx: CanvasRenderingContext2D) {
    this.ps.draw(ctx);
  }

  drawFloatTexts(ctx: CanvasRenderingContext2D) {
    ctx.textAlign = "center";
    for (const t of this.texts) {
      ctx.globalAlpha = clamp(t.life, 0, 1);
      ctx.font = `bold ${t.size}px monospace`;
      ctx.fillStyle = "#000";
      ctx.fillText(t.text, t.x + 1, t.y + 1);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  // ================= HUD =================
  drawHUD(ctx: CanvasRenderingContext2D) {
    const W = this.cssW;
    const H = this.cssH;

    if (this.screen === "play" || this.screen === "bonfire") {
      // bars top-left
      this.drawBar(ctx, 24, 22, 280, 16, this.hp / this.maxHp, "#b21f1f", "#3a0d0a");
      this.drawBar(
        ctx,
        24,
        44,
        220,
        10,
        this.stamina / this.maxStamina,
        this.exhausted ? "#7a6a1a" : "#9fb24e",
        "#2a2a10"
      );
      // estus + sap
      // poison meter (sits under the stamina bar)
      if (this.poison > 0)
        this.drawBar(ctx, 24, 58, 150, 6, this.poison / 48, "#9fd44e", "#1e2a12");
      ctx.font = "bold 14px monospace";
      ctx.textAlign = "left";
      ctx.fillStyle = "#7ac0ff";
      ctx.fillText("🜄 " + this.estus + "/" + this.estusMax, 24, 80);
      // equipped weapon + charm
      ctx.font = "12px monospace";
      ctx.fillStyle = "#cfe6a0";
      ctx.fillText(WEAPONS[this.weapon].name, 24, 100);
      if (this.charm) {
        ctx.fillStyle = "#c79be0";
        ctx.fillText(this.charm.name, 24, 116);
      }
      ctx.fillStyle = "#ffd56b";
      ctx.textAlign = "right";
      ctx.fillText(this.sap.toLocaleString() + " sap", W - 24, 36);
      ctx.fillStyle = "#8a7a5a";
      ctx.font = "11px monospace";
      ctx.fillText("LV " + (totalLevel(this.stats) + 1), W - 24, 54);

      // co-op roster
      if (this.net.mode !== "solo") {
        ctx.textAlign = "right";
        ctx.font = "11px monospace";
        let ry = 78;
        ctx.fillStyle = "#cfe6a0";
        ctx.fillText(
          (this.net.mode === "host" ? "HOSTING" : "SUMMONED") +
            " · " +
            (this.others.size + 1) +
            " tomatoes",
          W - 24,
          ry
        );
      }

      // boss bar
      const boss = this.boss;
      if (boss && this.bossIntro <= 0 && boss.state !== "dead") {
        const bw = Math.min(620, W - 120);
        const bx = (W - bw) / 2;
        const by = H - 54;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(bx - 4, by - 4, bw + 8, 22);
        this.drawBar(ctx, bx, by, bw, 14, boss.hp / boss.maxHp, "#9e2018", "#1a0606");
        ctx.font = "italic 14px Georgia";
        ctx.textAlign = "center";
        ctx.fillStyle = "#e8dcc0";
        ctx.fillText(boss.def.name, W / 2, by - 10);
      }

      // controls hint (fades)
      if (this.time < 14 && this.net.mode !== "client") {
        ctx.globalAlpha = clamp((14 - this.time) / 4, 0, 0.6);
        ctx.font = "11px monospace";
        ctx.textAlign = "center";
        ctx.fillStyle = "#b9a98a";
        ctx.fillText(
          "WASD move · LMB light · F heavy · SPACE roll · RMB guard (time it = parry) · 1-4 weapons · TAB lock-on · R heal · E rest",
          W / 2,
          H - 16
        );
        ctx.globalAlpha = 1;
      }

      // lock-on crosshair when aiming (no lock)
      if (!this.lockTarget && this.screen === "play") {
        ctx.strokeStyle = "rgba(232,181,58,0.5)";
        ctx.lineWidth = 1.5;
        const mx = this.input.mouseX;
        const my = this.input.mouseY;
        ctx.beginPath();
        ctx.arc(mx, my, 6, 0, Math.PI * 2);
        ctx.moveTo(mx - 11, my);
        ctx.lineTo(mx - 7, my);
        ctx.moveTo(mx + 7, my);
        ctx.lineTo(mx + 11, my);
        ctx.stroke();
      }
    }

    // area toast
    if (this.toastT > 0 && this.screen === "play") {
      const a = clamp(this.toastT > 3 ? 4 - this.toastT : this.toastT, 0, 1);
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.fillStyle = "#e9dcc0";
      ctx.font = "italic 34px Georgia";
      ctx.fillText(this.toastMsg, W / 2, H / 2 - 30);
      ctx.font = "italic 16px Georgia";
      ctx.fillStyle = "#b9a98a";
      ctx.fillText(this.toastSub, W / 2, H / 2);
      ctx.globalAlpha = 1;
    }

    if (this.harvest && this.screen === "play") this.drawRunHud(ctx);
    if (this.screen === "bonfire") this.drawBonfireMenu(ctx);
    if (this.screen === "boon") this.drawBoonDraft(ctx);
    if (this.screen === "dead") this.drawDeathScreen(ctx);
    if (this.screen === "victory") this.drawVictoryScreen(ctx);
    if (this.screen === "paused") this.drawPauseScreen(ctx);

    // boss intro nameplate
    if (this.boss && this.bossIntro > 0) {
      const a = clamp(this.bossIntro / 2.5, 0, 1);
      ctx.globalAlpha = a;
      ctx.textAlign = "center";
      ctx.fillStyle = "#9e2018";
      ctx.font = "bold 40px Georgia";
      ctx.fillText(this.boss.def.name.split(",")[0], W / 2, H / 2 + 120);
      ctx.globalAlpha = 1;
    }
  }

  drawBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    frac: number,
    fill: string,
    bg: string
  ) {
    frac = clamp(frac, 0, 1);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w * frac, h);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x, y, w * frac, h / 2);
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
  }

  drawBonfireMenu(ctx: CanvasRenderingContext2D) {
    const W = this.cssW;
    const H = this.cssH;
    ctx.fillStyle = "rgba(8,5,4,0.82)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffb347";
    ctx.font = "italic 28px Georgia";
    ctx.fillText("THE COMPOST HEAP", W / 2, 90);
    ctx.font = "13px monospace";
    ctx.fillStyle = "#8a7a5a";
    ctx.fillText("strengthen the fruit — spend sap", W / 2, 116);

    const cost = levelCost(this.stats);
    const stats: [string, number, string][] = [
      ["VIGOR", this.stats.vigor, "max health"],
      ["STRENGTH", this.stats.strength, "attack power"],
      ["VITALITY", this.stats.vitality, "stamina"],
      ["AGILITY", this.stats.agility, "speed & roll"],
    ];
    const baseY = 170;
    ctx.textAlign = "left";
    const cx = W / 2 - 200;
    stats.forEach((s, i) => {
      const y = baseY + i * 46;
      const sel = this.bonfireSel === i;
      if (sel) {
        ctx.fillStyle = "rgba(232,181,58,0.12)";
        ctx.fillRect(cx - 16, y - 24, 432, 38);
        ctx.fillStyle = "#ffd56b";
        ctx.font = "bold 18px monospace";
        ctx.fillText("›", cx - 10, y);
      }
      ctx.fillStyle = sel ? "#ffd56b" : "#e8dcc0";
      ctx.font = "bold 18px monospace";
      ctx.fillText(s[0], cx + 14, y);
      ctx.font = "12px monospace";
      ctx.fillStyle = "#8a7a5a";
      ctx.fillText(s[2], cx + 14, y + 16);
      ctx.textAlign = "right";
      ctx.font = "bold 20px monospace";
      ctx.fillStyle = "#e8dcc0";
      ctx.fillText(String(s[1]), cx + 380, y);
      ctx.textAlign = "left";
    });

    // leave option
    const ly = baseY + 4 * 46 + 10;
    const lsel = this.bonfireSel === 4;
    ctx.fillStyle = lsel ? "#ffd56b" : "#b9a98a";
    ctx.font = "bold 16px monospace";
    ctx.textAlign = "center";
    ctx.fillText(lsel ? "› LEAVE ‹" : "LEAVE", W / 2, ly + 8);

    ctx.font = "14px monospace";
    ctx.fillStyle = this.sap >= cost ? "#ffd56b" : "#9e5040";
    ctx.fillText("next point: " + cost + " sap   ·   you have " + this.sap, W / 2, ly + 44);

    // charm slot
    ctx.font = "12px monospace";
    if (this.ownedCharms.length > 0) {
      ctx.fillStyle = "#c79be0";
      ctx.fillText(
        "‹ charm: " + (this.charm ? this.charm.name : "none") + " ›",
        W / 2,
        ly + 70
      );
      ctx.fillStyle = "#6a5a40";
      ctx.font = "10px monospace";
      ctx.fillText(
        this.charm ? this.charm.flavor.slice(0, 64) : "← / → to equip a trinket",
        W / 2,
        ly + 86
      );
    } else {
      ctx.fillStyle = "#6a5a40";
      ctx.fillText("no charms found — they are won from great foes", W / 2, ly + 70);
    }

    ctx.fillStyle = "#6a5a40";
    ctx.font = "11px monospace";
    ctx.fillText("↑/↓ level · ←/→ charm · ENTER confirm · E leave", W / 2, ly + 108);
  }

  drawDeathScreen(ctx: CanvasRenderingContext2D) {
    const W = this.cssW;
    const H = this.cssH;
    ctx.fillStyle = "rgba(20,2,2,0.72)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#9e2018";
    ctx.font = "bold 64px Georgia";
    ctx.fillText("YOU WILTED", W / 2, H / 2 - 8);
    ctx.fillStyle = "#7a5a4a";
    ctx.font = "italic 16px Georgia";
    ctx.fillText(
      this.net.mode === "client"
        ? "a phantom fades... reforming at the host's heap"
        : "your sap spills into the soil. reclaim it where you fell.",
      W / 2,
      H / 2 + 28
    );
    if (this.respawnTimer <= 0) {
      ctx.globalAlpha = 0.6 + Math.sin(this.time * 4) * 0.3;
      ctx.fillStyle = "#e8dcc0";
      ctx.font = "13px monospace";
      ctx.fillText("press SPACE to rise", W / 2, H / 2 + 70);
      ctx.globalAlpha = 1;
    }
  }

  drawVictoryScreen(ctx: CanvasRenderingContext2D) {
    const W = this.cssW;
    const H = this.cssH;
    ctx.fillStyle = "rgba(8,5,4,0.85)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd56b";
    ctx.font = "bold 56px Georgia";
    ctx.fillText("HARVEST SURVIVED", W / 2, H / 2 - 30);
    ctx.fillStyle = "#cfe6a0";
    ctx.font = "italic 18px Georgia";
    ctx.fillText(
      "Tommy stands amid the wreckage of the blade. The rows are still.",
      W / 2,
      H / 2 + 10
    );
    ctx.fillStyle = "#b9a98a";
    ctx.font = "14px Georgia";
    ctx.fillText(
      "He is not safe. He is simply not paste. For a tomato, that is enough.",
      W / 2,
      H / 2 + 38
    );
    ctx.fillStyle = "#8a7a5a";
    ctx.font = "12px monospace";
    ctx.fillText(
      "LV " +
        (totalLevel(this.stats) + 1) +
        " · " +
        Math.floor(this.playtime / 60) +
        "m survived · thank you for playing",
      W / 2,
      H / 2 + 80
    );
  }

  drawPauseScreen(ctx: CanvasRenderingContext2D) {
    const W = this.cssW;
    const H = this.cssH;
    ctx.fillStyle = "rgba(8,5,4,0.7)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#e8dcc0";
    ctx.font = "italic 40px Georgia";
    ctx.fillText("PAUSED", W / 2, H / 2 - 20);
    ctx.font = "13px monospace";
    ctx.fillStyle = "#8a7a5a";
    ctx.fillText("press P to resume", W / 2, H / 2 + 14);
    ctx.font = "12px monospace";
    ctx.fillStyle = "#6a5a40";
    ctx.fillText(
      "WASD move · MOUSE aim · LMB attack · F heavy · SPACE roll · RMB block · TAB lock-on · R heal · E rest",
      W / 2,
      H / 2 + 44
    );
  }

  // external controls
  toggleMute() {
    this.audio.setEnabled(!this.audio.enabled);
    return this.audio.enabled;
  }
}
