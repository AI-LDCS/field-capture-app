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

export type CoverageOpts = { bufferM: number; stepM: number; maxAccuracyM: number; reachM: number };
type FixLike = Pick<GpsPoint, "lat" | "lng" | "acc">;

/** Where p lands on the line: metres along it from the start, and metres beside it. */
function projectOnLine(p: LngLat, coords: LngLat[], cum: number[]): { along: number; dist: number } {
  if (coords.length === 1) return { along: 0, dist: haversineM(p, coords[0]) };
  let best = { along: 0, dist: Infinity };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const k = Math.cos(rad(p[1])) * rad(1) * R;
    const m = rad(1) * R;
    const px = (p[0] - a[0]) * k,
      py = (p[1] - a[1]) * m;
    const bx = (b[0] - a[0]) * k,
      by = (b[1] - a[1]) * m;
    const len2 = bx * bx + by * by;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
    const dist = Math.hypot(px - bx * t, py - by * t);
    if (dist < best.dist) best = { along: cum[i - 1] + t * (cum[i] - cum[i - 1]), dist };
  }
  return best;
}

/**
 * Which ~stepM-spaced sample points of the segment the worker walked past.
 *
 * Each track is one recording's fixes in order. A usable fix (accuracy within maxAccuracyM) that lies within
 * bufferM beside the line lands on it and covers reachM along it either side. Two fixes in a row that both
 * land on the line also cover the stretch between them, when that stretch is no longer than the distance
 * really moved between them (plus 2 x reachM of slack): walking it is the only way to get from one to the
 * other. A fix beside the line covers only where it lands, never bufferM ahead, so progress follows the
 * worker's real position. Tracks are never joined to each other: the end of one recording and the start of
 * the next say nothing about what lies between.
 */
export function coverageMask(coords: LngLat[], tracks: FixLike[][], opts: CoverageOpts): { samples: LngLat[]; covered: boolean[] } {
  const samples = densify(coords, opts.stepM);
  if (samples.length === 0) return { samples, covered: [] };
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineM(coords[i - 1], coords[i]));
  const sAlong = [0];
  for (let i = 1; i < samples.length; i++) sAlong.push(sAlong[i - 1] + haversineM(samples[i - 1], samples[i]));

  const spans: [number, number][] = [];
  for (const track of tracks) {
    let prev: { at: LngLat; along: number } | null = null;
    for (const f of track) {
      if (f.acc > opts.maxAccuracyM) continue; // a weak fix says nothing either way
      const at: LngLat = [f.lng, f.lat];
      const pr = projectOnLine(at, coords, cum);
      if (pr.dist > opts.bufferM) {
        prev = null; // left the line: the walk along it starts again from the next fix on it
        continue;
      }
      spans.push([pr.along - opts.reachM, pr.along + opts.reachM]);
      if (prev && Math.abs(pr.along - prev.along) <= haversineM(prev.at, at) + 2 * opts.reachM) {
        spans.push([Math.min(prev.along, pr.along), Math.max(prev.along, pr.along)]);
      }
      prev = { at, along: pr.along };
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const covered = samples.map(() => false);
  let k = 0;
  for (const [lo, hi] of spans) {
    // samples are in order along the line; spans are sorted by start, so walk both once
    while (k < samples.length && sAlong[k] < lo) k++;
    for (let j = k; j < samples.length && sAlong[j] <= hi; j++) covered[j] = true;
  }
  return { samples, covered };
}

/**
 * Coverage = share of the segment's sample points the worker walked past (see coverageMask).
 * The end point being reached is not enough on its own.
 */
export function segmentCoverage(coords: LngLat[], tracks: FixLike[][], opts: CoverageOpts): number {
  const { samples, covered } = coverageMask(coords, tracks, opts);
  return samples.length === 0 ? 0 : covered.filter(Boolean).length / samples.length;
}

/** Compass bearing in degrees (0 = north, clockwise) from a to b. */
export function bearingDeg(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export const compass = (deg: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];

/** Point at a fraction (0..1) of the line's length, with the direction of travel there. */
export function pointAtFraction(coords: LngLat[], f: number): { point: LngLat; bearing: number } | null {
  if (coords.length < 2) return null;
  const total = lineLengthM(coords);
  if (total === 0) return null;
  let want = total * f;
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1], coords[i]);
    if (want <= d || i === coords.length - 1) {
      const t = d === 0 ? 0 : Math.min(1, want / d);
      const a = coords[i - 1],
        b = coords[i];
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearingDeg(a, b) };
    }
    want -= d;
  }
  return null;
}

/** Evenly spaced points along a line, about `spacingM` apart, for direction arrows. A short line still gets one, at its middle. */
export function arrowsAlong(coords: LngLat[], spacingM: number, max = 20): { point: LngLat; bearing: number }[] {
  const n = Math.max(1, Math.min(max, Math.round(lineLengthM(coords) / spacingM)));
  return Array.from({ length: n }, (_, k) => pointAtFraction(coords, (k + 0.5) / n)).filter((a) => a !== null);
}
