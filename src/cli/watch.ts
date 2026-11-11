/**
 * `mizzen watch`: build the site, then rebuild whenever a source or theme file changes.
 *
 * Events are coalesced with two bounds: a quiet period that restarts on every event, and a maximum delay measured from
 * the first event of a burst, so continuous rename events still produce a build. Events that land while a build runs
 * mark the tree dirty; when the build finishes exactly one follow-up is scheduled and reads the latest settled tree.
 *
 * A watcher that fails is logged and replaced. The failure itself schedules a recovery build, and a root that cannot
 * be watched is retried after the maximum delay, so a recreated root starts updating again instead of silently
 * stopping. Reasons are sorted, so a burst logs the same line whatever order its events arrived in.
 *
 * Nothing is served; the output folder is exactly what `mizzen build` writes. SIGINT is handled by the process, in
 * `cli/index.ts`. Tests and other callers use {@link Watcher.stop}, then await {@link Watcher.closed}; both are safe to
 * call more than once.
 */
import { watch as watchFs } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Diagnostic } from "../contracts/index.ts";
import { build } from "../pipeline/build.ts";
import { formatText } from "../pipeline/diagnostics.ts";

/** Folder under the site root that `mizzen watch` writes to when `--out` is not given. Hidden, so discovery skips it. */
export const DEFAULT_WATCH_OUT = ".mizzen/watch";

/** How long changes are collected before one rebuild, so an editor's burst of writes builds once. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 40;

/** The longest a continuous burst may postpone a rebuild. */
export const DEFAULT_WATCH_MAX_DELAY_MS = 1_000;

/** Folders that never affect a build and would otherwise make the watcher rebuild in a loop. */
const IGNORED = new Set(["node_modules", ".git", ".tmp", ".mizzen"]);

/** A timer source; tests inject a clock so scheduling is deterministic. */
export interface WatchTimers {
  /** Schedules `callback`, returning a handle for {@link WatchTimers.clearTimeout}. */
  setTimeout(callback: () => void, milliseconds: number): unknown;
  /** Cancels a timer scheduled by {@link WatchTimers.setTimeout}. */
  clearTimeout(handle: unknown): void;
}

/** The timers of the process. They are unref'd so a pending rebuild never keeps Node alive on its own. */
const NODE_TIMERS: WatchTimers = {
  setTimeout(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** An open recursive watcher. */
export interface WatchHandle {
  /** Stops the watcher. Safe to call more than once; it never reports a failure of its own close. */
  close(): void;
}

/**
 * Opens recursive watchers. Tests replace it to simulate a watcher error, a root that disappears, or a filename-less
 * event without depending on the platform's watcher.
 */
export interface WatchSource {
  /**
   * Watches `dir` recursively. `onChange` receives the file the event names, or `null` when the event names none;
   * `onFailure` is called at most once when the watcher stops without being closed by {@link WatchHandle.close}.
   */
  open(
    dir: string,
    onChange: (filename: string | null) => void,
    onFailure: (error: Error) => void,
  ): WatchHandle;
}

/** The process's recursive watchers. */
const FS_SOURCE: WatchSource = {
  open(dir, onChange, onFailure) {
    let closed = false;
    const watcher = watchFs(dir, { recursive: true }, (_event, filename) => {
      onChange(typeof filename === "string" ? filename : null);
    });
    const fail = (error: Error): void => {
      if (closed) return;
      closed = true;
      onFailure(error);
    };
    watcher.on("error", fail);
    watcher.on("close", () => fail(new Error("the watcher closed unexpectedly")));
    return {
      close() {
        if (closed) return;
        closed = true;
        watcher.close();
      },
    };
  },
};

/** Options of {@link WatchScheduler}. */
export interface WatchSchedulerOptions<T> {
  /** How long the tree must stay quiet before a rebuild. */
  readonly quietMs: number;
  /** The longest an event burst may postpone a rebuild. */
  readonly maxMs: number;
  /** Builds once for `reason`. Rejections are reported through `log` unless the caller asked for the build. */
  readonly run: (reason: string) => Promise<T>;
  /** Timer source. Default: the process's timers. */
  readonly timers?: WatchTimers;
  /** Receives failed rebuilds that nobody awaited. Default: silent. */
  readonly log?: (message: string) => void;
}

interface QueuedBuild<T> {
  readonly reason: string;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Coalesces change notifications into builds. At most one build runs and at most one timer-driven build waits, however
 * many events arrive; explicit {@link WatchScheduler.request} calls are served in call order.
 */
export class WatchScheduler<T> {
  readonly #quietMs: number;
  readonly #maxMs: number;
  readonly #run: (reason: string) => Promise<T>;
  readonly #timers: WatchTimers;
  readonly #log: (message: string) => void;

  readonly #pending = new Set<string>();
  readonly #manual: QueuedBuild<T>[] = [];
  #quietTimer: unknown;
  #maxTimer: unknown;
  #running: Promise<T> | undefined;
  #stopped = false;
  #stopping: Promise<void> | undefined;
  #idle: Array<() => void> = [];

  constructor(options: WatchSchedulerOptions<T>) {
    this.#quietMs = options.quietMs;
    this.#maxMs = options.maxMs;
    this.#run = options.run;
    this.#timers = options.timers ?? NODE_TIMERS;
    this.#log = options.log ?? (() => {});
  }

  /** True while a build runs, an event waits for either timer, or an explicit build waits for the one in flight. */
  get busy(): boolean {
    return (
      this.#running !== undefined ||
      this.#pending.size > 0 ||
      this.#manual.length > 0 ||
      this.#quietTimer !== undefined ||
      this.#maxTimer !== undefined
    );
  }

  /** Records an event reason; repeated reasons in one burst are logged once. */
  notify(reason: string): void {
    if (this.#stopped) return;
    this.#pending.add(reason);
    if (this.#running === undefined && this.#manual.length === 0) this.#arm();
  }

  /** Builds as soon as the build in flight finishes, merged with any event reasons already waiting. */
  request(reason: string): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error("mizzen watch: the watcher is closed"));
    return new Promise<T>((resolveBuild, rejectBuild) => {
      this.#manual.push({ reason, resolve: resolveBuild, reject: rejectBuild });
      this.#pump();
    });
  }

  /** Resolves once no build or timer remains. With injected timers, advance the clock instead of awaiting it. */
  settled(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise<void>((resolveIdle) => this.#idle.push(resolveIdle));
  }

  /** Cancels every timer, rejects queued explicit builds, and waits for the build in flight. Idempotent. */
  stop(): Promise<void> {
    if (this.#stopping !== undefined) return this.#stopping;
    this.#stopped = true;
    this.#clearTimers();
    this.#pending.clear();
    const queued = this.#manual.splice(0);
    for (const build of queued) build.reject(new Error("mizzen watch: the watcher is closed"));
    this.#stopping = (async () => {
      if (this.#running !== undefined) await this.#running.catch(() => undefined);
      this.#checkIdle();
    })();
    return this.#stopping;
  }

  #arm(): void {
    if (this.#stopped || this.#running !== undefined || this.#manual.length > 0) return;
    if (this.#pending.size === 0) return;
    if (this.#quietTimer !== undefined) this.#timers.clearTimeout(this.#quietTimer);
    this.#quietTimer = this.#timers.setTimeout(() => this.#fire(), this.#quietMs);
    // The maximum is measured from the first event of the burst, so it is set once and never restarted.
    if (this.#maxTimer === undefined) {
      this.#maxTimer = this.#timers.setTimeout(() => this.#fire(), this.#maxMs);
    }
  }

  #fire(): void {
    if (this.#stopped || this.#running !== undefined) return;
    this.#clearTimers();
    if (this.#pending.size === 0) {
      this.#checkIdle();
      return;
    }
    const reason = formatReasons(this.#pending);
    this.#pending.clear();
    this.#launch(reason);
  }

  #pump(): void {
    if (this.#stopped || this.#running !== undefined) return;
    const queued = this.#manual.shift();
    if (queued !== undefined) {
      this.#clearTimers();
      const reasons = new Set(this.#pending);
      reasons.add(queued.reason);
      this.#pending.clear();
      this.#launch(formatReasons(reasons), queued);
      return;
    }
    this.#arm();
    this.#checkIdle();
  }

  #launch(reason: string, queued?: QueuedBuild<T>): void {
    let run: Promise<T>;
    try {
      run = this.#run(reason);
    } catch (err) {
      run = Promise.reject(err);
    }
    this.#running = run;
    void run.then(
      (value) => {
        this.#running = undefined;
        queued?.resolve(value);
        this.#pump();
      },
      (err: unknown) => {
        this.#running = undefined;
        if (queued !== undefined) queued.reject(err);
        else this.#log(`mizzen watch: rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
        this.#pump();
      },
    );
  }

  #clearTimers(): void {
    if (this.#quietTimer !== undefined) {
      this.#timers.clearTimeout(this.#quietTimer);
      this.#quietTimer = undefined;
    }
    if (this.#maxTimer !== undefined) {
      this.#timers.clearTimeout(this.#maxTimer);
      this.#maxTimer = undefined;
    }
  }

  #checkIdle(): void {
    if (this.busy || this.#idle.length === 0) return;
    const waiting = this.#idle.splice(0);
    for (const resolveIdle of waiting) resolveIdle();
  }
}

/** Sorts and deduplicates a burst's reasons, so the same events always log the same line. */
function formatReasons(reasons: Iterable<string>): string {
  return [...new Set(reasons)].sort().join(", ");
}

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
  /** Reuse an unchanged build from `.mizzen/cache`, as `mizzen build` does. Off by default. */
  readonly cache?: boolean;
  /** Receives one line per rebuild and any diagnostic text. Default: silent. */
  readonly log?: (message: string) => void;
  /** How long the tree must stay quiet before rebuilding. Default: {@link DEFAULT_WATCH_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** The longest an event burst may postpone a rebuild. Default: {@link DEFAULT_WATCH_MAX_DELAY_MS}. */
  readonly maxDelayMs?: number;
  /** Timer source; tests inject a clock. Default: the process's timers. */
  readonly timers?: WatchTimers;
  /** Watcher source; tests inject watcher failures. Default: the process's recursive watchers. */
  readonly watchSource?: WatchSource;
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

/** A duration given by a caller, or `fallback` when it is missing or not a usable number of milliseconds. */
function duration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
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
  const quietMs = duration(options.debounceMs, DEFAULT_WATCH_DEBOUNCE_MS);
  const maxMs = duration(options.maxDelayMs, DEFAULT_WATCH_MAX_DELAY_MS);
  const timers = options.timers ?? NODE_TIMERS;
  const source = options.watchSource ?? FS_SOURCE;

  const watchers = new Map<string, { readonly label: string; readonly handle: WatchHandle }>();
  const roots = [{ dir: root, label: "the site" }];
  // A theme inside the site root is already covered by the recursive site watcher.
  if (!isInside(root, themeRoot)) roots.push({ dir: themeRoot, label: "the theme" });

  let retryTimer: unknown;
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

  const scheduler = new WatchScheduler<WatchBuild>({
    quietMs,
    maxMs,
    run: buildOnce,
    timers,
    log,
  });

  const ignored = (dir: string, filename: string | null): boolean => {
    // An event with no filename names no file we can rule out, so it always rebuilds.
    if (filename === null || filename === "") return false;
    const abs = resolve(dir, filename);
    if (isInside(out, abs)) return true;
    return filename
      .split(/[\\/]/)
      .some((part) => IGNORED.has(part) || part === ".DS_Store" || part.endsWith("~"));
  };

  const scheduleRetry = (): void => {
    if (closing || retryTimer !== undefined) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = undefined;
      const opened = ensureWatched();
      for (const label of opened) {
        log(`mizzen watch: watcher reattached for ${label}; rebuilding to recover`);
        scheduler.notify(`change in ${label}`);
      }
    }, maxMs);
  };

  const watchTree = (dir: string, label: string): boolean => {
    if (closing || watchers.has(dir)) return true;
    let failed = false;
    const fail = (error: Error): void => {
      if (failed || closing) return;
      failed = true;
      watchers.get(dir)?.handle.close();
      watchers.delete(dir);
      log(`mizzen watch: watcher error for ${label}: ${error.message}; rebuilding to recover`);
      scheduler.notify(`change in ${label}`);
      ensureWatched();
    };
    try {
      const handle = source.open(
        dir,
        (filename) => {
          if (!closing && !ignored(dir, filename)) scheduler.notify(`change in ${label}`);
        },
        fail,
      );
      if (failed) {
        handle.close();
        return false;
      }
      watchers.set(dir, { label, handle });
      return true;
    } catch (err) {
      log(
        `mizzen watch: cannot watch ${label} at ${dir}: ${err instanceof Error ? err.message : String(err)}; retrying in ${Math.round(maxMs)} ms`,
      );
      scheduleRetry();
      return false;
    }
  };

  // Reattaches any root whose watcher failed or whose first attach could not open. A failed attach retries itself.
  // Returns the labels opened by this call, so a retry can rebuild for a root that came back.
  const ensureWatched = (): string[] => {
    if (closing) return [];
    const opened: string[] = [];
    for (const watchRoot of roots) {
      if (watchers.has(watchRoot.dir)) continue;
      if (watchTree(watchRoot.dir, watchRoot.label)) opened.push(watchRoot.label);
    }
    return opened;
  };

  try {
    await buildOnce("initial build");
  } catch (err) {
    log(`mizzen watch: initial build failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  ensureWatched();

  const stop = (): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    closing = true;
    shuttingDown = (async () => {
      if (retryTimer !== undefined) {
        timers.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      for (const { handle } of watchers.values()) handle.close();
      watchers.clear();
      await scheduler.stop();
      log("mizzen watch: stopped");
      resolveClosed();
    })();
    return shuttingDown;
  };

  return {
    out,
    closed,
    rebuild: (reason = "rebuild") => scheduler.request(reason),
    stop,
  };
}

/** The default output folder of a site under watch: `<root>/.mizzen/watch`. */
export function watchOutOf(root: string): string {
  return join(resolve(root), DEFAULT_WATCH_OUT);
}
