/**
 * Runs one shell example in a throwaway folder with a scrubbed environment (#1462).
 *
 * The unit is the shell counterpart of the Node example runner (N02). A caller hands it the code of a `bash` or `sh`
 * snippet and gets back what the snippet printed, its exit code, how long it took, and whether it ran inside an OS
 * sandbox. It never throws for a failing example: a non-zero exit, a timeout, an output flood, or a snippet that cannot
 * even start is a result, not an exception.
 *
 * ## Isolation
 *
 * - The working folder is a fresh `mkdtemp` folder when the caller gives no {@link RunShellOptions.cwd}; with one,
 *   the caller's folder is the working folder and is kept. Either way the run creates its own private
 *   `.mizzen-run-*` folder inside the working folder and points `HOME` and `TMPDIR` at folders inside it, so they
 *   are always run-owned and never a folder the caller already had.
 *   The environment is an allow-list: `PATH`, `HOME`, `TMPDIR`, `LANG`, and `NO_COLOR`. Everything else from the
 *   host, including secrets, is dropped. {@link RunShellOptions.env} adds variables explicitly, which is the only way
 *   to pass anything else in; the fixed variables win, so an extra cannot move `HOME` out of the folder.
 * - Where the OS offers one, writes are confined to the working folder: `sandbox-exec` on macOS (a profile that allows
 *   everything except writes outside the folder) and `bwrap` on Linux (`/` read-only, the working folder writable).
 *   {@link ShellExampleResult.sandboxed} says whether that happened.
 * - A snippet that invokes a command in {@link DENIED_COMMANDS} is refused before anything is created or spawned.
 * - Cleanup is non-destructive to the caller (#100): only folders this run created are removed — the private
 *   `.mizzen-run-*` folder, and the whole throwaway workspace when the run made it. A folder that already existed in
 *   a caller-supplied `cwd`, including a `.mizzen-home` or `.mizzen-tmp` of the caller's own, is never removed.
 * - Only {@link MAX_SHELL_OUTPUT_BYTES} of each stream is kept; past that the process group is killed, so a runaway
 *   example cannot fill memory or a terminal.
 *
 * ## Honesty about isolation
 *
 * Without a sandbox, the working folder and the scrubbed environment are advice, not a boundary: a snippet can still
 * `rm` a path outside the folder, read the real home directory, and reach the network. That is why the result carries
 * `sandboxed` and why the "`rm` cannot reach outside" test skips when {@link sandboxAvailable} is false. A caller that
 * needs the guarantee must check the flag; this unit never claims a guarantee it did not get.
 *
 * ## Shared policy
 *
 * {@link sandboxAvailable}, {@link planSandbox}, {@link DENIED_COMMANDS}, and {@link deniedCommand} are also used by
 * the Node example runner, so both runners apply one isolation policy instead of two drifting ones.
 *
 * ## Determinism
 *
 * The result depends on the host: `PATH` and `LANG` come from the process, and the duration is wall-clock time. Both
 * are documented rather than hidden; the exit code, stdout, and stderr are whatever the snippet chose to emit.
 *
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Timeout used when the caller gives none. */
export const DEFAULT_SHELL_TIMEOUT_MS = 10_000;

/** How many bytes of each stream are kept before the run is killed. */
export const MAX_SHELL_OUTPUT_BYTES = 64 * 1024;

/** Appended to a stream that was cut at {@link MAX_SHELL_OUTPUT_BYTES}. */
const TRUNCATION_MARKER = "\n[output truncated]\n";

/**
 * Commands that act on the host rather than on the working folder. A snippet that invokes one as a command is refused
 * before it runs, so the refusal has no side effects.
 */
export const DENIED_COMMANDS: readonly string[] = [
  "sudo",
  "su",
  "doas",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "mkfs",
  "fdisk",
  "diskutil",
  "mount",
  "umount",
  "launchctl",
  "systemctl",
  "crontab",
  "killall",
  "pkill",
];

/** {@link DENIED_COMMANDS} as a set, for exact token lookup. */
const DENIED = new Set(DENIED_COMMANDS);

/** Words that keep the next word in command position: `if sudo …`, `then sudo …`, `env sudo …`. */
const SHELL_KEYWORDS = new Set([
  "!",
  "case",
  "command",
  "do",
  "done",
  "elif",
  "else",
  "env",
  "esac",
  "exec",
  "fi",
  "for",
  "if",
  "in",
  "nohup",
  "then",
  "time",
  "until",
  "while",
  "xargs",
]);

/** Characters that end one shell command and start the next. */
const SHELL_OPERATORS = new Set([";", "\n", "\r", "&", "|", "(", ")", "{", "}"]);

/** Calls that pass a command line or an executable name as their first argument. */
const COMMAND_CALL = /\b(?:exec|execFile|execFileSync|execSync|fork|spawn|spawnSync)\s*\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

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
   * is inherited from the host beyond the allow-list, and an extra cannot override `PATH`, `HOME`, `TMPDIR`, `LANG`,
   * or `NO_COLOR`.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Folder to run in. Default: a new temporary folder that is removed afterwards. A folder the caller names is kept;
   * the run cleans up only the private `.mizzen-run-*` folder it creates inside it, never a folder that already
   * existed there — a pre-existing `.mizzen-home` or `.mizzen-tmp` of the caller's is left untouched (#100).
   */
  readonly cwd?: string;
}

/** What one example produced. */
export interface ShellExampleResult {
  /** Everything the snippet wrote to stdout, decoded as UTF-8, cut at {@link MAX_SHELL_OUTPUT_BYTES}. */
  readonly stdout: string;
  /** Everything the snippet wrote to stderr, decoded as UTF-8, cut at {@link MAX_SHELL_OUTPUT_BYTES}. */
  readonly stderr: string;
  /** The exit code, or `null` when the process was killed or the snippet was refused. */
  readonly exitCode: number | null;
  /** Wall-clock milliseconds from just before the shell started to its close. */
  readonly durationMs: number;
  /** True when the timeout fired and the process group was killed. */
  readonly timedOut: boolean;
  /** True when a stream hit {@link MAX_SHELL_OUTPUT_BYTES} and the process group was killed for it. */
  readonly outputLimited: boolean;
  /** True when the snippet was refused before anything ran. {@link stderr} says why. */
  readonly rejected: boolean;
  /** True when the run went through the OS sandbox. When false, isolation is the folder and environment only. */
  readonly sandboxed: boolean;
  /** The absolute folder the snippet ran in. Empty when the snippet was refused and nothing was created. */
  readonly workdir: string;
}

/** A command line with the OS sandbox applied when this host has one. */
export interface SandboxPlan {
  /** The executable to spawn. */
  readonly command: string;
  /** Its arguments. */
  readonly args: readonly string[];
  /** True when the plan confines writes to the working folder. */
  readonly sandboxed: boolean;
  /** Removes the temporary profile a macOS plan writes. Total: it never throws. */
  readonly cleanup: () => Promise<void>;
}

/** The raw outcome of one spawned process. */
interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputLimited: boolean;
}

/** A byte stream captured up to a fixed budget. */
interface Collector {
  readonly push: (chunk: Buffer) => void;
  readonly text: () => string;
  /** True once the budget is spent, so the caller can stop the process. */
  readonly full: () => boolean;
}

/** Compares by code point, never by locale. */
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

/** The index just past the quoted literal starting at `start`. An unclosed literal ends at the end of the code. */
function endOfString(code: string, start: number): number {
  const quote = code[start];
  let i = start + 1;
  while (i < code.length) {
    if (code[i] === "\\") i += 2;
    else if (code[i] === quote) return i + 1;
    else i += 1;
  }
  return code.length;
}

/** Node comments become spaces, so a commented-out `execSync("sudo …")` is not a call. Strings are kept. */
function withoutNodeComments(code: string): string {
  let result = "";
  for (let i = 0; i < code.length; ) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = endOfString(code, i);
      result += code.slice(i, end);
      i = end;
    } else if (ch === "/" && code[i + 1] === "/") {
      const newline = code.indexOf("\n", i);
      const end = newline === -1 ? code.length : newline;
      result += " ".repeat(end - i);
      i = end;
    } else if (ch === "/" && code[i + 1] === "*") {
      const close = code.indexOf("*/", i + 2);
      const end = close === -1 ? code.length : close + 2;
      result += code.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      result += ch;
      i += 1;
    }
  }
  return result;
}

/** Shell comments and quoted words become spaces, so only unquoted words that can be a command remain. */
function shellCommandWords(code: string): string {
  let result = "";
  for (let i = 0; i < code.length; ) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = endOfString(code, i);
      result += " ".repeat(end - i);
      i = end;
      continue;
    }
    const atWordStart = i === 0 || /[\s;&|()]/.test(code[i - 1]!);
    if (ch === "#" && atWordStart) {
      const newline = code.indexOf("\n", i);
      const end = newline === -1 ? code.length : newline;
      result += " ".repeat(end - i);
      i = end;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

/** The first denied command that `code` invokes, or `undefined`. A word in an argument or a comment is not a command. */
function deniedShellCommand(code: string): string | undefined {
  let atCommandStart = true;
  let word = "";
  const check = (): string | undefined => {
    if (word === "") return undefined;
    const token = word;
    word = "";
    if (!atCommandStart) return undefined;
    // Assignments and keywords leave the command itself in the next word.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || SHELL_KEYWORDS.has(token)) return undefined;
    atCommandStart = false;
    const name = token.slice(token.lastIndexOf("/") + 1);
    return DENIED.has(name) ? name : undefined;
  };
  for (const ch of shellCommandWords(code)) {
    if (SHELL_OPERATORS.has(ch)) {
      const found = check();
      if (found !== undefined) return found;
      atCommandStart = true;
    } else if (/\s/.test(ch)) {
      const found = check();
      if (found !== undefined) return found;
    } else {
      word += ch;
    }
  }
  return check();
}

/**
 * The first denied command `code` invokes, or `undefined`.
 *
 * This is a static guard for mistakes, not a security boundary: quoting (`s'u'do`), an alias, or a variable hides a
 * command from it. The OS sandbox and the file permissions are the boundary. A shell snippet is read as command words,
 * so a comment or an argument that merely contains `sudo` is allowed. A Node snippet is read for the first argument of
 * the calls that spawn a command, so `console.log("sudo")` runs while `execSync("sudo …")` does not. It is shared by
 * both runners so a shell snippet and a Node snippet that spawn the same command get the same answer.
 */
export function deniedCommand(code: string, language: "node" | "shell"): string | undefined {
  if (language === "shell") return deniedShellCommand(code);
  for (const match of withoutNodeComments(code).matchAll(COMMAND_CALL)) {
    const found = deniedShellCommand(match[2]!);
    if (found !== undefined) return found;
  }
  return undefined;
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

/**
 * The command line that runs `command` with `args` confined to `workdir`, or the plain command when the host has no
 * sandbox. Reads are never confined; writes are. {@link SandboxPlan.sandboxed} says which of the two happened.
 *
 * The plan owns the temporary macOS profile, so the caller must await {@link SandboxPlan.cleanup} however the run ends.
 */
export async function planSandbox(
  command: string,
  args: readonly string[],
  workdir: string,
): Promise<SandboxPlan> {
  if (!sandboxAvailable()) {
    return { command, args, sandboxed: false, cleanup: async () => {} };
  }
  if (process.platform === "darwin") {
    const profileDir = await mkdtemp(join(tmpdir(), "mizzen-sandbox-"));
    const cleanup = async (): Promise<void> => {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    };
    try {
      const profile = join(profileDir, "profile.sb");
      const canonical = await realpath(workdir);
      const dirs = canonical === workdir ? [workdir] : [workdir, canonical];
      await writeFile(profile, sandboxProfile(dirs));
      return { command: "/usr/bin/sandbox-exec", args: ["-f", profile, command, ...args], sandboxed: true, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  return {
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
      command,
      ...args,
    ],
    sandboxed: true,
    cleanup: async () => {},
  };
}

/**
 * The scrubbed environment: the allow-list, `HOME`/`TMPDIR` inside the run's private folder, then the caller's
 * extras, then the fixed values again so an extra cannot move the confinement variables.
 */
function scrubbedEnv(runRoot: string, extra?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...extra,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: join(runRoot, "home"),
    TMPDIR: join(runRoot, "tmp"),
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
  };
}

/** Collects bytes until `budget`, then drops the rest and remembers that it did. */
function collector(budget: number): Collector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      const room = budget - size;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        size = budget;
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
function runProcess(plan: SandboxPlan, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((settle) => {
    const stdout = collector(MAX_SHELL_OUTPUT_BYTES);
    const stderr = collector(MAX_SHELL_OUTPUT_BYTES);
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle({ stdout: stdout.text(), stderr: stderr.text(), exitCode, timedOut, outputLimited });
    };
    try {
      child = spawn(plan.command, [...plan.args], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr.push(Buffer.from(`${messageOf(error)}\n`));
      finish(null);
      return;
    }
    const stop = (reason: "timeout" | "output"): void => {
      if (settled || timedOut || outputLimited) return;
      if (reason === "timeout") timedOut = true;
      else outputLimited = true;
      // The kill settles the run; clearing the timer keeps a late timeout from claiming a limit kill.
      clearTimeout(timer);
      killGroup(child.pid);
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
      stderr.push(Buffer.from(`${messageOf(error)}\n`));
      finish(null);
    });
    child.once("close", (code) => {
      finish(code);
    });
  });
}

/** A result for a run that never started. */
function failed(
  started: number,
  message: string,
  sandboxed: boolean,
  workdir: string,
): ShellExampleResult {
  return {
    stdout: "",
    stderr: `${message}\n`,
    exitCode: null,
    durationMs: performance.now() - started,
    timedOut: false,
    outputLimited: false,
    rejected: false,
    sandboxed,
    workdir,
  };
}

/** A result for a snippet refused before anything was created or spawned. */
function refused(started: number, command: string, cwd: string | undefined): ShellExampleResult {
  return {
    stdout: "",
    stderr: `The example was not run: it uses the denied command "${command}".\n`,
    exitCode: null,
    durationMs: performance.now() - started,
    timedOut: false,
    outputLimited: false,
    rejected: true,
    sandboxed: false,
    workdir: cwd === undefined ? "" : resolve(cwd),
  };
}

/**
 * Runs one shell example and reports what happened.
 *
 * The returned promise never rejects for a failing example: a shell that is missing, a folder that cannot be created,
 * a non-zero exit, a refused command, an output flood, and a timeout are all plain results. Only a defect in this unit
 * would reject, and there is no code path that does.
 */
export async function runShellExample(options: RunShellOptions): Promise<ShellExampleResult> {
  const started = performance.now();
  const timeoutMs =
    options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 1
      ? options.timeoutMs
      : DEFAULT_SHELL_TIMEOUT_MS;

  // Refused before the working folder exists, so a denied snippet leaves nothing behind.
  const denied = deniedCommand(options.code, "shell");
  if (denied !== undefined) return refused(started, denied, options.cwd);

  let workspace: string | undefined;
  let runRoot: string | undefined;
  let plan: SandboxPlan = { command: "", args: [], sandboxed: false, cleanup: async () => {} };
  let workdir = options.cwd === undefined ? "" : resolve(options.cwd);

  try {
    if (options.cwd === undefined) {
      workspace = await mkdtemp(join(tmpdir(), "mizzen-example-"));
      workdir = workspace;
    }
    await mkdir(workdir, { recursive: true });

    // The home and temp folders live inside a private folder this run created, so a snippet cannot write to the real
    // ones even without an OS sandbox, and cleanup can never remove a folder the caller already owned (#100).
    runRoot = await mkdtemp(join(workdir, ".mizzen-run-"));
    await mkdir(join(runRoot, "home"), { recursive: true });
    await mkdir(join(runRoot, "tmp"), { recursive: true });

    plan = await planSandbox(shellPath(options.shell), ["-c", options.code], workdir);

    const runStarted = performance.now();
    const result = await runProcess(plan, workdir, scrubbedEnv(runRoot, options.env), timeoutMs);
    return {
      ...result,
      durationMs: performance.now() - runStarted,
      rejected: false,
      sandboxed: plan.sandboxed,
      workdir,
    };
  } catch (error) {
    return failed(started, messageOf(error), plan.sandboxed, workdir);
  } finally {
    // Clean up whatever ran, and whatever failed before it could. Nothing here may throw over a result. Only
    // run-owned folders are removed: the private folder, then the throwaway workspace when this run made it.
    await plan.cleanup();
    if (runRoot !== undefined) {
      await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    }
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
    }
  }
}
