// Procedural audio for "Tommy Tomato: Harvest Souls".
// Everything is synthesized at runtime — no asset files, so it stays a static deploy.
//
// Architecture (all built lazily on first user gesture inside ensure()):
//   destination
//     └── limiter (DynamicsCompressor, brickwall-ish) ── master gain
//           ├── reverb (Convolver, procedural impulse) ── reverbReturn gain
//           ├── delay (feedback) ── delayReturn gain
//           ├── musicBus   gain  ── (3 crossfading layer beds)
//           ├── sfxBus     gain  ── (one-shot envelopes; reverb/delay sends)
//           └── ambienceBus gain ── (one looping biome bed at a time)
//
// SFX go through the sfxBus and may post a "send" to the reverb / delay returns
// so transients sit in a believable space. Repeated SFX (hits, swings, steps)
// get small pitch + timing jitter so they never sound machine-stamped.

type Wave = OscillatorType;

type MusicMode = "explore" | "combat" | "boss";
type Ambience = "rows" | "greenhouse" | "catacombs" | "yard" | "sodden" | "none";
type Floor = "soil" | "rows" | "glass" | "stone" | "yard";

// One self-contained looping ambience bed: its own sub-gain plus the live nodes
// we must stop/disconnect when it crossfades out.
interface AmbienceBed {
  gain: GainNode;
  nodes: AudioScheduledSourceNode[];
  cleanups: (() => void)[];
}

// One adaptive-music layer: a sub-gain (faded by mode) plus its persistent voices.
interface MusicLayer {
  gain: GainNode;
  voices: AudioScheduledSourceNode[];
}

const MASTER_VOL = 0.82;

export class Audio {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  musicGain: GainNode | null = null; // music bus (kept as public name for compatibility)
  sfxGain: GainNode | null = null; // sfx bus (kept as public name for compatibility)
  ambienceGain: GainNode | null = null; // ambience bus

  // sends / shared space
  private limiter: DynamicsCompressorNode | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private delay: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private delayReturn: GainNode | null = null;

  enabled = true;
  private started = false;

  // adaptive music state
  private musicMode: MusicMode = "explore";
  private layers: Partial<Record<MusicMode, MusicLayer>> = {};
  private musicTimer: number | null = null; // explore plucks
  private combatTimer: number | null = null; // combat pulse
  private bossTimer: number | null = null; // boss ostinato + drums

  // ambience state
  private ambienceKind: Ambience = "none";
  private ambienceBed: AmbienceBed | null = null;

  // ---- lazy graph construction (first user gesture) ----
  ensure() {
    if (this.ctx) return;
    const AC =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx: AudioContext = new AC();
    this.ctx = ctx;

    // master -> limiter -> destination. The limiter is the last thing before
    // the speakers so nothing the game throws at it can clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 2;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    limiter.connect(ctx.destination);
    this.limiter = limiter;

    const master = ctx.createGain();
    master.gain.value = this.enabled ? MASTER_VOL : 0.0;
    master.connect(limiter);
    this.master = master;

    // shared reverb (procedural impulse response — a decaying noise burst)
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(2.6, 2.4);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;
    reverb.connect(reverbReturn);
    reverbReturn.connect(master);
    this.reverb = reverb;
    this.reverbReturn = reverbReturn;

    // shared feedback delay (slap/echo send), gently rolled off in the loop
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.26;
    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.34;
    const delayDamp = ctx.createBiquadFilter();
    delayDamp.type = "lowpass";
    delayDamp.frequency.value = 2600;
    const delayReturn = ctx.createGain();
    delayReturn.gain.value = 0.5;
    delay.connect(delayDamp);
    delayDamp.connect(delayFeedback);
    delayFeedback.connect(delay); // feedback loop
    delay.connect(delayReturn);
    delayReturn.connect(master);
    this.delay = delay;
    this.delayFeedback = delayFeedback;
    this.delayReturn = delayReturn;

    // ---- buses ----
    const musicGain = ctx.createGain();
    musicGain.gain.value = 0.0; // faded in by startMusic()
    musicGain.connect(master);
    this.musicGain = musicGain;

    const sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(master);
    this.sfxGain = sfxGain;

    const ambienceGain = ctx.createGain();
    ambienceGain.gain.value = 0.0; // faded in by setAmbience()
    ambienceGain.connect(master);
    this.ambienceGain = ambienceGain;
  }

  resume() {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (this.master && this.ctx) {
      // smooth so toggling mute doesn't pop
      const t = this.now();
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(on ? MASTER_VOL : 0.0, t + 0.08);
    } else if (this.master) {
      this.master.gain.value = on ? MASTER_VOL : 0.0;
    }
  }

  private now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // small symmetric jitter helper for de-roboticizing repeated SFX
  private jit(amt: number) {
    return 1 + (Math.random() * 2 - 1) * amt;
  }

  // ---- procedural reverb impulse: exponentially-decaying stereo noise ----
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        // a touch of early-reflection sparseness then a smooth tail
        const env = Math.pow(1 - i / len, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  // ---- core voice: a single enveloped oscillator ----
  // send: 0..1 dry-relative amount routed to the reverb return.
  private tone(
    freq: number,
    dur: number,
    type: Wave,
    vol: number,
    glideTo?: number,
    dest?: AudioNode,
    send = 0,
    attack = 0.008
  ) {
    if (!this.ctx || !this.enabled) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo)
      o.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest || this.sfxGain!);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = vol * send;
      g.connect(s);
      s.connect(this.reverb);
    }
    o.start(t);
    o.stop(t + dur + 0.03);
    o.onended = () => {
      try {
        o.disconnect();
        g.disconnect();
      } catch {}
    };
  }

  // ---- core voice: filtered noise burst ----
  private noise(
    dur: number,
    vol: number,
    cutoff: number,
    sweepTo?: number,
    type: BiquadFilterType = "lowpass",
    dest?: AudioNode,
    send = 0,
    q = 0.7
  ) {
    if (!this.ctx || !this.enabled) return;
    const t = this.now();
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(cutoff, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest || this.sfxGain!);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = vol * send;
      g.connect(s);
      s.connect(this.reverb);
    }
    src.start(t);
    src.stop(t + dur + 0.03);
    src.onended = () => {
      try {
        src.disconnect();
        f.disconnect();
        g.disconnect();
      } catch {}
    };
  }

  // a short percussive "body" thump (used by hits / impacts)
  private thump(freq: number, dur: number, vol: number, dest?: AudioNode, send = 0) {
    if (!this.ctx || !this.enabled) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq * 2.2, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(24, freq), t + dur * 0.6);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest || this.sfxGain!);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = vol * send;
      g.connect(s);
      s.connect(this.reverb);
    }
    o.start(t);
    o.stop(t + dur + 0.03);
    o.onended = () => {
      try {
        o.disconnect();
        g.disconnect();
      } catch {}
    };
  }

  // route a node briefly to the delay send
  private toDelay(node: AudioNode, amount: number) {
    if (!this.ctx || !this.delay) return;
    const s = this.ctx.createGain();
    s.gain.value = amount;
    node.connect(s);
    s.connect(this.delay);
  }

  // ============================================================
  //  SFX
  // ============================================================

  swing() {
    this.ensure();
    const c = 1800 * this.jit(0.18);
    this.noise(0.15, 0.16, c, 520 * this.jit(0.1), "bandpass");
    this.tone(420 * this.jit(0.08), 0.09, "triangle", 0.05, 220);
  }

  // satisfying transient (click) + tonal body + low thump, light room send
  hit() {
    this.ensure();
    const p = this.jit(0.1);
    this.noise(0.04, 0.4, 5200 * p, 1800, "highpass"); // transient crack
    this.noise(0.1, 0.22, 1100 * p, 280); // meaty body
    this.thump(150 * p, 0.13, 0.28, this.sfxGain!, 0.12); // low punch
    this.tone(190 * p, 0.1, "square", 0.08, 95);
  }

  splat() {
    this.ensure();
    const p = this.jit(0.12);
    this.noise(0.22, 0.36, 900 * p, 170, "lowpass", this.sfxGain!, 0.14);
    this.thump(110 * p, 0.18, 0.22);
    this.tone(120 * p, 0.18, "sawtooth", 0.08, 56);
  }

  // generic dodge roll — improved into a directional cloth whoosh
  roll() {
    this.dodgeWhoosh();
  }

  // a fuller cloth/air whoosh with a rising-then-falling filter
  dodgeWhoosh() {
    this.ensure();
    const p = this.jit(0.12);
    this.noise(0.26, 0.16, 600 * p, 2000 * p, "bandpass", this.sfxGain!, 0.05, 1.2);
    this.noise(0.18, 0.08, 1800, 500, "lowpass");
  }

  parry() {
    this.ensure();
    const p = this.jit(0.05);
    // bright metallic shing with room + delay shimmer
    this.tone(1500 * p, 0.18, "triangle", 0.2, 2600, this.sfxGain!, 0.25);
    this.tone(2300 * p, 0.12, "triangle", 0.1, 3200, this.sfxGain!, 0.25);
    this.tone(940 * p, 0.1, "square", 0.08);
    this.noise(0.05, 0.18, 6000, 9000, "highpass");
  }

  // distinct, flashier parry confirm (use the instant a parry "lands")
  parryFlash() {
    this.ensure();
    this.tone(2600, 0.16, "triangle", 0.16, 3600, this.sfxGain!, 0.3);
    this.tone(1730, 0.14, "triangle", 0.12, 2300, this.sfxGain!, 0.3);
    this.noise(0.06, 0.2, 7000, 11000, "highpass", this.sfxGain!, 0.2);
  }

  // hold/raise guard — soft leathery brace (used when block begins)
  block() {
    this.ensure();
    this.noise(0.12, 0.16, 700, 240, "lowpass");
    this.tone(160, 0.1, "sine", 0.08, 120);
  }

  // guard shattered — harsh metallic crack + sour low tone
  guardBreak() {
    this.ensure();
    this.noise(0.18, 0.3, 3000, 800, "bandpass", this.sfxGain!, 0.18);
    this.tone(300, 0.3, "sawtooth", 0.16, 90, this.sfxGain!, 0.15);
    this.tone(150, 0.34, "square", 0.12, 70);
  }

  // critical hit (parry punish): a crisp "shing" then a heavy "thump"
  riposte() {
    this.ensure();
    this.tone(1900, 0.1, "triangle", 0.18, 2800, this.sfxGain!, 0.2); // shing
    this.noise(0.04, 0.3, 6000, 2000, "highpass");
    setTimeout(() => {
      this.thump(90, 0.26, 0.34, this.sfxGain!, 0.18); // delayed thump
      this.noise(0.14, 0.28, 800, 160, "lowpass", this.sfxGain!, 0.18);
      this.tone(140, 0.2, "sawtooth", 0.12, 60);
    }, 70);
  }

  // backstab: muffled cloth thud + dull crunch (sneakier than riposte)
  backstab() {
    this.ensure();
    this.noise(0.16, 0.26, 1400, 300, "lowpass", this.sfxGain!, 0.1);
    this.thump(120, 0.2, 0.28, this.sfxGain!, 0.14);
    this.tone(200, 0.12, "triangle", 0.08, 90);
  }

  // wet bubbling poison application / tick
  poison() {
    this.ensure();
    const n = 4;
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const f = 240 * this.jit(0.4);
        this.tone(f, 0.14, "sine", 0.06, f * 1.8, this.sfxGain!, 0.08);
      }, i * 70 + Math.random() * 30);
    }
    this.noise(0.3, 0.06, 500, 220, "bandpass");
  }

  // swapping weapons — sheath rasp + soft mechanical click
  weaponSwitch() {
    this.ensure();
    this.noise(0.12, 0.14, 2400, 900, "bandpass");
    this.tone(620, 0.05, "square", 0.07, 760);
    setTimeout(() => this.tone(900, 0.05, "square", 0.06, 720), 60);
  }

  heal() {
    this.ensure();
    this.tone(440, 0.2, "sine", 0.13, 660, this.musicGain ?? undefined, 0.0);
    this.tone(440, 0.2, "sine", 0.13, 660, this.sfxGain!, 0.18);
    this.tone(660, 0.28, "sine", 0.11, 880, this.sfxGain!, 0.2);
    // a soft glassy bloom on top
    this.tone(990, 0.34, "triangle", 0.05, 1180, this.sfxGain!, 0.25);
  }

  pickup() {
    this.ensure();
    this.tone(740, 0.08, "square", 0.11, 980, this.sfxGain!, 0.1);
    this.tone(980, 0.1, "square", 0.09, 1240, this.sfxGain!, 0.1);
  }

  sap() {
    this.ensure();
    this.tone(523, 0.06, "triangle", 0.09, undefined, this.sfxGain!, 0.08);
    this.tone(784, 0.08, "triangle", 0.08, undefined, this.sfxGain!, 0.08);
  }

  // big reward jingle / many coins (use for husk reclaim or large sap gains)
  coinShower() {
    this.ensure();
    const notes = [784, 988, 1175, 1318, 1568];
    const n = 9;
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const f = notes[Math.floor(Math.random() * notes.length)] * this.jit(0.02);
        this.tone(f, 0.12, "triangle", 0.07, f * 1.05, this.sfxGain!, 0.18);
      }, i * 55 + Math.random() * 25);
    }
    this.tone(392, 0.5, "sine", 0.06, 523, this.sfxGain!, 0.2);
  }

  levelUp() {
    this.ensure();
    // rising arpeggio with reverb tail — feels ceremonial
    [523, 659, 784, 1046].forEach((f, i) =>
      setTimeout(
        () => this.tone(f, 0.24, "triangle", 0.15, f * 1.01, this.sfxGain!, 0.3),
        i * 95
      )
    );
    setTimeout(() => this.tone(196, 0.9, "sine", 0.07, 261, this.sfxGain!, 0.3), 60);
  }

  bonfire() {
    this.ensure();
    // warm swelling drone-y rest cue, lots of room
    this.tone(196, 0.6, "sine", 0.1, 261, this.sfxGain!, 0.35);
    this.tone(261, 0.8, "sine", 0.08, 329, this.sfxGain!, 0.35);
    this.tone(392, 0.7, "triangle", 0.04, 466, this.sfxGain!, 0.4);
    // crackle
    this.noise(0.7, 0.05, 1800, 600, "bandpass");
  }

  // bonfire teleport / warp whoosh — long descending swept noise + tonal sweep
  warp() {
    this.ensure();
    this.noise(0.7, 0.22, 4000, 200, "lowpass", this.sfxGain!, 0.3, 1.4);
    this.tone(800, 0.6, "sine", 0.1, 90, this.sfxGain!, 0.35);
    this.tone(400, 0.6, "triangle", 0.06, 60, this.sfxGain!, 0.35);
  }

  death() {
    this.ensure();
    // final, heavy: low sawtooth collapse + sub thump + long reverberant noise
    this.tone(220, 1.3, "sawtooth", 0.2, 48, this.sfxGain!, 0.3);
    this.tone(110, 1.4, "sine", 0.16, 36, this.sfxGain!, 0.3);
    this.thump(70, 0.5, 0.3, this.sfxGain!, 0.3);
    this.noise(1.2, 0.16, 600, 90, "lowpass", this.sfxGain!, 0.4);
    // a mournful falling minor third on top
    setTimeout(
      () => this.tone(311, 1.0, "triangle", 0.07, 233, this.sfxGain!, 0.4),
      120
    );
  }

  bossRoar() {
    this.ensure();
    // huge layered roar with growl, room, and delay
    this.tone(88, 1.2, "sawtooth", 0.26, 58, this.sfxGain!, 0.3);
    this.tone(132, 0.95, "square", 0.12, 70, this.sfxGain!, 0.25);
    const g = this.ctx?.createGain();
    this.noise(1.15, 0.28, 520, 80, "lowpass", this.sfxGain!, 0.35);
    if (g) {
      // a slow growl wobble via a sub oscillator
      this.tone(60, 1.1, "sawtooth", 0.14, 44, this.sfxGain!, 0.3);
    }
  }

  // phase-change stinger (use when a boss enters phase 2)
  bossPhase() {
    this.ensure();
    // descending dissonant swell + impact
    this.tone(330, 0.7, "sawtooth", 0.14, 110, this.sfxGain!, 0.3);
    this.tone(349, 0.7, "sawtooth", 0.12, 116, this.sfxGain!, 0.3); // minor-2nd clash
    this.thump(80, 0.4, 0.3, this.sfxGain!, 0.25);
    this.noise(0.5, 0.2, 1400, 200, "bandpass", this.sfxGain!, 0.25);
    setTimeout(() => this.bossRoar(), 120);
  }

  enemyHurt() {
    this.ensure();
    const p = this.jit(0.12);
    this.tone(320 * p, 0.08, "square", 0.1, 180);
    this.noise(0.05, 0.12, 2200, 700, "bandpass");
  }

  // ---- heavy attack charge (hold) / release ----
  chargeUp() {
    this.ensure();
    // rising tension whine that swells over ~0.6s
    this.tone(120, 0.6, "sawtooth", 0.07, 480, this.sfxGain!, 0.1);
    this.tone(180, 0.6, "triangle", 0.05, 540, this.sfxGain!, 0.1);
  }
  chargeRelease() {
    this.ensure();
    this.noise(0.06, 0.34, 5000, 1600, "highpass");
    this.thump(120, 0.22, 0.32, this.sfxGain!, 0.15);
    this.tone(300, 0.18, "sawtooth", 0.12, 90, this.sfxGain!, 0.12);
    this.swing();
  }

  // ---- footsteps (per floor material, pitch + level jittered) ----
  footstep(floor: Floor = "soil") {
    this.ensure();
    if (!this.ctx || !this.enabled) return;
    const p = this.jit(0.16);
    switch (floor) {
      case "glass":
        // light tink + airy tail
        this.tone(2200 * p, 0.05, "triangle", 0.05, 2600);
        this.noise(0.05, 0.05, 4000 * p, 2000, "highpass");
        break;
      case "stone":
        // hard scuff with a touch of room
        this.noise(0.07, 0.1, 1600 * p, 500, "bandpass", this.sfxGain!, 0.08);
        this.thump(110 * p, 0.06, 0.06);
        break;
      case "yard":
        // dry dirt + faint metal grit
        this.noise(0.08, 0.09, 900 * p, 300, "lowpass");
        this.noise(0.04, 0.03, 3000 * p, 1500, "bandpass");
        break;
      case "rows":
        // crunchy soil + leaf rustle
        this.noise(0.09, 0.1, 1100 * p, 350, "lowpass");
        this.noise(0.05, 0.04, 2600 * p, 1200, "highpass");
        break;
      case "soil":
      default:
        // soft muffled earth
        this.noise(0.08, 0.09, 800 * p, 280, "lowpass");
        this.thump(90 * p, 0.05, 0.04);
        break;
    }
  }

  uiMove() {
    this.ensure();
    this.tone(520, 0.04, "square", 0.05);
  }
  uiSelect() {
    this.ensure();
    this.tone(700, 0.07, "square", 0.08, 900);
  }

  // optional generic UI helper
  playUi(kind: "move" | "select" | "back" | "error" = "move") {
    this.ensure();
    switch (kind) {
      case "select":
        return this.uiSelect();
      case "back":
        return this.tone(440, 0.06, "square", 0.06, 320);
      case "error":
        this.tone(220, 0.12, "square", 0.09, 180);
        return this.tone(180, 0.14, "square", 0.07, 150);
      case "move":
      default:
        return this.uiMove();
    }
  }

  // ============================================================
  //  ADAPTIVE MUSIC
  // ============================================================

  startMusic() {
    this.ensure();
    if (!this.ctx || this.started) return;
    this.started = true;
    this.musicMode = "explore";

    const t = this.now();
    this.musicGain!.gain.cancelScheduledValues(t);
    this.musicGain!.gain.setValueAtTime(0.0001, t);
    this.musicGain!.gain.exponentialRampToValueAtTime(0.5, t + 4);

    this.buildMusicLayers();
    this.applyMusicMode(this.musicMode, 0.01);

    this.scheduleExplore();
    this.scheduleCombat();
    this.scheduleBoss();
  }

  // Build the three persistent beds. Each has a layer-gain (0 = silent) that we
  // crossfade with setMusicMode; the actual sustained voices live underneath.
  private buildMusicLayers() {
    const ctx = this.ctx!;
    const make = (): MusicLayer => {
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.connect(this.musicGain!);
      return { gain: g, voices: [] };
    };
    const explore = make();
    const combat = make();
    const boss = make();
    this.layers = { explore, combat, boss };

    // ---- EXPLORE: sparse melancholy minor pad (low drone cluster) ----
    const droneFreqs = [55, 82.4, 110]; // A1, E2, A2 (open, minor-leaning)
    droneFreqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = i === 2 ? "triangle" : "sawtooth";
      o.frequency.value = f;
      g.gain.value = 0.05 - i * 0.012;
      const lfo = ctx.createOscillator();
      const lfoG = ctx.createGain();
      lfo.frequency.value = 0.05 + i * 0.03;
      lfoG.gain.value = 1.5;
      lfo.connect(lfoG);
      lfoG.connect(o.frequency);
      // gentle lowpass so the saws aren't buzzy
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 700;
      o.connect(lp);
      lp.connect(g);
      g.connect(explore.gain);
      // a little reverb on the pad
      const send = ctx.createGain();
      send.gain.value = 0.25;
      g.connect(send);
      send.connect(this.reverb!);
      o.start();
      lfo.start();
      explore.voices.push(o, lfo);
    });

    // ---- COMBAT: driving low pulse + a tense fifth above the drone ----
    {
      // throbbing sub pulse, amplitude-modulated by an LFO (the "drive")
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = 55; // A1
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 420;
      const amp = ctx.createGain();
      amp.gain.value = 0.0;
      const pulse = ctx.createOscillator(); // ~2.4 Hz heartbeat
      pulse.type = "sine";
      pulse.frequency.value = 2.4;
      const pulseDepth = ctx.createGain();
      pulseDepth.gain.value = 0.085;
      const pulseBias = ctx.createConstantSource();
      pulseBias.offset.value = 0.085;
      pulse.connect(pulseDepth);
      pulseDepth.connect(amp.gain);
      pulseBias.connect(amp.gain);
      o.connect(lp);
      lp.connect(amp);
      amp.connect(combat.gain);
      o.start();
      pulse.start();
      pulseBias.start();
      combat.voices.push(o, pulse, pulseBias);

      // tense sustained tritone-ish pad (Bb against the A drone) for unease
      const o2 = ctx.createOscillator();
      o2.type = "sawtooth";
      o2.frequency.value = 116.5; // ~Bb2
      const lp2 = ctx.createBiquadFilter();
      lp2.type = "lowpass";
      lp2.frequency.value = 600;
      const g2 = ctx.createGain();
      g2.gain.value = 0.03;
      o2.connect(lp2);
      lp2.connect(g2);
      g2.connect(combat.gain);
      const s2 = ctx.createGain();
      s2.gain.value = 0.2;
      g2.connect(s2);
      s2.connect(this.reverb!);
      o2.start();
      combat.voices.push(o2);
    }

    // ---- BOSS: dissonant cluster + a faster sub pulse (drums are scheduled) ----
    {
      const freqs = [55, 58.27, 87.31]; // A1 + Bb1 (clash) + E2 -> dread
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator();
        o.type = i === 1 ? "square" : "sawtooth";
        o.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 520;
        const g = ctx.createGain();
        g.gain.value = i === 1 ? 0.035 : 0.05;
        o.connect(lp);
        lp.connect(g);
        g.connect(boss.gain);
        const s = ctx.createGain();
        s.gain.value = 0.22;
        g.connect(s);
        s.connect(this.reverb!);
        o.start();
        boss.voices.push(o);
      });
    }
  }

  // crossfade layer gains to match the requested mode
  private applyMusicMode(mode: MusicMode, fade = 2.5) {
    if (!this.ctx) return;
    const t = this.now();
    // target gain per layer for each mode
    const targets: Record<MusicMode, Record<MusicMode, number>> = {
      explore: { explore: 1.0, combat: 0.0, boss: 0.0 },
      combat: { explore: 0.55, combat: 1.0, boss: 0.0 },
      boss: { explore: 0.0, combat: 0.4, boss: 1.0 },
    };
    (["explore", "combat", "boss"] as MusicMode[]).forEach((layerName) => {
      const layer = this.layers[layerName];
      if (!layer) return;
      const target = Math.max(0.0001, targets[mode][layerName]);
      const gp = layer.gain.gain;
      gp.cancelScheduledValues(t);
      gp.setValueAtTime(Math.max(0.0001, gp.value), t);
      gp.exponentialRampToValueAtTime(target, t + fade);
    });
  }

  setMusicMode(mode: MusicMode) {
    this.ensure();
    if (this.musicMode === mode) return;
    this.musicMode = mode;
    if (!this.started) return; // beds not built yet; mode is remembered for startMusic
    this.applyMusicMode(mode);
  }

  // ---- EXPLORE: sparse minor plucks (only audible when explore layer is up) ----
  private scheduleExplore() {
    const scale = [196, 233.08, 261.63, 293.66, 311.13, 392, 466.16];
    const step = () => {
      if (!this.ctx || !this.started) return;
      const audible = (this.layers.explore?.gain.gain.value ?? 0) > 0.15;
      if (this.enabled && audible && Math.random() < 0.55) {
        const f = scale[Math.floor(Math.random() * scale.length)];
        this.tone(
          f * (Math.random() < 0.3 ? 2 : 1),
          1.6,
          "triangle",
          0.05,
          undefined,
          this.layers.explore!.gain,
          0.3
        );
      }
      this.musicTimer = window.setTimeout(step, 1400 + Math.random() * 2600);
    };
    this.musicTimer = window.setTimeout(step, 2000);
  }

  // ---- COMBAT: a percussive low tom on a loose beat (only when combat layer up) ----
  private scheduleCombat() {
    const step = () => {
      if (!this.ctx || !this.started) return;
      const audible = (this.layers.combat?.gain.gain.value ?? 0) > 0.2;
      if (this.enabled && audible) {
        // soft tom hit through the combat layer
        this.thump(70 * this.jit(0.05), 0.18, 0.12, this.layers.combat!.gain, 0.15);
        if (Math.random() < 0.4)
          this.noise(0.06, 0.05, 3000, 1200, "highpass", this.layers.combat!.gain, 0.1);
      }
      this.combatTimer = window.setTimeout(step, 460 + Math.random() * 60);
    };
    this.combatTimer = window.setTimeout(step, 480);
  }

  // ---- BOSS: relentless ostinato + kick/snare pattern (only when boss layer up) ----
  private scheduleBoss() {
    const ost = [55, 55, 65.41, 55, 58.27, 55]; // A A C A Bb A — grim ostinato
    let i = 0;
    const step = () => {
      if (!this.ctx || !this.started) return;
      const audible = (this.layers.boss?.gain.gain.value ?? 0) > 0.2;
      if (this.enabled && audible) {
        const f = ost[i % ost.length];
        this.tone(f * 2, 0.22, "sawtooth", 0.06, undefined, this.layers.boss!.gain, 0.1);
        // kick every step, snare on the off-beats
        this.thump(58, 0.16, 0.16, this.layers.boss!.gain, 0.05);
        if (i % 2 === 1)
          this.noise(0.09, 0.12, 2400, 700, "bandpass", this.layers.boss!.gain, 0.12);
      }
      i++;
      this.bossTimer = window.setTimeout(step, 300);
    };
    this.bossTimer = window.setTimeout(step, 300);
  }

  // tense combat overlay sting when a boss appears (kept; routed via boss layer)
  bossMusicSting() {
    this.ensure();
    if (!this.ctx) return;
    const dest = this.layers.boss?.gain ?? this.musicGain!;
    this.tone(146.83, 2.5, "sawtooth", 0.06, undefined, dest, 0.3);
    this.tone(220, 2.5, "sawtooth", 0.05, undefined, dest, 0.3);
    this.tone(155.56, 2.5, "square", 0.03, undefined, dest, 0.3); // dissonant edge
  }

  stopMusic() {
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    if (this.combatTimer) {
      clearTimeout(this.combatTimer);
      this.combatTimer = null;
    }
    if (this.bossTimer) {
      clearTimeout(this.bossTimer);
      this.bossTimer = null;
    }
    if (this.musicGain && this.ctx) {
      const t = this.now();
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setValueAtTime(Math.max(0.0001, this.musicGain.gain.value), t);
      this.musicGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    }
    // stop & release the persistent layer voices shortly after the fade
    const layers = this.layers;
    this.layers = {};
    window.setTimeout(() => {
      (["explore", "combat", "boss"] as MusicMode[]).forEach((m) => {
        const layer = layers[m];
        if (!layer) return;
        for (const v of layer.voices) {
          try {
            v.stop();
          } catch {}
          try {
            v.disconnect();
          } catch {}
        }
        try {
          layer.gain.disconnect();
        } catch {}
      });
    }, 1700);
    this.started = false;
  }

  // ============================================================
  //  AMBIENCE (per-biome looping bed)
  // ============================================================

  setAmbience(kind: Ambience) {
    this.ensure();
    if (!this.ctx) return;
    if (this.ambienceKind === kind) return;
    this.ambienceKind = kind;

    // fade & tear down the current bed
    this.fadeOutAmbience();

    if (kind === "none") {
      if (this.ambienceGain) {
        const t = this.now();
        this.ambienceGain.gain.cancelScheduledValues(t);
        this.ambienceGain.gain.setValueAtTime(Math.max(0.0001, this.ambienceGain.gain.value), t);
        this.ambienceGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      }
      return;
    }

    const bed = this.buildAmbience(kind);
    this.ambienceBed = bed;

    const t = this.now();
    if (this.ambienceGain) {
      this.ambienceGain.gain.cancelScheduledValues(t);
      this.ambienceGain.gain.setValueAtTime(Math.max(0.0001, this.ambienceGain.gain.value), t);
      this.ambienceGain.gain.exponentialRampToValueAtTime(0.45, t + 2.0);
    }
    bed.gain.gain.setValueAtTime(0.0001, t);
    bed.gain.gain.exponentialRampToValueAtTime(1.0, t + 2.0);
  }

  private fadeOutAmbience() {
    const bed = this.ambienceBed;
    this.ambienceBed = null;
    if (!bed || !this.ctx) return;
    const t = this.now();
    bed.gain.gain.cancelScheduledValues(t);
    bed.gain.gain.setValueAtTime(Math.max(0.0001, bed.gain.gain.value), t);
    bed.gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    window.setTimeout(() => {
      for (const c of bed.cleanups) {
        try {
          c();
        } catch {}
      }
      for (const n of bed.nodes) {
        try {
          n.stop();
        } catch {}
        try {
          n.disconnect();
        } catch {}
      }
      try {
        bed.gain.disconnect();
      } catch {}
    }, 1800);
  }

  // a persistent filtered-noise source (the backbone of every bed)
  private ambienceNoise(
    bed: AmbienceBed,
    type: BiquadFilterType,
    cutoff: number,
    q: number,
    vol: number
  ): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } {
    const ctx = this.ctx!;
    // ~3s looping noise buffer (kept short; looped to save memory/CPU)
    const frames = Math.floor(ctx.sampleRate * 3);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f);
    f.connect(g);
    g.connect(bed.gain);
    src.start();
    bed.nodes.push(src);
    return { src, filter: f, gain: g };
  }

  // slow LFO -> AudioParam modulation (for wind swells, filter sweeps, etc.)
  private ambienceLFO(
    bed: AmbienceBed,
    target: AudioParam,
    rate: number,
    depth: number,
    type: Wave = "sine"
  ) {
    const ctx = this.ctx!;
    const lfo = ctx.createOscillator();
    lfo.type = type;
    lfo.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    lfo.connect(g);
    g.connect(target);
    lfo.start();
    bed.nodes.push(lfo);
  }

  private buildAmbience(kind: Ambience): AmbienceBed {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.ambienceGain!);
    const bed: AmbienceBed = { gain, nodes: [], cleanups: [] };

    switch (kind) {
      case "rows": {
        // dry wind (band-passed noise that slowly swells) + distant crow caws
        const wind = this.ambienceNoise(bed, "bandpass", 520, 1.2, 0.14);
        this.ambienceLFO(bed, wind.filter.frequency, 0.07, 220);
        this.ambienceLFO(bed, wind.gain.gain, 0.05, 0.06);
        bed.cleanups.push(this.startCaws(bed, 0.045));
        break;
      }
      case "greenhouse": {
        // humid glass hum (low sine bed) + irregular water drips
        const hum = ctx.createOscillator();
        hum.type = "sine";
        hum.frequency.value = 120;
        const humG = ctx.createGain();
        humG.gain.value = 0.05;
        const humLp = ctx.createBiquadFilter();
        humLp.type = "lowpass";
        humLp.frequency.value = 300;
        hum.connect(humLp);
        humLp.connect(humG);
        humG.connect(bed.gain);
        hum.start();
        bed.nodes.push(hum);
        // a faint airy high shimmer (glass)
        const shimmer = this.ambienceNoise(bed, "bandpass", 3200, 6, 0.025);
        this.ambienceLFO(bed, shimmer.filter.frequency, 0.13, 400);
        bed.cleanups.push(this.startDrips(bed));
        break;
      }
      case "catacombs": {
        // low cave rumble + sparse reverberant echo ticks
        const rumble = this.ambienceNoise(bed, "lowpass", 140, 0.7, 0.2);
        this.ambienceLFO(bed, rumble.gain.gain, 0.06, 0.07);
        // sub drone
        const sub = ctx.createOscillator();
        sub.type = "sine";
        sub.frequency.value = 42;
        const subG = ctx.createGain();
        subG.gain.value = 0.06;
        sub.connect(subG);
        subG.connect(bed.gain);
        sub.start();
        bed.nodes.push(sub);
        bed.cleanups.push(this.startEchoes(bed));
        break;
      }
      case "yard": {
        // ominous wind (lower, heavier) + occasional metal creak
        const wind = this.ambienceNoise(bed, "lowpass", 360, 0.8, 0.16);
        this.ambienceLFO(bed, wind.filter.frequency, 0.05, 160);
        this.ambienceLFO(bed, wind.gain.gain, 0.04, 0.07);
        const moan = this.ambienceNoise(bed, "bandpass", 240, 3, 0.05);
        this.ambienceLFO(bed, moan.filter.frequency, 0.03, 80);
        bed.cleanups.push(this.startCreaks(bed));
        break;
      }
      case "sodden": {
        // steady rain (hissy high noise) + low patter + sparse frog croaks
        const rain = this.ambienceNoise(bed, "highpass", 1800, 0.6, 0.12);
        this.ambienceLFO(bed, rain.gain.gain, 0.2, 0.02);
        const patter = this.ambienceNoise(bed, "bandpass", 700, 1.0, 0.06);
        this.ambienceLFO(bed, patter.gain.gain, 0.5, 0.03);
        bed.cleanups.push(this.startFrogs(bed));
        break;
      }
    }
    return bed;
  }

  // ---- sparse one-shot generators for ambience (return a stop() cleanup) ----

  private startCaws(bed: AmbienceBed, density: number): () => void {
    let stop = false;
    const tick = () => {
      if (stop || !this.ctx) return;
      if (this.enabled && Math.random() < 0.5) {
        // a rough downward caw via fast FM-ish glide on a saw
        this.tone(
          620 * this.jit(0.2),
          0.18,
          "sawtooth",
          0.05,
          340,
          bed.gain,
          0.4
        );
      }
      window.setTimeout(tick, 2200 + Math.random() * 5000);
    };
    window.setTimeout(tick, 1500 + Math.random() * 3000);
    void density;
    return () => {
      stop = true;
    };
  }

  private startDrips(bed: AmbienceBed): () => void {
    let stop = false;
    const tick = () => {
      if (stop || !this.ctx) return;
      if (this.enabled && Math.random() < 0.7) {
        const f = 900 * this.jit(0.3);
        this.tone(f, 0.12, "sine", 0.05, f * 0.4, bed.gain, 0.5);
      }
      window.setTimeout(tick, 700 + Math.random() * 2200);
    };
    window.setTimeout(tick, 800);
    return () => {
      stop = true;
    };
  }

  private startEchoes(bed: AmbienceBed): () => void {
    let stop = false;
    const tick = () => {
      if (stop || !this.ctx) return;
      if (this.enabled && Math.random() < 0.6) {
        // a low reverberant knock that smears into the convolver
        this.thump(90 * this.jit(0.2), 0.18, 0.06, bed.gain, 0.7);
      }
      window.setTimeout(tick, 3000 + Math.random() * 6000);
    };
    window.setTimeout(tick, 2500);
    return () => {
      stop = true;
    };
  }

  private startCreaks(bed: AmbienceBed): () => void {
    let stop = false;
    const tick = () => {
      if (stop || !this.ctx) return;
      if (this.enabled && Math.random() < 0.55) {
        // metallic creak: narrow band noise with a slow pitch glide feel
        this.noise(0.5, 0.05, 1200 * this.jit(0.2), 800, "bandpass", bed.gain, 0.4, 8);
      }
      window.setTimeout(tick, 4000 + Math.random() * 7000);
    };
    window.setTimeout(tick, 3500);
    return () => {
      stop = true;
    };
  }

  private startFrogs(bed: AmbienceBed): () => void {
    let stop = false;
    const tick = () => {
      if (stop || !this.ctx) return;
      if (this.enabled && Math.random() < 0.5) {
        // a short croak: two close low pulses
        const f = 180 * this.jit(0.15);
        this.tone(f, 0.08, "square", 0.05, f * 0.85, bed.gain, 0.15);
        setTimeout(
          () => this.tone(f * 0.95, 0.08, "square", 0.045, f * 0.8, bed.gain, 0.15),
          90
        );
      }
      window.setTimeout(tick, 1800 + Math.random() * 3500);
    };
    window.setTimeout(tick, 1200);
    return () => {
      stop = true;
    };
  }

  // ============================================================
  //  teardown
  // ============================================================

  destroy() {
    this.stopMusic();
    this.fadeOutAmbience();
    this.ambienceKind = "none";
    if (this.musicTimer) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
    if (this.combatTimer) {
      clearTimeout(this.combatTimer);
      this.combatTimer = null;
    }
    if (this.bossTimer) {
      clearTimeout(this.bossTimer);
      this.bossTimer = null;
    }
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.ambienceGain = null;
    this.reverb = null;
    this.reverbReturn = null;
    this.delay = null;
    this.delayFeedback = null;
    this.delayReturn = null;
    this.limiter = null;
    this.layers = {};
    this.ambienceBed = null;
    this.started = false;
    // close after a beat so in-flight fades/voices don't error
    if (ctx) {
      window.setTimeout(() => {
        try {
          ctx.close();
        } catch {}
      }, 2000);
    }
  }
}
