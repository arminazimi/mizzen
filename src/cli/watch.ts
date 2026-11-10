/**
 * `mizzen watch`: build the site, then rebuild whenever a source or theme file changes.
 *
 * The scheduling mirrors `mizzen dev`: changes are collected for a short delay so an editor's burst of writes builds
 * once, and builds run one at a time so a change that lands during a build waits for it. Nothing is served; the output
 * folder is exactly what `mizzen build` writes.
 *
 * SIGINT is handled by the process, in `cli/index.ts`. Tests and other callers use {@link Watcher.stop}, then await
 * {@link Watcher.closed}; both are safe to call more than once.
 */
import { watch as watchFs, type FSWatcher } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import { build } from "../pipeline/build.ts";
import { formatText } from "../pipeline/diagnostics.ts";

/** Folder under the site root that `mizzen watch` writes to when `--out` is not given. Hidden, so discovery skips it. */
export const DEFAULT_WATCH_OUT = ".slipway/watch";

/** How long changes are collected before one rebuild, so an editor's burst of writes builds once. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 40;

/** Folders that never affect a build and would otherwise make the watcher rebuild in a loop. */
const IGNORED = new Set(["node_modules", ".git", ".tmp", ".slipway"]);

/** What one watch rebuild wrote and how long it took. */
export interface WatchBuild {
  /** Wall-clock milliseconds the build took, from call to the output folder being in place. */
  readonly milliseconds: number;
  /** Every file written, relative to the output folder, sorted by path. */
  readonly files: readonly string[];
  /** Findings of the build, sorted. The site is written even when there are errors. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link watch}. */
export interface WatchOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The folder the site is written to. Changed as a whole by every build. */
  readonly out: string;
  /** The theme's root folder, as `mizzen build` takes it. */
  readonly themeRoot: string;
  /** Layout for a page that names none in its front matter or in `defaults`. */
  readonly defaultLayout?: string;
  /** Reuse an unchanged build from `.slipway/cache`, as `mizzen build` does. Off by default. */
  readonly cache?: boolean;
  /** Receives one line per rebuild and any diagnostic text. Default: silent. */
  readonly log?: (message: string) => void;
  /** How long to collect changes before rebuilding. Default: {@link DEFAULT_WATCH_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
}

/** A running watcher. */
export interface Watcher {
  /** The output folder every rebuild writes. */
  readonly out: string;
  /** Resolves once {@link stop} has finished. */
  readonly closed: Promise<void>;
  /** Builds once and resolves with the timing. Builds run one at a time, in call order. */
  rebuild(reason?: string): Promise<WatchBuild>;
  /** Stops watching, waits for a build in flight, and resolves {@link closed}. Safe to call more than once. */
  stop(): Promise<void>;
}

/** True when `child` is `parent` or sits inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Builds `root` once, then rebuilds whenever a source or theme file changes. The returned watcher keeps the process
 * alive until {@link Watcher.stop}; callers own signals and lifetime.
 */
export async function watch(options: WatchOptions): Promise<Watcher> {
  const root = resolve(options.root);
  const out = resolve(options.out);
  const themeRoot = resolve(options.themeRoot);
  const log = options.log ?? (() => {});
  const debounceMs =
    options.debounceMs !== undefined && Number.isFinite(options.debounceMs) && options.debounceMs >= 0
      ? options.debounceMs
      : DEFAULT_WATCH_DEBOUNCE_MS;

  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closing = false;
  let shuttingDown: Promise<void> | undefined;

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  const buildOnce = async (reason: string): Promise<WatchBuild> => {
    const started = performance.now();
    const result = await build({
      root,
      out,
      themeRoot,
      ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
      ...(options.cache === true ? { cache: true } : {}),
    });
    const milliseconds = performance.now() - started;
    if (result.diagnostics.length > 0) log(formatText(result.diagnostics).replace(/\n$/, ""));
    log(`mizzen watch: ${reason} in ${Math.round(milliseconds)} ms`);
    return { milliseconds, files: result.files, diagnostics: result.diagnostics };
  };

  // Builds run one at a time. A change that lands during a build waits for it instead of building twice at once.
  let tail = Promise.resolve();
  const rebuild = (reason = "rebuild"): Promise<WatchBuild> => {
    if (closing) return Promise.reject(new Error("mizzen watch: the watcher is closed"));
    const run = tail.then(
      () => buildOnce(reason),
      () => buildOnce(reason),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const ignored = (dir: string, filename: string | Buffer | null): boolean => {
    if (filename === null) return false;
    const name = typeof filename === "string" ? filename : filename.toString();
    if (name === "") return false;
    const abs = resolve(dir, name);
    if (isInside(out, abs)) return true;
    return name
      .split(/[\\/]/)
      .some((part) => IGNORED.has(part) || part === ".DS_Store" || part.endsWith("~"));
  };

  const schedule = (reason: string): void => {
    if (closing) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void rebuild(reason).catch((err: unknown) => {
        log(`mizzen watch: rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, debounceMs);
    timer.unref();
  };

  const watchTree = (dir: string, label: string): void => {
    try {
      const watcher = watchFs(dir, { recursive: true }, (_event, filename) => {
        if (!ignored(dir, filename)) schedule(`change in ${label}`);
      });
      watcher.on("error", (err) => log(`mizzen watch: watcher error: ${err.message}`));
      watchers.push(watcher);
    } catch (err) {
      log(`mizzen watch: cannot watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  try {
    await buildOnce("initial build");
  } catch (err) {
    log(`mizzen watch: initial build failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  watchTree(root, "the site");
  // A theme inside the site root is already covered by the recursive watcher above.
  if (!isInside(root, themeRoot)) watchTree(themeRoot, "the theme");

  const stop = (): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    closing = true;
    shuttingDown = (async () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
      await tail.catch(() => undefined);
      log("mizzen watch: stopped");
      resolveClosed();
    })();
    return shuttingDown;
  };

  return {
    out,
    closed,
    rebuild,
    stop,
  };
}

/** The default output folder of a site under watch: `<root>/.slipway/watch`. */
export function watchOutOf(root: string): string {
  return join(resolve(root), DEFAULT_WATCH_OUT);
}
