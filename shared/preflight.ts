import { CONFIG } from "./config.ts";
import { haversineM } from "./geo.ts";

export type PreflightConfig = { windowMs: number; minSamples: number; targetAccuracyM: number; maxSpreadM: number };

export type PreflightSample = { t: number; lat: number; lng: number; acc: number };

export type PreflightEval = {
  stable: boolean;
  samplesInWindow: number;
  spanMs: number;
  worstAccuracyM: number | null;
  spreadM: number | null;
  reason: string;
};

/**
 * Stable = enough fresh samples with distinct timestamps across the window,
 * every one within the target accuracy, and little positional spread.
 * One good reading is never enough.
 */
export function evaluatePreflight(samples: PreflightSample[], now: number, cfg: PreflightConfig = CONFIG.preflight): PreflightEval {
  const recent = samples.filter((s) => now - s.t <= cfg.windowMs);
  const distinct = [...new Map(recent.map((s) => [s.t, s])).values()].sort((a, b) => a.t - b.t);
  const base = { samplesInWindow: distinct.length, spanMs: 0, worstAccuracyM: null, spreadM: null };
  if (distinct.length < cfg.minSamples) {
    return { ...base, stable: false, reason: `need ${cfg.minSamples} samples (have ${distinct.length})` };
  }
  const spanMs = distinct[distinct.length - 1].t - distinct[0].t;
  const worst = Math.max(...distinct.map((s) => s.acc));
  const cLat = distinct.reduce((a, s) => a + s.lat, 0) / distinct.length;
  const cLng = distinct.reduce((a, s) => a + s.lng, 0) / distinct.length;
  const spread = Math.max(...distinct.map((s) => haversineM([s.lng, s.lat], [cLng, cLat])));
  const r = { samplesInWindow: distinct.length, spanMs, worstAccuracyM: worst, spreadM: spread };
  if (spanMs < cfg.windowMs * 0.7) return { ...r, stable: false, reason: "samples span too short" };
  if (worst > cfg.targetAccuracyM) return { ...r, stable: false, reason: `accuracy ${worst.toFixed(0)} m > ${cfg.targetAccuracyM} m` };
  if (spread > cfg.maxSpreadM) return { ...r, stable: false, reason: `position drifting ${spread.toFixed(1)} m` };
  return { ...r, stable: true, reason: "stable" };
}

/**
 * How close the check is to passing, 0 to 1: the unbroken run of accurate fixes ending now,
 * against the count and span a pass needs. A bad fix sends it back to zero, as it blocks a pass.
 */
export function preflightProgress(samples: PreflightSample[], now: number, cfg: PreflightConfig = CONFIG.preflight): number {
  const recent = samples.filter((s) => now - s.t <= cfg.windowMs);
  const distinct = [...new Map(recent.map((s) => [s.t, s])).values()].sort((a, b) => a.t - b.t);
  let start = distinct.length;
  while (start > 0 && distinct[start - 1].acc <= cfg.targetAccuracyM) start--;
  const good = distinct.slice(start);
  if (!good.length) return 0;
  return Math.min(1, good.length / cfg.minSamples, (good[good.length - 1].t - good[0].t) / (cfg.windowMs * 0.7));
}
