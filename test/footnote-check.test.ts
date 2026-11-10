import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic, Page, Site } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { parseMarkdown } from "../src/markdown/parse.ts";
import { markdownToHtml } from "../src/markdown/to-html.ts";
import { footnoteCheck, unresolvedFootnotes } from "../src/outputs/footnote-check.ts";

const FILE = "guide/install.md";

/** A site config with the defaults a build fills in. */
function site(pages: readonly Page[]): Site {
  return {
    config: {
      title: "Example",
      base: "",
      lang: "en",
      dir: "ltr",
      languages: [],
      source: ".",
      include: [],
      exclude: [],
      navigation: "_data/navigation.yml",
      defaults: [],
      theme: { options: {} },
      search: {},
      redirects: {},
      outputs: {},
    },
    pages,
    nav: {},
    data: {},
  };
}

/** A Markdown page whose body starts at `bodyLine` in `file`. */
function page(url: string, markdown: string, file = FILE, bodyLine = 1): Page {
  return {
    url,
    source: { file, line: bodyLine, column: 1, endLine: bodyLine, endColumn: 1 },
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown,
    kind: "doc",
  };
}

/** A context that keeps every diagnostic reported to it. */
function context(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("footnote-check never renders a page")),
    report: (diagnostic) => {
      reported.push(diagnostic);
    },
  };
  return { ctx, reported };
}

/** Runs the output and returns its files and everything it reported. */
async function run(model: Site): Promise<{ files: readonly OutputFile[]; reported: Diagnostic[] }> {
  const { ctx, reported } = context();
  const files = await footnoteCheck.run(model, ctx);
  return { files, reported };
}

test("a reference with a definition produces nothing", () => {
  assert.deepEqual(unresolvedFootnotes("Text[^1].\n\n[^1]: A note.\n", FILE, 1), []);
  assert.deepEqual(unresolvedFootnotes("Text[^Note].\n\n[^note]: A note.\n", FILE, 1), [], "GFM resolves labels by case");
});

test("GFM links a reference and its definition both ways, with ids that do not change between parses", async () => {
  const markdown = "Use it[^1].\n\n[^1]: A note.\n";
  const html = (await markdownToHtml(await parseMarkdown(markdown, 1), FILE)).html;
  const again = (await markdownToHtml(await parseMarkdown(markdown, 1), FILE)).html;

  assert.equal(again, html, "the ids are stable across builds");
  assert.match(html, /<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref/);
  assert.match(html, /<section data-footnotes class="footnotes">/);
  assert.match(html, /<li id="user-content-fn-1">/);
  assert.match(html, /href="#user-content-fnref-1" data-footnote-backref/);
});

test("a missing definition is reported at the reference's own line and column", async () => {
  const markdown = "# Install\n\nIntro\n\nMissing[^2].\n";
  const findings = unresolvedFootnotes(markdown, FILE, 10);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.label, "2");
  assert.deepEqual(findings[0]?.pos, {
    file: FILE,
    line: 14,
    column: 8,
    endLine: 14,
    endColumn: 11,
  });

  const { files, reported } = await run(site([page("/guide/install/", markdown, FILE, 10)]));
  assert.deepEqual(files, [], "the output writes no files");
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "footnote.missing-definition");
  assert.equal(reported[0]?.severity, "warning");
  assert.ok(reported[0]?.message.includes("[^2]"));
  assert.ok(reported[0]?.help?.includes("[^2]:"));
  assert.deepEqual(reported[0]?.pos, findings[0]?.pos);
});

test("every reference is reported, including repeated uses of one missing label, in document order", () => {
  const findings = unresolvedFootnotes("One[^a] two[^b] three[^a].\n", FILE, 1);
  assert.deepEqual(
    findings.map((finding) => [finding.label, finding.pos.line, finding.pos.column]),
    [
      ["a", 1, 4],
      ["b", 1, 12],
      ["a", 1, 22],
    ],
  );
});

test("an escaped reference is text, not a reference", () => {
  assert.deepEqual(unresolvedFootnotes("Not a reference \\[^1].\n", FILE, 1), []);
  assert.deepEqual(unresolvedFootnotes("One \\[^1] and two[^2].\n", FILE, 1).map((finding) => finding.label), ["2"]);
});

test("references inside fenced code and inline code are ignored", () => {
  const markdown = ["```", "fenced [^1]", "```", "", "Inline `[^2]` code.", "", "~~~md", "[^3]: code", "~~~", ""].join("\n");
  assert.deepEqual(unresolvedFootnotes(markdown, FILE, 1), []);
});

test("a definition's own marker is not an unresolved reference, and a reference inside a definition is checked", () => {
  const markdown = "Text[^1].\n\n[^1]: See also[^missing].\n";
  assert.deepEqual(
    unresolvedFootnotes(markdown, FILE, 1).map((finding) => [finding.label, finding.pos.line]),
    [["missing", 3]],
  );
});

test("ids and order are stable: the same pages give the same diagnostics on every run", async () => {
  const pages = [page("/b/", "B[^b].\n", "b.md"), page("/a/", "A[^a].\n", "a.md")];
  const once = await run(site(pages));
  const twice = await run(site([...pages].reverse()));

  assert.deepEqual(twice, once, "page order in the model does not change the report");
  assert.deepEqual(
    once.reported.map((diagnostic) => [diagnostic.id, diagnostic.pos?.file, diagnostic.pos?.line]),
    [
      ["footnote.missing-definition", "a.md", 1],
      ["footnote.missing-definition", "b.md", 1],
    ],
  );
  assert.equal(once.reported.length, 2);
});

test("HTML pages are not scanned for footnote references", async () => {
  const html = page("/page/", "<p>Missing[^1].</p>", "page.html");
  const { reported } = await run(site([html]));
  assert.deepEqual(reported, []);
});
