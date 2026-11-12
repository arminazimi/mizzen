import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { discover } from "../src/content/discover.ts";
import { copyAssets, themeAssetPath } from "../src/pipeline/assets.ts";

/**
 * Every fixture of every test here lives under one folder of `os.tmpdir()`, created by the test that uses
 * it and removed with it. Nothing reads or writes a real user path.
 */
interface Fixtures {
  /** The temp root, deleted after the test. */
  readonly parent: string;
  /** The site source folder. */
  readonly site: string;
  /** The theme root. */
  readonly theme: string;
  /** The output folder, empty at the start of a test unless the test fills it. */
  readonly out: string;
  /** A folder outside the theme root holding a file a theme entry must never reach. */
  readonly outside: string;
  /** A folder outside the output holding what a write must never reach. */
  readonly escaped: string;
}

/** Creates `files` under `root`, making parent folders as needed. */
function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A site, a theme, an empty output, and the two outside folders an escape would land in. */
function fixtures(): Fixtures {
  const parent = mkdtempSync(join(tmpdir(), "assets-theme-boundary-96-"));
  const fx: Fixtures = {
    parent,
    site: join(parent, "site"),
    theme: join(parent, "theme"),
    out: join(parent, "out"),
    outside: join(parent, "outside"),
    escaped: join(parent, "escaped"),
  };
  for (const dir of [fx.site, fx.theme, fx.out, fx.outside, fx.escaped]) mkdirSync(dir, { recursive: true });
  tree(fx.site, { "a.md": "# A\n", "images/logo.png": "png-bytes\n" });
  tree(fx.theme, { "assets/css/main.css": "body { color: ink; }\n", "assets/logo.svg": "<svg></svg>" });
  tree(fx.outside, { "evil.css": "body { color: outside; }\n" });
  return fx;
}

/** Every path under `root`, `/`-separated and sorted; a symlink is listed but never followed. */
function listing(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(/[\\/]/).join("/");
      found.push(rel);
      if (entry.isDirectory()) walk(path);
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

/** The whole state a refused set must leave untouched. */
function state(fx: Fixtures): string[] {
  return [
    ...listing(fx.out).map((p) => `out:${p}`),
    ...listing(fx.escaped).map((p) => `escaped:${p}`),
    ...listing(fx.outside).map((p) => `outside:${p}`),
    ...listing(fx.theme).map((p) => `theme:${p}`),
  ];
}

/** True when `err` is a TypeError whose message matches `pattern`. */
function isTypeErrorMatching(err: unknown, pattern: RegExp): boolean {
  return err instanceof TypeError && pattern.test((err as Error).message);
}

/**
 * Runs the unit over `themeFiles` and requires that it refused them before touching anything: the output,
 * both outside folders and the theme keep exactly the paths and bytes they had.
 */
async function refuses(fx: Fixtures, themeFiles: readonly string[], pattern: RegExp): Promise<void> {
  const before = state(fx);
  await assert.rejects(
    copyAssets({ source: fx.site, out: fx.out, files: [], themeRoot: fx.theme, themeFiles }),
    (err: unknown) => isTypeErrorMatching(err, pattern),
    `theme assets ${JSON.stringify(themeFiles)} are refused with a TypeError`,
  );
  assert.deepEqual(state(fx), before, `nothing was written for ${JSON.stringify(themeFiles)}`);
}

const HASH = /^[0-9a-f]{16}$/;

/** The 16-hex-character hash the unit has always used for these bytes. */
function expectedHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

test("an absolute theme entry is refused before any read or write", async () => {
  const fx = fixtures();
  try {
    const absolute = join(fx.outside, "evil.css");
    for (const entry of [absolute, "/etc/hosts-less", "//server/share/evil.css"]) {
      await refuses(fx, [entry], /absolute|relative path/);
    }
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a parent-relative theme entry is refused before any read or write", async () => {
  const fx = fixtures();
  try {
    for (const entry of ["../outside/evil.css", "assets/../../evil.css", "..", "../..", "a/../../evil.css"]) {
      await refuses(fx, [entry], /\.\.|relative path/);
    }
    // The read the current code would have performed: `join(themeRoot, "../outside/evil.css")` exists.
    assert.equal(readFileSync(join(fx.outside, "evil.css"), "utf8"), "body { color: outside; }\n");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a backslash, drive or UNC theme entry is refused, not rewritten", async () => {
  const fx = fixtures();
  try {
    for (const entry of ["assets\\evil.css", "..\\evil.css", "C:\\evil.css", "\\\\server\\share\\evil.css"]) {
      await refuses(fx, [entry], /backslash|relative path/);
    }
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("an empty, dotted or trailing-slash theme entry is refused", async () => {
  const fx = fixtures();
  try {
    for (const entry of ["", ".", "./assets/css/main.css", "assets/./main.css", "assets//css/main.css", "assets/css/main.css/"]) {
      await refuses(fx, [entry], /relative path|empty/);
    }
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a symlinked parent inside the theme root cannot redirect the read outside it", async () => {
  const fx = fixtures();
  try {
    symlinkSync(join(fx.outside, "css"), join(fx.theme, "linked"));
    mkdirSync(join(fx.outside, "css"), { recursive: true });
    // `theme/linked` resolves to `outside/css`, so this entry names the outside stylesheet.
    await refuses(fx, ["linked/evil.css"], /symbolic link|outside/);
    // A symlinked leaf is refused on its own too.
    symlinkSync(join(fx.outside, "evil.css"), join(fx.theme, "direct.css"));
    await refuses(fx, ["direct.css"], /symbolic link|outside/);
    assert.deepEqual(listing(fx.out), []);
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a symlinked parent inside the output cannot redirect the write outside it", async () => {
  const fx = fixtures();
  try {
    mkdirSync(join(fx.out, "assets"), { recursive: true });
    symlinkSync(fx.escaped, join(fx.out, "assets", "theme"));
    await refuses(fx, ["assets/logo.svg"], /symbolic link|outside/);
    assert.deepEqual(listing(fx.escaped), [], "the outside folder is still empty");
    assert.deepEqual(listing(fx.out), ["assets", "assets/theme"], "only the symlink the test made is there");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("an existing symlinked destination file is refused instead of written through", async () => {
  const fx = fixtures();
  try {
    const bytes = readFileSync(join(fx.theme, "assets/logo.svg"));
    const path = themeAssetPath("assets/logo.svg", bytes);
    mkdirSync(dirname(join(fx.out, path)), { recursive: true });
    writeFileSync(join(fx.escaped, "pwned.svg"), "not-the-theme\n");
    symlinkSync(join(fx.escaped, "pwned.svg"), join(fx.out, path));
    const before = readFileSync(join(fx.escaped, "pwned.svg"));
    await refuses(fx, ["assets/logo.svg"], /symbolic link|outside/);
    assert.deepEqual(readFileSync(join(fx.escaped, "pwned.svg")), before, "the link target keeps its bytes");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a refused set leaves already-valid theme assets and the whole output unwritten", async () => {
  const fx = fixtures();
  try {
    // The valid entry comes first: a unit that copies as it validates would leave it in the output.
    await refuses(
      fx,
      ["assets/css/main.css", "assets/logo.svg", "../outside/evil.css"],
      /\.\.|relative path/,
    );
    assert.deepEqual(listing(fx.out), [], "the output folder holds nothing");
    await refuses(fx, ["assets/css/main.css", join(fx.outside, "evil.css")], /absolute|relative path/);
    assert.deepEqual(listing(fx.out), [], "the output folder still holds nothing");
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("a theme root reached through a symlink keeps its own files inside itself", async () => {
  const fx = fixtures();
  const links = join(fx.parent, "links");
  try {
    mkdirSync(links, { recursive: true });
    symlinkSync(fx.theme, join(links, "theme"));
    const out = join(fx.parent, "out-via-symlink");
    mkdirSync(out, { recursive: true });
    const result = await copyAssets({
      source: fx.site,
      out,
      files: [],
      themeRoot: join(links, "theme"),
      themeFiles: ["assets/css/main.css"],
    });
    assert.equal(result.files.length, 1);
    assert.match(result.files[0]!.path, /^assets\/theme\/assets\/css\/main-[0-9a-f]{16}\.css$/);
    assert.deepEqual(
      readFileSync(join(out, result.files[0]!.path)),
      readFileSync(join(fx.theme, "assets/css/main.css")),
    );
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});

test("valid nested theme assets keep their content hash and output URL, and site assets are unchanged", async () => {
  const fx = fixtures();
  try {
    const css = readFileSync(join(fx.theme, "assets/css/main.css"));
    const svg = readFileSync(join(fx.theme, "assets/logo.svg"));
    const files = await discover(fx.site);
    const result = await copyAssets({
      source: fx.site,
      out: fx.out,
      files,
      themeRoot: fx.theme,
      themeFiles: ["assets/css/main.css", "assets/logo.svg"],
    });

    const expected = [
      `assets/theme/assets/css/main-${expectedHash(css)}.css`,
      `assets/theme/assets/logo-${expectedHash(svg)}.svg`,
      "images/logo.png",
    ].sort();
    assert.deepEqual(result.files.map((f) => f.path), expected);
    assert.deepEqual(
      result.files.map((f) => [f.from, f.hash]),
      [
        ["assets/css/main.css", expectedHash(css)],
        ["assets/logo.svg", expectedHash(svg)],
        ["images/logo.png", expectedHash(readFileSync(join(fx.site, "images/logo.png")))],
      ].sort(),
    );
    for (const file of result.files) assert.match(file.hash, HASH, file.path);

    // The theme bytes land under the output path the URL names, and the document is never copied.
    const written = result.files.find((f) => f.from === "assets/css/main.css")!;
    assert.equal(written.path, `assets/theme/assets/css/main-${expectedHash(css)}.css`);
    assert.deepEqual(readFileSync(join(fx.out, written.path)), css);
    assert.deepEqual(readFileSync(join(fx.out, "images/logo.png")), readFileSync(join(fx.site, "images/logo.png")));
    assert.equal(existsSync(join(fx.out, "a.md")), false);
    assert.deepEqual(listing(fx.escaped), []);

    // Deterministic: the same bytes give the same plan, and nothing extra appears outside.
    const again = await copyAssets({
      source: fx.site,
      out: fx.out,
      files,
      themeRoot: fx.theme,
      themeFiles: ["assets/css/main.css", "assets/logo.svg"],
    });
    assert.deepEqual(again.files, result.files);

    // A changed byte is a new hash in a new name, as before.
    writeFileSync(join(fx.theme, "assets/css/main.css"), "body { color: inkier; }\n");
    const changed = await copyAssets({
      source: fx.site,
      out: fx.out,
      files,
      themeRoot: fx.theme,
      themeFiles: ["assets/css/main.css", "assets/logo.svg"],
    });
    const newCss = changed.files.find((f) => f.from === "assets/css/main.css")!;
    assert.notEqual(newCss.path, result.files.find((f) => f.from === "assets/css/main.css")!.path);
    assert.equal(lstatSync(join(fx.out, newCss.path)).isSymbolicLink(), false);
  } finally {
    rmSync(fx.parent, { recursive: true, force: true });
  }
});
