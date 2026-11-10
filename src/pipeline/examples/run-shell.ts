/**
 * Runs one shell example in a throwaway folder with a scrubbed environment (#1462).
 *
 * The unit is the shell counterpart of the Node example runner (N02). A caller hands it the code of a `bash` or `sh`
 * snippet and gets back what the snippet printed, its exit code, how long it took, and whether it ran inside an OS
 * sandbox. It never throws for a failing example: a non-zero exit, a timeout, or a snippet that cannot even start is a
 * result, not an exception.
 *
 * ## Isolation
 *
 * - The working folder is a fresh `mkdtemp` folder, removed when the run ends. `HOME` and `TMPDIR` point inside it.
 *   The environment is an allow-list: `PATH`, `HOME`, `TMPDIR`, `LANG`, and `NO_COLOR`. Everything else from the
 *   host, including secrets, is dropped. {@link RunShellOptions.env} adds variables explicitly, which is the only way
 *   to pass anything else in.
 * - Where the OS offers one, writes are confined to the working folder: `sandbox-exec` on macOS (a profile that allows
 *   everything except writes outside the folder) and `bwrap` on Linux (`/` read-only, the working folder writable).
 *   {@link ShellExampleResult.sandboxed} says whether that happened.
 *
 * ## Honesty about isolation
 *
 * Without a sandbox, the working folder and the scrubbed environment are advice, not a boundary: a snippet can still
 * `rm` a path outside the folder, read the real home directory, and reach the network. That is why the result carries
 * `sandboxed` and why the "`rm` cannot reach outside" test skips when {@link sandboxAvailable} is false. A caller that
 * needs the guarantee must check the flag; this unit never claims a guarantee it did not get.
 *
 * ## Determinism
 *
 * The result depends on the host: `PATH` and `LANG` come from the process, and the duration is wall-clock time. Both
 * are documented rather than hidden; the exit code, stdout, and stderr are whatever the snippet chose to emit.
 *
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Timeout used when the caller gives none. */
export const DEFAULT_SHELL_TIMEOUT_MS = 10_000;

/** What {@link runShellExample} needs. */
export interface RunShellOptions {
  /** The snippet, passed to the shell as the argument of `-c`. It is not interpolated into a command line. */
  readonly code: string;
  /** The shell to run it with: `/bin/bash` or `/bin/sh`. */
  readonly shell: "bash" | "sh";
  /** Milliseconds before the process group is killed. Defaults to {@link DEFAULT_SHELL_TIMEOUT_MS}; values below one are ignored. */
  readonly timeoutMs?: number;
  /**
   * Extra variables to add after scrubbing. This is the only way a caller passes an environment variable in; nothing
   * is inherited from the host beyond the allow-list.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Folder to run in. Default: a new temporary folder that is removed afterwards. A folder the caller names is kept;
   * only the `.mizzen-home` and `.mizzen-tmp` folders created inside it are removed.
   */
  readonly cwd?: string;
}

/** What one example produced. */
export interface ShellExampleResult {
  /** Everything the snippet wrote to stdout, decoded as UTF-8. */
  readonly stdout: string;
  /** Everything the snippet wrote to stderr, decoded as UTF-8. */
  readonly stderr: string;
  /** The exit code, or `null` when the process was killed (a timeout, for example). */
  readonly exitCode: number | null;
  /** Wall-clock milliseconds from just before the shell started to its close. */
  readonly durationMs: number;
  /** True when the timeout fired and the process group was killed. */
  readonly timedOut: boolean;
  /** True when the run went through the OS sandbox. When false, isolation is the folder and environment only. */
  readonly sandboxed: boolean;
  /** The absolute folder the snippet ran in. It no longer exists when the caller gave no `cwd`. */
  readonly workdir: string;
}

/** The command and arguments of one run, once the sandbox decision is made. */
interface RunPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly sandboxed: boolean;
}

/** The raw outcome of one spawned process. */
interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The message of an unknown error, for a result rather than a throw. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `command` starts and exits zero. Used only to probe an optional tool. */
function canRun(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 5_000 });
  return !result.error && result.status === 0;
}

/**
 * True when this host has an OS sandbox this unit can use: `sandbox-exec` on macOS, `bwrap` on Linux.
 *
 * The probe runs the tool once, so a host that has the binary but forbids the sandbox reports false and the run falls
 * back to folder-and-environment isolation. Tests use it to skip the escape test instead of assuming a sandbox.
 */
export function sandboxAvailable(): boolean {
  if (process.platform === "darwin") {
    return canRun("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/bin/sh", "-c", "true"]);
  }
  if (process.platform === "linux") {
    // A real launch, not just `--version`: a host may have bwrap but forbid the user namespaces it needs.
    return canRun("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/sh", "-c", "true"]);
  }
  return false;
}

/** The shell binary, falling back to a bare name when the absolute path is not there (a minimal Linux image). */
function shellPath(shell: "bash" | "sh"): string {
  const absolute = shell === "bash" ? "/bin/bash" : "/bin/sh";
  return existsSync(absolute) ? absolute : shell;
}

/** Quotes one path for an SBPL string. The paths here come from `mkdtemp`, never from user input. */
function sbplPath(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** The macOS profile: allow everything, then deny every write and allow it back inside the working folder. */
function sandboxProfile(workdirs: readonly string[]): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)", '(allow file-write* (literal "/dev/null"))'];
  for (const dir of [...workdirs].sort(byCodePoint)) {
    lines.push(`(allow file-write* (subpath "${sbplPath(dir)}"))`);
  }
  return `${lines.join("\n")}\n`;
}

/** The scrubbed environment: the allow-list, `HOME`/`TMPDIR` inside the working folder, then the caller's extras. */
function scrubbedEnv(workdir: string, extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(workdir, ".mizzen-home"),
    TMPDIR: join(workdir, ".mizzen-tmp"),
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
  };
  return { ...env, ...extra };
}

/** Kills the process group led by `pid`, falling back to the process itself. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process is already gone; `close` will settle the run.
    }
  }
}

/** Spawns one process, collects both streams, and settles once, however it ends. */
function runProcess(plan: RunPlan, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((settle) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ stdout, stderr, exitCode, timedOut });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = spawn(plan.command, [...plan.args], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid);
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        stderr += `${messageOf(error)}\n`;
        finish(null);
      });
      child.once("close", (code) => {
        finish(code);
      });
    } catch (error) {
      stderr += `${messageOf(error)}\n`;
      finish(null);
    }
  });
}

/** A result for a run that never started. */
function failed(started: number, message: string, sandboxed: boolean, workdir: string): ShellExampleResult {
  return {
    stdout: "",
    stderr: `${message}\n`,
    exitCode: null,
    durationMs: performance.now() - started,
    timedOut: false,
    sandboxed,
    workdir,
  };
}

/**
 * Runs one shell example and reports what happened.
 *
 * The returned promise never rejects for a failing example: a shell that is missing, a folder that cannot be created,
 * a non-zero exit, and a timeout are all plain results. Only a defect in this unit would reject, and there is no code
 * path that does.
 */
export async function runShellExample(options: RunShellOptions): Promise<ShellExampleResult> {
  const started = performance.now();
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1
      ? options.timeoutMs
      : DEFAULT_SHELL_TIMEOUT_MS;

  let workspace: string | undefined;
  let profileDir: string | undefined;
  const internalDirs: string[] = [];
  let sandboxed = false;
  let workdir = options.cwd === undefined ? "" : resolve(options.cwd);
  let plan: RunPlan = { command: "", args: [], sandboxed: false };

  try {
    if (options.cwd === undefined) {
      workspace = await mkdtemp(join(tmpdir(), "mizzen-example-"));
      workdir = workspace;
    }
    await mkdir(workdir, { recursive: true });

    // The home and temp folders live inside the run's folder, so a snippet cannot write to the real ones even
    // without an OS sandbox.
    const home = join(workdir, ".mizzen-home");
    const temp = join(workdir, ".mizzen-tmp");
    internalDirs.push(home, temp);
    await mkdir(home, { recursive: true });
    await mkdir(temp, { recursive: true });

    const shell = shellPath(options.shell);
    if (sandboxAvailable()) {
      sandboxed = true;
      if (process.platform === "darwin") {
        profileDir = await mkdtemp(join(tmpdir(), "mizzen-sandbox-"));
        const profile = join(profileDir, "profile.sb");
        const canonical = await realpath(workdir);
        const dirs = canonical === workdir ? [workdir] : [workdir, canonical];
        await writeFile(profile, sandboxProfile(dirs));
        plan = { command: "/usr/bin/sandbox-exec", args: ["-f", profile, shell, "-c", options.code], sandboxed };
      } else {
        plan = {
          command: "bwrap",
          args: [
            "--ro-bind",
            "/",
            "/",
            "--bind",
            workdir,
            workdir,
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--chdir",
            workdir,
            "--die-with-parent",
            shell,
            "-c",
            options.code,
          ],
          sandboxed,
        };
      }
    } else {
      plan = { command: shell, args: ["-c", options.code], sandboxed: false };
    }

    const runStarted = performance.now();
    const result = await runProcess(plan, workdir, scrubbedEnv(workdir, options.env), timeoutMs);
    return {
      ...result,
      durationMs: performance.now() - runStarted,
      sandboxed: plan.sandboxed,
      workdir,
    };
  } catch (error) {
    return failed(started, messageOf(error), plan.sandboxed, workdir);
  } finally {
    // Clean up whatever ran, and whatever failed before it could. Nothing here may throw over a result.
    if (profileDir !== undefined) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
    for (const dir of internalDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
