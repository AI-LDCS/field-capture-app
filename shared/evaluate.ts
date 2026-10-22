import { CONFIG } from "./config.ts";
import { distToLineM, haversineM, segmentCoverage } from "./geo.ts";
import type { GpsPoint, GpsQuality, LngLat } from "./types.ts";

/** Coverage of each segment from all given GPS tracks combined. */
export function coverageFor(segmentCoords: LngLat[][], tracks: GpsPoint[][]): number[] {
  const all = tracks.flat();
  return segmentCoords.map((c) => segmentCoverage(c, all, CONFIG.coverage));
}

/** Flags (never drops) imperfect data. Gaps and jumps are measured inside one recording. */
export function analyseQuality(tracks: GpsPoint[][], segmentCoords: LngLat[][]): GpsQuality {
  const q: GpsQuality = { total: 0, poorAccuracy: 0, gaps: 0, jumps: 0, offRoute: 0 };
  for (const track of tracks) {
    const pts = [...track].sort((a, b) => a.seq - b.seq);
    pts.forEach((p, i) => {
      q.total++;
      if (p.acc > CONFIG.coverage.maxAccuracyM) q.poorAccuracy++;
      if (segmentCoords.length) {
        const d = Math.min(...segmentCoords.map((c) => distToLineM([p.lng, p.lat], c)));
        if (d > CONFIG.quality.offRouteM) q.offRoute++;
      }
      if (i > 0) {
        const prev = pts[i - 1];
        const dt = p.t - prev.t;
        if (dt > CONFIG.quality.gapMs) q.gaps++;
        const dist = haversineM([prev.lng, prev.lat], [p.lng, p.lat]);
        if (dt > 0 && dist / (dt / 1000) > CONFIG.quality.jumpSpeedMps) q.jumps++;
      }
    });
  }
  return q;
}

export function qualityReasons(q: GpsQuality): string[] {
  const out: string[] = [];
  if (q.total === 0) return out;
  if (q.poorAccuracy / q.total > CONFIG.quality.reviewBadRatio) out.push(`${q.poorAccuracy}/${q.total} GPS points have poor accuracy`);
  if (q.offRoute / q.total > CONFIG.quality.reviewBadRatio) out.push(`${q.offRoute}/${q.total} GPS points are off route`);
  if (q.gaps > CONFIG.quality.reviewMaxGaps) out.push(`${q.gaps} GPS gaps`);
  return out;
}
