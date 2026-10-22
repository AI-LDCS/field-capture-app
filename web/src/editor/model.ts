import { smoothLine } from "@shared/curve.ts";
import { bearingDeg, haversineM, lineLengthM } from "@shared/geo.ts";
import type { LngLat, SegmentInput } from "@shared/types.ts";

/** Editing model. Every function is pure: it returns a new list and never mutates its input. */
/** `coords` are what the admin edits: control points when `smooth` (the line is the curve through them), else the line itself. */
export type Seg = { key: string; name: string; required: boolean; minCoverage: number; smooth: boolean; coords: LngLat[] };

let counter = 0;
export const newKey = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;
export const makeSeg = (coords: LngLat[] = [], over: Partial<Seg> = {}): Seg => ({
  key: newKey(), name: "", required: true, minCoverage: 0.9, smooth: false, coords, ...over,
});

export const toInput = (segs: Seg[]): SegmentInput[] =>
  segs.map((s) => ({ name: s.name, required: s.required, smooth: s.smooth, coords: s.coords, minCoverageRatio: s.minCoverage }));

const mapSeg = (segs: Seg[], key: string, f: (s: Seg) => Seg) => segs.map((s) => (s.key === key ? f(s) : s));

export const updateSeg = (segs: Seg[], key: string, patch: Partial<Seg>) => mapSeg(segs, key, (s) => ({ ...s, ...patch }));
export const removeSeg = (segs: Seg[], key: string) => segs.filter((s) => s.key !== key);

/** Drag-and-drop reorder: take the segment at `from` and put it at `to`. */
export function moveSeg(segs: Seg[], from: number, to: number): Seg[] {
  if (from === to || from < 0 || to < 0 || from >= segs.length || to >= segs.length) return segs;
  const next = [...segs];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export const setPoint = (segs: Seg[], key: string, i: number, p: LngLat) =>
  mapSeg(segs, key, (s) => (i < 0 || i >= s.coords.length ? s : { ...s, coords: s.coords.map((c, j) => (j === i ? p : c)) }));

/** Insert so that the new point ends up at index `at` (0..length). */
export const insertPoint = (segs: Seg[], key: string, at: number, p: LngLat) =>
  mapSeg(segs, key, (s) => {
    const i = Math.max(0, Math.min(at, s.coords.length));
    return { ...s, coords: [...s.coords.slice(0, i), p, ...s.coords.slice(i)] };
  });

export const removePoint = (segs: Seg[], key: string, i: number) =>
  mapSeg(segs, key, (s) => (i < 0 || i >= s.coords.length ? s : { ...s, coords: s.coords.filter((_, j) => j !== i) }));

export const midpoint = (a: LngLat, b: LngLat): LngLat => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Split at an inner vertex: [0..i] stays, [i..end] becomes a new segment right after it. */
export function splitAt(segs: Seg[], key: string, i: number): { segs: Seg[]; newKey: string | null } {
  const idx = segs.findIndex((s) => s.key === key);
  if (idx < 0) return { segs, newKey: null };
  const s = segs[idx];
  if (i <= 0 || i >= s.coords.length - 1) return { segs, newKey: null }; // need 2+ points on both sides
  const a: Seg = { ...s, coords: s.coords.slice(0, i + 1) };
  const b: Seg = { ...s, key: newKey(), coords: s.coords.slice(i) };
  return { segs: [...segs.slice(0, idx), a, b, ...segs.slice(idx + 1)], newKey: b.key };
}

/** Join a segment with the one after it. The first segment keeps its name and settings. */
export function joinWithNext(segs: Seg[], key: string): Seg[] {
  const idx = segs.findIndex((s) => s.key === key);
  if (idx < 0 || idx >= segs.length - 1) return segs;
  const a = segs[idx];
  const b = segs[idx + 1];
  const same = a.coords.length > 0 && b.coords.length > 0 && haversineM(a.coords[a.coords.length - 1], b.coords[0]) < 0.01;
  const joined: Seg = { ...a, coords: [...a.coords, ...(same ? b.coords.slice(1) : b.coords)] };
  return [...segs.slice(0, idx), joined, ...segs.slice(idx + 2)];
}

export const reverseSeg = (segs: Seg[], key: string) => mapSeg(segs, key, (s) => ({ ...s, coords: [...s.coords].reverse() }));

// the same function the server uses, so what you see is what gets stored
const curves = new WeakMap<LngLat[], { line: LngLat[]; at: number[] }>();
export function curveOf(s: Pick<Seg, "smooth" | "coords">): { line: LngLat[]; at: number[] } {
  if (!s.smooth) return { line: s.coords, at: s.coords.map((_, i) => i) };
  let c = curves.get(s.coords);
  if (!c) curves.set(s.coords, (c = smoothLine(s.coords)));
  return c;
}

/** Where a new point goes between control point i and i+1: on the drawn line, so a curve is not disturbed. */
export function midAfter(s: Seg, i: number): LngLat {
  const { line, at } = curveOf(s);
  if (s.smooth && at.length === s.coords.length) return line[Math.round((at[i] + at[i + 1]) / 2)];
  return midpoint(s.coords[i], s.coords[i + 1]);
}

export const segLength = (s: Seg) => lineLengthM(curveOf(s).line);
export const totalLength = (segs: Seg[]) => segs.reduce((a, s) => a + segLength(s), 0);

/** A segment is usable once it has two points. Returns the 1-based numbers of the ones that are not. */
export const incompleteSegments = (segs: Seg[]) => segs.flatMap((s, i) => (s.coords.length < 2 ? [i + 1] : []));

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
      const a = coords[i - 1], b = coords[i];
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearingDeg(a, b) };
    }
    want -= d;
  }
  return null;
}

/** Colour by position in the walking order, so the sequence is visible on the map and in the list. */
export const seqColor = (i: number, n: number) => `hsl(${Math.round(210 + (n <= 1 ? 0 : (i / (n - 1)) * 130))} 75% 45%)`;

export const validLat = (v: number) => Number.isFinite(v) && Math.abs(v) <= 90;
export const validLng = (v: number) => Number.isFinite(v) && Math.abs(v) <= 180;

/** "13.7563, 100.5018" (comma, space, tab or semicolon) -> [lng, lat], or an error text. */
export function parseLatLng(text: string): { p: LngLat } | { error: string } {
  const nums = text.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
  if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) return { error: 'expected "lat, lng"' };
  if (!validLat(nums[0])) return { error: `latitude ${nums[0]} is out of range (lat first, then lng)` };
  if (!validLng(nums[1])) return { error: `longitude ${nums[1]} is out of range` };
  return { p: [nums[1], nums[0]] };
}

/**
 * Bulk text: one point per line as "lat, lng". A blank line starts the next segment.
 * A line "optional" or "required" before a segment sets its type.
 */
export function parsePoints(text: string): { segs: Seg[]; errors: string[] } {
  const segs: Seg[] = [];
  const errors: string[] = [];
  let cur: LngLat[] = [];
  let required = true;
  const flush = (line: number) => {
    if (cur.length === 1) errors.push(`segment ending near line ${line}: needs at least 2 points`);
    else if (cur.length > 1) segs.push(makeSeg(cur, { required }));
    cur = [];
    required = true;
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return flush(i);
    if (/^#?\s*(optional|required)\s*$/i.test(line)) {
      if (cur.length) flush(i);
      required = /required/i.test(line);
      return;
    }
    const r = parseLatLng(line);
    if ("error" in r) return void errors.push(`line ${i + 1}: ${r.error}`);
    cur.push(r.p);
  });
  flush(lines.length);
  return { segs, errors };
}

// ---------- undo / redo ----------
export type History<T> = { past: T[]; present: T; future: T[] };
export const hist = <T,>(present: T): History<T> => ({ past: [], present, future: [] });
export const commit = <T,>(h: History<T>, next: T): History<T> =>
  next === h.present ? h : { past: [...h.past.slice(-99), h.present], present: next, future: [] };
export const undo = <T,>(h: History<T>): History<T> =>
  h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h;
export const redo = <T,>(h: History<T>): History<T> =>
  h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h;
