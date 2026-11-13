/**
 * Whole-build cache identity for symbolic links (#147): a confined file link contributes its link path, its in-root
 * target's path, and the target's bytes to the key; a broken or escaping link contributes only a marker, so it is
 * never read and never aliases a missing or empty input.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load.ts";
import { cacheKey, type CacheKeyOptions } from "../src/pipeline/cache.ts";

/** Creates `files` under `root`, making parent folders as needed. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A site, a theme, an outputs folder, and one folder outside both, all under a uniquely named temp root. */
interface Fixtures {
  readonly parent: string;
  readonly theme: string;
  readonly outputs: string;
  readonly outside: string;
  readonly options: CacheKeyOptions;
}

/** Builds the fixture tree and the `cacheKey` options that point at it. */
function fixtures(): Fixtures {
  const parent = mkdtempSync(join(tmpdir(), "cache-symlink-inputs-147-"));
  const site = join(parent, "site");
  const theme = join(parent, "theme");
  const outputs = join(parent, "outputs");
  const outside = join(parent, "outside");
  for (const dir of [site, theme, outputs, outside]) mkdirSync(dir, { recursive: true });
  tree(site, { "mizzen.yml": "title: Links\n", "index.md": "# Home\n" });
  // `test/` and `dist/` are skipped by the walker, so a target under them is reachable only through its link.
  tree(theme, { "src/index.ts": 'export const theme = { name: "links" };\n', "test/shared.css": "one\n" });
  tree(outputs, { "html.ts": 'export const html = { name: "html", run: () => [] };\n', "test/shared.ts": "one\n" });
  return {
    parent,
    theme,
    outputs,
    outside,
    options: {
      root: site,
      sourceDir: site,
      config: loadConfig(site).config,
      themeRoot: theme,
      outputsDir: outputs,
      defaultLayout: "doc",
    },
  };
}

/** Replaces `link` with a symlink to `target`. */
function relink(link: string, target: string): void {
  rmSync(link, { force: true });
  symlinkSync(target, link);
}

test("a linked target's bytes change the key even when no walked file changes", async () => {
  const fx = fixtures();
  try {
    symlinkSync("test/shared.css", join(fx.theme, "styles.css"));
    const base = await cacheKey(fx.options);
    assert.equal(await cacheKey(fx.options), base, "the same link inputs give one deterministic key");

    writeFileSync(join(fx.theme, "test/shared.css"), "two\n");
    assert.notEqual(await cacheKey(fx.options), base, "the link target's bytes are part of the key");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("retargeting a link changes the key even when the target bytes are equal", async () => {
  const fx = fixtures();
  try {
    tree(fx.theme, { "test/other.css": "one\n" });
    const link = join(fx.theme, "styles.css");
    symlinkSync("test/shared.css", link);
    const base = await cacheKey(fx.options);

    relink(link, "test/other.css");
    assert.notEqual(await cacheKey(fx.options), base, "the link's own identity includes its target");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("an output link is an input the same way a theme link is", async () => {
  const fx = fixtures();
  try {
    const link = join(fx.outputs, "helpers.ts");
    symlinkSync("test/shared.ts", link);
    const base = await cacheKey(fx.options);

    writeFileSync(join(fx.outputs, "test/shared.ts"), "two\n");
    assert.notEqual(await cacheKey(fx.options), base, "the output link's target bytes are part of the key");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a broken link has its own identity and aliases neither a missing nor an empty input", async () => {
  const fx = fixtures();
  try {
    const link = join(fx.theme, "styles.css");
    symlinkSync("test/nowhere.css", link);
    const broken = await cacheKey(fx.options);

    // Replace the link itself; writing to it would follow the link instead.
    unlinkSync(link);
    writeFileSync(link, "");
    assert.notEqual(await cacheKey(fx.options), broken, "a broken link is not an empty file");

    unlinkSync(link);
    assert.notEqual(await cacheKey(fx.options), broken, "a broken link is not a missing file");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a link that escapes its root is never read, and its marker never aliases a regular file", async () => {
  const fx = fixtures();
  try {
    writeFileSync(join(fx.outside, "secret.css"), "outside-one\n");
    const link = join(fx.theme, "styles.css");
    symlinkSync(join(fx.outside, "secret.css"), link);
    const base = await cacheKey(fx.options);

    writeFileSync(join(fx.outside, "secret.css"), "outside-two\n");
    assert.equal(await cacheKey(fx.options), base, "outside bytes are not read or hashed");

    unlinkSync(link);
    writeFileSync(link, "outside-two\n");
    assert.notEqual(await cacheKey(fx.options), base, "the escaping link's marker is not the outside bytes");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});
