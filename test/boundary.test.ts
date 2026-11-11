import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildModel } from "../src/model/build.ts";

const PACKAGE = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SHIPPED = [join(PACKAGE, "src"), join(PACKAGE, "bin")];
const SOURCE = new Set([".ts", ".tsx", ".js", ".mjs"]);
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SOURCE.has(extname(entry.name))) out.push(path);
  }
  return out;
}

test("no shipped module imports a theme, by package name or by a path outside the package", () => {
  const bad: string[] = [];
  for (const file of SHIPPED.flatMap((dir) => walk(dir))) {
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (/(^|\/)lateen(\/|$)/i.test(specifier)) bad.push(`${relative(PACKAGE, file)}: ${specifier}`);
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      if (target !== PACKAGE && !target.startsWith(PACKAGE + sep)) {
        bad.push(`${relative(PACKAGE, file)}: ${specifier} leaves the package`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// The theme only ever enters through a theme root the caller passes in. Nothing in the engine reaches for one.
test("a site with no theme on disk builds its model without a theme fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "boundary-"));
  try {
    writeFileSync(join(root, "mizzen.yml"), "title: Boundary\n");
    writeFileSync(join(root, "index.md"), "# Boundary\n\nNo theme is installed anywhere near this site.\n");
    const { site, diagnostics } = await buildModel(root);
    assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
    assert.deepEqual(site.pages.map((p) => p.url), ["/"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the package entry is one self-contained export with no imports", () => {
  const lines = readFileSync(join(PACKAGE, "src", "index.ts"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"));
  assert.deepEqual(lines.length, 1, "src/index.ts holds the version export alone");
  assert.match(lines[0] ?? "", /^export const version = "[^"]+";$/);
});
