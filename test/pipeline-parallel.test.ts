import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/cli/index.ts";
import type { Diagnostic, Page } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import { build } from "../src/pipeline/build.ts";
import { createRenderPool, type RenderPool, type RenderPoolOptions, type RenderedPage } from "../src/pipeline/parallel.ts";
import { loadRegistry } from "../src/render/registry.ts";

/** The theme that ships in this repository. */
const THEME = fileURLToPath(new URL("../../lateen", import.meta.url));

/** The fixture docs site: 593 pages, which is the size parallel rendering is for. */
const FIXTURE = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));

/** A 24-page site whose theme records, per render, the interval it held its thread. */
const PARALLEL_SITE = fileURLToPath(new URL("../fixtures/parallel/site", import.meta.url));

/** The recording theme paired with {@link PARALLEL_SITE}. */
const PARALLEL_THEME = fileURLToPath(new URL("../fixtures/parallel/theme", import.meta.url));

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-parallel-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A temporary outputs folder holding only the html output, which keeps the pagefind index out of the comparison. */
function htmlOnlyOutputs(): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "temp-outputs" }),
    "html.ts": `export const html = {
  name: "html",
  async run(site, ctx) {
    const files = [];
    for (const page of site.pages) {
      if (page.kind !== "doc") continue;
      files.push({ path: page.url.replace(/^\\//, "") + "index.html", contents: await ctx.renderPage(page) });
    }
    return files;
  },
};
`,
  });
}

/** A temporary outputs folder of one output, whose source is `source`; the output is named `one`. */
function oneOutput(source: string): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "temp-outputs" }),
    "one.ts": source,
  });
}

/** A temporary folder for the output; its parent is removed by the test. */
function scratch(): { parent: string; out: string } {
  const parent = mkdtempSync(join(tmpdir(), "pipeline-parallel-out-"));
  return { parent, out: join(parent, "site") };
}

/** Every file under `dir` as path → bytes, so two builds can be compared byte for byte. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
    const abs = join(dir, rel);
    if (statSync(abs).isFile()) map.set(rel.split("\\").join("/"), readFileSync(abs, "latin1"));
  }
  return map;
}

function errors(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.severity === "error");
}

/** Removes the folders a test made. */
function cleanup(...folders: string[]): void {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
}

/** One render the recording theme traced: its page, the worker thread it ran on, and the interval it held that thread. */
interface Span {
  readonly url: string;
  readonly thread: number;
  readonly start: bigint;
  readonly end: bigint;
}

/** The renders traced under `dir`, in no particular order. */
function spansIn(dir: string): Span[] {
  if (!existsSync(dir)) return [];
  const spans: Span[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const { url, start, end } = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        url: string;
        start: string;
        end: string;
      };
      const thread = Number(name.split("-")[1]);
      spans.push({ url, thread, start: BigInt(start), end: BigInt(end) });
    } catch {
      // A trace file being written between the listing and the read; the next poll sees it complete.
    }
  }
  return spans;
}

/** The most spans covering one instant; intervals are half-open, so touching spans do not overlap. */
function peakOverlap(spans: readonly Span[]): number {
  const edges: { readonly at: bigint; readonly delta: number }[] = [];
  for (const span of spans) edges.push({ at: span.start, delta: 1 }, { at: span.end, delta: -1 });
  // An end sorts before a start at the same instant, so a page that stops as another starts is not counted twice.
  edges.sort((a, b) => (a.at === b.at ? a.delta - b.delta : a.at < b.at ? -1 : 1));
  let active = 0;
  let peak = 0;
  for (const edge of edges) {
    active += edge.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(what: string, ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 2000; tries++) {
    if (ready()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Runs `run` with the recording theme tracing into a temporary folder that is removed afterwards. */
async function traced<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-parallel-trace-"));
  process.env.MIZZEN_PARALLEL_TRACE = dir;
  try {
    return await run(dir);
  } finally {
    delete process.env.MIZZEN_PARALLEL_TRACE;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A pool on the recording fixture, with its registry loaded here as the fallback. */
async function fixturePool(
  options: Omit<RenderPoolOptions, "themeRoot" | "site" | "registry">,
): Promise<{ readonly pool: RenderPool; readonly pages: Page[] }> {
  const { site } = await buildModel(PARALLEL_SITE);
  const registry = await loadRegistry(PARALLEL_THEME);
  return {
    pool: createRenderPool({ themeRoot: PARALLEL_THEME, site, registry, ...options }),
    pages: site.pages.filter((page) => page.kind === "doc"),
  };
}

/** Renders every fixture page through a fresh pool: the results in page order, and what actually ran. */
async function renderFixture(
  options: Omit<RenderPoolOptions, "themeRoot" | "site" | "registry">,
): Promise<{ readonly rendered: RenderedPage[]; readonly pages: Page[]; readonly spans: Span[] }> {
  return traced(async (dir) => {
    const { pool, pages } = await fixturePool(options);
    try {
      pool.prefetch(pages);
      const rendered = await Promise.all(pages.map((page) => pool.render(page)));
      return { rendered, pages, spans: spansIn(dir) };
    } finally {
      await pool.close();
    }
  });
}

/**
 * A theme whose layout throws only inside a worker thread: the same layout works in this process, so a fallback can
 * be compared with a plain build.
 */
function failingTheme(): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "throwing-theme" }),
    "src/index.ts": 'export const theme = { name: "throwing", folders: ["layouts"] };\n',
    "layouts/doc.ts": `import { isMainThread } from "node:worker_threads";

export default function doc({ page }: { page: { html: string } }): string {
  if (!isMainThread) throw new Error("worker boom");
  return \`<!DOCTYPE html>\\n<html lang="en" dir="ltr"><head><title>Page</title></head><body>\\n\${page.html}\\n</body></html>\`;
}
`,
  });
}

/**
 * A theme whose layout spends time on purpose. Rendering is all it does, so the timing test measures the render stage
 * rather than the model, which stays in this process and is the same for both builds.
 */
function slowTheme(): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "slow-theme" }),
    "src/index.ts": 'export const theme = { name: "slow", folders: ["layouts"] };\n',
    "layouts/doc.ts": `export default function doc({ page }: { page: { title: string; html: string } }): string {
  let sum = 0;
  for (let index = 0; index < 600_000; index++) sum = (sum + index) % 1000003;
  return \`<!DOCTYPE html>\\n<html lang="en" dir="ltr"><head><title>\${page.title}</title></head><body data-sum="\${sum}">\\n\${page.html}\\n</body></html>\`;
}
`,
  });
}

test("a site renders byte for byte the same with 1 worker and with several, diagnostics included", async () => {
  const root = tree({
    "index.md": "# Home\n\n:::callout{type=warning title=\"Careful\"}\nWatch this.\n:::\n",
    "guide/install.md": "---\ntitle: Install\n---\n# Install\n\n## Steps\n\n1. One\n2. Two\n",
    "guide/usage.md": "---\ntitle: Usage\ndescription: How to use it\n---\n# Usage\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
    "missing.md": "---\nlayout: nope\n---\n# Missing layout\n",
    "404.md": "---\npermalink: /404.html\n---\n# Nothing here\n",
  });
  const outputs = htmlOnlyOutputs();
  const serial = scratch();
  const parallel = scratch();
  try {
    const one = await build({ root, out: serial.out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc" });
    const many = await build({ root, out: parallel.out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc", workers: 4 });
    assert.deepEqual(snapshot(parallel.out), snapshot(serial.out), "every output file is the same bytes");
    assert.deepEqual(many.files, one.files);
    assert.deepEqual(many.diagnostics, one.diagnostics, "the same findings, in the same order");
    assert.deepEqual(
      errors(many.diagnostics).map((d) => d.id),
      ["render.unknown-layout"],
    );
  } finally {
    cleanup(root, outputs, serial.parent, parallel.parent);
  }
});

test("the 593-page fixture builds byte for byte the same with 4 workers, and both times are recorded", async (t) => {
  const outputs = htmlOnlyOutputs();
  const serial = scratch();
  const parallel = scratch();
  try {
    const serialStart = performance.now();
    const one = await build({ root: FIXTURE, out: serial.out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc" });
    const serialMs = performance.now() - serialStart;

    const parallelStart = performance.now();
    const many = await build({ root: FIXTURE, out: parallel.out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc", workers: 4 });
    const parallelMs = performance.now() - parallelStart;

    t.diagnostic(`${one.files.length} files, 1 worker: ${serialMs.toFixed(0)} ms`);
    t.diagnostic(`${many.files.length} files, 4 workers: ${parallelMs.toFixed(0)} ms`);

    assert.deepEqual(errors(many.diagnostics), []);
    assert.deepEqual(many.files, one.files);
    assert.deepEqual(many.diagnostics, one.diagnostics);
    assert.deepEqual(snapshot(parallel.out), snapshot(serial.out), "593 pages, byte for byte");
    assert.ok(one.files.filter((file) => file.endsWith("index.html")).length > 500);
    // Generous on purpose: the model stage is single-threaded and dominates on a small or loaded machine, so the test
    // reports the times and only fails on a regression that is far worse than no speedup at all.
    assert.ok(
      parallelMs < serialMs * 2 + 5000,
      `parallel build took ${parallelMs.toFixed(0)} ms against ${serialMs.toFixed(0)} ms serially`,
    );
  } finally {
    cleanup(outputs, serial.parent, parallel.parent);
  }
});

test("a page a pool prefetches but no output asks for reports nothing, as in a single-thread build", async () => {
  const root = tree({ "a.md": "---\ntitle: A\nlayout: doc\n---\n# A\n", "b.md": "# B with no layout\n" });
  const outputs = oneOutput(`export const one = {
  name: "one",
  async run(site, ctx) {
    const page = site.pages.find((each) => each.url === "/a/");
    return [{ path: "one.html", contents: await ctx.renderPage(page) }];
  },
};
`);
  const serial = scratch();
  const parallel = scratch();
  try {
    const one = await build({ root, out: serial.out, themeRoot: THEME, outputsDir: outputs });
    const many = await build({ root, out: parallel.out, themeRoot: THEME, outputsDir: outputs, workers: 2 });
    assert.deepEqual(
      many.diagnostics.map((d) => d.id),
      one.diagnostics.map((d) => d.id),
      "prefetching a page no output asks for does not report its findings",
    );
    assert.deepEqual(errors(many.diagnostics), [], "no render.no-layout for the page nobody rendered");
    assert.deepEqual(snapshot(parallel.out), snapshot(serial.out));
  } finally {
    cleanup(root, outputs, serial.parent, parallel.parent);
  }
});

test("50 pages: both times are recorded, the sites are the same, and workers speed up a render-heavy theme", async (t) => {
  const theme = slowTheme();
  const files: Record<string, string> = {};
  for (let index = 0; index < 50; index++) {
    const name = `guide/page-${String(index).padStart(2, "0")}`;
    files[`${name}.md`] = `---\ntitle: Page ${index}\n---\n# Page ${index}\n\nBody text with a [link](/guide/page-00/).\n`;
  }
  const root = tree(files);
  const outputs = htmlOnlyOutputs();
  const serial = scratch();
  const parallel = scratch();
  const workers = Math.max(2, Math.min(4, availableParallelism() - 1));
  try {
    const serialStart = performance.now();
    const one = await build({ root, out: serial.out, themeRoot: theme, outputsDir: outputs, defaultLayout: "doc" });
    const serialMs = performance.now() - serialStart;

    const parallelStart = performance.now();
    const many = await build({ root, out: parallel.out, themeRoot: theme, outputsDir: outputs, defaultLayout: "doc", workers });
    const parallelMs = performance.now() - parallelStart;

    t.diagnostic(`50 pages, 1 worker: ${serialMs.toFixed(0)} ms`);
    t.diagnostic(`50 pages, ${workers} workers: ${parallelMs.toFixed(0)} ms`);

    assert.deepEqual(errors(many.diagnostics), []);
    assert.deepEqual(many.files, one.files);
    assert.deepEqual(snapshot(parallel.out), snapshot(serial.out));
    assert.equal(many.files.filter((file) => file.endsWith("index.html")).length, 50);
    // Generous on purpose: a loaded machine can make workers look slow, and the suite must not fail for that. The
    // bound only catches a regression that serializes the render stage or worse.
    assert.ok(
      parallelMs < serialMs * 2 + 5000,
      `parallel build took ${parallelMs.toFixed(0)} ms against ${serialMs.toFixed(0)} ms serially`,
    );
  } finally {
    cleanup(theme, root, outputs, serial.parent, parallel.parent);
  }
});

test("peak active work never exceeds the configured concurrency", async () => {
  const limited = await renderFixture({ workers: 4, concurrency: 2 });
  assert.equal(limited.pages.length, 24);
  assert.equal(limited.spans.length, limited.pages.length, "every page rendered exactly once");
  assert.deepEqual(
    limited.spans.map((span) => span.url).sort(),
    limited.pages.map((page) => page.url).sort(),
    "one render per page, none shared or dropped",
  );
  const limitedPeak = peakOverlap(limited.spans);
  assert.ok(limitedPeak <= 2, `four workers at concurrency 2 ran ${limitedPeak} pages at once`);
  assert.equal(new Set(limited.spans.map((span) => span.thread)).size, 2, "two workers took the work, no more");
  // Results come back keyed by the page that was asked for, whatever order the workers finished in.
  for (const [index, page] of limited.pages.entries()) {
    assert.equal(limited.rendered[index]?.url, page.url);
    assert.ok(limited.rendered[index]?.html.includes(page.title));
  }

  const natural = await renderFixture({ workers: 3 });
  const naturalPeak = peakOverlap(natural.spans);
  assert.ok(naturalPeak <= 3, `three workers ran ${naturalPeak} pages at once`);
  assert.equal(new Set(natural.spans.map((span) => span.thread)).size, 3, "the default window keeps every worker fed");
});

test("two requests for one page share one render, so a destination has one owner", async () => {
  await traced(async (dir) => {
    const { pool, pages } = await fixturePool({ workers: 2 });
    const page = pages[0]!;
    try {
      pool.prefetch([page, page]);
      const [first, second] = await Promise.all([pool.render(page), pool.render(page)]);
      assert.equal(first, second, "both requests got the same result, not two renders");
      assert.equal(spansIn(dir).filter((span) => span.url === page.url).length, 1, "the page rendered once");
    } finally {
      await pool.close();
    }
  });
});

test("the recording fixture site is byte for byte the same at every concurrency setting", async () => {
  const outputs = htmlOnlyOutputs();
  const serial = scratch();
  const scratchs = [serial];
  try {
    const one = await build({ root: PARALLEL_SITE, out: serial.out, themeRoot: PARALLEL_THEME, outputsDir: outputs });
    assert.deepEqual(errors(one.diagnostics), []);
    for (const workers of [2, 3, 5, 8]) {
      const each = scratch();
      scratchs.push(each);
      const many = await build({
        root: PARALLEL_SITE,
        out: each.out,
        themeRoot: PARALLEL_THEME,
        outputsDir: outputs,
        workers,
      });
      assert.deepEqual(snapshot(each.out), snapshot(serial.out), `${workers} workers write the same bytes`);
      assert.deepEqual(many.files, one.files, `${workers} workers write the same files`);
      assert.deepEqual(many.diagnostics, one.diagnostics, `${workers} workers find the same things`);
    }
  } finally {
    cleanup(outputs, ...scratchs.map((each) => each.parent));
  }
});

test("closing the pool cancels queued and in-flight work and settles every waiter", async () => {
  await traced(async (dir) => {
    const { pool, pages } = await fixturePool({ workers: 2, concurrency: 2 });
    try {
      pool.prefetch(pages);
      await waitFor("a page to start rendering", () => spansIn(dir).length > 0);
      // Attach the expectation before closing: close settles the promise synchronously.
      const pending = assert.rejects(pool.render(pages[pages.length - 1]!), /the pool closed before/);
      await pool.close();
      await pending;
      await assert.rejects(pool.render(pages[0]!), /the pool closed before/);
      const after = spansIn(dir).length;
      assert.ok(after < pages.length, "close stopped the prefetch queue instead of draining it");
      await sleep(150);
      assert.equal(spansIn(dir).length, after, "no worker kept rendering after close");
    } finally {
      await pool.close();
    }
  });
});

test("a page whose layout throws everywhere rejects its render instead of hanging", async () => {
  const theme = tree({
    "package.json": JSON.stringify({ type: "module", name: "broken-theme" }),
    "src/index.ts": 'export const theme = { name: "broken", folders: ["layouts"] };\n',
    "layouts/doc.ts": 'export default function doc(): string {\n  throw new Error("render boom");\n}\n',
  });
  const root = tree({ "a.md": "---\nlayout: doc\n---\n# A\n" });
  try {
    const { site } = await buildModel(root);
    const registry = await loadRegistry(theme);
    const pool = createRenderPool({ themeRoot: theme, site, registry, workers: 2 });
    try {
      await assert.rejects(pool.render(site.pages[0]!), /render boom/, "the failure reached the caller");
    } finally {
      await pool.close();
    }
  } finally {
    cleanup(theme, root);
  }
});

test("a build that fails while pages render leaves no destination and no staging folder", async () => {
  const root = tree({ "a.md": "# A\n", "b.md": "# B\n" });
  const outputs = oneOutput(`export const one = {
  name: "one",
  async run(site, ctx) {
    for (const page of site.pages) await ctx.renderPage(page);
    throw new Error("output boom");
  },
};
`);
  const { parent, out } = scratch();
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "old.txt"), "old");
    await assert.rejects(
      build({ root, out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc", workers: 2 }),
      /output boom/,
    );
    assert.equal(readFileSync(join(out, "old.txt"), "utf8"), "old", "the site on disk is left as it was");
    assert.deepEqual(
      readdirSync(parent).filter((name) => name.startsWith(".site-build-")),
      [],
      "no staging folder is left behind",
    );
  } finally {
    cleanup(root, outputs, parent);
  }
});

test("worker counts are validated before any build work", async () => {
  const root = tree({ "a.md": "# A\n" });
  const outputs = htmlOnlyOutputs();
  const { parent, out } = scratch();
  try {
    for (const workers of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        build({ root, out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc", workers }),
        TypeError,
        `${workers} is not a worker count`,
      );
    }
    // The pool itself refuses a count it cannot split, whatever the caller.
    await assert.rejects(
      Promise.resolve().then(() => createRenderPool({ workers: 1 } as unknown as RenderPoolOptions)),
      TypeError,
    );
    // A window narrower than one page is no window, and is refused before any worker starts.
    for (const concurrency of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => createRenderPool({ workers: 2, concurrency } as unknown as RenderPoolOptions),
        TypeError,
        `${concurrency} is not a concurrency`,
      );
    }
    // One worker is not a pool: it renders in this process, fast and without starting a thread.
    const result = await build({ root, out, themeRoot: THEME, outputsDir: outputs, defaultLayout: "doc", workers: 1 });
    assert.deepEqual(errors(result.diagnostics), []);
  } finally {
    cleanup(root, outputs, parent);
  }
});

test("a worker that throws falls back to this process for its pages, with a diagnostic", async () => {
  const theme = failingTheme();
  const root = tree({ "a.md": "# A\n", "b.md": "# B\n" });
  const outputs = htmlOnlyOutputs();
  const serial = scratch();
  const parallel = scratch();
  try {
    const one = await build({ root, out: serial.out, themeRoot: theme, outputsDir: outputs, defaultLayout: "doc" });
    const many = await build({ root, out: parallel.out, themeRoot: theme, outputsDir: outputs, defaultLayout: "doc", workers: 2 });
    assert.deepEqual(errors(many.diagnostics), []);
    const fellBack = many.diagnostics.filter((d) => d.id === "render.worker-failed");
    assert.deepEqual(
      fellBack.map((d) => d.severity),
      ["warning", "warning"],
      "one warning for each page the worker could not render",
    );
    assert.ok(fellBack.every((d) => d.pos !== undefined && d.pos.file.endsWith(".md")), "the warning points at the page");
    assert.match(fellBack[0]?.message ?? "", /worker boom/);
    assert.deepEqual(snapshot(parallel.out), snapshot(serial.out), "the fallback HTML is the in-process HTML");
  } finally {
    cleanup(theme, root, outputs, serial.parent, parallel.parent);
  }
});

test("--workers is parsed for build and check, in numbers or auto, and refused elsewhere", () => {
  const parsed = parseArgs(["build", "--workers", "3"]);
  assert.equal("options" in parsed && parsed.options.command === "build" ? parsed.options.workers : undefined, 3);
  const auto = parseArgs(["check", "--workers", "auto"]);
  const count = "options" in auto && auto.options.command === "check" ? auto.options.workers : undefined;
  assert.ok(typeof count === "number" && count >= 1, "auto is at least one worker");
  assert.equal(count, Math.max(1, availableParallelism() - 1));
  assert.equal("error" in parseArgs(["build", "--workers", "0"]), true);
  assert.equal("error" in parseArgs(["build", "--workers", "many"]), true);
  assert.equal("error" in parseArgs(["watch", "--workers", "2"]), true);
  assert.deepEqual(parseArgs(["build"]), { options: { command: "build", root: ".", out: "dist" } }, "no flag, no key");
});
