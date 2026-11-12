import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadData } from "../src/content/data.ts";
import { discover } from "../src/content/discover.ts";

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-prototype-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Own-property reads, so an assertion never sees an inherited value as data. */
function owns(record: unknown, key: string): boolean {
  return typeof record === "object" && record !== null && Object.prototype.hasOwnProperty.call(record, key);
}

function dataOf(files: Record<string, string>): Promise<{
  data: Record<string, unknown>;
  diagnostics: readonly unknown[];
}> {
  return (async () => {
    const root = tree(files);
    try {
      return (await loadData(root, await discover(root))) as unknown as {
        data: Record<string, unknown>;
        diagnostics: readonly unknown[];
      };
    } finally {
      rmSync(root, { recursive: true });
    }
  })();
}

test("a `__proto__` file name is an own data key and leaves every prototype unchanged", async () => {
  const untouched = Object.getOwnPropertyNames(Object.prototype).join("\n");
  const result = await dataOf({
    "_data/__proto__.yml": "polluted: yes\n",
    "_data/normal.yml": "kept: true\n",
  });

  assert.deepEqual(result.diagnostics, []);

  // The record itself is untouched: no prototype swap, no inherited leak from the special file.
  assert.equal(Object.getPrototypeOf(result.data), Object.prototype);
  assert.equal(owns(result.data, "__proto__"), true);
  assert.deepEqual(result.data["__proto__"], { polluted: "yes" });
  assert.deepEqual(Object.keys(result.data), ["__proto__", "normal"]);

  // Ordinary objects, and Object.prototype itself, are unchanged.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((result.data["normal"] as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getOwnPropertyNames(Object.prototype).join("\n"), untouched);
});

test("special keys in a YAML or JSON mapping are data, never prototypes or inherited reads", async () => {
  const result = await dataOf({
    "_data/settings.yml": "__proto__:\n  polluted: yes\nprototype:\n  hidden: true\nconstructor:\n  derived: true\n",
    "_data/raw.json": '{ "__proto__": { "x": 1 }, "kept": true }\n',
  });

  assert.deepEqual(result.diagnostics, []);

  const settings = result.data["settings"] as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
  // Keys keep the order the mappings were read in, so document order decides here.
  assert.deepEqual(Object.keys(settings), ["__proto__", "prototype", "constructor"]);
  assert.deepEqual(settings["__proto__"], { polluted: "yes" });
  assert.deepEqual(settings["prototype"], { hidden: true });
  assert.deepEqual(settings["constructor"], { derived: true });
  // Nothing readable through the prototype chain: the special keys are only data.
  assert.equal(settings.polluted, undefined);
  assert.equal(settings.x, undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);

  const raw = result.data["raw"] as Record<string, unknown>;
  assert.equal(owns(raw, "__proto__"), true);
  assert.deepEqual(raw["__proto__"], { x: 1 });
  assert.deepEqual(raw["kept"], true);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test("nested special-key files and folders stay readable through the documented data shape", async () => {
  const result = await dataOf({
    // A folder named `__proto__` is skipped by discovery (folders starting with `_`), so the special key reaches
    // the tree as a file name here and as the last key of a deeper path below.
    "_data/constructor/steps.yml": "- one\n",
    "_data/guides/constructor.yml": "from: folder\n",
    "_data/guides/intro.yml": "kept: true\n",
    "_data/guides/nested/__proto__.yml": "steps:\n  - download\n  - extract\n",
    "_data/guides/prototype.yml": "hidden: true\n",
    "_data/prototype/intro.json": '{ "short": true }\n',
    "_data/x/constructor/steps.yml": "- deep\n",
  });

  assert.deepEqual(result.diagnostics, []);

  assert.equal(Object.getPrototypeOf(result.data), Object.prototype);
  assert.deepEqual(Object.keys(result.data), ["constructor", "guides", "prototype", "x"]);
  assert.deepEqual(result.data["constructor"], { steps: ["one"] });
  assert.deepEqual(result.data["prototype"], { intro: { short: true } });

  const guides = result.data["guides"] as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(guides), Object.prototype);
  assert.deepEqual(Object.keys(guides), ["constructor", "intro", "nested", "prototype"]);
  assert.equal(owns(guides, "constructor"), true);
  assert.deepEqual(guides["constructor"], { from: "folder" });
  assert.deepEqual(guides["prototype"], { hidden: true });
  assert.deepEqual(guides["intro"], { kept: true });

  const nested = guides["nested"] as Record<string, unknown>;
  assert.equal(owns(guides, "nested"), true);
  assert.equal(Object.getPrototypeOf(nested), Object.prototype);
  assert.deepEqual(Object.keys(nested), ["__proto__"]);
  assert.deepEqual(nested["__proto__"], { steps: ["download", "extract"] });

  // `constructor` deep in a path is the loaded data, not the function Object.prototype inherits.
  const x = result.data["x"] as Record<string, unknown>;
  assert.equal(owns(x, "constructor"), true);
  assert.equal(typeof x["constructor"], "object");
  assert.deepEqual(x["constructor"], { steps: ["deep"] });
  assert.equal(({} as Record<string, unknown>).steps, undefined);
});

test("mapping merges keep special keys as data and the later path still wins ordinary keys", async () => {
  const result = await dataOf({
    "_data/authors.yml": "__proto__:\n  from: file\nnadia: from-file\nmemo: from-file\n",
    "_data/authors/__proto__.yml": "folder: wins\n",
    "_data/authors/memo.yml": "from-folder\n",
  });

  assert.deepEqual(result.diagnostics, []);

  const authors = result.data["authors"] as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(authors), Object.prototype);
  assert.deepEqual(Object.keys(authors), ["__proto__", "nadia", "memo"]);
  // The folder path sorts after the file path, so it wins each key of the merged `__proto__` mapping.
  assert.deepEqual(authors["__proto__"], { from: "file", folder: "wins" });
  assert.equal(authors["from"], undefined);
  assert.deepEqual(authors["memo"], "from-folder");
  assert.deepEqual(authors["nadia"], "from-file");
  assert.equal(({} as Record<string, unknown>).folder, undefined);
});

test("a special-key entry beside a parse error still loads and the diagnostic is unchanged", async () => {
  const root = tree({
    "_data/__proto__.yml": "polluted: yes\n",
    "_data/bad.yml": "a: 1\na: 2\n",
  });
  try {
    const result = await loadData(root, await discover(root));
    const data = result.data as Record<string, unknown>;
    assert.equal(owns(data, "__proto__"), true);
    assert.deepEqual(data["__proto__"], { polluted: "yes" });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.id, "data.invalid-yaml");
    assert.equal(result.diagnostics[0]?.pos?.file, "_data/bad.yml");
    assert.equal(result.diagnostics[0]?.pos?.line, 2);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  } finally {
    rmSync(root, { recursive: true });
  }
});
