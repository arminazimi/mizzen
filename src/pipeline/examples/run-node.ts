/**
 * Runs one recorded Node or TypeScript example in a child process (#1461).
 *
 * The snippet is written into a fresh `mkdtemp` folder, beside a `package.json` for `js` and `mjs` (so both are ES
 * modules), and run by `process.execPath` with that folder as the working directory. `ts` relies on Node's native type
 * stripping, so a TypeScript example must use erasable syntax only. `HOME` and `TMPDIR` point inside the same folder,
 * and the folder is removed before {@link runNodeExample} returns, whether the example passed, failed, or timed out.
 *
 * ## Isolation
 *
 * The environment is an allow-list — `PATH`, `HOME`, `TMPDIR`, `LANG=C.UTF-8`, `NO_COLOR=1`, plus whatever the caller
 * passes in `env` — so the engine's secrets never reach the example. A snippet that invokes a command in
 * {@link DENIED_COMMANDS} is refused before the folder is created. Where the host offers an OS sandbox,
 * {@link planSandbox} confines writes to the working folder; {@link NodeExampleResult.sandboxed} says whether that
 * happened.
 *
 * **Without an OS sandbox this is a process sandbox, not isolation.** The temp folder, the scrubbed environment, the
 * timeout, and the process group limit what an example starts with, but the example runs with the same user and file
 * permissions as the engine: an absolute path, the network, or a process that leaves the group is still reachable when
 * `sandboxed` is false. Examples come from the site being built and are otherwise treated as trusted input.
 *
 * Only {@link MAX_OUTPUT_BYTES} of each stream is kept; past that the process group is killed, so a runaway example
 * cannot fill memory. The duration is measured with a monotonic clock, because the result reports it.
 *
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { deniedCommand, planSandbox, type SandboxPlan } from "./run-shell.ts";

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
  /** The exit code; `null` when the example timed out, was refused, or could not be started. */
  readonly exitCode: number | null;
  /** Standard output, UTF-8, cut at {@link MAX_OUTPUT_BYTES} with a marker when it was longer. */
  readonly stdout: string;
  /** Standard error, UTF-8, cut at {@link MAX_OUTPUT_BYTES} with a marker when it was longer. */
  readonly stderr: string;
  /** Wall time from spawn to close, in milliseconds. */
  readonly durationMs: number;
  /** True when {@link RunNodeExampleOptions.timeoutMs} expired and the process group was killed. */
  readonly timedOut: boolean;
  /** True when a stream hit {@link MAX_OUTPUT_BYTES} and the process group was killed for it. */
  readonly outputLimited: boolean;
  /** True when the snippet was refused before anything ran. {@link stderr} says why. */
  readonly rejected: boolean;
  /** True when the run went through the OS sandbox. When false, only the process sandbox applies. */
  readonly sandboxed: boolean;
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
  /** True once the budget is spent, so the caller can stop the process. */
  readonly full: () => boolean;
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
    full() {
      return truncated;
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

/** What one child process did, independent of what it printed. */
interface ProcessOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
  readonly spawnError: Error | undefined;
}

/**
 * Spawns the example, collects both streams, and kills the process group on a timeout or when either stream spends
 * its output budget. The kill is the point: a limit that only stops reading still leaves a runaway example running.
 */
function runChild(
  plan: SandboxPlan,
  root: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdout: Collector,
  stderr: Collector,
): Promise<ProcessOutcome> {
  return new Promise((settle) => {
    let timedOut = false;
    let outputLimited = false;
    let spawnError: Error | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ exitCode, timedOut, outputLimited, spawnError });
    };
    try {
      child = spawn(plan.command, [...plan.args], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // A new process group lets the timeout kill a command the example started, not just the example itself.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      spawnError = error instanceof Error ? error : new Error(String(error));
      finish(null);
      return;
    }
    const stop = (reason: "timeout" | "output"): void => {
      if (settled || timedOut || outputLimited) return;
      if (reason === "timeout") timedOut = true;
      else outputLimited = true;
      // The kill settles the run; clearing the timer keeps a late timeout from claiming a limit kill.
      clearTimeout(timer);
      killGroup(child);
    };
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      if (stdout.full()) stop("output");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (stderr.full()) stop("output");
    });
    child.once("error", (error) => {
      spawnError = error;
      finish(null);
    });
    child.once("close", (code) => {
      finish(code);
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
 * Runs one example and reports what happened. A failing, noisy, refused, or hanging example is a result, not an
 * exception: the only errors thrown are for a caller's mistake (an unknown language or an unusable timeout).
 */
export async function runNodeExample(options: RunNodeExampleOptions): Promise<NodeExampleResult> {
  const startedAt = performance.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number of milliseconds, not ${String(timeoutMs)}.`);
  }
  const file = FILE_BY_LANG[options.lang];
  if (file === undefined) {
    throw new TypeError(`Unknown example language "${String(options.lang)}"; use "js", "mjs", or "ts".`);
  }

  // Refused before the temp folder exists, so a denied snippet leaves nothing behind.
  const denied = deniedCommand(options.code, "node");
  if (denied !== undefined) {
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: `The example was not run: it uses the denied command "${denied}".\n`,
      durationMs: performance.now() - startedAt,
      timedOut: false,
      outputLimited: false,
      rejected: true,
      sandboxed: false,
    };
  }

  // `realpath` makes the folder canonical, so `process.cwd()` in the example equals the path the runner set as HOME.
  const root = await realpath(await mkdtemp(join(options.cwd ?? tmpdir(), "mizzen-example-")));
  const stdout = collector();
  const stderr = collector();
  let plan: SandboxPlan = { command: "", args: [], sandboxed: false, cleanup: async () => {} };

  try {
    await Promise.all([
      mkdir(join(root, "home"), { recursive: true }),
      mkdir(join(root, "tmp"), { recursive: true }),
      writeFile(join(root, file), options.code),
      writeFile(join(root, "package.json"), '{\n  "type": "module"\n}\n'),
    ]);

    plan = await planSandbox(process.execPath, [file], root);
    const outcome = await runChild(plan, root, environment(root, options.env), timeoutMs, stdout, stderr);
    if (outcome.spawnError !== undefined) stderr.push(Buffer.from(`${outcome.spawnError.message}\n`));
    return {
      ok: outcome.exitCode === 0 && !outcome.timedOut && !outcome.outputLimited && outcome.spawnError === undefined,
      exitCode: outcome.exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      durationMs: performance.now() - startedAt,
      timedOut: outcome.timedOut,
      outputLimited: outcome.outputLimited,
      rejected: false,
      sandboxed: plan.sandboxed,
    };
  } finally {
    // Cleanup is best effort: an example that made its folder unreadable must not turn a result into a throw.
    await plan.cleanup();
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
