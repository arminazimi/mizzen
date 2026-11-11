import type { Diagnostic, Page, Site, SourcePos } from "../contracts/index.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { examplesOf, type MarkdownExample } from "../markdown/plugins/example-fence.ts";
import { cachedRun, exampleCache, exampleCacheDirOf, type ExampleCache } from "../pipeline/examples/cache.ts";
import { exampleFailed, exampleSandboxUnavailable } from "../pipeline/examples/diagnostic.ts";
import { runNodeExample, type ExampleLang } from "../pipeline/examples/run-node.ts";
import { runShellExample, sandboxAvailable } from "../pipeline/examples/run-shell.ts";

/**
 * Writes `examples.json`: one entry per page with how many runnable examples it declares, how many passed, how many
 * failed, and how many were not run (#1465).
 *
 * Every fence marked `test` is found again from the page's Markdown by `examplesOf`, then run: `js`, `mjs`, and `ts`
 * through `runNodeExample`, `bash` and `sh` through `runShellExample`. An example passes when it exits with code 0
 * and, when it is followed by an `output` fence, when its stdout matches that fence after line endings are normalized
 * and trailing newlines are dropped. A fence without an `output` fence checks only that it exits successfully. A
 * failing example is reported through `exampleFailed`, with the fence's source position, and never fails the build.
 * A host with no OS sandbox reports one `example-sandbox` warning, so a build never presents best-effort limits as
 * isolation.
 *
 * A fence whose language has no runner (`python`, `rust`, an empty language) is **not run**: it is counted in `skipped`
 * and neither passed nor failed, because the engine cannot know whether it works. For every page
 * `total = passed + failed + skipped`.
 *
 * ## Machine dependence
 *
 * Running an example makes the build depend on the machine it runs on: the installed Node version, `PATH`, the
 * process limit, and whatever the example reads from the network. A build has to be deterministic,
 * so `examples.json` itself never records a duration, a timestamp, a machine name, or a run order: only counts, in a
 * fixed key order, sorted by page URL. The counts are stable when the examples are, and a flaky example shows up as a
 * diff in `examples.json`. A site that wants no execution can switch the output off with
 * `outputs: { examples-report: false }`.
 *
 * ## Cache
 *
 * `examplesReport` runs every example unless `cacheDir` names a folder. The output enables the cache only when
 * `MIZZEN_EXAMPLES_CACHE` is set: a path uses that folder, and `1`, `true`, or an empty value use the default
 * `.mizzen/examples` under the working directory. With the cache on, changing the code, language, runner, Node
 * version, or engine version misses the entry and the example runs again.
 *
 */

/** The runner family of a supported example language; also the `kind` of its cache key. */
export type ExampleKind = "node" | "shell";

/** What one runner reports. A duration is allowed and ignored: it never reaches the JSON. */
export interface ExampleRun {
  /** The process exit code, or `null` when it timed out, was refused, or could not start. */
  readonly exitCode: number | null;
  /** Standard output, which an `output` fence is compared with. */
  readonly stdout: string;
  /** How long the run took, in milliseconds; accepted and never written. */
  readonly durationMs?: number;
  /** Why the runner refused or could not run the example, shown instead of an empty actual output. */
  readonly error?: string;
}

/** What a runner receives. */
export interface ExampleRunInput {
  /** The fence's code, unmodified. */
  readonly code: string;
  /** The lowercased fence language: `js`, `mjs`, `ts`, `bash`, or `sh`. */
  readonly lang: string;
  /** Which runner family handles it. */
  readonly kind: ExampleKind;
}

/** Runs one example. Tests replace it; the default spawns a process. */
export type ExampleRunner = (input: ExampleRunInput) => Promise<ExampleRun>;

/** Options of {@link examplesReport}. Every field has a default. */
export interface ExamplesReportOptions {
  /** Called once per failing example, with the fence's position. The output passes the build context's `report`. */
  readonly report?: (diagnostic: Diagnostic) => void;
  /** Enables the example cache in this folder. Default: no cache, so every example runs. */
  readonly cacheDir?: string;
  /** Replaces the process runners. The cache still wraps it, so a hit never calls it. */
  readonly runner?: ExampleRunner;
  /** Per-example timeout for the default runners, in milliseconds. Default: the runner's own. */
  readonly timeoutMs?: number;
}

/** One page's counts, in the order the JSON writes them. */
interface PageExamples {
  /** Output URL, including `base`. */
  readonly url: string;
  /** Every `test` fence on the page, including the ones not run. */
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** Examples whose language has no runner; they are neither passed nor failed. */
  readonly skipped: number;
}

/** The JSON body, with a fixed key order so the same counts give the same bytes. */
interface ExamplesJson {
  readonly pages: readonly PageExamples[];
}

/** The environment variable that enables the cache in the output. */
const CACHE_ENV = "MIZZEN_EXAMPLES_CACHE";

/** Languages `runNodeExample` runs. */
const NODE_LANGS: ReadonlySet<string> = new Set(["js", "mjs", "ts"]);

/** Languages `runShellExample` runs. */
const SHELL_LANGS: ReadonlySet<string> = new Set(["bash", "sh"]);

/** The bare meta token that marks an example, used as a cheap pre-filter before a page is parsed again. */
const TEST_TOKEN = "test";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The runner family of a language, or `undefined` when no runner handles it. */
function kindOf(lang: string): ExampleKind | undefined {
  if (NODE_LANGS.has(lang)) return "node";
  if (SHELL_LANGS.has(lang)) return "shell";
  return undefined;
}

/**
 * What an `output` fence and stdout are compared as: CRLF folded to LF and trailing newlines dropped. A code fence
 * value carries no trailing newline while `console.log` writes one, so the two would never match otherwise.
 */
function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** True when a run passed: exit code 0, and stdout equal to the expected output when the page gives one. */
function passed(example: MarkdownExample, run: ExampleRun): boolean {
  if (run.exitCode !== 0) return false;
  if (example.expected === null) return true;
  return normalize(example.expected) === normalize(run.stdout);
}

/** The fence's source span, with the page's file when the record has none. */
function posOf(page: Page, example: MarkdownExample): SourcePos {
  return {
    file: example.pos.file ?? page.source.file,
    line: example.pos.line,
    column: example.pos.column,
    endLine: example.pos.endLine,
    endColumn: example.pos.endColumn,
  };
}

/** The default runner: the Node process runner or the shell process runner, chosen by language family. */
function defaultRunner(options: ExamplesReportOptions): ExampleRunner {
  /** A refused run carries its reason, so the diagnostic shows why instead of an empty actual output. */
  const report = (result: {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly durationMs: number;
    readonly rejected: boolean;
    readonly stderr: string;
  }): ExampleRun => ({
    exitCode: result.exitCode,
    stdout: result.stdout,
    durationMs: result.durationMs,
    ...(result.rejected ? { error: result.stderr.trim() } : {}),
  });
  return async (input) => {
    if (input.kind === "node") {
      const result = await runNodeExample({
        code: input.code,
        lang: input.lang as ExampleLang,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return report(result);
    }
    const result = await runShellExample({
      code: input.code,
      shell: input.lang as "bash" | "sh",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return report(result);
  };
}

/**
 * Runs one example, through the cache when there is one. A runner that throws is a failed result, not a failed
 * build: the message becomes the observed output in the diagnostic.
 */
async function runOne(
  cache: ExampleCache | undefined,
  runner: ExampleRunner,
  input: ExampleRunInput,
): Promise<ExampleRun> {
  try {
    if (cache === undefined) return await runner(input);
    const { result } = await cachedRun(
      cache,
      { code: input.code, lang: input.lang, kind: input.kind },
      () => runner(input),
    );
    return result;
  } catch (error) {
    return { exitCode: null, stdout: "", error: error instanceof Error ? error.message : String(error) };
  }
}

/** The diagnostic for one failed example: the fence's position, the expected output, and what happened. */
function diagnosticOf(page: Page, example: MarkdownExample, run: ExampleRun): Diagnostic {
  return exampleFailed({
    pos: posOf(page, example),
    page: page.url,
    expected: example.expected ?? "",
    actual: run.error ?? run.stdout,
    ...(run.exitCode === null || run.exitCode === 0 ? {} : { exitCode: run.exitCode }),
  });
}

/**
 * Runs a site's examples and returns the `examples.json` file: one entry per page, sorted by URL, with `total`,
 * `passed`, `failed`, and `skipped` counts in a fixed key order. Pages without examples are present with zeros.
 *
 * Only doc pages are parsed and run: an app page has no Markdown body of its own, so it is present with zeros. The
 * runner, the cache folder, and the report sink are options, so a test can use a fake runner and a temp cache.
 */
export async function examplesReport(
  site: Site,
  options: ExamplesReportOptions = {},
): Promise<readonly OutputFile[]> {
  const runner = options.runner ?? defaultRunner(options);
  const cache = options.cacheDir === undefined ? undefined : exampleCache({ dir: options.cacheDir });
  const pages: PageExamples[] = [];
  // Probed only when the default runners are about to run a real example, so a fake runner stays sandbox-free.
  let trustChecked = false;

  const allPages = [...site.pages].sort((a, b) => byCodePoint(a.url, b.url));
  for (const page of allPages) {
    // Every example's meta contains the token, so a page without the substring cannot carry one and is not parsed
    // again. This keeps a large site without examples from paying for a second parse per page.
    const examples =
      page.kind === "doc" && page.markdown.includes(TEST_TOKEN) ? await examplesOf(page) : [];
    let passedCount = 0;
    let failedCount = 0;
    let skipped = 0;

    for (const example of examples) {
      const lang = example.lang.trim().toLowerCase();
      const kind = kindOf(lang);
      if (kind === undefined) {
        skipped += 1;
        continue;
      }
      // One explicit finding when the host cannot confine examples, so a passing example never silently implies
      // isolation the platform did not provide. Only the default runners are subject to the host's sandbox.
      if (options.runner === undefined && !trustChecked) {
        trustChecked = true;
        if (!sandboxAvailable()) options.report?.(exampleSandboxUnavailable(process.platform));
      }
      const outcome = await runOne(cache, runner, { code: example.code, lang, kind });
      if (passed(example, outcome)) {
        passedCount += 1;
      } else {
        failedCount += 1;
        options.report?.(diagnosticOf(page, example, outcome));
      }
    }

    pages.push({ url: page.url, total: examples.length, passed: passedCount, failed: failedCount, skipped });
  }

  const body: ExamplesJson = { pages };
  return [{ path: "examples.json", contents: `${JSON.stringify(body, null, 2)}\n` }];
}

/**
 * The cache folder `MIZZEN_EXAMPLES_CACHE` asks for, or `undefined` when the variable is unset.
 *
 * A value of `1`, `true`, or nothing is the default `.mizzen/examples` under the working directory; any other value
 * is a folder path, resolved by the cache against the working directory. The output calls this once per build, so the
 * variable is read at run time and never by {@link examplesReport}.
 */
export function examplesCacheDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[CACHE_ENV];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "1" || trimmed.toLowerCase() === "true") {
    return exampleCacheDirOf(process.cwd());
  }
  return trimmed;
}

/**
 * The output that writes `examples.json`. It runs the site's examples unless it is switched off with
 * `outputs: { examples-report: false }`, and it caches them only when `MIZZEN_EXAMPLES_CACHE` is set.
 */
export const examplesReportOutput: Output = {
  name: "examples-report",
  async run(site: Site, ctx): Promise<readonly OutputFile[]> {
    const cacheDir = examplesCacheDir();
    return examplesReport(site, {
      report: (diagnostic) => ctx.report(diagnostic),
      ...(cacheDir === undefined ? {} : { cacheDir }),
    });
  },
};
