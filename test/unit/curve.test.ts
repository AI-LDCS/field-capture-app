import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { haversineM, lineLengthM } from "../../shared/geo.ts";
import { smoothLine } from "../../shared/curve.ts";
import type { LngLat } from "../../shared/types.ts";

const bend: LngLat[] = [
  [100.5, 13.75],
  [100.5006, 13.7506],
  [100.5012, 13.7504],
  [100.5018, 13.751],
];

describe("smoothLine", () => {
  it("passes exactly through every control point, in order", () => {
    const { line, at } = smoothLine(bend);
    assert.equal(at.length, bend.length);
    bend.forEach((c, i) => assert.deepEqual(line[at[i]], c));
    assert.deepEqual(
      at,
      [...at].sort((a, b) => a - b),
    );
    assert.equal(at[0], 0);
    assert.equal(at[at.length - 1], line.length - 1);
  });

  it("is dense (about one point per step) and has no NaN", () => {
    const { line } = smoothLine(bend, 2);
    assert.ok(line.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
    const gaps = line.slice(1).map((p, i) => haversineM(line[i], p));
    assert.ok(Math.max(...gaps) < 2.5, `max gap ${Math.max(...gaps)}`);
    assert.ok(line.length > bend.length * 10);
  });

  it("curves: the result is not the same as the straight polyline, but stays close to it", () => {
    const { line } = smoothLine(bend);
    const straight = lineLengthM(bend);
    const curved = lineLengthM(line);
    assert.ok(curved > 0 && Math.abs(curved - straight) / straight < 0.2, `${curved} vs ${straight}`);
    // it really is a different line: it contains points that are not control points
    assert.ok(line.some((p) => !bend.some((b) => b[0] === p[0] && b[1] === p[1])));
  });

  it("a straight row of points stays straight", () => {
    const row: LngLat[] = [
      [100.5, 13.75],
      [100.501, 13.75],
      [100.502, 13.75],
      [100.503, 13.75],
    ];
    const { line } = smoothLine(row);
    assert.ok(line.every((p) => Math.abs(p[1] - 13.75) < 1e-9));
  });

  it("copes with repeated points and with fewer than 3 points", () => {
    const dup = smoothLine([
      [100.5, 13.75],
      [100.5, 13.75],
      [100.501, 13.751],
      [100.502, 13.75],
    ]);
    assert.ok(dup.line.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
    assert.equal(dup.at.length, 3);
    assert.deepEqual(
      smoothLine([
        [1, 2],
        [3, 4],
      ]).line,
      [
        [1, 2],
        [3, 4],
      ],
    );
    assert.deepEqual(smoothLine([[1, 2]]).line, [[1, 2]]);
    assert.deepEqual(smoothLine([]).line, []);
  });

  it("does not loop on very uneven spacing", () => {
    const uneven: LngLat[] = [
      [100.5, 13.75],
      [100.5001, 13.7501],
      [100.51, 13.7502],
      [100.5101, 13.7503],
    ];
    const { line } = smoothLine(uneven);
    // never wanders more than 30 m outside the control points' bounding box
    const lngs = uneven.map((p) => p[0]),
      lats = uneven.map((p) => p[1]);
    const pad = 30 / 111_320;
    assert.ok(
      line.every(
        (p) =>
          p[0] >= Math.min(...lngs) - pad &&
          p[0] <= Math.max(...lngs) + pad &&
          p[1] >= Math.min(...lats) - pad &&
          p[1] <= Math.max(...lats) + pad,
      ),
    );
  });
});
