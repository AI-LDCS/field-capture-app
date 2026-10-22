import fs from "node:fs";
import path from "node:path";
import { listEndpoints } from "../server/app.ts";

/**
 * Runs after the tests. Every endpoint the app serves must have been answered with a success
 * (2xx) by at least one test, so "all API endpoints are tested" is enforced, not claimed.
 * Endpoints that were only ever tested with failures are listed as a warning.
 */
const dir = path.resolve(import.meta.dirname, "../.test-hits");
const hits = new Map<string, Set<number>>();
for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
  for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) {
    const i = line.lastIndexOf(" ");
    const ep = line.slice(0, i);
    (hits.get(ep) ?? hits.set(ep, new Set()).get(ep)!).add(Number(line.slice(i + 1)));
  }
}

const all = listEndpoints();
const never = all.filter((e) => !hits.has(e));
const noSuccess = all.filter((e) => hits.has(e) && ![...hits.get(e)!].some((s) => s >= 200 && s < 300));
const noRefusal = all.filter((e) => hits.has(e) && ![...hits.get(e)!].some((s) => s >= 400));

console.log(`\nendpoints: ${all.length} | answered with 2xx in tests: ${all.length - never.length - noSuccess.length} | refused (4xx) at least once: ${all.length - never.length - noRefusal.length}`);
if (noRefusal.length) console.log(`note: never refused in a test (fine for read-only or always-allowed routes):\n  ${noRefusal.join("\n  ")}`);
if (never.length || noSuccess.length) {
  if (never.length) console.error(`\nFAIL: no test hits these endpoints:\n  ${never.join("\n  ")}`);
  if (noSuccess.length) console.error(`\nFAIL: only ever tested with failures (no 2xx):\n  ${noSuccess.join("\n  ")}`);
  process.exit(1);
}
console.log("OK: every endpoint has a passing test");
