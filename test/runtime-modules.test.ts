import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { moduleName } from "../src/runtime/modules.ts";
import { allowTypeScriptInPackages } from "../src/runtime/typescript-in-packages.ts";

test("a module file is a .ts or .js file, named without its extension", () => {
  assert.equal(moduleName("title.ts"), "title");
  assert.equal(moduleName("title.js"), "title");
});

test("declaration files, dot files, and other files are not modules", () => {
  assert.equal(moduleName("title.d.ts"), null);
  assert.equal(moduleName(".hidden.ts"), null);
  assert.equal(moduleName("README.md"), null);
  assert.equal(moduleName("title.js.map"), null);
});

test("a .ts file inside node_modules can be imported once the hook is registered", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-pkg-"));
  const dir = join(root, "node_modules", "pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pkg", type: "module" }));
  writeFileSync(join(dir, "helper.ts"), "export const double = (n: number): number => n * 2;\n");
  writeFileSync(join(dir, "index.ts"), 'import { double } from "./helper.ts";\nexport const value: number = double(21);\n');

  allowTypeScriptInPackages();
  allowTypeScriptInPackages();
  const mod = (await import(pathToFileURL(join(dir, "index.ts")).href)) as { value: number };
  assert.equal(mod.value, 42);
});
