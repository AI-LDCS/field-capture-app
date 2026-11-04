import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError, isNotFound } from "../../web/src/api.ts";

describe("isNotFound", () => {
  it("is true only when the server says the thing does not exist", () => {
    assert.equal(isNotFound(new ApiError(404, "not_found", "assignment not found")), true);
  });
  it("is false for a lost connection or any other answer, so the page keeps trying", () => {
    assert.equal(isNotFound(new TypeError("Failed to fetch")), false);
    assert.equal(isNotFound(new ApiError(500, "error", "server error")), false);
    assert.equal(isNotFound(new ApiError(401, "unauthenticated", "sign in")), false);
    assert.equal(isNotFound(undefined), false);
  });
});
