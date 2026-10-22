import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CONFIG } from "../shared/config.ts";
import { listEndpoints } from "../server/app.ts";

/**
 * The docs describe the code, so they are checked against it. A new endpoint, setting, migration,
 * audit action or error code without a mention here fails the build, and so does documenting
 * something that no longer exists.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const listFiles = (dir: string, ext: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: false } as any)
    .map(String).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));
const sourceFiles = [...listFiles("server", ".ts"), ...listFiles("shared", ".ts")];
const allSource = sourceFiles.map(read).join("\n");

const api = read("docs/api.md");
const configDoc = read("docs/configuration.md");
const dataDoc = read("docs/data-model.md");

const norm = (e: string) => e.replace(/\/$/, "");

describe("API reference", () => {
  it("lists every endpoint the app serves", () => {
    const missing = listEndpoints().map(norm).filter((e) => !api.includes(`### ${e}\n`));
    assert.deepEqual(missing, [], `add these to docs/api.md as "### METHOD /path": ${missing.join(", ")}`);
  });
  it("documents no endpoint that does not exist", () => {
    const real = new Set(listEndpoints().map(norm));
    const documented = [...api.matchAll(/^### ((?:GET|POST|PUT|PATCH|DELETE) \S+)$/gm)].map((m) => m[1]);
    assert.ok(documented.length >= 40, "found the endpoint headings");
    assert.deepEqual(documented.filter((d) => !real.has(d)), []);
  });
  it("mentions every error code the server can answer", () => {
    const codes = new Set([...allSource.matchAll(/HttpError\(\d+, "([a-z0-9_]+)"/g)].map((m) => m[1]));
    for (const c of ["invalid_input", "invalid_json", "too_large", "conflict", "rule_violation", "server_error"]) codes.add(c);
    const missing = [...codes].filter((c) => !api.includes(`\`${c}\``));
    assert.deepEqual(missing, [], `error codes missing from docs/api.md: ${missing.join(", ")}`);
  });
});

describe("configuration", () => {
  it("documents every environment variable the app reads and every one in .env.example", () => {
    const fromCode = [...read("server/config.ts").matchAll(/env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    const fromExample = [...read(".env.example").matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    const missing = [...new Set([...fromCode, ...fromExample])].filter((v) => !configDoc.includes(`\`${v}\``));
    assert.deepEqual(missing, [], `missing from docs/configuration.md: ${missing.join(", ")}`);
  });
  it("documents every tuning constant", () => {
    const missing: string[] = [];
    for (const [group, values] of Object.entries(CONFIG)) {
      assert.ok(configDoc.includes(`\`${group}\``), `group ${group}`);
      for (const key of Object.keys(values)) if (!configDoc.includes(`\`${key}\``)) missing.push(`${group}.${key}`);
    }
    assert.deepEqual(missing, []);
  });
  it("states the documented values that matter (a change in code must change the docs)", () => {
    const pf = CONFIG.preflight, cov = CONFIG.coverage;
    assert.ok(configDoc.includes(`| \`targetAccuracyM\` | ${pf.targetAccuracyM} |`));
    assert.ok(configDoc.includes(`| \`bufferM\` | ${cov.bufferM} |`));
    assert.ok(configDoc.includes(`| \`maxAccuracyM\` | ${cov.maxAccuracyM} |`));
    assert.ok(configDoc.includes(`| \`timesliceMs\` | ${CONFIG.recording.timesliceMs} |`));
  });
});

describe("data model", () => {
  it("lists every migration, table and audit action", () => {
    const migrations = fs.readdirSync(path.join(ROOT, "db/migrations")).filter((f) => f.endsWith(".sql"));
    assert.deepEqual(migrations.filter((m) => !dataDoc.includes(m)), []);
    const tables = [...migrations.map((m) => read(`db/migrations/${m}`)).join("\n").matchAll(/^CREATE TABLE (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(tables.filter((t) => !dataDoc.includes(`\`${t}\``)), []);
    const actions = [...allSource.matchAll(/audit\([^,]+, "([a-z0-9_]+)"/g)].map((m) => m[1]);
    assert.ok(actions.length > 20);
    assert.deepEqual([...new Set(actions)].filter((a) => !dataDoc.includes(`\`${a}\``)), []);
  });
});

describe("markdown links", () => {
  const docs = ["README.md", ...listFiles("docs", ".md")];
  const slug = (h: string) => h.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");
  const anchors = (file: string) =>
    new Set([...read(file).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])));

  it("every relative link and anchor resolves", () => {
    const broken: string[] = [];
    for (const f of docs) {
      const text = read(f).replace(/```[\s\S]*?```/g, ""); // ignore code blocks
      for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [target, anchor] = href.split("#");
        const file = target ? path.normalize(path.join(path.dirname(f), target)) : f;
        if (!fs.existsSync(path.join(ROOT, file))) { broken.push(`${f}: ${href} (no such file)`); continue; }
        if (anchor && file.endsWith(".md") && !anchors(file).has(anchor)) broken.push(`${f}: ${href} (no such heading)`);
      }
    }
    assert.deepEqual(broken, []);
  });

  it("the documentation index links every page in docs/", () => {
    const index = read("docs/README.md");
    const pages = listFiles("docs", ".md").map((p) => path.basename(p)).filter((n) => n !== "README.md");
    assert.deepEqual(pages.filter((p) => !index.includes(`(${p})`)), []);
  });
});
