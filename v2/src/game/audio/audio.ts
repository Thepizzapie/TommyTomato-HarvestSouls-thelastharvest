// Procedural audio for "Tommy Tomato: Harvest Souls" (v2).
//
// Everything is synthesized at runtime from oscillators + filtered noise — there
// are no asset files, so the game stays a static deploy. The whole graph is
// built lazily on the first user gesture (inside ensure()) because browsers
// won't let an AudioContext make sound until the user has interacted.
//
// Signal graph (built once, lazily):
//
//   destination
//     └── limiter (DynamicsCompressor, brickwall-ish)
//           └── master gain  (muted when !enabled)
//                 ├── reverbReturn ← reverb (Convolver, procedural impulse)
//                 ├── delayReturn  ← delay (damped feedback echo)
//                 ├── musicBus     (3 crossfading adaptive layers)
//                 ├── sfxBus       (one-shot envelopes; post reverb/delay sends)
//                 └── ambienceBus  (one looping biome bed at a time)
//
// SFX render through the sfxBus and can post a "send" to the shared reverb /
// delay so transients sit in a believable space. Repeated SFX (hits, swings,
// footsteps) get small pitch + timing jitter so they never sound stamped.
//
// Harvest-gothic tone: dread-but-whimsical, minor key. Sparse melancholy on
// explore, a driving low pulse in combat, a relentless dissonant ostinato with
// drums on boss.

type Wave = OscillatorType;

export type MusicMode = "explore" | "combat" | "boss";
export type Ambience =
  | "rows"
  | "greenhouse"
  | "catacombs"
  | "yard"
  | "sodden"
  | "none";
export type Floor = "soil" | "rows" | "glass" | "stone" | "yard";

// One self-contained looping ambience bed: its own sub-gain, the live source
// nodes we must stop, and the sparse-event timers we must cancel on crossfade.
interface AmbienceBed {
  gain: GainNode;
  nodes: AudioScheduledSourceNode[];
  cleanups: Array<() => void>;
}

// One adaptive-music layer: a sub-gain (crossfaded by mode) plus the persistent
// voices that sustain underneath it for the lifetime of the music.
interface MusicLayer {
  gain: GainNode;
  voices: AudioScheduledSourceNode[];
}

const MASTER_VOL = 0.82;

export class Audio {
  // ---- public bus handles (kept as public fields for integrator/debug use) ----
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  musicGain: GainNode | null = null; // music bus
  sfxGain: GainNode | null = null; // sfx bus
  ambienceGain: GainNode | null = null; // ambience bus

  enabled = true;

  // ---- shared space (sends) ----
  private limiter: DynamicsCompressorNode | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private delay: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private delayReturn: GainNode | null = null;

  private started = false;

  // ---- adaptive music state ----
  private musicMode: MusicMode = "explore";
  private layers: Partial<Record<MusicMode, MusicLayer>> = {};
  private exploreTimer: ReturnType<typeof setTimeout> | null = null; // sparse plucks
  private combatTimer: ReturnType<typeof setTimeout> | null = null; // tom groove
  private bossTimer: ReturnType<typeof setTimeout> | null = null; // ostinato + drums
  private bossIntensity = 0; // 0..1, ramped by bossPhase()

  // ---- ambience state ----
  private ambienceKind: Ambience = "none";
  private ambienceBed: AmbienceBed | null = null;

  // Track every pending setTimeout we spawn for multi-hit SFX so destroy() can
  // cancel them and we never fire into a torn-down context.
  private sfxTimers = new Set<ReturnType<typeof setTimeout>>();

  // ============================================================
  //  lazy graph construction (first user gesture)
  // ============================================================

  ensure(): void {
    if (this.ctx) return;
    if (typeof window === "undefined") return;
    const AC: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;

    let ctx: AudioContext;
    try {
      ctx = new AC();
    } catch {
      return;
    }
    this.ctx = ctx;

    // master -> limiter -> destination. The limiter is the last thing before the
    // speakers, so nothing the game throws at it (stacked hits, boss roar over a
    // full music bed) can clip.
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

    // shared reverb (procedural impulse: exponentially-decaying stereo noise)
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(2.8, 2.6);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.9;
    reverb.connect(reverbReturn);
    reverbReturn.connect(master);
    this.reverb = reverb;
    this.reverbReturn = reverbReturn;

    // shared damped feedback delay (slap/echo send)
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
    musicGain.gain.value = 0.0001; // faded in by startMusic()
    musicGain.connect(master);
    this.musicGain = musicGain;

    const sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.9;
    sfxGain.connect(master);
    this.sfxGain = sfxGain;

    const ambienceGain = ctx.createGain();
    ambienceGain.gain.value = 0.0001; // faded in by setAmbience()
    ambienceGain.connect(master);
    this.ambienceGain = ambienceGain;
  }

  // ============================================================
  //  lifecycle
  // ============================================================

  resume(): void {
    this.ensure();
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master && this.ctx) {
      // smooth so toggling mute never pops
      const t = this.now();
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(on ? MASTER_VOL : 0.0, t + 0.08);
    } else if (this.master) {
      this.master.gain.value = on ? MASTER_VOL : 0.0;
    }
  }

  // ============================================================
  //  internal helpers
  // ============================================================

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // symmetric multiplicative jitter (e.g. jit(0.1) -> 0.9..1.1) to de-roboticize
  private jit(amt: number): number {
    return 1 + (Math.random() * 2 - 1) * amt;
  }

  // managed setTimeout for multi-hit SFX so destroy() can cancel cleanly
  private later(fn: () => void, ms: number): void {
    if (typeof window === "undefined") return;
    const id = setTimeout(() => {
      this.sfxTimers.delete(id);
      fn();
    }, ms);
    this.sfxTimers.add(id);
  }

  // procedural reverb impulse: exponentially-decaying stereo noise
  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const env = Math.pow(1 - i / len, decay);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  // cache one ~2s mono white-noise buffer; one-shots window into it with their
  // own envelope. Cheaper than minting a fresh buffer per transient.
  private noiseBuf: AudioBuffer | null = null;
  private getNoise(): AudioBuffer {
    const ctx = this.ctx!;
    if (this.noiseBuf && this.noiseBuf.sampleRate === ctx.sampleRate) {
      return this.noiseBuf;
    }
    const frames = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }

  // ---- core voice: a single enveloped oscillator ----
  // send: 0..1 amount (relative to vol) routed to the shared reverb return.
  private tone(
    freq: number,
    dur: number,
    type: Wave,
    vol: number,
    glideTo?: number,
    dest?: AudioNode,
    send = 0,
    attack = 0.008,
  ): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest ?? this.sfxGain!);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = vol * send;
      g.connect(s);
      s.connect(this.reverb);
      o.onended = () => {
        safeDisconnect(o, g, s);
      };
    } else {
      o.onended = () => {
        safeDisconnect(o, g);
      };
    }
    o.start(t);
    o.stop(t + dur + 0.03);
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
    q = 0.7,
  ): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.getNoise();
    // start at a random offset so repeated bursts don't share a waveform
    const off = Math.random() * Math.max(0, src.buffer.duration - dur - 0.05);
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(cutoff, t);
    if (sweepTo) {
      f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest ?? this.sfxGain!);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = vol * send;
      g.connect(s);
      s.connect(this.reverb);
      src.onended = () => {
        safeDisconnect(src, f, g, s);
      };
    } else {
      src.onended = () => {
        safeDisconnect(src, f, g);
      };
    }
    src.start(t, off, dur + 0.03);
    src.stop(t + dur + 0.03);
  }

  // short percussive "body" thump (impacts, kicks)
  private thump(
    freq: number,
    dur: number,
    vol: number,
    dest?: AudioNode,
    send = 0,
  ): void {
    if (!this.ctx || !this.enabled) return;
    const t = this.now();
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(freq * 2.2, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(24, freq), t + dur * 0.6);
    g.gain.setValueAtTime(Math.max(0.0002, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest ?? this.sfxGain!);
    if (send > 0 && this.reverb) {
      const s = this.ctx.createGain();
      s.gain.value = vol * send;
      g.connect(s);
      s.connect(this.reverb);
      o.onended = () => {
        safeDisconnect(o, g, s);
      };
    } else {
      o.onended = () => {
        safeDisconnect(o, g);
      };
    }
    o.start(t);
    o.stop(t + dur + 0.03);
  }

  // route a node briefly to the shared delay send
  private toDelay(node: AudioNode, amount: number): void {
    if (!this.ctx || !this.delay) return;
    const s = this.ctx.createGain();
    s.gain.value = amount;
    node.connect(s);
    s.connect(this.delay);
  }

  // ============================================================
  //  SFX  (combat)
  // ============================================================

  swing(): void {
    this.ensure();
    const c = 1800 * this.jit(0.18);
    this.noise(0.15, 0.16, c, 520 * this.jit(0.1), "bandpass");
    this.tone(420 * this.jit(0.08), 0.09, "triangle", 0.05, 220);
  }

  // transient crack + tonal body + low thump, light room send
  hit(): void {
    this.ensure();
    const p = this.jit(0.1);
    this.noise(0.04, 0.4, 5200 * p, 1800, "highpass"); // crack
    this.noise(0.1, 0.22, 1100 * p, 280); // meaty body
    this.thump(150 * p, 0.13, 0.28, this.sfxGain!, 0.12); // low punch
    this.tone(190 * p, 0.1, "square", 0.08, 95);
  }

  splat(): void {
    this.ensure();
    const p = this.jit(0.12);
    this.noise(0.22, 0.36, 900 * p, 170, "lowpass", this.sfxGain!, 0.14);
    this.thump(110 * p, 0.18, 0.22);
    this.tone(120 * p, 0.18, "sawtooth", 0.08, 56);
  }

  // generic dodge roll — a directional cloth whoosh
  roll(): void {
    this.dodgeWhoosh();
  }

  // fuller cloth/air whoosh with a rising-then-falling filter
  dodgeWhoosh(): void {
    this.ensure();
    const p = this.jit(0.12);
    this.noise(0.26, 0.16, 600 * p, 2000 * p, "bandpass", this.sfxGain!, 0.05, 1.2);
    this.noise(0.18, 0.08, 1800, 500, "lowpass");
  }

  // raise/clash guard — bright metallic shing with room + delay shimmer
  parry(): void {
    this.ensure();
    const p = this.jit(0.05);
    this.tone(1500 * p, 0.18, "triangle", 0.2, 2600, this.sfxGain!, 0.25);
    this.tone(2300 * p, 0.12, "triangle", 0.1, 3200, this.sfxGain!, 0.25);
    this.tone(940 * p, 0.1, "square", 0.08);
    this.noise(0.05, 0.18, 6000, 9000, "highpass");
  }

  // flashier parry confirm (the instant a parry "lands")
  parryFlash(): void {
    this.ensure();
    this.tone(2600, 0.16, "triangle", 0.16, 3600, this.sfxGain!, 0.3);
    this.tone(1730, 0.14, "triangle", 0.12, 2300, this.sfxGain!, 0.3);
    this.noise(0.06, 0.2, 7000, 11000, "highpass", this.sfxGain!, 0.2);
  }

  // critical punish: crisp shing then a delayed heavy thump
  riposte(): void {
    this.ensure();
    this.tone(1900, 0.1, "triangle", 0.18, 2800, this.sfxGain!, 0.2); // shing
    this.noise(0.04, 0.3, 6000, 2000, "highpass");
    this.later(() => {
      this.thump(90, 0.26, 0.34, this.sfxGain!, 0.18);
      this.noise(0.14, 0.28, 800, 160, "lowpass", this.sfxGain!, 0.18);
      this.tone(140, 0.2, "sawtooth", 0.12, 60);
    }, 70);
  }

  // sneaky kill: muffled cloth thud + dull crunch
  backstab(): void {
    this.ensure();
    this.noise(0.16, 0.26, 1400, 300, "lowpass", this.sfxGain!, 0.1);
    this.thump(120, 0.2, 0.28, this.sfxGain!, 0.14);
    this.tone(200, 0.12, "triangle", 0.08, 90);
  }

  // hold/raise guard — soft leathery brace
  block(): void {
    this.ensure();
    this.noise(0.12, 0.16, 700, 240, "lowpass");
    this.tone(160, 0.1, "sine", 0.08, 120);
  }

  // guard shattered — harsh metallic crack + sour low tone
  guardBreak(): void {
    this.ensure();
    this.noise(0.18, 0.3, 3000, 800, "bandpass", this.sfxGain!, 0.18);
    this.tone(300, 0.3, "sawtooth", 0.16, 90, this.sfxGain!, 0.15);
    this.tone(150, 0.34, "square", 0.12, 70);
  }

  enemyHurt(): void {
    this.ensure();
    const p = this.jit(0.12);
    this.tone(320 * p, 0.08, "square", 0.1, 180);
    this.noise(0.05, 0.12, 2200, 700, "bandpass");
  }

  // wet bubbling poison application / tick
  poison(): void {
    this.ensure();
    for (let i = 0; i < 4; i++) {
      this.later(
        () => {
          const f = 240 * this.jit(0.4);
          this.tone(f, 0.14, "sine", 0.06, f * 1.8, this.sfxGain!, 0.08);
        },
        i * 70 + Math.random() * 30,
      );
    }
    this.noise(0.3, 0.06, 500, 220, "bandpass");
  }

  // swapping weapons — sheath rasp + soft mechanical clicks
  weaponSwitch(): void {
    this.ensure();
    this.noise(0.12, 0.14, 2400, 900, "bandpass");
    this.tone(620, 0.05, "square", 0.07, 760);
    this.later(() => this.tone(900, 0.05, "square", 0.06, 720), 60);
  }

  // ============================================================
  //  SFX  (rewards / utility / boss)
  // ============================================================

  heal(): void {
    this.ensure();
    this.tone(440, 0.2, "sine", 0.13, 660, this.sfxGain!, 0.18);
    this.tone(660, 0.28, "sine", 0.11, 880, this.sfxGain!, 0.2);
    this.tone(990, 0.34, "triangle", 0.05, 1180, this.sfxGain!, 0.25); // glassy bloom
  }

  pickup(): void {
    this.ensure();
    this.tone(740, 0.08, "square", 0.11, 980, this.sfxGain!, 0.1);
    this.tone(980, 0.1, "square", 0.09, 1240, this.sfxGain!, 0.1);
  }

  // small currency tick
  sap(): void {
    this.ensure();
    this.tone(523, 0.06, "triangle", 0.09, undefined, this.sfxGain!, 0.08);
    this.tone(784, 0.08, "triangle", 0.08, undefined, this.sfxGain!, 0.08);
  }

  // big reward jingle / many coins (husk reclaim or large sap gains)
  coinShower(): void {
    this.ensure();
    const notes = [784, 988, 1175, 1318, 1568];
    for (let i = 0; i < 9; i++) {
      this.later(
        () => {
          const f = notes[Math.floor(Math.random() * notes.length)] * this.jit(0.02);
          this.tone(f, 0.12, "triangle", 0.07, f * 1.05, this.sfxGain!, 0.18);
        },
        i * 55 + Math.random() * 25,
      );
    }
    this.tone(392, 0.5, "sine", 0.06, 523, this.sfxGain!, 0.2);
  }

  // ceremonial rising arpeggio with a long reverb tail
  levelUp(): void {
    this.ensure();
    [523, 659, 784, 1046].forEach((f, i) =>
      this.later(
        () => this.tone(f, 0.24, "triangle", 0.15, f * 1.01, this.sfxGain!, 0.3),
        i * 95,
      ),
    );
    this.later(() => this.tone(196, 0.9, "sine", 0.07, 261, this.sfxGain!, 0.3), 60);
  }

  // warm swelling drone-y rest cue, lots of room + crackle
  bonfire(): void {
    this.ensure();
    this.tone(196, 0.6, "sine", 0.1, 261, this.sfxGain!, 0.35);
    this.tone(261, 0.8, "sine", 0.08, 329, this.sfxGain!, 0.35);
    this.tone(392, 0.7, "triangle", 0.04, 466, this.sfxGain!, 0.4);
    this.noise(0.7, 0.05, 1800, 600, "bandpass");
  }

  // bonfire teleport / warp — long descending swept noise + tonal sweep
  warp(): void {
    this.ensure();
    this.noise(0.7, 0.22, 4000, 200, "lowpass", this.sfxGain!, 0.3, 1.4);
    this.tone(800, 0.6, "sine", 0.1, 90, this.sfxGain!, 0.35);
    this.tone(400, 0.6, "triangle", 0.06, 60, this.sfxGain!, 0.35);
  }

  // final, heavy: low sawtooth collapse + sub thump + long reverberant noise
  death(): void {
    this.ensure();
    this.tone(220, 1.3, "sawtooth", 0.2, 48, this.sfxGain!, 0.3);
    this.tone(110, 1.4, "sine", 0.16, 36, this.sfxGain!, 0.3);
    this.thump(70, 0.5, 0.3, this.sfxGain!, 0.3);
    this.noise(1.2, 0.16, 600, 90, "lowpass", this.sfxGain!, 0.4);
    this.later(
      () => this.tone(311, 1.0, "triangle", 0.07, 233, this.sfxGain!, 0.4),
      120,
    ); // mournful falling minor third
  }

  // huge layered roar with growl, room, and a delay smear
  bossRoar(): void {
    this.ensure();
    this.tone(88, 1.2, "sawtooth", 0.26, 58, this.sfxGain!, 0.3);
    this.tone(132, 0.95, "square", 0.12, 70, this.sfxGain!, 0.25);
    this.tone(60, 1.1, "sawtooth", 0.14, 44, this.sfxGain!, 0.3); // sub growl
    this.noise(1.15, 0.28, 520, 80, "lowpass", this.sfxGain!, 0.35);
  }

  // phase-change stinger (boss enters a new phase). Also ramps boss music
  // intensity so the ostinato/drums get more relentless each phase.
  bossPhase(): void {
    this.ensure();
    this.bossIntensity = Math.min(1, this.bossIntensity + 0.5);
    // descending dissonant swell (minor-2nd clash) + impact, then the roar
    this.tone(330, 0.7, "sawtooth", 0.14, 110, this.sfxGain!, 0.3);
    this.tone(349, 0.7, "sawtooth", 0.12, 116, this.sfxGain!, 0.3);
    this.thump(80, 0.4, 0.3, this.sfxGain!, 0.25);
    this.noise(0.5, 0.2, 1400, 200, "bandpass", this.sfxGain!, 0.25);
    this.later(() => this.bossRoar(), 120);
  }

  // ---- footsteps (per floor material, pitch + level jittered) ----
  footstep(floor: Floor = "soil"): void {
    this.ensure();
    if (!this.ctx || !this.enabled) return;
    const p = this.jit(0.16);
    switch (floor) {
      case "glass":
        this.tone(2200 * p, 0.05, "triangle", 0.05, 2600); // light tink
        this.noise(0.05, 0.05, 4000 * p, 2000, "highpass"); // airy tail
        break;
      case "stone":
        this.noise(0.07, 0.1, 1600 * p, 500, "bandpass", this.sfxGain!, 0.08); // hard scuff + room
        this.thump(110 * p, 0.06, 0.06);
        break;
      case "yard":
        this.noise(0.08, 0.09, 900 * p, 300, "lowpass"); // dry dirt
        this.noise(0.04, 0.03, 3000 * p, 1500, "bandpass"); // metal grit
        break;
      case "rows":
        this.noise(0.09, 0.1, 1100 * p, 350, "lowpass"); // crunchy soil
        this.noise(0.05, 0.04, 2600 * p, 1200, "highpass"); // leaf rustle
        break;
      case "soil":
      default:
        this.noise(0.08, 0.09, 800 * p, 280, "lowpass"); // muffled earth
        this.thump(90 * p, 0.05, 0.04);
        break;
    }
  }

  // ============================================================
  //  SFX  (UI)
  // ============================================================

  uiMove(): void {
    this.ensure();
    this.tone(520, 0.04, "square", 0.05);
  }

  uiSelect(): void {
    this.ensure();
    this.tone(700, 0.07, "square", 0.08, 900);
  }

  // ============================================================
  //  ADAPTIVE MUSIC
  // ============================================================

  startMusic(): void {
    this.ensure();
    if (!this.ctx || this.started) return;
    this.started = true;
    this.bossIntensity = 0;

    const t = this.now();
    this.musicGain!.gain.cancelScheduledValues(t);
    this.musicGain!.gain.setValueAtTime(0.0001, t);
    this.musicGain!.gain.exponentialRampToValueAtTime(0.5, t + 4);

    this.buildMusicLayers();
    this.applyMusicMode(this.musicMode, 0.01); // snap to whatever mode is queued

    this.scheduleExplore();
    this.scheduleCombat();
    this.scheduleBoss();
  }

  // Build the three persistent beds. Each has a layer-gain (0 = silent) that we
  // crossfade with setMusicMode; the sustained voices live underneath.
  private buildMusicLayers(): void {
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

    this.buildExploreLayer(explore);
    this.buildCombatLayer(combat);
    this.buildBossLayer(boss);
  }

  // EXPLORE: sparse melancholy minor pad. A low drone cluster, each voice gently
  // detuned by its own slow LFO, plus a soft high "air" pad for harvest-whimsy.
  private buildExploreLayer(layer: MusicLayer): void {
    const ctx = this.ctx!;
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
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 700;
      o.connect(lp);
      lp.connect(g);
      g.connect(layer.gain);
      const send = ctx.createGain();
      send.gain.value = 0.25;
      g.connect(send);
      send.connect(this.reverb!);
      o.start();
      lfo.start();
      layer.voices.push(o, lfo);
    });

    // breathy high pad an octave-and-fifth up — adds the whimsical glaze without
    // brightening the dread (kept very quiet, heavily reverbed).
    {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = 329.63; // E4
      const trem = ctx.createOscillator();
      const tremG = ctx.createGain();
      trem.frequency.value = 0.13;
      tremG.gain.value = 0.012;
      const amp = ctx.createGain();
      amp.gain.value = 0.018;
      const tremBias = ctx.createConstantSource();
      tremBias.offset.value = 0.018;
      trem.connect(tremG);
      tremG.connect(amp.gain);
      tremBias.connect(amp.gain);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400;
      o.connect(lp);
      lp.connect(amp);
      amp.connect(layer.gain);
      const send = ctx.createGain();
      send.gain.value = 0.5;
      amp.connect(send);
      send.connect(this.reverb!);
      o.start();
      trem.start();
      tremBias.start();
      layer.voices.push(o, trem, tremBias);
    }
  }

  // COMBAT: throbbing sub pulse (amplitude-modulated drive) + a tense minor-2nd
  // pad above the drone for unease.
  private buildCombatLayer(layer: MusicLayer): void {
    const ctx = this.ctx!;

    // throbbing sub pulse, amplitude-modulated by a ~2.4 Hz "heartbeat" LFO
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = 55; // A1
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const amp = ctx.createGain();
    amp.gain.value = 0.0;
    const pulse = ctx.createOscillator();
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
    amp.connect(layer.gain);
    o.start();
    pulse.start();
    pulseBias.start();
    layer.voices.push(o, pulse, pulseBias);

    // tense minor-2nd pad (Bb against the A drone) for unease
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
    g2.connect(layer.gain);
    const s2 = ctx.createGain();
    s2.gain.value = 0.2;
    g2.connect(s2);
    s2.connect(this.reverb!);
    o2.start();
    layer.voices.push(o2);
  }

  // BOSS: a dissonant low cluster (A + Bb clash + E) for dread. The ostinato and
  // drums are scheduled (scheduleBoss); here we just lay the sustained bed.
  private buildBossLayer(layer: MusicLayer): void {
    const ctx = this.ctx!;
    const freqs = [55, 58.27, 87.31]; // A1 + Bb1 (clash) + E2
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
      g.connect(layer.gain);
      const s = ctx.createGain();
      s.gain.value = 0.22;
      g.connect(s);
      s.connect(this.reverb!);
      o.start();
      layer.voices.push(o);
    });
  }

  // crossfade layer gains to match the requested mode. combat/boss keep a little
  // of the lower layers bleeding through so transitions feel continuous.
  private applyMusicMode(mode: MusicMode, fade = 2.5): void {
    if (!this.ctx) return;
    const t = this.now();
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

  setMusicMode(mode: MusicMode): void {
    this.ensure();
    if (this.musicMode === mode) return;
    this.musicMode = mode;
    if (mode !== "boss") this.bossIntensity = 0; // reset escalation on leaving boss
    if (!this.started) return; // beds not built yet; remembered for startMusic()
    this.applyMusicMode(mode);
  }

  // is a given layer currently audible enough to bother scheduling events into?
  private layerAudible(mode: MusicMode, thresh: number): boolean {
    return (this.layers[mode]?.gain.gain.value ?? 0) > thresh;
  }

  // EXPLORE: sparse minor plucks (only audible when the explore layer is up)
  private scheduleExplore(): void {
    const scale = [196, 233.08, 261.63, 293.66, 311.13, 392, 466.16]; // G minor-ish
    const step = (): void => {
      if (!this.ctx || !this.started) return;
      if (this.enabled && this.layerAudible("explore", 0.15) && Math.random() < 0.55) {
        const f = scale[Math.floor(Math.random() * scale.length)];
        this.tone(
          f * (Math.random() < 0.3 ? 2 : 1),
          1.6,
          "triangle",
          0.05,
          undefined,
          this.layers.explore!.gain,
          0.3,
        );
      }
      this.exploreTimer = setTimeout(step, 1400 + Math.random() * 2600);
    };
    this.exploreTimer = setTimeout(step, 2000);
  }

  // COMBAT: a soft low tom on a loose beat + the occasional hat tick
  private scheduleCombat(): void {
    const step = (): void => {
      if (!this.ctx || !this.started) return;
      if (this.enabled && this.layerAudible("combat", 0.2)) {
        this.thump(70 * this.jit(0.05), 0.18, 0.12, this.layers.combat!.gain, 0.15);
        if (Math.random() < 0.4) {
          this.noise(0.06, 0.05, 3000, 1200, "highpass", this.layers.combat!.gain, 0.1);
        }
      }
      this.combatTimer = setTimeout(step, 460 + Math.random() * 60);
    };
    this.combatTimer = setTimeout(step, 480);
  }

  // BOSS: relentless ostinato + kick/snare. bossIntensity (raised by bossPhase)
  // tightens the tempo and adds a driving hat as phases escalate.
  private scheduleBoss(): void {
    const ost = [55, 55, 65.41, 55, 58.27, 55]; // A A C A Bb A — grim ostinato
    let i = 0;
    const step = (): void => {
      if (!this.ctx || !this.started) return;
      if (this.enabled && this.layerAudible("boss", 0.2)) {
        const f = ost[i % ost.length];
        this.tone(f * 2, 0.22, "sawtooth", 0.06, undefined, this.layers.boss!.gain, 0.1);
        this.thump(58, 0.16, 0.16, this.layers.boss!.gain, 0.05); // kick every step
        if (i % 2 === 1) {
          this.noise(0.09, 0.12, 2400, 700, "bandpass", this.layers.boss!.gain, 0.12); // snare off-beat
        }
        // escalation: a tight driving hat once we're a phase or two in
        if (this.bossIntensity > 0.4 && i % 2 === 0) {
          this.noise(
            0.03,
            0.05 + 0.04 * this.bossIntensity,
            6000,
            4000,
            "highpass",
            this.layers.boss!.gain,
            0.05,
          );
        }
      }
      i++;
      // tempo tightens from 300ms toward ~250ms at full intensity
      this.bossTimer = setTimeout(step, 300 - 50 * this.bossIntensity);
    };
    this.bossTimer = setTimeout(step, 300);
  }

  stopMusic(): void {
    if (this.exploreTimer) {
      clearTimeout(this.exploreTimer);
      this.exploreTimer = null;
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
    // stop & release the persistent layer voices once the fade has finished
    const layers = this.layers;
    this.layers = {};
    this.later(() => {
      (["explore", "combat", "boss"] as MusicMode[]).forEach((m) => {
        const layer = layers[m];
        if (!layer) return;
        for (const v of layer.voices) {
          try {
            v.stop();
          } catch {
            /* already stopped */
          }
          try {
            v.disconnect();
          } catch {
            /* already disconnected */
          }
        }
        try {
          layer.gain.disconnect();
        } catch {
          /* already disconnected */
        }
      });
    }, 1700);
    this.started = false;
  }

  // ============================================================
  //  AMBIENCE (per-biome looping bed)
  // ============================================================

  setAmbience(kind: Ambience): void {
    this.ensure();
    if (!this.ctx) return;
    if (this.ambienceKind === kind) return;
    this.ambienceKind = kind;

    this.fadeOutAmbience(); // fade & tear down the current bed

    if (kind === "none") {
      if (this.ambienceGain) {
        const t = this.now();
        this.ambienceGain.gain.cancelScheduledValues(t);
        this.ambienceGain.gain.setValueAtTime(
          Math.max(0.0001, this.ambienceGain.gain.value),
          t,
        );
        this.ambienceGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      }
      return;
    }

    const bed = this.buildAmbience(kind);
    this.ambienceBed = bed;

    const t = this.now();
    if (this.ambienceGain) {
      this.ambienceGain.gain.cancelScheduledValues(t);
      this.ambienceGain.gain.setValueAtTime(
        Math.max(0.0001, this.ambienceGain.gain.value),
        t,
      );
      this.ambienceGain.gain.exponentialRampToValueAtTime(0.45, t + 2.0);
    }
    bed.gain.gain.setValueAtTime(0.0001, t);
    bed.gain.gain.exponentialRampToValueAtTime(1.0, t + 2.0);
  }

  private fadeOutAmbience(): void {
    const bed = this.ambienceBed;
    this.ambienceBed = null;
    if (!bed || !this.ctx) return;
    // stop sparse-event timers immediately so nothing schedules into a dying bed
    for (const c of bed.cleanups) {
      try {
        c();
      } catch {
        /* ignore */
      }
    }
    const t = this.now();
    bed.gain.gain.cancelScheduledValues(t);
    bed.gain.gain.setValueAtTime(Math.max(0.0001, bed.gain.gain.value), t);
    bed.gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    this.later(() => {
      for (const n of bed.nodes) {
        try {
          n.stop();
        } catch {
          /* already stopped */
        }
        try {
          n.disconnect();
        } catch {
          /* already disconnected */
        }
      }
      try {
        bed.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    }, 1800);
  }

  // a persistent filtered-noise source (the backbone of every bed)
  private ambienceNoise(
    bed: AmbienceBed,
    type: BiquadFilterType,
    cutoff: number,
    q: number,
    vol: number,
  ): { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(); // reuse the shared 2s buffer, looped
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

  // slow LFO -> AudioParam modulation (wind swells, filter sweeps, etc.)
  private ambienceLFO(
    bed: AmbienceBed,
    target: AudioParam,
    rate: number,
    depth: number,
    type: Wave = "sine",
  ): void {
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
        bed.cleanups.push(this.startCaws(bed));
        break;
      }
      case "greenhouse": {
        // humid glass hum (low sine bed) + airy shimmer + irregular water drips
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
        const shimmer = this.ambienceNoise(bed, "bandpass", 3200, 6, 0.025);
        this.ambienceLFO(bed, shimmer.filter.frequency, 0.13, 400);
        bed.cleanups.push(this.startDrips(bed));
        break;
      }
      case "catacombs": {
        // low cave rumble + sub drone + sparse reverberant echo knocks
        const rumble = this.ambienceNoise(bed, "lowpass", 140, 0.7, 0.2);
        this.ambienceLFO(bed, rumble.gain.gain, 0.06, 0.07);
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
        // ominous heavy wind + a low moan + occasional metal creak
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

  // ---- sparse one-shot generators for ambience (each returns a stop() cleanup) ----
  // A generic recursive scheduler keeps these tidy and guarantees the timer is
  // cancellable (so a crossfade can't leave a dangling caw/drip firing).

  private sparse(
    bed: AmbienceBed,
    minMs: number,
    spanMs: number,
    chance: number,
    play: () => void,
    firstMs: number,
  ): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      if (stopped || !this.ctx) return;
      if (this.enabled && Math.random() < chance) play();
      timer = setTimeout(tick, minMs + Math.random() * spanMs);
    };
    timer = setTimeout(tick, firstMs);
    void bed;
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  private startCaws(bed: AmbienceBed): () => void {
    return this.sparse(
      bed,
      2200,
      5000,
      0.5,
      () => this.tone(620 * this.jit(0.2), 0.18, "sawtooth", 0.05, 340, bed.gain, 0.4),
      1500 + Math.random() * 3000,
    );
  }

  private startDrips(bed: AmbienceBed): () => void {
    return this.sparse(
      bed,
      700,
      2200,
      0.7,
      () => {
        const f = 900 * this.jit(0.3);
        this.tone(f, 0.12, "sine", 0.05, f * 0.4, bed.gain, 0.5);
      },
      800,
    );
  }

  private startEchoes(bed: AmbienceBed): () => void {
    return this.sparse(
      bed,
      3000,
      6000,
      0.6,
      () => this.thump(90 * this.jit(0.2), 0.18, 0.06, bed.gain, 0.7),
      2500,
    );
  }

  private startCreaks(bed: AmbienceBed): () => void {
    return this.sparse(
      bed,
      4000,
      7000,
      0.55,
      () =>
        this.noise(0.5, 0.05, 1200 * this.jit(0.2), 800, "bandpass", bed.gain, 0.4, 8),
      3500,
    );
  }

  private startFrogs(bed: AmbienceBed): () => void {
    return this.sparse(
      bed,
      1800,
      3500,
      0.5,
      () => {
        const f = 180 * this.jit(0.15);
        this.tone(f, 0.08, "square", 0.05, f * 0.85, bed.gain, 0.15);
        this.later(
          () => this.tone(f * 0.95, 0.08, "square", 0.045, f * 0.8, bed.gain, 0.15),
          90,
        );
      },
      1200,
    );
  }

  // ============================================================
  //  teardown
  // ============================================================

  destroy(): void {
    // cancel every pending multi-hit SFX timer first
    for (const id of this.sfxTimers) clearTimeout(id);
    this.sfxTimers.clear();

    this.stopMusic();
    this.fadeOutAmbience();
    this.ambienceKind = "none";

    if (this.exploreTimer) {
      clearTimeout(this.exploreTimer);
      this.exploreTimer = null;
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
    this.noiseBuf = null;
    this.started = false;
    this.bossIntensity = 0;

    // close after a beat so in-flight fades/voices don't throw on a dead context
    if (ctx && typeof window !== "undefined") {
      setTimeout(() => {
        try {
          void ctx.close();
        } catch {
          /* already closed */
        }
      }, 2000);
    }
  }
}

// Disconnect a set of nodes, swallowing "already disconnected" errors. Used by
// every one-shot voice's onended so the graph self-prunes (no node leak).
function safeDisconnect(...nodes: AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}
