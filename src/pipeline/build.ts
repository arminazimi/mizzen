import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config/load.ts";
import { discover } from "../content/discover.ts";
import type { Diagnostic, Output, OutputContext, OutputFile, Page } from "../contracts/index.ts";
import { buildModel } from "../model/build.ts";
import { MANIFEST_PATH, recordBuildHash } from "../outputs/build-hash.ts";
import { createCssBundler, type CssBundle } from "../render/css.ts";
import { loadRegistry } from "../render/registry.ts";
import { copyAssets } from "./assets.ts";
import { cacheKey, cacheRootOf, restoreCache, writeCache } from "./cache.ts";
import { createDiagnostics, sortDiagnostics, type Diagnostics } from "./diagnostics.ts";
import { createRenderPool, renderOnePage, type RenderPool } from "./parallel.ts";
import { placeholderDiagnostics } from "./placeholder-diagnostic.ts";

/** Options of {@link build}. */
export interface BuildOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The folder the site is written to. Replaced as a whole: the old site stays until the new one is complete. */
  readonly out: string;
  /** The theme's root folder: its `src/index.ts`, and its `layouts/`, `chrome/`, and `components/` folders. */
  readonly themeRoot: string;
  /** Theme files to copy, as paths relative to `themeRoot`; each lands under `assets/theme/` with its hash in the name. */
  readonly themeFiles?: readonly string[];
  /** Layout for a page that names none in its front matter or in `defaults`. Without it such a page is an error. */
  readonly defaultLayout?: string;
  /** Folder the outputs are read from. Default: `src/outputs/` beside this file. */
  readonly outputsDir?: string;
  /** Reuse the output of an unchanged build from the cache. Off by default; `mizzen build` turns it on. */
  readonly cache?: boolean;
  /** Folder the cache lives in. Default: `<root>/.slipway/cache`. Only used when `cache` is true. */
  readonly cacheDir?: string;
  /**
   * Pages to render at once in worker threads. `1`, the default, renders in this process, byte for byte as before;
   * `2` or more starts that many workers, each loading the theme, and pages are rendered in batches. A worker that
   * fails renders its pages in this process with a diagnostic. There is no config key for this: it is a machine
   * setting, like a make job count, and `mizzen build --workers <n|auto>` is how a person sets it.
   */
  readonly workers?: number;
}

/** What {@link build} wrote and found. */
export interface BuildResult {
  /** Absolute path of the output folder. */
  readonly out: string;
  /** Every file written, relative to `out`, sorted by path. */
  readonly files: readonly string[];
  /** Every finding of the build, sorted. The site is written even when there are errors; the caller decides whether to fail. */
  readonly diagnostics: readonly Diagnostic[];
}

/** The default folder of outputs: `src/outputs/` beside this file's folder. */
const OUTPUTS_DIR = fileURLToPath(new URL("../outputs/", import.meta.url));

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True for a path an output may write: relative, `/`-separated, and with no empty, `.`, or `..` segment. */
function isInside(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isOutput(value: unknown): value is Output {
  if (typeof value !== "object" || value === null) return false;
  const { name, run } = value as { name?: unknown; run?: unknown };
  return typeof name === "string" && typeof run === "function";
}

/**
 * Reads every `*.ts` file of the outputs folder in file-name order and returns the outputs they export.
 * A file must export exactly one output, under any export name, and the output's `name` must equal the file name.
 * A file that exports no output is a helper and is not run.
 */
async function loadOutputs(dir: string, diagnostics: Diagnostics): Promise<Output[]> {
  if (!(await exists(dir))) {
    diagnostics.error("output.missing-folder", `Output folder "${dir}" does not exist.`, {
      help: "Point `outputsDir` at the folder of output files.",
    });
    return [];
  }
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort(byCodePoint);

  const outputs: Output[] = [];
  for (const file of names) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      diagnostics.error("output.load-failed", `Failed to load output "${file}": ${detail}.`, {
        help: "Fix the file so Node can import it.",
      });
      continue;
    }
    const found = Object.keys(mod)
      .sort(byCodePoint)
      .map((key) => mod[key])
      .filter(isOutput);
    if (found.length === 0) continue;
    if (found.length > 1) {
      diagnostics.error("output.multiple", `Output file "${file}" exports ${found.length} outputs; it may export one.`, {
        help: "Move the extra outputs into their own files.",
      });
      continue;
    }
    const output = found[0]!;
    const expected = file.slice(0, -".ts".length);
    if (output.name !== expected) {
      diagnostics.error("output.name-mismatch", `Output file "${file}" is named "${output.name}"; it must be "${expected}".`, {
        help: "Make the output's name equal to its file name, without `.ts`.",
      });
      continue;
    }
    outputs.push(output);
  }
  return outputs;
}

/**
 * Puts `staging` in place of `out`. The old folder is moved aside first and removed only once the new one is in
 * place, so a failed swap puts the old site back.
 */
async function commit(staging: string, out: string): Promise<void> {
  const replaced = `${staging}-replaced`;
  const hadOld = await exists(out);
  if (hadOld) await rename(out, replaced);
  try {
    await rename(staging, out);
  } catch (err) {
    if (hadOld) await rename(replaced, out);
    throw err;
  }
  if (hadOld) await rm(replaced, { recursive: true, force: true });
}

/** Fails when `out` is the source folder or sits inside it under a name discovery would not skip. */
function assertOutOutsideSource(sourceDir: string, out: string): void {
  const rel = relative(sourceDir, out);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside && (rel === "" || !/^[_.]/.test(rel.split(sep)[0] ?? ""))) {
    throw new TypeError(
      `build: the output folder "${out}" is inside the source folder "${sourceDir}"; name it with a leading "_" (such as _site) or put it outside.`,
    );
  }
}

/**
 * Builds the site: model, theme, outputs, and write.
 *
 * Every output runs first, in file-name order, and its files are checked in memory: a path outside the output folder
 * is an error, and so is a path two outputs both write; the first one wins. Then the site's assets are copied and the
 * output files written, all into a staging folder beside `out`. A site file wins over an output file at the same path:
 * the output's file is skipped, with no diagnostic. Only when the staging folder is complete is it swapped in, so `out`
 * is never half-written. Outputs switched off by `outputs` in the config do not run.
 *
 * With `cache`, a build whose config, source, navigation, theme, outputs, layout options, and engine version are
 * unchanged restores the previous output instead of building again. Config and navigation are in the same key as the
 * pages, so changing either invalidates every page. When that whole-build entry misses, each page's Markdown parse is
 * kept under `<cache>/pages/` and keyed by its expanded body, body line, plugin names and orders, and the engine
 * version, so only the pages that changed are parsed again.
 *
 * With `workers` above 1, pages render in worker threads, and the site written is byte for byte the one a single
 * process writes. A worker that fails renders its pages in this process, with a `render.worker-failed` warning.
 *
 * Problems in the content and the theme come back as diagnostics; a throw means a bug, such as an output or layout
 * that threw, and leaves `out` as it was. `out` must not be the source folder nor sit inside it, unless its name
 * starts with `_` or `.`, which discovery skips.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const diagnostics = createDiagnostics();
  const root = resolve(options.root);
  const out = resolve(options.out);
  const themeRoot = resolve(options.themeRoot);
  const outputsDir = resolve(options.outputsDir ?? OUTPUTS_DIR);
  const workers = options.workers ?? 1;
  if (!Number.isInteger(workers) || workers < 1) {
    throw new TypeError(`build: workers must be a whole number of at least 1, not ${String(options.workers)}.`);
  }

  // The config is read before the cache so the source folder is known without building the model.
  const loaded = loadConfig(root);
  const sourceDir = resolve(root, loaded.config.source);
  assertOutOutsideSource(sourceDir, out);

  const cacheRoot = options.cache === true ? resolve(options.cacheDir ?? cacheRootOf(root)) : undefined;
  let key: string | undefined;
  if (cacheRoot !== undefined) {
    key = await cacheKey({
      root,
      sourceDir,
      config: loaded.config,
      themeRoot,
      outputsDir,
      ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
      ...(options.themeFiles === undefined ? {} : { themeFiles: options.themeFiles }),
    }).catch(() => undefined);
    if (key !== undefined) {
      const hit = await restoreCache(cacheRoot, key, out).catch(() => undefined);
      if (hit !== undefined) {
        try {
          await commit(hit.staging, out);
          return { out, files: hit.files, diagnostics: [...hit.diagnostics] };
        } catch {
          // A cache entry that cannot be put in place is no better than no entry: build cold below.
        } finally {
          await rm(hit.staging, { recursive: true, force: true });
        }
      }
    }
  }

  const model = await buildModel(
    root,
    cacheRoot === undefined ? undefined : { pageCacheDir: join(cacheRoot, "pages") },
  );
  for (const d of model.diagnostics) diagnostics.report(d);
  const { site } = model;
  for (const d of await placeholderDiagnostics(site)) diagnostics.report(d);

  const registry = await loadRegistry(themeRoot);
  for (const d of registry.diagnostics) diagnostics.report(d);

  // Shared CSS, in cascade order: the theme's `styles/`, then every chrome part's `style.css`. A page adds its layout's
  // and its components' CSS. Bundles are collected here and written with the site.
  const bundler = createCssBundler({
    themeRoot,
    base: [
      ...registry.styles,
      ...Object.values(registry.chrome).flatMap((unit) => (unit.css === undefined ? [] : [unit.css])),
    ],
    urlBase: site.config.base,
  });
  const bundles = new Map<string, CssBundle>();

  /** Links the page's stylesheets just before `</head>`; the render stage is synchronous, so this happens after it. */
  const withCss = async (rendered: { html: string; css: readonly string[] }): Promise<string> => {
    const { base, page } = await bundler.page(rendered.css);
    const used = [base, page].filter((b): b is CssBundle => b !== undefined && b.css !== "");
    for (const b of used) bundles.set(b.path, b);
    if (used.length === 0) return rendered.html;
    const links = used.map((b) => `<link rel="stylesheet" href="${site.config.base}/${b.path}">`).join("");
    return rendered.html.replace(/<\/head>/i, () => `${links}</head>`);
  };

  const renderOne = async (page: Page): Promise<string> => {
    const rendered = renderOnePage(registry, site, page, options.defaultLayout);
    for (const d of rendered.diagnostics) diagnostics.report(d);
    return withCss(rendered);
  };

  const files = await discover(sourceDir, { include: site.config.include, exclude: site.config.exclude });

  // With one worker, pages render in this process exactly as before. With more, the pool starts rendering the doc
  // pages the html output will ask for while the outputs are still being loaded, then serves them from its results.
  // A pool that renders a page nobody asks for reports nothing: reporting happens when an output asks for the page.
  const pool: RenderPool | undefined =
    workers > 1
      ? createRenderPool({
          themeRoot,
          site,
          registry,
          ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
          workers,
        })
      : undefined;
  if (pool !== undefined && site.config.outputs.html !== false) {
    pool.prefetch(site.pages.filter((page) => page.kind === "doc"));
  }

  const renderPaged = async (page: Page): Promise<string> => {
    if (pool === undefined) return renderOne(page);
    const rendered = await pool.render(page);
    for (const d of rendered.diagnostics) diagnostics.report(d);
    return withCss(rendered);
  };

  const ctx: OutputContext = {
    renderPage: renderPaged,
    report: (d) => diagnostics.report(d),
  };

  // Outputs run in memory, so every path is checked before anything is written.
  const claimed = new Map<string, string>();
  const pending: { readonly output: string; readonly file: OutputFile }[] = [];
  try {
    for (const output of await loadOutputs(outputsDir, diagnostics)) {
      if (site.config.outputs[output.name] === false) continue;
      for (const file of await output.run(site, ctx)) {
        if (!isInside(file.path)) {
          diagnostics.error("output.bad-path", `Output "${output.name}" writes "${file.path}", which is not inside the output folder.`, {
            help: "Use a relative path with `/` separators and no `..`.",
          });
          continue;
        }
        const first = claimed.get(file.path);
        if (first !== undefined) {
          diagnostics.error("output.duplicate-path", `Two files write "${file.path}": outputs "${first}" and "${output.name}".`, {
            help: "Turn one of them off in `outputs`, or rename its file.",
          });
          continue;
        }
        claimed.set(file.path, output.name);
        pending.push({ output: output.name, file });
      }
    }
  } finally {
    await pool?.close();
  }

  const parent = dirname(out);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(out)}-build-`));
  try {
    const assets = await copyAssets({
      source: sourceDir,
      out: staging,
      files,
      themeRoot,
      themeFiles: [...new Set([...(options.themeFiles ?? []), ...bundler.assets()])],
    });
    const assetPaths = new Set(assets.files.map((f) => f.path));
    const written = assets.files.map((f) => f.path);

    for (const bundle of bundles.values()) {
      const abs = join(staging, bundle.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bundle.css);
      assetPaths.add(bundle.path);
      written.push(bundle.path);
    }

    for (const { output, file } of pending) {
      // A site's own file wins over a generated one at the same path, silently: a site `llms.txt` replaces the output's.
      if (assetPaths.has(file.path)) continue;
      const abs = join(staging, file.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, file.contents);
      written.push(file.path);
    }

    // The build's one hash goes into the manifest last, so every other file is in place (#1252). The manifest that
    // records the hash is left out of it, and a site file that replaced the generated manifest is left alone.
    if (claimed.get(MANIFEST_PATH) === "manifest" && !assetPaths.has(MANIFEST_PATH)) await recordBuildHash(staging);

    const fileList = [...written].sort(byCodePoint);
    const findings = sortDiagnostics(diagnostics.all);
    if (cacheRoot !== undefined && key !== undefined) await writeCache(cacheRoot, key, staging, fileList, findings);

    await commit(staging, out);
    return { out, files: fileList, diagnostics: findings };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
