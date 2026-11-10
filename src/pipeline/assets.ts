import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DiscoveredFile } from "../content/discover.ts";

/** One file the assets unit wrote to the output folder. */
export interface CopiedFile {
  /** Where the file came from: relative to the site source, or to the theme root for theme assets. */
  readonly from: string;
  /** Path of the written file, relative to the output folder, using `/`. */
  readonly path: string;
  /** SHA-256 of the file's bytes, as 16 lowercase hex characters. */
  readonly hash: string;
}

/** What the assets unit needs. Discovery has already run; the unit copies only what it is handed. */
export interface CopyAssetsOptions {
  /** Absolute path of the site source folder the discovered paths are relative to. */
  readonly source: string;
  /** Absolute path of the output folder; created when missing. */
  readonly out: string;
  /** Files discovery found. `asset` and `app` files are copied; `doc` and `data` files are not. */
  readonly files: readonly DiscoveredFile[];
  /** Absolute path of the theme's root folder. */
  readonly themeRoot?: string;
  /** Theme files to copy, as paths relative to the theme root. Each lands at `assets/theme/` with the hash in its name. */
  readonly themeFiles?: readonly string[];
}

/** What the assets unit wrote. */
export interface CopyAssetsResult {
  /** Every written file, sorted by output path, so runs are deterministic. */
  readonly files: readonly CopiedFile[];
}

/** Folder under the output that hashed theme assets go to, so they can never collide with site paths. */
const THEME_OUT = "assets/theme";

/** Length of the hash in a file name: 16 hex characters is far beyond collision range for a site. */
const HASH_LENGTH = 16;

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, HASH_LENGTH);
}

/** `css/main.css` becomes `css/main-<hash>.css`; the extension is kept so servers still see the type. */
function hashedName(path: string, hash: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const base = path.slice(slash + 1, dot > slash ? dot : undefined);
  const ext = dot > slash ? path.slice(dot) : "";
  return `${dir}${base}-${hash}${ext}`;
}

/** Output path of a theme file with these bytes: `assets/theme/<rel>` with the hash in the name. */
export function themeAssetPath(rel: string, bytes: Uint8Array): string {
  return `${THEME_OUT}/${hashedName(rel, hashOf(bytes))}`;
}

async function write(from: string, path: string, abs: string, bytes: Uint8Array): Promise<CopiedFile> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  return { from, path, hash: hashOf(bytes) };
}

/**
 * Copies assets to the output: site assets keep their paths, app pages pass through byte for byte, and theme assets
 * land under `assets/theme/` with the hash of their bytes in the name, so a changed file is a new URL. `doc` and
 * `data` files are never copied: docs are rendered, and `_data` is read by the engine.
 */
export async function copyAssets(options: CopyAssetsOptions): Promise<CopyAssetsResult> {
  const { source, out, files } = options;
  const themeRoot = options.themeRoot;
  const themeFiles = (options.themeFiles ?? []).map((path) => path.replace(/\\/g, "/"));
  if (themeFiles.length > 0 && themeRoot === undefined) {
    throw new TypeError("copyAssets: themeFiles given without themeRoot.");
  }

  const copied: CopiedFile[] = [];
  for (const file of files) {
    if (file.kind !== "asset" && file.kind !== "app") continue;
    const bytes = await readFile(join(source, file.path));
    copied.push(await write(file.path, file.path, join(out, file.path), bytes));
  }
  for (const rel of themeFiles) {
    const bytes = await readFile(join(themeRoot as string, rel));
    const hash = hashOf(bytes);
    const path = `${THEME_OUT}/${hashedName(rel, hash)}`;
    copied.push(await write(rel, path, join(out, path), bytes));
  }

  copied.sort((a, b) => byCodePoint(a.path, b.path));
  return { files: copied };
}
