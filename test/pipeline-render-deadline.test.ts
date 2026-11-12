/**
 * Per-page render deadlines for the worker pool (#108): a theme that never answers must not leave a parallel build
 * waiting forever.
 *
 * Every scenario here hangs a worker on purpose. Nothing waits for a duration it hopes is enough: the deadline the pool
 * is configured with is far below the worker's 120-second park and far above the time an honest worker needs to boot,
 * and the tests read what the pool actually did from a trace the theme writes. A test that hung instead of falling back
 * fails through `within`, so a regression reports itself rather than stalling the suite.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Diagnostic, Page, Site } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import { createRenderPool, DEFAULT_RENDER_DEADLINE_MS, renderOnePage, type RenderPool } from "../src/pipeline/parallel.ts";
import { loadRegistry, type ThemeRegistry } from "../src/render/registry.ts";

const runChild = promisify(execFile);

/** `src` of this repository, so the child script imports the pool these tests exercise. */
const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The page the tracing themes never answer for, so a hung batch and a healthy one are distinguishable. */
const HANG_URL = "/hang/";

/** A deadline an honest worker clears with room to spare, and a hung one cannot: its park is 240 times longer. */
const BATCH_DEADLINE_MS = 3000;

/** How far apart the timer's millisecond clock and `performance.now` may sit; a deadline never fires by more than this. */
const CLOCK_SLACK_MS = 5;

/** One line of the theme's trace: what happened, on which kind of thread, for which page. */
interface TraceLine {
  readonly kind: "started" | "done";
  readonly thread: "main" | "worker";
  readonly url: string;
}

/** A theme layout that traces its renders and, in a worker thread, parks forever on the hang page. */
function layoutSource(): string {
  return `import { isMainThread, threadId } from "node:worker_threads";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let counter = 0;

/** One append-only line per render step, so nothing collides and the order within a thread is readable. */
function record(kind: string, url: string): void {
  const dir = process.env.MIZZEN_DEADLINE_TRACE;
  if (dir === undefined) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "trace.log"), [kind, isMainThread ? "main" : "worker", process.pid, threadId, counter++, url].join(" ") + "\\n");
}

export default function doc({ page }: { page: { title: string; url: string; html: string } }): string {
  if (!isMainThread && page.url === "${HANG_URL}") {
    record("started", page.url);
    // A worker that never replies: the thread parks here until the pool's deadline terminates it.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  }
  record("done", page.url);
  return \`<!DOCTYPE html>\\n<html lang="en" dir="ltr"><head><title>\${page.title}</title></head><body>\\n\${page.html}\\n</body></html>\`;
}
`;
}

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-deadline-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A site with one page that hangs a worker and three that do not. */
function hangSite(): string {
  return tree({
    "hang.md": "---\ntitle: Hangs\nlayout: doc\n---\n# Hangs\n",
    "a.md": "---\ntitle: A\nlayout: doc\n---\n# A\n",
    "b.md": "---\ntitle: B\nlayout: doc\n---\n# B\n",
    "c.md": "---\ntitle: C\nlayout: doc\n---\n# C\n",
  });
}

/** A theme whose layout hangs a worker on one page; the main thread always answers. */
function hangingPageTheme(): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "deadline-hanging-page" }),
    "src/index.ts": 'export const theme = { name: "deadline-hanging-page", folders: ["layouts"] };\n',
    "layouts/doc.ts": layoutSource(),
  });
}

/** A theme whose module never finishes loading inside a worker thread, so initialization never answers. */
function hangingInitTheme(): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "deadline-hanging-init" }),
    "src/index.ts": `import { isMainThread } from "node:worker_threads";

if (!isMainThread) {
  // Never posts "ready": the pool can only be fed by a worker that is not there yet.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
}

export const theme = { name: "deadline-hanging-init", folders: ["layouts"] };
`,
    "layouts/doc.ts": layoutSource(),
  });
}

/** The trace lines written under `dir`, in the order they were appended. */
function traceLines(dir: string): TraceLine[] {
  const file = join(dir, "trace.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [kind, thread, , , , url] = line.split(" ");
      return { kind: kind as TraceLine["kind"], thread: thread as TraceLine["thread"], url: url! };
    });
}

/**
 * Turns tracing on for this process and, because a worker copies the environment when it starts, for every worker the
 * pool creates while it is on. The caller switches it off with {@link stopTrace} once the pool is done.
 */
function startTrace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-deadline-trace-"));
  process.env.MIZZEN_DEADLINE_TRACE = dir;
  return dir;
}

/** Switches tracing off and returns what the theme recorded. */
function stopTrace(dir: string): TraceLine[] {
  delete process.env.MIZZEN_DEADLINE_TRACE;
  return traceLines(dir);
}

/** `work`, but rejected if it has not settled by `ms`: a hung pool must fail the test instead of hanging the suite. */
function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function warnings(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.id === "render.worker-failed");
}

function errors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

/** A pool over `themeRoot` and the site at `root`, plus the pages to ask for and their in-process HTML. */
async function modelOver(
  themeRoot: string,
  root: string,
): Promise<{ readonly registry: ThemeRegistry; readonly site: Site; readonly pages: readonly Page[]; readonly html: Map<string, string> }> {
  const { site } = await buildModel(root);
  const registry = await loadRegistry(themeRoot);
  const docs = site.pages.filter((page) => page.kind === "doc");
  const hang = docs.filter((page) => page.url === HANG_URL);
  // The hang page goes first, so it is the first batch the pool dispatches.
  const pages = hang.length === 0 ? docs : [...hang, ...docs.filter((page) => page.url !== HANG_URL)];
  const html = new Map(pages.map((page) => [page.url, renderOnePage(registry, site, page, undefined).html]));
  return { registry, site, pages, html };
}

interface Outcome {
  readonly rendered: RenderedPage_[];
  readonly elapsedMs: number;
  readonly trace: TraceLine[];
}

type RenderedPage_ = Awaited<ReturnType<RenderPool["render"]>>;

/**
 * Runs one pool over the fixture: prefetch `pages`, ask for every one of them twice, and record what each thread did.
 * The pool starts while tracing is on, so its workers trace too, and closes before the trace is read back.
 */
async function runPool(
  themeRoot: string,
  model: Awaited<ReturnType<typeof modelOver>>,
  pages: readonly Page[],
  options: { readonly workers: number; readonly concurrency?: number; readonly renderDeadlineMs: number },
): Promise<Outcome> {
  const dir = startTrace();
  let pool: RenderPool | undefined;
  try {
    // Measured from the construction, because that is when the pool arms a worker's init deadline.
    const started = performance.now();
    pool = createRenderPool({ themeRoot, site: model.site, registry: model.registry, ...options });
    pool.prefetch(pages);
    const rendered = await within(
      "render",
      60000,
      Promise.all(
        pages.map(async (page) => {
          const first = await pool!.render(page);
          const second = await pool!.render(page);
          assert.equal(first, second, `${page.url} is served from one render, not two`);
          return first;
        }),
      ),
    );
    return { rendered, elapsedMs: performance.now() - started, trace: stopTrace(dir) };
  } finally {
    delete process.env.MIZZEN_DEADLINE_TRACE;
    if (pool !== undefined) await pool.close();
  }
}

test("the render deadline has a documented finite default", () => {
  assert.equal(typeof DEFAULT_RENDER_DEADLINE_MS, "number");
  assert.ok(Number.isFinite(DEFAULT_RENDER_DEADLINE_MS), "the default is finite, so a hung worker cannot wait forever");
  assert.ok(
    DEFAULT_RENDER_DEADLINE_MS >= 1000,
    `the default is generous enough for an honest theme (${DEFAULT_RENDER_DEADLINE_MS} ms)`,
  );
  for (const renderDeadlineMs of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createRenderPool({ workers: 2, renderDeadlineMs } as never),
      TypeError,
      `${renderDeadlineMs} is not a deadline`,
    );
  }
});

test("a worker whose initialization never answers falls back to the main thread", async () => {
  const theme = hangingInitTheme();
  const root = tree({
    "a.md": "---\ntitle: A\nlayout: doc\n---\n# A\n",
    "b.md": "---\ntitle: B\nlayout: doc\n---\n# B\n",
    "c.md": "---\ntitle: C\nlayout: doc\n---\n# C\n",
  });
  try {
    const model = await modelOver(theme, root);
    const { rendered, elapsedMs, trace } = await runPool(theme, model, model.pages, { workers: 2, renderDeadlineMs: 500 });
    // The fallback happened because the deadline fired, not because something answered early.
    assert.ok(
      elapsedMs >= 500 - CLOCK_SLACK_MS,
      `the deadline fired after ${elapsedMs.toFixed(0)} ms of a 500 ms budget`,
    );
    assert.equal(rendered.length, model.pages.length, "every requested page resolved");
    for (const [index, page] of model.pages.entries()) {
      const result = rendered[index]!;
      assert.equal(result.url, page.url);
      assert.equal(result.html, model.html.get(page.url), `${page.url} falls back to the main-thread bytes`);
      const fellBack = warnings(result.diagnostics);
      assert.equal(fellBack.length, 1, `one warning for ${page.url}`);
      assert.equal(fellBack[0]?.severity, "warning");
      assert.match(fellBack[0]?.message ?? "", /did not initialize within 500 ms/, "the warning names the missed deadline");
      assert.deepEqual(errors(result.diagnostics), [], `${page.url} still rendered`);
    }
    const done = trace.filter((line) => line.kind === "done");
    assert.deepEqual(
      done.map((line) => line.url).sort(),
      model.pages.map((page) => page.url).sort(),
      "every page rendered exactly once",
    );
    assert.deepEqual(
      [...new Set(done.map((line) => line.thread))],
      ["main"],
      "a pool whose workers never initialized renders on the main thread only",
    );
    assert.equal(trace.filter((line) => line.kind === "started").length, 0, "no worker ever got a batch");
  } finally {
    rmSync(theme, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a page that never answers costs only its own worker; the rest of the pool keeps going", async () => {
  const theme = hangingPageTheme();
  const root = hangSite();
  try {
    const model = await modelOver(theme, root);
    const { rendered, elapsedMs, trace } = await runPool(theme, model, model.pages, {
      workers: 2,
      concurrency: 1,
      renderDeadlineMs: BATCH_DEADLINE_MS,
    });
    assert.ok(
      elapsedMs >= BATCH_DEADLINE_MS - CLOCK_SLACK_MS,
      `the deadline fired after ${elapsedMs.toFixed(0)} ms of a ${BATCH_DEADLINE_MS} ms budget`,
    );
    assert.equal(rendered.length, model.pages.length, "every requested page resolved");
    for (const result of rendered) {
      assert.equal(result.html, model.html.get(result.url), `${result.url} is the main-thread HTML`);
    }

    const hang = rendered.find((result) => result.url === HANG_URL)!;
    const fellBack = warnings(hang.diagnostics);
    assert.equal(fellBack.length, 1, "the hung page reports one fallback");
    assert.equal(fellBack[0]?.severity, "warning");
    assert.match(
      fellBack[0]?.message ?? "",
      new RegExp(`did not answer its batch within ${BATCH_DEADLINE_MS} ms`),
      "the warning names the missed deadline",
    );
    assert.deepEqual(errors(hang.diagnostics), [], "the fallback page still rendered");

    const healthy = rendered.filter((result) => result.url !== HANG_URL);
    assert.equal(healthy.length, model.pages.length - 1);
    for (const result of healthy) {
      assert.deepEqual(warnings(result.diagnostics), [], `${result.url} was not blamed for its neighbour`);
      assert.deepEqual(errors(result.diagnostics), []);
    }

    // The hung batch really was dispatched, and really did park.
    assert.deepEqual(
      trace.filter((line) => line.kind === "started").map((line) => [line.thread, line.url]),
      [["worker", HANG_URL]],
      "one worker parked on the hung page",
    );
    const done = trace.filter((line) => line.kind === "done");
    assert.deepEqual(
      done.map((line) => line.url).sort(),
      model.pages.map((page) => page.url).sort(),
      "each page produced exactly one render: the hung page on the main thread, no page twice",
    );
    const threadOf = new Map(done.map((line) => [line.url, line.thread]));
    assert.equal(threadOf.get(HANG_URL), "main", "the hung page fell back to this process");
    assert.deepEqual(
      healthy.map((result) => threadOf.get(result.url)),
      healthy.map(() => "worker"),
      "the surviving worker kept taking batches after the timeout",
    );
  } finally {
    rmSync(theme, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a worker that answers before the deadline is untouched by it", async () => {
  const theme = hangingPageTheme();
  const root = hangSite();
  try {
    const model = await modelOver(theme, root);
    const asked = model.pages.filter((page) => page.url !== HANG_URL);
    const { rendered, trace } = await runPool(theme, model, asked, {
      workers: 2,
      renderDeadlineMs: DEFAULT_RENDER_DEADLINE_MS,
    });
    assert.equal(rendered.length, asked.length);
    for (const [index, page] of asked.entries()) {
      const result = rendered[index]!;
      assert.equal(result.url, page.url);
      assert.equal(result.html, model.html.get(page.url), `${page.url} is byte for byte the in-process HTML`);
      assert.deepEqual(warnings(result.diagnostics), [], "no fallback warning for a prompt worker");
      assert.deepEqual(errors(result.diagnostics), []);
    }
    const done = trace.filter((line) => line.kind === "done");
    assert.equal(done.length, asked.length, "one render per page");
    assert.deepEqual(
      [...new Set(done.map((line) => line.thread))],
      ["worker"],
      "a pool that answers in time never touches the main thread",
    );
  } finally {
    rmSync(theme, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a timed-out pool closes idempotently and leaves no timer, worker, or pending render", async () => {
  const theme = hangingPageTheme();
  const root = hangSite();
  const scratch = mkdtempSync(join(tmpdir(), "pipeline-deadline-child-"));
  try {
    const firstTrace = join(scratch, "trace-timeout");
    const secondTrace = join(scratch, "trace-cancel");
    // A second process, because the proof that a closed pool leaves nothing alive is that the process ends by itself.
    const source = `import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { buildModel } from ${JSON.stringify(pathToFileURL(join(SRC, "model", "build.ts")).href)};
import { loadRegistry } from ${JSON.stringify(pathToFileURL(join(SRC, "render", "registry.ts")).href)};
import { createRenderPool } from ${JSON.stringify(pathToFileURL(join(SRC, "pipeline", "parallel.ts")).href)};

const themeRoot = ${JSON.stringify(theme)};
const root = ${JSON.stringify(root)};
const firstTrace = ${JSON.stringify(firstTrace)};
const secondTrace = ${JSON.stringify(secondTrace)};
const deadlineMs = ${BATCH_DEADLINE_MS};
mkdirSync(firstTrace, { recursive: true });
mkdirSync(secondTrace, { recursive: true });
process.env.MIZZEN_DEADLINE_TRACE = firstTrace;

/** The trace lines the pool now tracing wrote so far. */
function lines(dir) {
  const file = dir + "/trace.log";
  return existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter((line) => line !== "") : [];
}

/** Waits for a real event instead of assuming a duration. */
async function waitFor(what, ready) {
  for (let tries = 0; tries < 12000; tries++) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for " + what);
}

const timeouts = (resources) => resources.filter((each) => each === "Timeout").length;
const report = { baseline: timeouts(process.getActiveResourcesInfo()), afterTimeout: -1, afterCancel: -1, settled: 0, warnings: 0, healthy: 0, rejected: 0 };

const { site } = await buildModel(root);
const registry = await loadRegistry(themeRoot);
const docs = site.pages.filter((page) => page.kind === "doc");
const pages = [...docs.filter((page) => page.url === "/hang/"), ...docs.filter((page) => page.url !== "/hang/")];

// A batch that never answers: the deadline falls back for it, and closing twice afterwards changes nothing.
const timedOut = createRenderPool({ themeRoot, site, registry, workers: 2, concurrency: 1, renderDeadlineMs: deadlineMs });
timedOut.prefetch(pages);
const rendered = await Promise.all(pages.map((page) => timedOut.render(page)));
report.settled = rendered.length;
report.warnings = rendered.reduce((sum, each) => sum + each.diagnostics.filter((d) => d.id === "render.worker-failed").length, 0);
report.healthy = rendered.filter((each) => each.url !== "/hang/").length;
await timedOut.close();
await timedOut.close();
report.afterTimeout = timeouts(process.getActiveResourcesInfo());
await timedOut.render(pages[1]).then(
  () => { throw new Error("render resolved after close"); },
  () => undefined,
);

// Closing while a batch is in flight, long before its deadline, settles every waiter too.
process.env.MIZZEN_DEADLINE_TRACE = secondTrace;
const cancelled = createRenderPool({ themeRoot, site, registry, workers: 2, concurrency: 1, renderDeadlineMs: 120000 });
cancelled.prefetch(pages);
const pending = pages.map((page) => cancelled.render(page).then(() => "resolved", () => "rejected"));
await waitFor("the hung batch to be dispatched", () => lines(secondTrace).some((line) => line.startsWith("started worker") && line.endsWith("/hang/")));
await cancelled.close();
await cancelled.close();
report.afterCancel = timeouts(process.getActiveResourcesInfo());
report.rejected = (await Promise.all(pending)).filter((each) => each === "rejected").length;

// Writing this line and exiting at all proves nothing kept the event loop alive: no worker, no deadline timer.
process.stdout.write(JSON.stringify(report));
`;
    const child = join(scratch, "child.mts");
    writeFileSync(child, source);
    const { stdout } = await within("the child process", 120000, runChild(process.execPath, [child], { timeout: 120000 }));
    const report = JSON.parse(stdout) as {
      baseline: number;
      afterTimeout: number;
      afterCancel: number;
      settled: number;
      warnings: number;
      healthy: number;
      rejected: number;
    };
    // Reaching this line at all means the child exited by itself, so no worker and no timer outlived close().
    assert.equal(report.baseline, 0, "the child started with nothing pending");
    assert.equal(report.afterTimeout, 0, "closing after a timeout leaves no pending timer");
    assert.equal(report.afterCancel, 0, "closing during a batch leaves no pending timer");
    assert.equal(report.settled, 4, "every page of the timed-out pool resolved exactly once");
    assert.equal(report.warnings, 1, "only the hung page fell back to the main thread");
    assert.equal(report.healthy, 3, "the healthy pages were not disturbed by the deadline");
    assert.equal(report.rejected, 4, "close settled every waiter of the cancelled pool");
  } finally {
    rmSync(theme, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
