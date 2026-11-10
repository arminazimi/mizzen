/**
 * Runs one recorded Node or TypeScript example in a child process (#1461).
 *
 * The snippet is written into a fresh `mkdtemp` folder, beside a `package.json` for `js` and `mjs` (so both are ES
 * modules), and run by `process.execPath` with that folder as the working directory. `ts` relies on Node's native type
 * stripping, so a TypeScript example must use erasable syntax only. `HOME` and `TMPDIR` point inside the same folder,
 * and the folder is removed before {@link runNodeExample} returns, whether the example passed, failed, or timed out.
 *
 * **This is a process sandbox, not an OS sandbox.** The temp folder, the scrubbed environment, and the process group
 * limit what an example starts with. The example still runs with the same user and file permissions as the engine, so
 * it can read or write any path it names by absolute path, use the network, or leave the process group and outlive a
 * timeout. The promise is a clean start, a bounded run, and no leftover temp folder — not isolation from the host.
 * Examples come from the site being built and are treated as trusted input.
 *
 * The only ambient input is the environment, which the issue requires: `PATH` is inherited so an example that runs a
 * command works, `LANG` is fixed to `C.UTF-8` and `NO_COLOR` to `1` so output does not depend on the caller's locale or
 * terminal, and everything else in `process.env` is dropped. The duration is measured with a monotonic clock, because
 * the result reports it. No other clock or environment value is read.
 *
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

/** The languages an example may be written in. */
export type ExampleLang = "js" | "mjs" | "ts";

/** What {@link runNodeExample} runs. */
export interface RunNodeExampleOptions {
  /** The snippet, written into the temp folder as a whole file. */
  readonly code: string;
  /** How the snippet is treated: an ES module (`js`, `mjs`) or a TypeScript file run through type stripping (`ts`). */
  readonly lang: ExampleLang;
  /**
   * How long the example may run, in milliseconds. Default: {@link DEFAULT_TIMEOUT_MS}. On expiry the whole process
   * group is killed with `SIGKILL` and the result says `timedOut`.
   */
  readonly timeoutMs?: number;
  /**
   * Extra environment variables for the example. They are added to the scrubbed environment; they cannot move
   * `HOME`, `TMPDIR`, `PATH`, `LANG`, or `NO_COLOR`, which are always set by the runner.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The folder to create the temp folder in. Default: the operating system's temp folder. The example always runs in
   * a new folder inside it; the caller's folder is never the working directory.
   */
  readonly cwd?: string;
}

/** What an example did. */
export interface NodeExampleResult {
  /** True only when the example exited on its own with code 0. */
  readonly ok: boolean;
  /** The exit code; `null` when the example timed out or could not be started. */
  readonly exitCode: number | null;
  /** Standard output, UTF-8, cut at {@link MAX_OUTPUT_BYTES} with a marker when it was longer. */
  readonly stdout: string;
  /** Standard error, UTF-8, cut at {@link MAX_OUTPUT_BYTES} with a marker when it was longer. */
  readonly stderr: string;
  /** Wall time from spawn to close, in milliseconds. */
  readonly durationMs: number;
  /** True when {@link RunNodeExampleOptions.timeoutMs} expired and the process group was killed. */
  readonly timedOut: boolean;
}

/** How long an example runs when the caller names no limit. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** How many bytes of each stream are kept. Output past this is dropped, so one noisy example cannot fill memory. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Appended to a stream that was cut at {@link MAX_OUTPUT_BYTES}. */
const TRUNCATION_MARKER = "\n[output truncated]\n";

/** The file each language is written to. */
const FILE_BY_LANG: Readonly<Record<ExampleLang, string>> = {
  js: "main.js",
  mjs: "main.mjs",
  ts: "main.ts",
};

/** A byte stream captured up to a fixed budget. */
interface Collector {
  readonly push: (chunk: Buffer) => void;
  readonly text: () => string;
}

/** Collects bytes until {@link MAX_OUTPUT_BYTES}, then drops the rest and remembers that it did. */
function collector(): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const room = MAX_OUTPUT_BYTES - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = MAX_OUTPUT_BYTES;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    },
    text() {
      const body = Buffer.concat(chunks, size).toString("utf8");
      return truncated ? body + TRUNCATION_MARKER : body;
    },
  };
}

/** Kills the child's whole process group, so a command the example started dies with it. */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // The group is already gone, or the child never started. Either way there is nothing left to kill.
  }
}

/** Waits for the child to close, killing the group when the timeout expires. */
function waitFor(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ readonly exitCode: number | null; readonly timedOut: boolean; readonly spawnError: Error | undefined }> {
  return new Promise((resolve) => {
    let timedOut = false;
    let spawnError: Error | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, spawnError });
    });
  });
}

/** The scrubbed environment of an example: the five fixed values, then whatever the caller added. */
function environment(root: string, extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  return {
    ...extra,
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    LANG: "C.UTF-8",
    NO_COLOR: "1",
  };
}

/**
 * Runs one example and reports what happened. A failing, noisy, or hanging example is a result, not an exception: the
 * only errors thrown are for a caller's mistake (an unknown language or an unusable timeout).
 */
export async function runNodeExample(options: RunNodeExampleOptions): Promise<NodeExampleResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number of milliseconds, not ${String(timeoutMs)}.`);
  }
  const file = FILE_BY_LANG[options.lang];
  if (file === undefined) {
    throw new TypeError(`Unknown example language "${String(options.lang)}"; use "js", "mjs", or "ts".`);
  }

  // `realpath` makes the folder canonical, so `process.cwd()` in the example equals the path the runner set as HOME.
  const root = await realpath(await mkdtemp(join(options.cwd ?? tmpdir(), "mizzen-example-")));
  const stdout = collector();
  const stderr = collector();
  const startedAt = performance.now();
  let result: Omit<NodeExampleResult, "durationMs" | "stdout" | "stderr">;

  try {
    await Promise.all([
      mkdir(join(root, "home"), { recursive: true }),
      mkdir(join(root, "tmp"), { recursive: true }),
      writeFile(join(root, file), options.code),
      writeFile(join(root, "package.json"), '{\n  "type": "module"\n}\n'),
    ]);

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [file], {
        cwd: root,
        env: environment(root, options.env),
        stdio: ["ignore", "pipe", "pipe"],
        // A new process group lets the timeout kill a command the example started, not just the example itself.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: `${detail}\n`,
        durationMs: performance.now() - startedAt,
        timedOut: false,
      };
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    const waited = await waitFor(child, timeoutMs);
    if (waited.spawnError !== undefined) stderr.push(Buffer.from(`${waited.spawnError.message}\n`));
    result = {
      ok: waited.exitCode === 0 && !waited.timedOut && waited.spawnError === undefined,
      exitCode: waited.exitCode,
      timedOut: waited.timedOut,
    };
    return {
      ...result,
      stdout: stdout.text(),
      stderr: stderr.text(),
      durationMs: performance.now() - startedAt,
    };
  } finally {
    // Cleanup is best effort: an example that made its folder unreadable must not turn a result into a throw.
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
