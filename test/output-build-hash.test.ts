import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";
import { main, parseArgs } from "../src/cli/index.ts";
import { verify, verifyMessage } from "../src/cli/verify.ts";
import { buildHashOf, fingerprint, MANIFEST_PATH } from "../src/outputs/build-hash.ts";
import { build } from "../src/pipeline/build.ts";

const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** Folders another test's build may be writing into the fixture; a build cache is never input. */
const TRANSIENT = new Set([".mizzen", ".tmp", "node_modules", ".git"]);

/** Copies the fixture into `parent` so the CLI's build cache cannot land inside the shared fixture. */
function copyFixture(parent: string): string {
  const root = join(parent, "docs-site");
  cpSync(FIXTURE, root, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => TRANSIENT.has(part)),
  });
  return root;
}

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const schema = JSON.parse(readFileSync(new URL("../schema/manifest.schema.json", import.meta.url), "utf8")) as object;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

/** A temporary folder holding `files`, whose parent the caller removes. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "build-hash-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary parent folder for a build; the caller removes it. */
function scratch(): { readonly parent: string; readonly out: string } {
  const parent = mkdtempSync(join(tmpdir(), "build-hash-out-"));
  return { parent, out: join(parent, "site") };
}

function capture(): { readonly logs: string[]; readonly errors: string[]; readonly io: { log: (m: string) => void; error: (m: string) => void } } {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    io: {
      log: (m: string) => {
        logs.push(m);
      },
      error: (m: string) => {
        errors.push(m);
      },
    },
  };
}

type Manifest = {
  readonly version: number;
  readonly pages: readonly unknown[];
  readonly build?: { readonly hash: string; readonly files: Readonly<Record<string, string>> };
};

function manifestOf(out: string): Manifest {
  return JSON.parse(readFileSync(join(out, MANIFEST_PATH), "utf8")) as Manifest;
}

test("the build hash sorts paths by code point and changes when one byte changes", async () => {
  const one = tree({ "b.txt": "b\n", "a/c.txt": "c\n" });
  const two = tree({ "a/c.txt": "c\n", "b.txt": "b\n", [MANIFEST_PATH]: "the manifest is not part of the hash\n" });
  try {
    const first = await fingerprint(one);
    assert.deepEqual(Object.keys(first.files), ["a/c.txt", "b.txt"], "paths are sorted, and the manifest is left out");
    assert.equal(first.hash, buildHashOf(first.files));
    assert.deepEqual(await fingerprint(two), first, "the order files were written in does not matter");

    writeFileSync(join(one, "b.txt"), "b!\n");
    const changed = await fingerprint(one);
    assert.equal(changed.hash === first.hash, false, "one byte changes the whole-build hash");
    assert.notEqual(changed.files["b.txt"], first.files["b.txt"]);
    assert.equal(changed.files["a/c.txt"], first.files["a/c.txt"], "the other files keep their hashes");
  } finally {
    rmSync(one, { recursive: true });
    rmSync(two, { recursive: true });
  }
});

test("a built fixture records one hash, validates against the schema, and verify names the file a byte changed", async () => {
  const { parent, out } = scratch();
  try {
    const result = await build({ root: FIXTURE, out, themeRoot: THEME, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    const manifest = manifestOf(out);
    assert.equal(validate(manifest), true, ajv.errorsText(validate.errors));
    const buildRecord = manifest.build;
    assert.ok(buildRecord, "the build writes its hash into the manifest");
    assert.match(buildRecord.hash, /^[0-9a-f]{64}$/);
    assert.equal(buildRecord.files[MANIFEST_PATH], undefined, "the manifest does not hash itself");
    assert.ok(buildRecord.files["quickstart/index.html"], "the page's HTML is one of the hashed files");
    assert.equal(buildRecord.hash, (await fingerprint(out)).hash);

    const matching = await verify({ dir: out });
    assert.equal(matching.ok, true);
    assert.equal(matching.files, Object.keys(buildRecord.files).length);
    assert.equal(matching.actual, buildRecord.hash);
    assert.equal(verifyMessage(matching), `ok: ${buildRecord.hash}`);

    const page = join(out, "quickstart/index.html");
    writeFileSync(page, readFileSync(page, "utf8").replace("Quickstart", "Quickstart!"));

    const changed = await verify({ dir: out });
    assert.equal(changed.ok, false, "one changed byte fails verification");
    assert.deepEqual(changed.failure, { kind: "file", path: "quickstart/index.html", state: "changed" });
    assert.match(verifyMessage(changed), /quickstart\/index\.html/);

    const againstHash = await verify({ dir: out, hash: buildRecord.hash });
    assert.equal(againstHash.ok, false, "--hash still compares the files it can name");
    assert.deepEqual(againstHash.failure, { kind: "file", path: "quickstart/index.html", state: "changed" });
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("mizzen verify exits 0 for a matching build and 1 with the file that changed", async () => {
  const { parent, out } = scratch();
  try {
    const built = capture();
    assert.equal(await main(["build", copyFixture(parent), "--out", out, "--theme", THEME], built.io), 0);
    const manifest = manifestOf(out);
    assert.ok(manifest.build);

    const ok = capture();
    assert.equal(await main(["verify", out], ok.io), 0);
    assert.match(ok.logs.join("\n"), /^ok: [0-9a-f]{64}$/);
    assert.deepEqual(ok.errors, []);

    const page = join(out, "quickstart/index.html");
    writeFileSync(page, readFileSync(page, "utf8").replace("Quickstart", "Quickstart!"));

    const wrong = capture();
    assert.equal(await main(["verify", out], wrong.io), 1);
    assert.match(wrong.errors.join("\n"), /quickstart\/index\.html" differs from the build/);

    const wrongHash = capture();
    assert.equal(await main(["verify", out, "--hash", manifest.build.hash], wrongHash.io), 1);
    assert.match(wrongHash.errors.join("\n"), /quickstart\/index\.html/);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("verify reports a missing, extra, or changed file, and a missing or read-only record", async () => {
  const withManifest = tree({ "a.txt": "a\n", [MANIFEST_PATH]: "" });
  const empty = tree({ "x.txt": "x\n" });
  const unbuilt = tree({ [MANIFEST_PATH]: JSON.stringify({ version: 1, pages: [] }) });
  try {
    const record = await fingerprint(withManifest);
    writeFileSync(join(withManifest, MANIFEST_PATH), `${JSON.stringify({ version: 1, pages: [], build: record })}\n`);
    assert.equal((await verify({ dir: withManifest })).ok, true);

    writeFileSync(join(withManifest, "b.txt"), "b\n");
    const extra = await verify({ dir: withManifest });
    assert.deepEqual(extra.failure, { kind: "file", path: "b.txt", state: "extra" });
    assert.match(verifyMessage(extra), /"b\.txt" is not part of the build/);

    rmSync(join(withManifest, "a.txt"));
    const missing = await verify({ dir: withManifest });
    assert.deepEqual(missing.failure, { kind: "file", path: "a.txt", state: "missing" });
    assert.match(verifyMessage(missing), /"a\.txt" is missing from the folder/);

    const byHash = await verify({ dir: empty, hash: (await fingerprint(empty)).hash });
    assert.equal(byHash.ok, true, "--hash works without a manifest");
    assert.equal((await verify({ dir: empty })).failure?.kind, "manifest");
    assert.match(verifyMessage(await verify({ dir: empty })), /no build hash|missing or not a valid manifest/);

    const noRecord = await verify({ dir: unbuilt });
    assert.equal(noRecord.failure?.kind, "record");
    assert.match(verifyMessage(noRecord), /has no build hash/);
  } finally {
    rmSync(withManifest, { recursive: true });
    rmSync(empty, { recursive: true });
    rmSync(unbuilt, { recursive: true });
  }
});

test("parseArgs: verify takes a folder and a 64-hex hash, and rejects options of other commands", () => {
  assert.deepEqual(parseArgs(["verify"]), { options: { command: "verify", root: "." } });
  assert.deepEqual(parseArgs(["verify", "dist", "--hash", "a".repeat(64)]), {
    options: { command: "verify", root: "dist", hash: "a".repeat(64) },
  });
  assert.equal("error" in parseArgs(["verify", "--hash", "abc"]), true);
  assert.equal("error" in parseArgs(["verify", "--theme", "/t"]), true);
  assert.equal("error" in parseArgs(["verify", "--format", "json"]), true);
  assert.equal("error" in parseArgs(["build", "--hash", "a".repeat(64)]), true);
});
