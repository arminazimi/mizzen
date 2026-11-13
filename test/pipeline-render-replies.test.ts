/**
 * Worker render replies are validated before any page is released (#148): a `done` reply must hold exactly one
 * well-formed result per requested page, in the order sent, with that page's URL. A reply that does not is refused as
 * a whole and its batch goes through the worker-failure policy, so a duplicate, missing, extra, malformed, or
 * misidentified result can never become another page's HTML.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Page } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import { createRenderPool, renderOnePage, renderReplyProblem, type RenderPool, type RenderedPage } from "../src/pipeline/parallel.ts";
import { loadRegistry } from "../src/render/registry.ts";

/** A temporary folder holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-render-replies-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A page the validator only reads the URL of. */
function page(url: string): Page {
  return { url } as unknown as Page;
}

/** One well-formed worker result for `url`. */
function result(url: string, html = `<p>${url}</p>`): RenderedPage {
  return { url, html, css: [], diagnostics: [] };
}

/** `work`, but rejected if it has not settled by `ms`, so a stuck waiter fails the test instead of the suite. */
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

test("a reply with one well-formed result per requested page, in order, is accepted", () => {
  const pages = [page("/a/"), page("/b/")];
  assert.equal(renderReplyProblem(pages, [result("/a/"), result("/b/")]), undefined);
  assert.equal(
    renderReplyProblem(pages, [
      { url: "/a/", html: "", css: ["a.css"], islands: [{ name: "a", src: "/a.js" }], diagnostics: [] },
      result("/b/"),
    ]),
    undefined,
    "CSS, islands, and diagnostics in their proper shapes are fine",
  );
});

test("a missing, extra, duplicate, wrong-URL, or malformed reply is refused with one deterministic reason", () => {
  const pages = [page("/a/"), page("/b/")];
  const good = [result("/a/"), result("/b/")];
  const cases: readonly (readonly [string, unknown, string])[] = [
    ["not a list", "nope", "the reply is not a list of pages"],
    ["missing a result", [good[0]], "the reply holds 1 result for 2 requested pages"],
    ["extra result", [...good, result("/c/")], "the reply holds 3 results for 2 requested pages"],
    ["duplicate result", [result("/a/"), result("/a/")], 'result 1 is for "/a/" instead of "/b/"'],
    ["wrong URL first", [result("/b/"), result("/a/")], 'result 0 is for "/b/" instead of "/a/"'],
    ["null result", [null, good[1]], "result 0 is not a rendered page"],
    ["HTML not a string", [{ ...good[0], html: 42 }, good[1]], "the HTML for /a/ is not a string"],
    ["CSS not a list", [{ ...good[0], css: "a.css" }, good[1]], "the CSS for /a/ is not a list of strings"],
    ["CSS entry not a string", [{ ...good[0], css: [1] }, good[1]], "the CSS for /a/ is not a list of strings"],
    ["diagnostics not a list", [{ ...good[0], diagnostics: {} }, good[1]], "the diagnostics for /a/ are not a list of findings"],
    ["diagnostic not a finding", [{ ...good[0], diagnostics: [{}] }, good[1]], "the diagnostics for /a/ are not a list of findings"],
    ["islands not a list", [{ ...good[0], islands: "a.js" }, good[1]], "the islands for /a/ are not a list of islands"],
    ["island without a name", [{ ...good[0], islands: [{ src: "/a.js" }] }, good[1]], "the islands for /a/ are not a list of islands"],
  ];
  for (const [label, reply, expected] of cases) {
    assert.equal(renderReplyProblem(pages, reply), expected, label);
  }
});

/**
 * A theme whose component renames page `/a/` to `/b/` inside a worker thread. The batch that holds both pages then
 * comes back with a duplicate URL, while the same render in this process is untouched, so the fallback is comparable.
 */
function renamingTheme(): string {
  return tree({
    "package.json": JSON.stringify({ type: "module", name: "misidentified-replies" }),
    "src/index.ts": 'export const theme = { name: "misidentified-replies", folders: ["layouts", "components"] };\n',
    "layouts/doc.ts": `export default function doc({ page }: { page: { title: string; html: string } }): string {
  return \`<!DOCTYPE html>\\n<html lang="en" dir="ltr"><head><title>\${page.title}</title></head><body>\\n\${page.html}\\n</body></html>\`;
}
`,
    "components/rename/index.ts": `import { isMainThread } from "node:worker_threads";

export default function rename({ page, html }: { page: { url: string }; html: string }): string {
  // Only the worker lies, so this process still renders the page the batch asked for.
  if (!isMainThread && page.url === "/a/") page.url = "/b/";
  return html;
}
`,
  });
}

test("a misidentified reply falls back to this process for its whole batch, with no cross-page content", async () => {
  const theme = renamingTheme();
  const root = tree({
    "a.md": '---\ntitle: A\nlayout: doc\n---\n# A\n\n<sl-component name="rename">A body</sl-component>\n',
    "b.md": "---\ntitle: B\nlayout: doc\n---\n# B\n",
    "c.md": "---\ntitle: C\nlayout: doc\n---\n# C\n",
    "d.md": "---\ntitle: D\nlayout: doc\n---\n# D\n",
  });
  let pool: RenderPool | undefined;
  try {
    const { site } = await buildModel(root);
    const registry = await loadRegistry(theme);
    const pages = site.pages.filter((each) => each.kind === "doc");
    assert.equal(pages.length, 4);
    pool = createRenderPool({ themeRoot: theme, site, registry, workers: 2, concurrency: 4, renderDeadlineMs: 60000 });
    pool.prefetch(pages);
    const started = performance.now();
    // Two requests per page: a bad batch must settle every waiter once, not leave one pending.
    const rendered = await within(
      "render",
      30000,
      Promise.all(
        pages.map(async (each) => {
          const first = await pool!.render(each);
          const second = await pool!.render(each);
          assert.equal(first, second, `${each.url} is served from one settled result`);
          return first;
        }),
      ),
    );
    assert.ok(performance.now() - started < 25000, "the bad batch settled without waiting for its deadline");

    for (const [index, each] of pages.entries()) {
      const actual = rendered[index]!;
      assert.equal(actual.url, each.url, `${each.url} keeps its identity`);
      assert.equal(
        actual.html,
        renderOnePage(registry, site, each, undefined).html,
        `${each.url} is byte for byte the page this process renders`,
      );
    }

    const byURL = new Map(pages.map((each, index) => [each.url, rendered[index]!]));
    for (const url of ["/a/", "/b/"]) {
      const warnings = byURL.get(url)!.diagnostics.filter((d) => d.id === "render.worker-failed");
      assert.equal(warnings.length, 1, `${url} reports why its batch was not used`);
      assert.match(warnings[0]!.message, /invalid reply \(result \d is for/, `${url} names the invalid reply`);
    }
    for (const url of ["/c/", "/d/"]) {
      assert.deepEqual(
        byURL.get(url)!.diagnostics.filter((d) => d.id === "render.worker-failed"),
        [],
        `${url} came from a valid batch and was not blamed for its neighbour`,
      );
    }
    assert.ok(byURL.get("/a/")!.html.includes("A body"));
    assert.ok(!byURL.get("/a/")!.html.includes("B body"));
  } finally {
    if (pool !== undefined) await pool.close();
    rmSync(theme, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
