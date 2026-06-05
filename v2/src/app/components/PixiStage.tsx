"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import type { Renderer } from "pixi.js";
import type { Sim } from "@/game/sim/Sim";
import type { InputState, WorldState, Entity } from "@/game/sim/types";
import type { AreaDef } from "@/game/sim/content";
import type { Creature } from "@/game/assets/manifest";
import type { ActorSprite } from "@/game/render/sprites";
import type { ParticleSystem, ScreenShake, FlashOverlay, Vignette } from "@/game/render/vfx";
import type { LightLayer } from "@/game/render/lighting";
import type { GroundLayer } from "@/game/render/env";
import type { PropLayer } from "@/game/render/props";
import type { WorldFxLayer } from "@/game/render/worldfx";
import type { Hud } from "@/game/render/hud";
import type { WeaponView } from "@/game/render/weapon";
import type { CombatUiLayer } from "@/game/render/combatui";

// ---- tuning ----
const ZOOM = 1.3;
const ROOM_CREATURES: Creature[] = ["player", "grub", "weed", "drone", "hornet"];
const VFX_TO_LOAD = ["pulpSplatter", "sapPickup", "poisonCloud", "healMotes", "parryFlash", "levelUp", "bossDeath"];
const BOSS_OF_AREA: Record<string, Creature> = { kingarena: "king", sodden: "oldtom", yard: "harvester" };

type Biome = "none" | "rows" | "greenhouse" | "catacombs" | "kingarena" | "yard" | "sodden";
function biomeFor(areaId: string, floor: string): { biome: Biome; darkness: number; ambient: number; ambience: "rows" | "greenhouse" | "catacombs" | "yard" | "sodden" | "none" } {
  if (areaId === "kingarena") return { biome: "kingarena", darkness: 0.7, ambient: 0x140406, ambience: "catacombs" };
  switch (floor) {
    case "rows": return { biome: "rows", darkness: 0.14, ambient: 0x4a3018, ambience: "rows" };
    case "glass": return { biome: "greenhouse", darkness: 0.28, ambient: 0x16241e, ambience: "greenhouse" };
    case "stone": return { biome: "catacombs", darkness: 0.82, ambient: 0x05060a, ambience: "catacombs" };
    case "yard": return { biome: "yard", darkness: 0.46, ambient: 0x1e0a07, ambience: "yard" };
    case "bog": return { biome: "sodden", darkness: 0.62, ambient: 0x06100c, ambience: "sodden" };
    default: return { biome: "none", darkness: 0.2, ambient: 0x0a0a0e, ambience: "none" };
  }
}

export default function PixiStage() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("booting WebGL…");

  useEffect(() => {
    let destroyed = false;
    const cleanups: Array<() => void> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let app: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let audio: any = null;

    (async () => {
      const PIXI = await import("pixi.js");
      const { Application, Container, UPDATE_PRIORITY } = PIXI;
      const { Sim } = await import("@/game/sim/Sim");
      const { EMPTY_INPUT } = await import("@/game/sim/types");
      const { AREAS } = await import("@/game/sim/content");
      const sprites = await import("@/game/render/sprites");
      const vfxMod = await import("@/game/render/vfx");
      const { LightLayer } = await import("@/game/render/lighting");
      const { GroundLayer } = await import("@/game/render/env");
      const { PropLayer } = await import("@/game/render/props");
      const { WorldFxLayer } = await import("@/game/render/worldfx");
      const { Hud } = await import("@/game/render/hud");
      const { WeaponView } = await import("@/game/render/weapon");
      const { CombatUiLayer } = await import("@/game/render/combatui");
      const { Audio } = await import("@/game/audio/audio");

      app = new Application();
      await app.init({ resizeTo: window, background: 0x07_05_04, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
      if (destroyed) { app.destroy(true); return; }
      const renderer: Renderer = app.renderer;
      hostRef.current?.appendChild(app.canvas);

      setStatus("loading the rows…");
      await sprites.loadCreatures(ROOM_CREATURES);
      await sprites.loadVfx(VFX_TO_LOAD);
      if (destroyed) { app.destroy(true); return; }
      setStatus("");

      const sw = () => app.renderer.width / app.renderer.resolution;
      const sh = () => app.renderer.height / app.renderer.resolution;

      // ---- world layers ----
      const world: InstanceType<typeof Container> = new Container();
      app.stage.addChild(world);
      const ground: GroundLayer = new GroundLayer();
      const props: PropLayer = new PropLayer();
      const entityLayer: InstanceType<typeof Container> = new Container();
      entityLayer.sortableChildren = true;
      const worldFx: WorldFxLayer = new WorldFxLayer();
      const fx: ParticleSystem = new vfxMod.ParticleSystem(1800);
      const combatUi: CombatUiLayer = new CombatUiLayer();
      world.addChild(ground, props, entityLayer, worldFx, fx, combatUi);
      ground.init(renderer); props.init(renderer); worldFx.init(renderer); fx.init(renderer); combatUi.init(renderer);
      if (process.env.NODE_ENV !== "production") (window as any).__combatUi = combatUi;

      let grade = vfxMod.gradeFor("rows");
      world.filters = [grade];

      // ---- screen overlays ----
      const lights: LightLayer = new LightLayer(sw(), sh(), 0.5);
      const vignette: Vignette = vfxMod.makeVignette(sw(), sh(), 0.42);
      const flash: FlashOverlay = new vfxMod.FlashOverlay(sw(), sh());
      const hud: Hud = new Hud();
      app.stage.addChild(lights, vignette, flash, hud);
      hud.init(renderer); hud.resize(sw(), sh());

      const shake: ScreenShake = new vfxMod.ScreenShake(18, 1.4);
      audio = new Audio();
      const sim: Sim = new Sim({ seed: 0xC0FFEE });
      let simPaused = false;
      let dbgSwing: number | null = null;
      if (process.env.NODE_ENV !== "production")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__g = { sim, get state() { return sim.getState(); }, app, setPaused: (v: boolean) => { simPaused = v; }, setSwing: (v: number | null) => { dbgSwing = v; } };

      // ---- input ----
      const held = new Set<string>();
      const pressed = new Set<string>();
      let mouseX = 0, mouseY = 0, lmbDown = false, rmbDown = false, lmbPressed = false, started = false;
      const startAudio = () => { if (!started) { started = true; audio.resume(); audio.startMusic(); } };
      const onKD = (e: KeyboardEvent) => { if (["Space", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault(); if (!held.has(e.code)) pressed.add(e.code); held.add(e.code); startAudio(); };
      const onKU = (e: KeyboardEvent) => held.delete(e.code);
      const onMM = (e: MouseEvent) => { const r = app.canvas.getBoundingClientRect(); mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; };
      const onMD = (e: MouseEvent) => { if (e.button === 0) { lmbDown = true; lmbPressed = true; } if (e.button === 2) rmbDown = true; startAudio(); };
      const onMU = (e: MouseEvent) => { if (e.button === 0) lmbDown = false; if (e.button === 2) rmbDown = false; };
      const onCtx = (e: Event) => e.preventDefault();
      const onBlur = () => { held.clear(); lmbDown = rmbDown = false; };
      window.addEventListener("keydown", onKD); window.addEventListener("keyup", onKU);
      app.canvas.addEventListener("mousemove", onMM); app.canvas.addEventListener("mousedown", onMD);
      window.addEventListener("mouseup", onMU); app.canvas.addEventListener("contextmenu", onCtx); window.addEventListener("blur", onBlur);
      cleanups.push(() => { window.removeEventListener("keydown", onKD); window.removeEventListener("keyup", onKU); app.canvas.removeEventListener("mousemove", onMM); app.canvas.removeEventListener("mousedown", onMD); window.removeEventListener("mouseup", onMU); app.canvas.removeEventListener("contextmenu", onCtx); window.removeEventListener("blur", onBlur); });
      void lmbDown;

      // ---- camera + area ----
      let camX = 0, camY = 0, curArea = "";
      const enterArea = (area: AreaDef) => {
        ground.build(area); props.build(area);
        const b = biomeFor(area.id, area.floor);
        grade = vfxMod.gradeFor(b.biome); world.filters = [grade];
        lights.setDarkness(b.darkness); lights.setAmbient(b.ambient); audio.setAmbience(b.ambience);
        hud.showToast(area.name, area.subtitle);
        const boss = BOSS_OF_AREA[area.id];
        if (boss) void sprites.loadCreatures([boss]); // lazy-load boss sprites
      };

      // ---- actors ----
      const actors = new Map<number, ActorSprite>();
      const playerActor: ActorSprite = new sprites.ActorSprite("player");
      entityLayer.addChild(playerActor);
      const weaponView: WeaponView = new WeaponView();
      entityLayer.addChild(weaponView);
      const syncActor = (e: Entity) => {
        let a = actors.get(e.id);
        if (!a) { a = new sprites.ActorSprite(e.kind as Creature); actors.set(e.id, a); entityLayer.addChild(a); }
        a.x = e.x; a.y = e.y; a.zIndex = e.y;
        a.setFacing(e.facingFlip ? -1 : 1);
        // (re)bind the clip when the state changes OR when frames weren't loaded yet
        // (lazy-loaded boss sprites arrive a beat after the entity spawns)
        const cur = a.animatedSprite;
        const hasFrames = !!cur && cur.totalFrames > 0;
        if (a.state !== e.animState || !hasFrames) a.play(e.animState);
        const spr = a.animatedSprite; if (spr) spr.tint = e.hurtT > 0 ? 0xffaaaa : 0xffffff;
      };

      // ---- events → fx + audio ----
      const handleEvents = () => {
        for (const ev of sim.drainEvents()) {
          combatUi.pushEvent(ev); // floating numbers / callouts (ignores non-combat types)
          switch (ev.type) {
            case "hit": fx.emit("spark", ev.x, ev.y, { count: ev.crit ? 16 : 9 }); fx.emit("blood", ev.x, ev.y, { count: ev.crit ? 12 : 7 }); audio.hit(); shake.add((ev.big ? 12 : 6) / 18); break;
            case "playerHit": fx.emit("blood", ev.x, ev.y, { count: 9 }); audio.enemyHurt(); shake.add(8 / 18); flash.flash(0x7a1414, Math.min(0.32, (ev.amount ?? 10) / 60)); break;
            case "death": fx.emit("death", ev.x, ev.y, { count: 22 }); audio.splat(); shake.add(6 / 18); break;
            case "bossDeath": { const s = sprites.makeVfxSprite("bossDeath", { scale: 0.18, autoDestroy: true }); if (s) { s.x = ev.x; s.y = ev.y; world.addChild(s); } fx.emit("sapglow", ev.x, ev.y, { count: 40 }); audio.death(); audio.coinShower(); shake.add(1); flash.flash(0xffd56b, 0.4); break; }
            case "parry": { const s = sprites.makeVfxSprite("parryFlash", { scale: 0.12, autoDestroy: true }); if (s) { s.x = ev.x; s.y = ev.y; world.addChild(s); } audio.parryFlash(); flash.flash(0xcfe6a0, 0.22); shake.add(4 / 18); break; }
            case "riposte": audio.riposte(); fx.emit("spark", ev.x, ev.y, { count: 14 }); break;
            case "backstab": audio.backstab(); fx.emit("spark", ev.x, ev.y, { count: 12 }); break;
            case "block": audio.parry(); fx.emit("spark", ev.x, ev.y, { count: 6, color: 0xcfe6a0 }); break;
            case "guardBreak": audio.guardBreak(); shake.add(10 / 18); break;
            case "stagger": fx.emit("spark", ev.x, ev.y, { count: 10 }); audio.guardBreak(); break;
            case "bossPhase": audio.bossPhase(); shake.add(1); break;
            case "bossRoar": audio.bossRoar(); break;
            case "sap": audio.sap(); break;
            case "sapReclaim": audio.coinShower(); fx.emit("sapglow", ev.x, ev.y, { count: 18 }); break;
            case "poison": fx.emit("poison", ev.x, ev.y, { count: 5 }); audio.poison(); break;
            case "heal": { const s = sprites.makeVfxSprite("healMotes", { scale: 0.12, autoDestroy: true }); if (s) { s.x = ev.x; s.y = ev.y; world.addChild(s); } fx.emit("heal", ev.x, ev.y, { count: 14 }); audio.heal(); break; }
            case "roll": fx.emit("dust", ev.x, ev.y, { count: 6 }); audio.roll(); break;
            case "swing": audio.swing(); break;
            case "shoot": fx.emit("muzzle", ev.x, ev.y, { color: 0x9fd44e }); break;
            case "pickup": audio.pickup(); fx.emit("sapglow", ev.x, ev.y, { count: 8 }); break;
            case "levelUp": { const s = sprites.makeVfxSprite("levelUp", { scale: 0.12, autoDestroy: true }); if (s) { s.x = ev.x; s.y = ev.y; world.addChild(s); } audio.levelUp(); break; }
            case "bonfire": audio.bonfire(); fx.emit("ember", ev.x, ev.y, { count: 24 }); break;
            case "weaponSwitch": audio.weaponSwitch(); break;
            case "areaChange": audio.warp(); break;
            case "uiMove": audio.uiMove(); break;
            case "uiSelect": audio.uiSelect(); break;
          }
        }
      };

      // ---- music ----
      let musicMode = "explore";
      const updateMusic = (st: WorldState) => {
        let want = "explore";
        if (st.boss && st.boss.active) want = "boss";
        else for (const e of st.entities) { if (e.flags.dead) continue; const dx = e.x - st.player.entity.x, dy = e.y - st.player.entity.y; if (dx * dx + dy * dy < 600 * 600 && (e.flags.attacking || e.flags.windup)) { want = "combat"; break; } }
        if (want !== musicMode) { musicMode = want; audio.setMusicMode(want); }
      };

      let footAccum = 0;

      // ---- loop ----
      app.ticker.add((tk: { deltaMS: number }) => {
        const dtMS = tk.deltaMS, dt = Math.min(dtMS / 1000, 0.05), t = app.ticker.lastTime / 1000;
        const aimX = (mouseX - world.x) / ZOOM, aimY = (mouseY - world.y) / ZOOM;
        let mx = 0, my = 0;
        if (held.has("KeyW") || held.has("ArrowUp")) my -= 1;
        if (held.has("KeyS") || held.has("ArrowDown")) my += 1;
        if (held.has("KeyA") || held.has("ArrowLeft")) mx -= 1;
        if (held.has("KeyD") || held.has("ArrowRight")) mx += 1;
        const input: InputState = { ...EMPTY_INPUT, moveX: mx, moveY: my, aimX, aimY, lightPressed: lmbPressed || pressed.has("KeyJ"), heavyPressed: pressed.has("KeyF") || pressed.has("KeyK"), rollPressed: pressed.has("Space"), lockOnPressed: pressed.has("Tab") || pressed.has("KeyQ"), healPressed: pressed.has("KeyR") || pressed.has("KeyH"), interactPressed: pressed.has("KeyE"), weapon1Pressed: pressed.has("Digit1"), weapon2Pressed: pressed.has("Digit2"), weapon3Pressed: pressed.has("Digit3"), weapon4Pressed: pressed.has("Digit4"), guardHeld: rmbDown };

        if (!simPaused) sim.update(dt, input);
        const st = sim.getState();

        if (st.areaId !== curArea) { curArea = st.areaId; const area = AREAS[curArea]; if (area) enterArea(area); }

        // player
        const pe = st.player.entity;
        playerActor.x = pe.x; playerActor.y = pe.y; playerActor.zIndex = pe.y;
        playerActor.setFacing(pe.facingFlip ? -1 : 1);
        if (playerActor.state !== pe.animState) playerActor.play(pe.animState);
        playerActor.visible = st.screen !== "dead";

        // held weapon — positioned at the hand, rotated to aim, swing from the attack clip
        const attacking = pe.animState === "lightAttack" || pe.animState === "heavyAttack";
        let swing = 0;
        if (attacking) { const spr = playerActor.animatedSprite; swing = spr && spr.totalFrames > 1 ? spr.currentFrame / (spr.totalFrames - 1) : 0.5; }
        weaponView.visible = st.screen !== "dead";
        weaponView.setWeapon(st.player.weapon);
        weaponView.x = pe.x - 8; weaponView.y = pe.y - 8; weaponView.rotation = pe.facing; // hand offset (body now centered on the point)
        weaponView.zIndex = pe.y + 0.5;
        weaponView.update(dbgSwing != null ? dbgSwing : swing, pe.animState === "heavyAttack", t);

        // enemies
        const seen = new Set<number>();
        for (const e of st.entities) { if (e.flags.dead && !actors.has(e.id)) continue; seen.add(e.id); syncActor(e); }
        for (const [id, a] of actors) { if (!seen.has(id)) { a.destroy(); actors.delete(id); } }

        // dressing + world fx
        ground.update(t); props.update(t); worldFx.update(st, t);
        handleEvents();
        combatUi.update(st, dt, t);

        // footsteps
        if ((mx !== 0 || my !== 0) && st.screen === "play") { footAccum += Math.hypot(pe.vx, pe.vy) * dt; if (footAccum > 34) { footAccum = 0; const fl = (AREAS[curArea]?.floor === "bog" ? "soil" : AREAS[curArea]?.floor) as "soil" | "rows" | "glass" | "stone" | "yard"; audio.footstep(fl || "soil"); fx.emit("dust", pe.x, pe.y + 12, { count: 2 }); } }
        updateMusic(st);

        // camera
        const hw = sw() / 2 / ZOOM, hh = sh() / 2 / ZOOM;
        camX = st.areaW > hw * 2 ? Math.max(hw, Math.min(st.areaW - hw, pe.x)) : st.areaW / 2;
        camY = st.areaH > hh * 2 ? Math.max(hh, Math.min(st.areaH - hh, pe.y)) : st.areaH / 2;
        shake.update(dtMS);
        world.scale.set(ZOOM);
        world.x = Math.round(sw() / 2 - camX * ZOOM + shake.x);
        world.y = Math.round(sh() / 2 - camY * ZOOM + shake.y);

        fx.update(dtMS); flash.update(dtMS);
        const lightList: Array<{ x: number; y: number; radius: number; color: number; intensity: number; flicker?: number }> = [{ x: pe.x, y: pe.y, radius: 340, color: 0xffe6b0, intensity: 1.15, flicker: 0.1 }];
        for (const l of props.lights()) lightList.push(l);
        for (const p of st.projectiles) lightList.push({ x: p.x, y: p.y, radius: 80, color: parseInt((p.color || "#9fd44e").slice(1), 16), intensity: 0.6 });
        if (st.boss && st.boss.active) { const be = st.entities.find((e) => e.id === st.boss!.id); if (be) lightList.push({ x: be.x, y: be.y, radius: 170, color: 0xff7a3a, intensity: 0.85, flicker: 0.5 }); }
        lights.setCamera(camX, camY, ZOOM, sw(), sh());
        lights.setLights(lightList);
        lights.update(dtMS, t, renderer);

        hud.update(st, sw(), sh(), dt);

        pressed.clear(); lmbPressed = false;
      }, null, UPDATE_PRIORITY.HIGH);

      const onResize = () => { lights.resize(sw(), sh()); vignette.resize(sw(), sh()); flash.resize(sw(), sh()); hud.resize(sw(), sh()); };
      app.renderer.on("resize", onResize);
      setStatus("");
    })();

    return () => { destroyed = true; for (const c of cleanups) c(); try { audio?.destroy?.(); } catch {} try { app?.destroy(true, { children: true }); } catch {} };
  }, []);

  return (
    <div className="stage-root" ref={hostRef}>
      {status && <div className="stage-hud">{status}</div>}
      <Link href="/" className="stage-back">← title</Link>
    </div>
  );
}
