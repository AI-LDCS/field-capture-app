import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/** The layout rules from docs/development/architecture.md, so the folders keep meaning what they say. */
const ROOT = path.resolve(import.meta.dirname, "../..");

const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });

/** Every import in a file, with local ones turned into paths from the repository root. */
function importsOf(file: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(([, spec]) => {
    if (spec.startsWith("@shared/")) return `shared/${spec.slice(8)}`;
    return spec.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec;
  });
}

function broken(dir: string, forbidden: (target: string) => boolean): string[] {
  return walk(dir).flatMap((f) =>
    importsOf(f)
      .filter(forbidden)
      .map((t) => `${f} imports ${t}`),
  );
}

describe("file layout", () => {
  it("shared/ imports only shared/, so it runs in both the server and the browser", () => {
    assert.deepEqual(
      broken("shared", (t) => !t.startsWith("shared/")),
      [],
    );
  });
  it("web/ and server/ never import each other", () => {
    assert.deepEqual(
      broken("web/src", (t) => t.startsWith("server/")),
      [],
    );
    assert.deepEqual(
      broken("server", (t) => t.startsWith("web/")),
      [],
    );
  });
  it("services never import routes", () => {
    assert.deepEqual(
      broken("server/services", (t) => t.startsWith("server/routes/")),
      [],
    );
  });
  it("admin and worker pages never import each other", () => {
    assert.deepEqual(
      broken("web/src/admin", (t) => t.startsWith("web/src/worker/")),
      [],
    );
    assert.deepEqual(
      broken("web/src/worker", (t) => t.startsWith("web/src/admin/")),
      [],
    );
  });
  it("worker/lib never imports the worker's pages", () => {
    assert.deepEqual(
      broken("web/src/worker/lib", (t) => t.startsWith("web/src/worker/") && !t.startsWith("web/src/worker/lib/")),
      [],
    );
  });
  it("the web app uses its own dialogs, never the browser's", () => {
    const used = walk("web/src").filter((f) => /(^|[^.\w])(alert|confirm|prompt)\(/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    assert.deepEqual(used, []);
  });
  it("styles take colours from the theme tokens, outside the fixed-colour section", () => {
    const css = fs.readFileSync(path.join(ROOT, "web/src/styles.css"), "utf8");
    const [tokensEnd, fixedStart] = [css.indexOf("/* ---------- base"), css.indexOf("/* ---------- fixed colours")];
    assert.ok(tokensEnd > 0 && fixedStart > tokensEnd, "the section comments are there");
    const themed = css.slice(tokensEnd, fixedStart);
    assert.deepEqual(themed.match(/#[0-9a-f]{3,8}\b|rgba?\(|gradient\(/gi) ?? [], []);
  });
  it("the rules can see imports", () => {
    assert.ok(importsOf("server/app.ts").includes("server/config.ts"));
    assert.ok(importsOf("web/src/worker/RunPage.tsx").some((t) => t.startsWith("web/src/worker/lib/")));
    assert.ok(importsOf("web/src/worker/RunPage.tsx").some((t) => t.startsWith("shared/")));
  });
});
