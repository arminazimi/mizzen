import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = fileURLToPath(new URL("../", import.meta.url));
const DIST = join(PACKAGE, "dist");
const TSC = join(PACKAGE, "node_modules", "typescript", "bin", "tsc");
const SOURCE = new Set([".ts", ".js", ".mjs"]);
const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

interface Manifest {
  readonly version: string;
  readonly files: readonly string[];
  readonly exports: Readonly<Record<string, string | { readonly types: string; readonly default: string }>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const manifest = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")) as Manifest;

/** Builds the package the way `npm pack` does, so every test here reads the artifact a consumer installs. */
before(() => {
  rmSync(DIST, { recursive: true, force: true });
  execFileSync(process.execPath, [TSC, "-p", join(PACKAGE, "tsconfig.build.json")], { cwd: PACKAGE, stdio: "pipe" });
});

/** Imports a package entry point by name, so Node resolves it through package.json "exports". */
function importEntry(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (SOURCE.has(extname(entry.name))) out.push(path);
  }
  return out;
}

test("the packed entry points export version and the contracts, and nothing else", async () => {
  const entry = await importEntry("@velella/mizzen");
  assert.deepEqual(Object.keys(entry), ["version"]);
  assert.equal(entry.version, manifest.version);

  const contracts = await importEntry("@velella/mizzen/contracts");
  assert.deepEqual(Object.keys(contracts), [], "the contracts entry is types only");

  for (const file of ["index.js", "contracts/index.js"]) {
    const text = readFileSync(join(DIST, file), "utf8");
    assert.doesNotMatch(text, /\b(?:from|import)\s*\(?\s*["']/, `${file} pulls no internal module into the API`);
  }
});

test("a consumer typechecks against the built entry points", () => {
  const consumer = join(PACKAGE, ".contracts-consumer.ts");
  writeFileSync(
    consumer,
    `import { version } from "@velella/mizzen";
import type { Chrome, Component, Diagnostic, Layout, Output, Page, Plugin, Site, SiteConfig, SourcePos } from "@velella/mizzen/contracts";

export const engine: string = version;
export type Surface = [SourcePos, Diagnostic, SiteConfig, Page, Site, Output, Plugin, Layout, Chrome, Component];
`,
  );
  try {
    execFileSync(
      process.execPath,
      [
        TSC, "--ignoreConfig", "--noEmit", "--strict", "--target", "esnext", "--module", "nodenext",
        "--moduleResolution", "nodenext", "--skipLibCheck", "--types", "node", consumer,
      ],
      { cwd: PACKAGE, stdio: "pipe" },
    );
  } finally {
    rmSync(consumer, { force: true });
  }
});

test("package.json exposes only the two public entries and the manifest, all built", () => {
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./contracts", "./package.json"].sort());
  assert.ok(manifest.files.includes("dist"), "dist is packed");
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (subpath === "./package.json") {
      assert.equal(target, "./package.json");
      continue;
    }
    assert.equal(typeof target, "object", `${subpath} names its types and module`);
    const { types, default: module } = target as { types: string; default: string };
    assert.match(types, /^\.\/dist\/.+\.d\.ts$/, `${subpath} types come from dist`);
    assert.match(module, /^\.\/dist\/.+\.js$/, `${subpath} runtime comes from dist`);
    assert.ok(existsSync(join(PACKAGE, types)), `${types} exists after a build`);
    assert.ok(existsSync(join(PACKAGE, module)), `${module} exists after a build`);
  }
});

test("the packed package imports no theme and declares no theme dependency", () => {
  const bad: string[] = [];
  for (const file of walk(DIST)) {
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (/(^|\/)lateen(\/|$)/i.test(specifier)) bad.push(`${file.slice(PACKAGE.length)}: ${specifier}`);
    }
  }
  assert.deepEqual(bad, []);
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      assert.doesNotMatch(name, /lateen|theme/i, `package.json ${field} names no theme`);
    }
  }
});
