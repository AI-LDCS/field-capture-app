import type { GpsPoint, LngLat } from "./types.ts";

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLengthM(coords: LngLat[]): number {
  let n = 0;
  for (let i = 1; i < coords.length; i++) n += haversineM(coords[i - 1], coords[i]);
  return n;
}

/** Points along the line every ~stepM metres (always includes both ends). */
export function densify(coords: LngLat[], stepM: number): LngLat[] {
  if (coords.length === 0) return [];
  const out: LngLat[] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = haversineM(a, b);
    const n = Math.max(1, Math.ceil(d / stepM));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
  }
  return out;
}

/** Local equirectangular distance (m) from p to segment a-b. Fine for short spans. */
function distToSegM(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos(rad(p[1])) * rad(1) * R;
  const m = rad(1) * R;
  const px = (p[0] - a[0]) * k,
    py = (p[1] - a[1]) * m;
  const bx = (b[0] - a[0]) * k,
    by = (b[1] - a[1]) * m;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - bx * t, py - by * t);
}

export function distToLineM(p: LngLat, coords: LngLat[]): number {
  if (coords.length === 1) return haversineM(p, coords[0]);
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    best = Math.min(best, distToSegM(p, coords[i - 1], coords[i]));
  }
  return best;
}

export type CoverageOpts = { bufferM: number; stepM: number; maxAccuracyM: number };

/**
 * Which ~stepM-spaced sample points of the segment lie within bufferM of at least one
 * usable GPS point. Points worse than maxAccuracyM are ignored (kept elsewhere, never counted).
 */
export function coverageMask(
  coords: LngLat[],
  points: Pick<GpsPoint, "lat" | "lng" | "acc">[],
  opts: CoverageOpts,
): { samples: LngLat[]; covered: boolean[] } {
  const samples = densify(coords, opts.stepM);
  const usable = points.filter((p) => p.acc <= opts.maxAccuracyM);
  if (samples.length === 0 || usable.length === 0) return { samples, covered: samples.map(() => false) };
  // spatial grid so the check stays fast with thousands of points
  const cell = Math.max(opts.bufferM, 10);
  const latM = rad(1) * R;
  const key = (lat: number, lng: number) => {
    const lngM = Math.cos(rad(lat)) * rad(1) * R;
    return `${Math.floor((lat * latM) / cell)}:${Math.floor((lng * lngM) / cell)}`;
  };
  const grid = new Map<string, LngLat[]>();
  for (const p of usable) {
    const k = key(p.lat, p.lng);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push([p.lng, p.lat]);
  }
  const covered = samples.map((s) => {
    const lngM = Math.cos(rad(s[1])) * rad(1) * R;
    const cy = Math.floor((s[1] * latM) / cell);
    const cx = Math.floor((s[0] * lngM) / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get(`${cy + dy}:${cx + dx}`);
        if (list && list.some((q) => haversineM(s, q) <= opts.bufferM)) return true;
      }
    }
    return false;
  });
  return { samples, covered };
}

/**
 * Coverage = share of the segment's length that lies within bufferM of at least
 * one usable GPS point. The end point being reached is not enough on its own.
 */
export function segmentCoverage(coords: LngLat[], points: Pick<GpsPoint, "lat" | "lng" | "acc">[], opts: CoverageOpts): number {
  const { samples, covered } = coverageMask(coords, points, opts);
  return samples.length === 0 ? 0 : covered.filter(Boolean).length / samples.length;
}

/** Compass bearing in degrees (0 = north, clockwise) from a to b. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export const compass = (deg: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
