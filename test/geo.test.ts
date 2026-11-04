import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.ts";
import { analyseQuality, coverageFor, qualityReasons } from "../shared/evaluate.ts";
import { bearingDeg, compass, coverageMask, densify, distToLineM, haversineM, lineLengthM, segmentCoverage } from "../shared/geo.ts";
import type { GpsPoint, LngLat } from "../shared/types.ts";

const LAT = 13.75;
const mLng = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180)); // metres east -> degrees of longitude
const mLat = (m: number) => m / 110_574;
/** a straight line `len` metres east from the origin */
const east = (len: number): LngLat[] => [
  [100.5, LAT],
  [100.5 + mLng(len), LAT],
];
const opts = CONFIG.coverage;
const pt = (lng: number, lat: number, acc = 5, extra: Partial<GpsPoint> = {}): GpsPoint => ({ seq: 0, t: 0, lat, lng, acc, ...extra });
/** fixes every `every` metres along the east line */
const along = (len: number, every: number, acc = 5): GpsPoint[] =>
  Array.from({ length: Math.floor(len / every) + 1 }, (_, i) => pt(100.5 + mLng(i * every), LAT, acc, { seq: i, t: i * 1000 }));

describe("distances", () => {
  it("haversine: a degree of latitude is about 111 km; same point is 0", () => {
    assert.ok(Math.abs(haversineM([100, 13], [100, 14]) - 111_195) < 200);
    assert.equal(haversineM([100.5, 13.75], [100.5, 13.75]), 0);
  });
  it("line length adds the pieces", () => {
    const l: LngLat[] = [
      [100.5, LAT],
      [100.5 + mLng(100), LAT],
      [100.5 + mLng(100), LAT + mLat(50)],
    ];
    assert.ok(Math.abs(lineLengthM(l) - 150) < 0.5);
    assert.equal(lineLengthM([[1, 1]]), 0);
  });
  it("densify keeps both ends and spaces points no further apart than the step", () => {
    const d = densify(east(103), 5);
    assert.deepEqual(d[0], [100.5, LAT]);
    assert.deepEqual(d[d.length - 1], east(103)[1]);
    const gaps = d.slice(1).map((p, i) => haversineM(d[i], p));
    assert.ok(Math.max(...gaps) <= 5.01, `max gap ${Math.max(...gaps)}`);
    assert.equal(densify([], 5).length, 0);
  });
  it("distance to a line: zero on it, the sideways distance beside it, the end point beyond it", () => {
    const l = east(100);
    assert.ok(distToLineM([100.5 + mLng(50), LAT], l) < 0.01);
    assert.ok(Math.abs(distToLineM([100.5 + mLng(50), LAT + mLat(20)], l) - 20) < 0.3);
    assert.ok(Math.abs(distToLineM([100.5 + mLng(130), LAT], l) - 30) < 0.3, "beyond the end it is the distance to the end");
    assert.ok(Math.abs(distToLineM([100.5, LAT + mLat(10)], [[100.5, LAT]]) - 10) < 0.2, "a one-point line is a point");
  });
});

describe("coverage", () => {
  it("walking the whole segment covers it; the end point alone does not", () => {
    assert.ok(segmentCoverage(east(300), along(300, 10), opts) > 0.99);
    const onlyEnd = [pt(100.5 + mLng(300), LAT)];
    assert.ok(segmentCoverage(east(300), onlyEnd, opts) < 0.2, "reaching the destination is not walking the route");
  });
  it("half walked is about half covered (plus the buffer around the last fix)", () => {
    const c = segmentCoverage(east(300), along(150, 10), opts);
    assert.ok(c > 0.5 && c < 0.65, `coverage ${c}`);
  });
  it("points farther than the buffer from the line do not count", () => {
    const off = along(300, 10).map((p) => ({ ...p, lat: p.lat + mLat(opts.bufferM + 5) }));
    assert.equal(segmentCoverage(east(300), off, opts), 0);
    const near = along(300, 10).map((p) => ({ ...p, lat: p.lat + mLat(opts.bufferM - 5) }));
    assert.ok(segmentCoverage(east(300), near, opts) > 0.95);
  });
  it("poor-accuracy points are ignored for coverage but nothing breaks", () => {
    assert.equal(segmentCoverage(east(300), along(300, 10, opts.maxAccuracyM + 1), opts), 0);
    assert.ok(segmentCoverage(east(300), along(300, 10, opts.maxAccuracyM), opts) > 0.99, "exactly at the limit still counts");
    assert.equal(segmentCoverage(east(300), [], opts), 0);
    assert.equal(segmentCoverage([], along(300, 10), opts), 0);
  });
  it("the mask says which parts are covered, so 'where next' can find the gap", () => {
    const m = coverageMask(east(300), along(120, 10), opts);
    assert.equal(m.samples.length, m.covered.length);
    assert.equal(m.covered[0], true);
    assert.equal(m.covered[m.covered.length - 1], false);
    const firstOpen = m.covered.indexOf(false);
    assert.ok(
      m.covered.slice(firstOpen).every((c) => !c),
      "covered first, open after",
    );
  });
  it("coverageFor combines several recordings", () => {
    const first = along(150, 10),
      second = along(300, 10).filter((p) => p.seq >= 15);
    const both = coverageFor([east(300)], [first, second])[0];
    assert.ok(both > 0.99, `together ${both}`);
    assert.ok(coverageFor([east(300)], [first])[0] < 0.7);
  });
});

describe("compass", () => {
  it("bearings in degrees and eight-way names", () => {
    const o: LngLat = [100.5, LAT];
    assert.ok(Math.abs(bearingDeg(o, [100.5, LAT + 0.01]) - 0) < 0.5);
    assert.ok(Math.abs(bearingDeg(o, [100.51, LAT]) - 90) < 0.5);
    assert.ok(Math.abs(bearingDeg(o, [100.5, LAT - 0.01]) - 180) < 0.5);
    assert.ok(Math.abs(bearingDeg(o, [100.49, LAT]) - 270) < 0.5);
    assert.deepEqual([0, 45, 90, 135, 180, 225, 270, 315, 350].map(compass), ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N"]);
  });
});

describe("GPS quality flags (kept for review, never dropped)", () => {
  const line = [east(1000)];
  it("clean data raises nothing", () => {
    const q = analyseQuality([along(300, 10)], line);
    assert.deepEqual(q, { total: 31, poorAccuracy: 0, gaps: 0, jumps: 0, offRoute: 0 });
    assert.deepEqual(qualityReasons(q), []);
  });
  it("counts poor accuracy, off-route points, gaps and jumps separately", () => {
    const pts: GpsPoint[] = [
      pt(100.5, LAT, 5, { seq: 0, t: 0 }),
      pt(100.5 + mLng(10), LAT, 90, { seq: 1, t: 1000 }), // poor accuracy
      pt(100.5 + mLng(20), LAT + mLat(80), 5, { seq: 2, t: 2000 }), // 80 m off the line (and a fast jump from the last fix)
      pt(100.5 + mLng(30), LAT, 5, { seq: 3, t: 3000 + CONFIG.quality.gapMs + 1 }), // long silence, then back
    ];
    const q = analyseQuality([pts], line);
    assert.equal(q.total, 4);
    assert.equal(q.poorAccuracy, 1);
    assert.equal(q.offRoute, 1);
    assert.equal(q.gaps, 1);
    assert.ok(q.jumps >= 1);
  });
  it("gaps and jumps are measured inside one recording, not between two", () => {
    const a = [pt(100.5, LAT, 5, { seq: 0, t: 0 }), pt(100.5 + mLng(5), LAT, 5, { seq: 1, t: 1000 })];
    const b = [pt(100.5 + mLng(500), LAT, 5, { seq: 0, t: 999_999_000 })];
    const q = analyseQuality([a, b], line);
    assert.equal(q.gaps, 0);
    assert.equal(q.jumps, 0);
  });
  it("review reasons appear only past the thresholds", () => {
    const base = { total: 100, poorAccuracy: 0, gaps: 0, jumps: 0, offRoute: 0 };
    assert.deepEqual(qualityReasons({ ...base, poorAccuracy: 20 }), [], "exactly 20% is still fine");
    assert.equal(qualityReasons({ ...base, poorAccuracy: 21 }).length, 1);
    assert.equal(qualityReasons({ ...base, offRoute: 21 }).length, 1);
    assert.deepEqual(qualityReasons({ ...base, gaps: CONFIG.quality.reviewMaxGaps }), []);
    assert.match(qualityReasons({ ...base, gaps: CONFIG.quality.reviewMaxGaps + 1 })[0], /gaps/);
    assert.deepEqual(qualityReasons({ total: 0, poorAccuracy: 0, gaps: 9, jumps: 9, offRoute: 9 }), [], "no data, no verdict");
  });
});
