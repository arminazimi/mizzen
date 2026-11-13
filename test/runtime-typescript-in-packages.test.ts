import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { allowTypeScriptInPackages } from "../src/runtime/typescript-in-packages.ts";

allowTypeScriptInPackages();

/** A temp project with a package under `node_modules`, never the real dependency tree. */
function packageDir(files: Record<string, string>): string {
  const project = mkdtempSync(join(tmpdir(), "mizzen-ts-packages-"));
  const dir = join(project, "node_modules", "pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pkg", type: "module" }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test("a query-suffixed .ts file under node_modules loads, and each version is its own module", async () => {
  const dir = packageDir({ "entry.ts": "export const value: number = 1;\n" });
  try {
    const url = pathToFileURL(join(dir, "entry.ts")).href;
    const first = (await import(`${url}?v=one`)) as { value: number };
    assert.equal(first.value, 1);

    writeFileSync(join(dir, "entry.ts"), "export const value: number = 2;\n");
    const second = (await import(`${url}?v=two`)) as { value: number };
    assert.equal(second.value, 2);
    // The first version is still the module it was; the query, not the path, made a new one.
    assert.equal(first.value, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a plain .ts file under node_modules still loads", async () => {
  const dir = packageDir({ "entry.ts": "export const label: string = 'plain';\n" });
  try {
    const mod = (await import(pathToFileURL(join(dir, "entry.ts")).href)) as { label: string };
    assert.equal(mod.label, "plain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .ts file must end in .ts: other extensions under node_modules are left to Node", async () => {
  const dir = packageDir({ "entry.tsx": "export const notLoaded = true;\n", "style.css": ".x {}\n" });
  try {
    await assert.rejects(import(pathToFileURL(join(dir, "style.css")).href));
    await assert.rejects(import(`${pathToFileURL(join(dir, "entry.tsx")).href}?v=one`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a declaration file under node_modules keeps its existing behavior", async () => {
  const dir = packageDir({ "types.d.ts": "export declare const onlyAType: number;\n" });
  try {
    // Node loads a `.d.ts` as an empty module outside packages too; the hook does not change that.
    const mod = (await import(pathToFileURL(join(dir, "types.d.ts")).href)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(mod), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hook leaves non-file URLs alone", async () => {
  const dataUrl = "data:text/javascript,export const value = 7;";
  const mod = (await import(dataUrl)) as { value: number };
  assert.equal(mod.value, 7);

  assert.throws(() => fileURLToPath(dataUrl));
});

test("a .ts file outside node_modules is still Node's own to strip", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-ts-checkout-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(root, "entry.ts"), "export const value: number = 21 * 2;\n");
    const mod = (await import(`${pathToFileURL(join(root, "entry.ts")).href}?v=one`)) as { value: number };
    assert.equal(mod.value, 42);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
