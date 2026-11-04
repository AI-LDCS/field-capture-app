import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeError, withRetry } from "../web/src/worker/retry.ts";

const noWait = async () => {};

describe("withRetry", () => {
  it("returns the result of a write that works first time, without retrying", async () => {
    let calls = 0;
    assert.equal(
      await withRetry(
        async () => {
          calls++;
          return "ok";
        },
        { sleep: noWait },
      ),
      "ok",
    );
    assert.equal(calls, 1);
  });

  it("tries again after a failure and reports each retry, so the caller can reopen the database", async () => {
    let calls = 0;
    const retries: number[] = [];
    const out = await withRetry(
      async () => {
        if (++calls < 3) throw new Error("connection lost");
        return "saved";
      },
      { sleep: noWait, onRetry: (_e, attempt) => retries.push(attempt) },
    );
    assert.equal(out, "saved");
    assert.equal(calls, 3);
    assert.deepEqual(retries, [1, 2]);
  });

  it("gives up after the last pause and throws the last error", async () => {
    let calls = 0;
    const waited: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error(`failure ${calls}`);
        },
        { delaysMs: [10, 20], sleep: async (ms) => void waited.push(ms) },
      ),
      /failure 3/,
    );
    assert.equal(calls, 3, "one try plus one per pause");
    assert.deepEqual(waited, [10, 20]);
  });
});

describe("describeError", () => {
  it("names the error so a full disk can be told apart from a dropped connection", () => {
    const quota = Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
    assert.equal(describeError(quota), "QuotaExceededError: The quota has been exceeded.");
    assert.equal(describeError(new Error("boom")), "Error: boom");
    assert.equal(describeError("just text"), "Error: just text");
    assert.equal(describeError(undefined), "Error");
  });

  it("cuts long text to the length the server allows for a stop reason", () => {
    const long = new Error("x".repeat(500));
    assert.equal(describeError(long, 80).length, 80);
    assert.ok(`storage error: ${describeError(long, 80)}`.length <= 100);
  });
});
