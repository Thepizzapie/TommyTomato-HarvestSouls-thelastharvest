// Tiny math toolbox for the sim. No deps, all hot-path friendly.

export interface Vec {
  x: number;
  y: number;
}

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const lerpAngle = (a: number, b: number, t: number) => {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

export const dist = (ax: number, ay: number, bx: number, by: number) =>
  Math.sqrt(dist2(ax, ay, bx, by));

export const len = (x: number, y: number) => Math.sqrt(x * x + y * y);

export function norm(x: number, y: number): Vec {
  const l = Math.hypot(x, y);
  if (l < 1e-6) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}

export const angleTo = (ax: number, ay: number, bx: number, by: number) =>
  Math.atan2(by - ay, bx - ax);

// circle vs circle
export const circleHit = (
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number
) => dist2(ax, ay, bx, by) <= (ar + br) * (ar + br);

// is point within an arc (used for melee swings & vision cones)
export function inArc(
  px: number,
  py: number,
  ox: number,
  oy: number,
  facing: number,
  halfAngle: number,
  radius: number
): boolean {
  const dx = px - ox;
  const dy = py - oy;
  if (dx * dx + dy * dy > radius * radius) return false;
  const a = Math.atan2(dy, dx);
  let d = Math.abs(((a - facing + Math.PI) % (Math.PI * 2)) - Math.PI);
  return d <= halfAngle;
}

// axis-aligned rectangle (wall) — for collision resolution
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// push a circle out of a rect, returns resolved position
export function resolveCircleRect(
  cx: number,
  cy: number,
  r: number,
  rect: Rect
): Vec {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  const dx = cx - nx;
  const dy = cy - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > r * r) return { x: cx, y: cy };

  if (d2 > 1e-6) {
    const d = Math.sqrt(d2);
    return { x: nx + (dx / d) * r, y: ny + (dy / d) * r };
  }
  // center inside rect: push out along least-penetration axis
  const left = cx - rect.x;
  const right = rect.x + rect.w - cx;
  const top = cy - rect.y;
  const bottom = rect.y + rect.h - cy;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: rect.x - r, y: cy };
  if (m === right) return { x: rect.x + rect.w + r, y: cy };
  if (m === top) return { x: cx, y: rect.y - r };
  return { x: cx, y: rect.y + rect.h + r };
}

export const approach = (cur: number, target: number, step: number) => {
  if (cur < target) return Math.min(cur + step, target);
  if (cur > target) return Math.max(cur - step, target);
  return cur;
};
