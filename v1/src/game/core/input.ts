// Keyboard + mouse + gamepad input.
// Tracks held keys and edge-triggered "pressed this frame". A connected
// controller (Xbox layout) is merged transparently into the same accessors the
// game already reads — left stick → moveVec(), right stick → aim (mouseX/Y),
// buttons → synthetic "pressed" codes / lmbPressed / rmbDown — so the rest of
// the game needs no controller-specific code.

export class Input {
  private down = new Set<string>();
  private pressedQueue = new Set<string>();
  private pressedThisFrame = new Set<string>();

  mouseX = 0;
  mouseY = 0;
  mouseDown = false; // left
  lmbPressed = false;
  private lmbQueued = false;

  // right-mouse (guard) is the union of the physical mouse button and a held
  // controller bumper/trigger, exposed as a read-only `rmbDown` getter.
  private rmbDownMouse = false;
  private padGuard = false;

  // ---- gamepad ----
  private padPrev: boolean[] = []; // button pressed-state from the previous poll (edge detection)
  private padMoveX = 0;
  private padMoveY = 0;
  private static readonly DEAD = 0.28; // analog stick deadzone
  private static readonly AIM_REACH = 260; // right-stick aim distance from screen center (px)

  private el: HTMLElement;
  private handlers: Array<[string, EventTarget, EventListenerOrEventListenerObject]> = [];

  constructor(el: HTMLElement) {
    this.el = el;
    const on = (
      type: string,
      target: EventTarget,
      fn: EventListenerOrEventListenerObject
    ) => {
      target.addEventListener(type, fn);
      this.handlers.push([type, target, fn]);
    };

    on("keydown", window, (e) => {
      const ev = e as KeyboardEvent;
      const k = ev.code;
      // prevent scroll on space/arrows while playing
      if (
        ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(
          k
        )
      )
        ev.preventDefault();
      if (!this.down.has(k)) this.pressedQueue.add(k);
      this.down.add(k);
    });
    on("keyup", window, (e) => {
      this.down.delete((e as KeyboardEvent).code);
    });
    on("mousemove", el, (e) => {
      const r = el.getBoundingClientRect();
      const me = e as MouseEvent;
      this.mouseX = me.clientX - r.left;
      this.mouseY = me.clientY - r.top;
    });
    on("mousedown", el, (e) => {
      const me = e as MouseEvent;
      if (me.button === 0) {
        this.mouseDown = true;
        this.lmbQueued = true;
      }
      if (me.button === 2) this.rmbDownMouse = true;
    });
    on("mouseup", window, (e) => {
      const me = e as MouseEvent;
      if (me.button === 0) this.mouseDown = false;
      if (me.button === 2) this.rmbDownMouse = false;
    });
    on("contextmenu", el, (e) => e.preventDefault());
    on("blur", window, () => {
      this.down.clear();
      this.mouseDown = false;
      this.rmbDownMouse = false;
    });
  }

  // call once at the very start of each sim tick
  beginFrame() {
    this.pressedThisFrame = this.pressedQueue;
    this.pressedQueue = new Set();
    this.lmbPressed = this.lmbQueued;
    this.lmbQueued = false;
    // merge the controller AFTER the keyboard swap so its edges land in the
    // frame's pressed set and its held state overrides cleanly.
    this.pollGamepad();
  }

  /** Read the first connected gamepad and fold it into this frame's input. */
  private pollGamepad() {
    this.padMoveX = 0;
    this.padMoveY = 0;
    this.padGuard = false;

    const pads =
      typeof navigator !== "undefined" && navigator.getGamepads
        ? navigator.getGamepads()
        : [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        gp = p;
        break;
      }
    }
    if (!gp) {
      this.padPrev = [];
      return;
    }

    const ax = gp.axes;
    const b = gp.buttons;
    const lx = ax[0] || 0,
      ly = ax[1] || 0,
      rx = ax[2] || 0,
      ry = ax[3] || 0;

    // left stick → movement (raw; the moveVec consumer normalizes)
    if (Math.hypot(lx, ly) > Input.DEAD) {
      this.padMoveX = lx;
      this.padMoveY = ly;
    }
    // right stick → aim. The camera keeps the player near screen-center, so a
    // screen point offset from center by the stick maps (via screenToWorld) to
    // an aim direction out of the tomato.
    if (Math.hypot(rx, ry) > Input.DEAD) {
      const r = this.el.getBoundingClientRect();
      this.mouseX = r.width / 2 + rx * Input.AIM_REACH;
      this.mouseY = r.height / 2 + ry * Input.AIM_REACH;
    }

    const dn = (i: number) => !!(b[i] && b[i].pressed);
    const edge = (i: number) => dn(i) && !this.padPrev[i];

    // edge-triggered actions → the same codes the keyboard path emits
    if (edge(0)) this.pressedThisFrame.add("Space"); // A      → dodge roll / confirm
    if (edge(1)) this.pressedThisFrame.add("KeyE"); //  B      → rest / interact / back
    if (edge(2)) this.pressedThisFrame.add("KeyR"); //  X      → heal
    if (edge(3) || edge(10)) this.pressedThisFrame.add("Tab"); // Y / R3 → lock-on
    if (edge(5)) this.lmbPressed = true; //              RB     → light attack
    if (edge(7)) this.pressedThisFrame.add("KeyF"); //  RT     → heavy attack
    // dpad → weapons 1-4 in play; also arrows so it drives the bonfire menu
    if (edge(12)) {
      this.pressedThisFrame.add("Digit1");
      this.pressedThisFrame.add("ArrowUp");
    }
    if (edge(13)) {
      this.pressedThisFrame.add("Digit2");
      this.pressedThisFrame.add("ArrowDown");
    }
    if (edge(14)) {
      this.pressedThisFrame.add("Digit3");
      this.pressedThisFrame.add("ArrowLeft");
    }
    if (edge(15)) {
      this.pressedThisFrame.add("Digit4");
      this.pressedThisFrame.add("ArrowRight");
    }

    // held → guard (LB or LT)
    if (dn(4) || dn(6)) this.padGuard = true;

    this.padPrev = b.map((x) => !!(x && x.pressed));
  }

  /** Right-mouse / guard: held physical RMB or a held controller bumper/trigger. */
  get rmbDown(): boolean {
    return this.rmbDownMouse || this.padGuard;
  }

  held(code: string) {
    return this.down.has(code);
  }
  pressed(code: string) {
    return this.pressedThisFrame.has(code);
  }

  // WASD + arrows + left-stick movement vector (not normalized)
  moveVec(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.held("KeyW") || this.held("ArrowUp")) y -= 1;
    if (this.held("KeyS") || this.held("ArrowDown")) y += 1;
    if (this.held("KeyA") || this.held("ArrowLeft")) x -= 1;
    if (this.held("KeyD") || this.held("ArrowRight")) x += 1;
    x += this.padMoveX;
    y += this.padMoveY;
    return { x, y };
  }

  destroy() {
    for (const [type, target, fn] of this.handlers)
      target.removeEventListener(type, fn);
    this.handlers = [];
  }
}
