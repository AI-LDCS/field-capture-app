import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  curveOf,
  endOf,
  midAfter,
  segLength,
  commit,
  hist,
  incompleteSegments,
  insertPoint,
  joinWithNext,
  makeSeg,
  midpoint,
  moveSeg,
  parseLatLng,
  parsePoints,
  redo,
  removePoint,
  reverseSeg,
  setPoint,
  snapTarget,
  splitAt,
  toInput,
  undo,
} from "../../web/src/admin/editor/model.ts";
import { pointAtFraction } from "../../shared/geo.ts";
import type { LngLat } from "../../shared/types.ts";

const P = (...xs: number[][]) => xs as LngLat[];
const seg = (name: string, coords: LngLat[], required = true) => makeSeg(coords, { name, required });
const names = (s: { name: string }[]) => s.map((x) => x.name).join(",");

describe("editor model", () => {
  describe("snap", () => {
    const flat = (a: LngLat, b: LngLat) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const a = seg("A", P([0, 0], [10, 0]));
    const b = seg("B", P([20, 0], [30, 0]));
    const c = seg("C", P([40, 0], [50, 0]));
    const all = [a, b, c];

    it("an end sticks to another segment's start, and a start to another segment's end", () => {
      assert.deepEqual(snapTarget(all, a.key, "end", [19, 0], flat, 2), [20, 0]);
      assert.deepEqual(snapTarget(all, b.key, "start", [11, 0], flat, 2), [10, 0]);
    });
    it("never sticks an end to an end, or a start to a start", () => {
      assert.equal(snapTarget(all, a.key, "end", [29, 0], flat, 2), null);
      assert.equal(snapTarget(all, b.key, "start", [41, 0], flat, 2), null);
    });
    it("never sticks to the segment's own other end", () => {
      assert.equal(snapTarget([a], a.key, "end", [1, 0], flat, 2), null);
    });
    it("stays free outside the radius, and takes the nearest inside it", () => {
      assert.equal(snapTarget(all, a.key, "end", [17, 0], flat, 2), null);
      const near = seg("N", P([21, 0], [25, 0]));
      assert.deepEqual(snapTarget([a, b, near], a.key, "end", [20.8, 0], flat, 2), [21, 0]);
    });
    it("ignores a segment with no points yet", () => {
      assert.equal(snapTarget([a, seg("E", [])], a.key, "end", [0, 0], flat, 2), null);
    });
    it("only the first and last points count as ends", () => {
      const s = seg("S", P([0, 0], [1, 0], [2, 0]));
      assert.deepEqual([endOf(s, 0), endOf(s, 1), endOf(s, 2)], ["start", null, "end"]);
    });
    it("joining snapped segments keeps one shared point", () => {
      const end = snapTarget(all, a.key, "end", [19, 0], flat, 2)!;
      const joined = joinWithNext(setPoint([a, b], a.key, 1, end), a.key);
      assert.deepEqual(joined[0].coords, P([0, 0], [20, 0], [30, 0]));
    });
  });

  it("drag-reorder moves a segment and keeps the rest in order", () => {
    const s = [seg("A", P([0, 0], [1, 0])), seg("B", P([1, 0], [2, 0])), seg("C", P([2, 0], [3, 0])), seg("D", P([3, 0], [4, 0]))];
    assert.equal(names(moveSeg(s, 0, 2)), "B,C,A,D");
    assert.equal(names(moveSeg(s, 3, 0)), "D,A,B,C");
    assert.equal(names(moveSeg(s, 1, 1)), "A,B,C,D");
    assert.equal(moveSeg(s, 1, 9), s); // out of range: untouched
    assert.equal(names(s), "A,B,C,D"); // input never mutated
  });

  it("edits one point without touching other segments", () => {
    const a = seg("A", P([0, 0], [1, 0], [2, 0])),
      b = seg("B", P([5, 5], [6, 6]));
    const next = setPoint([a, b], a.key, 1, [1, 0.5]);
    assert.deepEqual(next[0].coords[1], [1, 0.5]);
    assert.equal(next[1], b);
    assert.deepEqual(a.coords[1], [1, 0]);
    assert.equal(setPoint([a], a.key, 9, [1, 1])[0], a); // bad index ignored
  });

  it("inserts and removes points", () => {
    const a = seg("A", P([0, 0], [2, 0]));
    const ins = insertPoint([a], a.key, 1, midpoint([0, 0], [2, 0]));
    assert.deepEqual(ins[0].coords, [
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    assert.deepEqual(insertPoint([a], a.key, 99, [3, 0])[0].coords.at(-1), [3, 0]);
    assert.deepEqual(removePoint(ins, a.key, 1)[0].coords, [
      [0, 0],
      [2, 0],
    ]);
  });

  it("splits at an inner vertex into two usable segments, and refuses at the ends", () => {
    const a = seg("A", P([0, 0], [1, 0], [2, 0], [3, 0]), false);
    const r = splitAt([a], a.key, 2);
    assert.equal(r.segs.length, 2);
    assert.deepEqual(r.segs[0].coords, [
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    assert.deepEqual(r.segs[1].coords, [
      [2, 0],
      [3, 0],
    ]);
    assert.equal(r.segs[1].required, false);
    assert.notEqual(r.segs[0].key, r.segs[1].key);
    assert.equal(splitAt([a], a.key, 0).segs.length, 1);
    assert.equal(splitAt([a], a.key, 3).segs.length, 1);
    assert.equal(splitAt([a], a.key, 1).segs.length, 2); // pieces of 2 and 3 points are both fine
  });

  it("join is the inverse of split (no duplicated shared point)", () => {
    const a = seg("A", P([0, 0], [1, 0], [2, 0], [3, 0]));
    const split = splitAt([a], a.key, 2).segs;
    const joined = joinWithNext(split, split[0].key);
    assert.equal(joined.length, 1);
    assert.deepEqual(joined[0].coords, a.coords);
    const far = joinWithNext([seg("X", P([0, 0], [1, 0])), seg("Y", P([5, 5], [6, 6]))], "x");
    assert.equal(far.length, 2); // unknown key: nothing happens
  });

  it("reverses direction", () => {
    const a = seg("A", P([0, 0], [1, 1], [2, 0]));
    assert.deepEqual(reverseSeg([a], a.key)[0].coords, [
      [2, 0],
      [1, 1],
      [0, 0],
    ]);
  });

  it("flags segments with fewer than 2 points", () => {
    assert.deepEqual(incompleteSegments([seg("A", P([0, 0], [1, 0])), seg("B", P([0, 0])), seg("C", [])]), [2, 3]);
  });

  it("maps to the API input", () => {
    const a = makeSeg(P([0, 0], [1, 0]), { name: "N", required: false, minCoverage: 0.8 });
    assert.deepEqual(toInput([a]), [
      {
        name: "N",
        required: false,
        smooth: false,
        coords: [
          [0, 0],
          [1, 0],
        ],
        minCoverageRatio: 0.8,
      },
    ]);
  });

  it("finds the middle of a line and its heading", () => {
    const r = pointAtFraction(P([100, 13], [100.002, 13]), 0.5)!;
    assert.ok(Math.abs(r.point[0] - 100.001) < 1e-6);
    assert.ok(Math.abs(r.bearing - 90) < 0.5); // due east
    assert.equal(pointAtFraction(P([1, 1]), 0.5), null);
  });
});

describe("curved segments in the editor", () => {
  const ctrl = P([100.5, 13.75], [100.5006, 13.7506], [100.5012, 13.7504], [100.5018, 13.751]);
  it("a curved segment draws a denser line than its control points; a straight one draws its points", () => {
    const curved = makeSeg(ctrl, { smooth: true });
    const straight = makeSeg(ctrl, { smooth: false });
    assert.ok(curveOf(curved).line.length > ctrl.length * 10);
    assert.equal(curveOf(straight).line, straight.coords);
    assert.ok(segLength(curved) > 0);
    assert.equal(curveOf(curved), curveOf(curved), "cached per control list, so dragging stays fast");
  });
  it("a new point goes on the drawn curve, so adding it does not change the shape", () => {
    const curved = makeSeg(ctrl, { smooth: true });
    const m = midAfter(curved, 1);
    assert.ok(
      curveOf(curved).line.some((p) => p[0] === m[0] && p[1] === m[1]),
      "the handle sits on the line",
    );
    const with1 = insertPoint([curved], curved.key, 2, m)[0];
    const before = segLength(curved),
      after = segLength(with1);
    assert.ok(Math.abs(after - before) / before < 0.03, `${before} -> ${after}`);
  });
  it("split and join keep the curved setting", () => {
    const s = makeSeg(ctrl, { smooth: true });
    const parts = splitAt([s], s.key, 2).segs;
    assert.ok(parts.every((x) => x.smooth));
    assert.ok(joinWithNext(parts, parts[0].key)[0].smooth);
  });
});

describe("typing coordinates", () => {
  it("accepts lat first, any separator", () => {
    assert.deepEqual(parseLatLng("13.7563, 100.5018"), { p: [100.5018, 13.7563] });
    assert.deepEqual(parseLatLng("13.7563 100.5018"), { p: [100.5018, 13.7563] });
    assert.deepEqual(parseLatLng("13.7563;100.5018"), { p: [100.5018, 13.7563] });
  });
  it("rejects swapped, out of range and junk with a reason", () => {
    assert.match((parseLatLng("100.5018, 13.7563") as any).error, /latitude/);
    assert.match((parseLatLng("13, 200") as any).error, /longitude/);
    assert.match((parseLatLng("hello") as any).error, /lat, lng/);
    assert.match((parseLatLng("1, 2, 3") as any).error, /lat, lng/);
  });
  it("bulk text makes segments; blank line splits; optional marks the next", () => {
    const r = parsePoints("13.1, 100.1\n13.2, 100.2\n\noptional\n13.3, 100.3\n13.4, 100.4\n13.5, 100.5");
    assert.deepEqual(r.errors, []);
    assert.equal(r.segs.length, 2);
    assert.equal(r.segs[0].required, true);
    assert.equal(r.segs[1].required, false);
    assert.equal(r.segs[1].coords.length, 3);
  });
  it("bulk text reports bad lines and one-point segments", () => {
    const r = parsePoints("100.5, 13.7\nbad\n\n13.1, 100.1");
    assert.equal(r.segs.length, 0);
    assert.ok(r.errors.length >= 3);
  });
});

describe("undo / redo", () => {
  it("steps back and forward, and a new edit clears redo", () => {
    let h = hist(1);
    h = commit(h, 2);
    h = commit(h, 3);
    assert.equal(undo(h).present, 2);
    assert.equal(redo(undo(undo(h))).present, 2);
    const back = undo(h);
    const edited = commit(back, 9);
    assert.equal(edited.present, 9);
    assert.equal(edited.future.length, 0);
    assert.equal(undo(hist(1)).present, 1); // nothing to undo
    assert.equal(commit(h, h.present), h); // no-op change adds no step
  });
});
