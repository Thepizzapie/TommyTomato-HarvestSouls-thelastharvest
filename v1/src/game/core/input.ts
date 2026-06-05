// Keyboard + mouse input. Tracks held keys and edge-triggered "pressed this frame".

export class Input {
  private down = new Set<string>();
  private pressedQueue = new Set<string>();
  private pressedThisFrame = new Set<string>();

  mouseX = 0;
  mouseY = 0;
  mouseDown = false; // left
  rmbDown = false; // right
  lmbPressed = false;
  private lmbQueued = false;

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
      if (me.button === 2) this.rmbDown = true;
    });
    on("mouseup", window, (e) => {
      const me = e as MouseEvent;
      if (me.button === 0) this.mouseDown = false;
      if (me.button === 2) this.rmbDown = false;
    });
    on("contextmenu", el, (e) => e.preventDefault());
    on("blur", window, () => {
      this.down.clear();
      this.mouseDown = false;
      this.rmbDown = false;
    });
  }

  // call once at the very start of each sim tick
  beginFrame() {
    this.pressedThisFrame = this.pressedQueue;
    this.pressedQueue = new Set();
    this.lmbPressed = this.lmbQueued;
    this.lmbQueued = false;
  }

  held(code: string) {
    return this.down.has(code);
  }
  pressed(code: string) {
    return this.pressedThisFrame.has(code);
  }

  // WASD + arrows movement vector (not normalized)
  moveVec(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.held("KeyW") || this.held("ArrowUp")) y -= 1;
    if (this.held("KeyS") || this.held("ArrowDown")) y += 1;
    if (this.held("KeyA") || this.held("ArrowLeft")) x -= 1;
    if (this.held("KeyD") || this.held("ArrowRight")) x += 1;
    return { x, y };
  }

  destroy() {
    for (const [type, target, fn] of this.handlers)
      target.removeEventListener(type, fn);
    this.handlers = [];
  }
}
