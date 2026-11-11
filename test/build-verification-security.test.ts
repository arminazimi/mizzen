import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/index.ts";
import { verify, verifyMessage } from "../src/cli/verify.ts";
import {
  fingerprint,
  MANIFEST_PATH,
  UnsupportedEntryError,
  type BuildRecord,
} from "../src/outputs/build-hash.ts";

/** A temporary folder holding `files`; the caller removes it. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "build-verification-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Writes a manifest carrying `build` into a folder. */
function writeManifest(root: string, build: unknown): void {
  mkdirSync(join(root, ".mizzen"), { recursive: true });
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify({ version: 1, pages: [], build })}\n`);
}

/** A built folder: the files hashed, then a manifest recording that hash. */
async function validBuild(files: Record<string, string> = { "a.txt": "a\n" }): Promise<{
  readonly root: string;
  readonly record: BuildRecord;
}> {
  const root = tree(files);
  const record = await fingerprint(root);
  writeManifest(root, record);
  return { root, record };
}

/** Captures what `main` would print. */
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

test("a symlink added to a valid build is unsupported, with or without --hash", async () => {
  const outside = tree({ "secret.txt": "outside content\n" });
  const { root, record } = await validBuild();
  try {
    assert.equal((await verify({ dir: root })).ok, true);

    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));

    const refused = await verify({ dir: root });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.failure, { kind: "unsupported", path: "link.txt", entry: "symlink" });
    assert.match(verifyMessage(refused), /"link\.txt" is a symlink entry/);
    assert.doesNotMatch(JSON.stringify(refused), /outside content/);
    assert.doesNotMatch(JSON.stringify(refused), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const byHash = await verify({ dir: root, hash: record.hash });
    assert.deepEqual(byHash.failure, { kind: "unsupported", path: "link.txt", entry: "symlink" });

    const cli = capture();
    assert.equal(await main(["verify", root], cli.io), 1);
    assert.match(cli.errors.join("\n"), /link\.txt.*symlink/);

    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "outside content\n", "the target is untouched");
  } finally {
    rmSync(outside, { recursive: true });
    rmSync(root, { recursive: true });
  }
});

test("a link to a folder is reported and its target is never traversed", async () => {
  const outside = tree({ "nested/private.txt": "private\n" });
  const { root, record } = await validBuild();
  try {
    symlinkSync(outside, join(root, "linked-folder"));

    const result = await verify({ dir: root, hash: record.hash });
    assert.deepEqual(result.failure, { kind: "unsupported", path: "linked-folder", entry: "symlink" });
    assert.equal(result.files, 0, "no file is hashed once an entry is unsupported");
    assert.doesNotMatch(verifyMessage(result), /private\.txt/);
  } finally {
    rmSync(outside, { recursive: true });
    rmSync(root, { recursive: true });
  }
});

test(
  "a FIFO added to a valid build is unsupported",
  { skip: process.platform === "win32" },
  async () => {
    const { root, record } = await validBuild();
    try {
      execFileSync("mkfifo", [join(root, "pipe")]);

      const result = await verify({ dir: root });
      assert.deepEqual(result.failure, { kind: "unsupported", path: "pipe", entry: "fifo" });
      assert.equal((await verify({ dir: root, hash: record.hash })).ok, false);
      await assert.rejects(fingerprint(root), (err: unknown) => {
        assert.ok(err instanceof UnsupportedEntryError);
        assert.equal(err.entry, "fifo");
        return true;
      });
    } finally {
      rmSync(root, { recursive: true });
    }
  },
);

test("several unsupported entries report the first by code point, every time", async () => {
  const { root } = await validBuild();
  try {
    symlinkSync(join(root, "a.txt"), join(root, "z-link"));
    symlinkSync(join(root, "a.txt"), join(root, "a-link"));

    const first = await verify({ dir: root });
    assert.deepEqual(first.failure, { kind: "unsupported", path: "a-link", entry: "symlink" });
    assert.deepEqual((await verify({ dir: root })).failure, first.failure);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a manifest path named like an object prototype is an ordinary key", async () => {
  const root = tree({ ["__proto__"]: "proto\n", "a.txt": "a\n" });
  try {
    writeManifest(root, await fingerprint(root));
    const result = await verify({ dir: root });
    assert.equal(result.ok, true);
    assert.equal(result.files, 2);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("an unsafe manifest path is malformed before any folder comparison", async () => {
  const { root, record } = await validBuild();
  try {
    const badPaths = ["", "/absolute.txt", "../escape.txt", "a\\b.txt", "a/./b.txt", "a\nb.txt", "a\u0000b.txt", "a//b.txt"];
    for (const path of badPaths) {
      writeManifest(root, { hash: record.hash, files: { ...record.files, [path]: "b".repeat(64) } });

      const result = await verify({ dir: root });
      assert.equal(result.ok, false, JSON.stringify(path));
      assert.equal(result.failure?.kind, "malformed", JSON.stringify(path));
      assert.match(verifyMessage(result), /is malformed/);
      assert.doesNotMatch(verifyMessage(result), /differs from the build/);

      const byHash = await verify({ dir: root, hash: record.hash });
      assert.equal(byHash.failure?.kind, "malformed", `--hash cannot trust ${JSON.stringify(path)}`);
    }

    for (const path of [MANIFEST_PATH, ".DS_Store", "__MACOSX/._a", "dir/Thumbs.db"]) {
      writeManifest(root, { hash: record.hash, files: { ...record.files, [path]: "b".repeat(64) } });
      const result = await verify({ dir: root });
      assert.equal(result.failure?.kind, "malformed", `the manifest cannot record ${path}`);
      assert.match(verifyMessage(result), /unsafe path/);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a malformed hash or record shape is malformed, not a folder difference", async () => {
  const { root, record } = await validBuild();
  try {
    const shapes: Record<string, unknown> = {
      "a null build": null,
      "an array build": [],
      "a non-object build": "build",
      "a missing hash": { files: record.files },
      "an uppercase hash": { hash: "A".repeat(64), files: record.files },
      "a short hash": { hash: "a".repeat(63), files: record.files },
      "missing files": { hash: record.hash },
      "array files": { hash: record.hash, files: ["a".repeat(64)] },
      "a null files": { hash: record.hash, files: null },
      "an uppercase file hash": { hash: record.hash, files: { "a.txt": "A".repeat(64) } },
      "a short file hash": { hash: record.hash, files: { "a.txt": "a".repeat(63) } },
      "a non-string file hash": { hash: record.hash, files: { "a.txt": 1 } },
      "an inconsistent whole-build hash": { hash: "c".repeat(64), files: record.files },
    };
    for (const [name, build] of Object.entries(shapes)) {
      writeManifest(root, build);
      const result = await verify({ dir: root });
      assert.equal(result.failure?.kind, "malformed", name);
      assert.match(verifyMessage(result), /rebuild the site/);

      const byHash = await verify({ dir: root, hash: record.hash });
      assert.equal(byHash.failure?.kind, "malformed", `--hash cannot trust ${name}`);
    }

    writeFileSync(join(root, MANIFEST_PATH), "{not json");
    assert.equal((await verify({ dir: root })).failure?.kind, "malformed");
    writeFileSync(join(root, MANIFEST_PATH), "");
    assert.equal((await verify({ dir: root })).failure?.kind, "malformed");
    writeFileSync(join(root, MANIFEST_PATH), JSON.stringify({ version: 1, pages: [], build: record }));
    assert.equal((await verify({ dir: root })).ok, true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a whole-build hash that does not match its file map is rejected even when --hash names the folder's real hash", async () => {
  const { root, record } = await validBuild({ "a.txt": "a\n", "dir/b.txt": "b\n" });
  try {
    const inconsistent = { hash: "d".repeat(64), files: record.files };
    writeManifest(root, inconsistent);

    const result = await verify({ dir: root, hash: record.hash });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.kind, "malformed");
    assert.match(verifyMessage(result), /does not match build\.files/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("changed, missing, and extra ordinary files keep their behavior, and --hash stays truthful", async () => {
  const { root, record } = await validBuild({ "a.txt": "a\n" });
  try {
    writeFileSync(join(root, "a.txt"), "changed\n");
    const changed = await verify({ dir: root, hash: record.hash });
    assert.deepEqual(changed.failure, { kind: "file", path: "a.txt", state: "changed" });
    assert.match(verifyMessage(changed), /"a\.txt" differs from the build/);

    rmSync(join(root, "a.txt"));
    const missing = await verify({ dir: root });
    assert.deepEqual(missing.failure, { kind: "file", path: "a.txt", state: "missing" });
    assert.match(verifyMessage(missing), /"a\.txt" is missing from the folder/);

    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    const extra = await verify({ dir: root });
    assert.deepEqual(extra.failure, { kind: "file", path: "b.txt", state: "extra" });
    assert.match(verifyMessage(extra), /"b\.txt" is not part of the build/);

    const cli = capture();
    assert.equal(await main(["verify", root], cli.io), 1);
    assert.match(cli.errors.join("\n"), /"b\.txt" is not part of the build/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("valid builds verify the same on every platform, and metadata is still not identity", async () => {
  const one = tree({ "a.txt": "a\n", "dir/b.txt": "b\n" });
  const two = tree({ "a.txt": "a\n", "dir/b.txt": "b\n" });
  try {
    const record = await fingerprint(one);
    writeManifest(one, record);
    writeManifest(two, record);

    assert.equal((await verify({ dir: one })).ok, true);
    assert.equal((await verify({ dir: two })).ok, true);

    for (const path of [".DS_Store", "Thumbs.db", "desktop.ini", "._a.txt", "__MACOSX/._b.txt"]) {
      mkdirSync(join(two, path, ".."), { recursive: true });
      writeFileSync(join(two, path), "metadata\n");
    }
    const metadata = await verify({ dir: two });
    assert.equal(metadata.ok, true);
    assert.equal(metadata.files, 2, "metadata is not part of the identity");
  } finally {
    rmSync(one, { recursive: true });
    rmSync(two, { recursive: true });
  }
});

test("a manifest reached through a symlink is never trusted", async () => {
  const outside = tree({ "manifest.json": JSON.stringify({ version: 1, pages: [] }) });
  const root = tree({ "a.txt": "a\n" });
  try {
    const record = await fingerprint(root);
    writeFileSync(join(outside, "manifest.json"), `${JSON.stringify({ version: 1, pages: [], build: record })}\n`);
    mkdirSync(join(root, ".mizzen"), { recursive: true });
    symlinkSync(join(outside, "manifest.json"), join(root, MANIFEST_PATH));

    const result = await verify({ dir: root });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.kind, "unsupported", "the manifest's link is an unsupported entry, not the record");
    assert.equal((await verify({ dir: root, hash: record.hash })).ok, false);
  } finally {
    rmSync(outside, { recursive: true });
    rmSync(root, { recursive: true });
  }
});
