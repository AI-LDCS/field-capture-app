import type { LngLat } from "./types.ts";

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

type V = { x: number; y: number };

/**
 * A smooth line through the control points (centripetal Catmull-Rom). It passes exactly through every
 * control point and does not loop or overshoot at uneven spacing. Used by the editor preview and by the
 * server when it stores the geometry, so both always agree.
 *
 * `at[i]` is the index in `line` where control point i sits (after removing repeated points).
 */
export function smoothLine(control: LngLat[], stepM = 2): { line: LngLat[]; at: number[] } {
  // drop repeated points, they would give zero-length pieces
  const pts: LngLat[] = [];
  for (const c of control) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot((c[0] - last[0]) * 111_320, (c[1] - last[1]) * 110_574) > 0.01) pts.push(c);
  }
  if (pts.length < 3) return { line: pts, at: pts.map((_, i) => i) };

  // metres on a flat plane around the line: plenty accurate at walking-route scale
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const lng0 = pts[0][0];
  const kx = Math.cos(rad(lat0)) * rad(1) * R;
  const ky = rad(1) * R;
  const P: V[] = pts.map((p) => ({ x: (p[0] - lng0) * kx, y: (p[1] - lat0) * ky }));
  const back = (v: V): LngLat => [lng0 + v.x / kx, lat0 + v.y / ky];

  const n = P.length;
  const ext: V[] = [
    { x: 2 * P[0].x - P[1].x, y: 2 * P[0].y - P[1].y },
    ...P,
    { x: 2 * P[n - 1].x - P[n - 2].x, y: 2 * P[n - 1].y - P[n - 2].y },
  ];
  const dist = (a: V, b: V) => Math.hypot(b.x - a.x, b.y - a.y);
  const lerp = (a: V, b: V, ta: number, tb: number, t: number): V => {
    const d = tb - ta;
    if (d === 0) return b;
    const u = (t - ta) / d;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  };

  const line: LngLat[] = [pts[0]];
  const at: number[] = [0];
  for (let i = 0; i < n - 1; i++) {
    const p0 = ext[i],
      p1 = ext[i + 1],
      p2 = ext[i + 2],
      p3 = ext[i + 3];
    const t0 = 0;
    const t1 = t0 + Math.sqrt(dist(p0, p1));
    const t2 = t1 + Math.sqrt(dist(p1, p2));
    const t3 = t2 + Math.sqrt(dist(p2, p3));
    const steps = Math.max(2, Math.ceil(dist(p1, p2) / stepM));
    for (let j = 1; j < steps; j++) {
      const t = t1 + ((t2 - t1) * j) / steps;
      const A1 = lerp(p0, p1, t0, t1, t),
        A2 = lerp(p1, p2, t1, t2, t),
        A3 = lerp(p2, p3, t2, t3, t);
      const B1 = lerp(A1, A2, t0, t2, t),
        B2 = lerp(A2, A3, t1, t3, t);
      line.push(back(lerp(B1, B2, t1, t2, t)));
    }
    line.push(pts[i + 1]); // the control point itself, exactly
    at.push(line.length - 1);
  }
  return { line, at };
}
