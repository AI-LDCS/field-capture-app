import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONFIG } from "../../shared/config.ts";
import { evaluatePreflight, preflightProgress, type PreflightSample } from "../../shared/preflight.ts";

const NOW = 1_800_000_000_000;
const M_PER_DEG = 111_320;

/** n fixes, one per second, ending at `NOW`, at 13.75 N with the given accuracy and a little sideways wobble in metres */
const fixes = (n: number, acc = 5, wobbleM = 0, endAt = NOW): PreflightSample[] =>
  Array.from({ length: n }, (_, i) => ({
    t: endAt - (n - 1 - i) * 1000,
    lat: 13.75,
    lng: 100.5 + ((i % 2 ? 1 : -1) * wobbleM) / (M_PER_DEG * Math.cos((13.75 * Math.PI) / 180)),
    acc,
  }));

describe("GPS check", () => {
  it("passes with steady, accurate fixes across the window", () => {
    const e = evaluatePreflight(fixes(12), NOW);
    assert.equal(e.stable, true);
    assert.equal(e.reason, "stable");
    assert.equal(e.samplesInWindow, 12);
    assert.ok(e.spanMs >= CONFIG.preflight.windowMs * 0.7);
  });

  it("one good reading is never enough", () => {
    assert.equal(evaluatePreflight(fixes(1), NOW).stable, false);
    assert.match(evaluatePreflight(fixes(4), NOW).reason, /need 5 samples \(have 4\)/);
    assert.equal(evaluatePreflight([], NOW).stable, false);
  });

  it("needs the samples to cover most of the window, not five in one burst", () => {
    const burst: PreflightSample[] = Array.from({ length: 6 }, (_, i) => ({ t: NOW - i * 100, lat: 13.75, lng: 100.5, acc: 4 }));
    const e = evaluatePreflight(burst, NOW);
    assert.equal(e.stable, false);
    assert.match(e.reason, /span too short/);
  });

  it("fails while any sample in the window is worse than the target accuracy", () => {
    const f = fixes(12);
    f[3] = { ...f[3], acc: CONFIG.preflight.targetAccuracyM + 1 };
    const e = evaluatePreflight(f, NOW);
    assert.equal(e.stable, false);
    assert.match(e.reason, /accuracy 16 m > 15 m/);
    assert.equal(e.worstAccuracyM, 16);
    // exactly on the target is fine
    const edge = fixes(12, CONFIG.preflight.targetAccuracyM);
    assert.equal(evaluatePreflight(edge, NOW).stable, true);
  });

  it("a bad fix that has left the window no longer blocks", () => {
    const old: PreflightSample = { t: NOW - CONFIG.preflight.windowMs - 1, lat: 13.75, lng: 100.5, acc: 500 };
    assert.equal(evaluatePreflight([old, ...fixes(12)], NOW).stable, true);
  });

  it("fails when the position drifts", () => {
    const drifting = fixes(12, 5, CONFIG.preflight.maxSpreadM + 6);
    const e = evaluatePreflight(drifting, NOW);
    assert.equal(e.stable, false);
    assert.match(e.reason, /position drifting/);
    assert.ok(e.spreadM! > CONFIG.preflight.maxSpreadM);
    assert.equal(evaluatePreflight(fixes(12, 5, 2), NOW).stable, true, "small wobble is fine");
  });

  it("counts each timestamp once (a repeated fix is not a new sample)", () => {
    const one = { t: NOW, lat: 13.75, lng: 100.5, acc: 4 };
    const e = evaluatePreflight(
      Array.from({ length: 8 }, () => ({ ...one })),
      NOW,
    );
    assert.equal(e.samplesInWindow, 1);
    assert.equal(e.stable, false);
  });

  it("the thresholds come from the config and can be overridden", () => {
    const strict = { ...CONFIG.preflight, targetAccuracyM: 3 };
    assert.equal(evaluatePreflight(fixes(12, 5), NOW, strict).stable, false);
    const more = { ...CONFIG.preflight, minSamples: 20 };
    assert.equal(evaluatePreflight(fixes(12), NOW, more).stable, false);
  });
});

describe("GPS check progress", () => {
  it("is zero with no fixes or a single fix", () => {
    assert.equal(preflightProgress([], NOW), 0);
    assert.equal(preflightProgress(fixes(1), NOW), 0);
  });
  it("grows with the span of good fixes and is full whenever the check would pass", () => {
    const half = preflightProgress(fixes(5), NOW);
    assert.ok(half > 0 && half < 1);
    assert.ok(preflightProgress(fixes(9), NOW) > half);
    assert.equal(evaluatePreflight(fixes(12), NOW).stable, true);
    assert.equal(preflightProgress(fixes(12), NOW), 1);
  });
  it("goes back to zero when the latest fix is inaccurate, and counts only the fixes after a bad one", () => {
    const bad = CONFIG.preflight.targetAccuracyM + 1;
    assert.equal(preflightProgress([...fixes(11, 5, 0, NOW - 1000), ...fixes(1, bad)], NOW), 0);
    const recovering = [...fixes(6, bad, 0, NOW - 3000), ...fixes(3)];
    assert.ok(preflightProgress(recovering, NOW) < preflightProgress(fixes(9), NOW));
  });
});
