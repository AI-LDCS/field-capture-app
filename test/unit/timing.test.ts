import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TIME_MISMATCH_WARN_S, timeCheck } from "../../shared/timing.ts";

describe("timeCheck", () => {
  it("is quiet when the video matches the recorder window", () => {
    const c = timeCheck(265_116, 265_370);
    assert.equal(c.recorderWindowS, 265.116);
    assert.equal(c.videoDurationS, 265.37);
    assert.equal(c.timeMismatchS, -0.254);
    assert.equal(c.timeWarning, null);
  });
  it("warns when the video is shorter", () => {
    const c = timeCheck(257_980, 240_984);
    assert.equal(c.timeMismatchS, 16.996);
    assert.match(c.timeWarning ?? "", /shorter/);
  });
  it("warns when the video is longer", () => {
    assert.match(timeCheck(100_000, 110_000).timeWarning ?? "", /longer/);
  });
  it("does not warn exactly at the limit", () => {
    assert.equal(timeCheck(100_000 + TIME_MISMATCH_WARN_S * 1000, 100_000).timeWarning, null);
  });
  it("says nothing when either length is unknown", () => {
    assert.deepEqual(timeCheck(null, 1000), { recorderWindowS: null, videoDurationS: 1, timeMismatchS: null, timeWarning: null });
    assert.deepEqual(timeCheck(1000, null), { recorderWindowS: 1, videoDurationS: null, timeMismatchS: null, timeWarning: null });
  });
});
