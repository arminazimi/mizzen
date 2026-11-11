import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Heading, Page, Site, SourcePos } from "../src/contracts/index.ts";
import { buildModel } from "../src/model/build.ts";
import { rankPages } from "../src/packs/rank.ts";

function pos(file: string): SourcePos {
  return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
}

interface PageOptions {
  readonly title?: string;
  readonly headings?: readonly string[];
  readonly html?: string;
  readonly markdown?: string;
  readonly source?: string;
}

function page(url: string, options: PageOptions = {}): Page {
  const source = options.source ?? "guide/page.md";
  const headings: Heading[] = (options.headings ?? []).map((text, index) => ({
    depth: 2,
    id: `heading-${index}`,
    text,
    pos: pos(source),
  }));
  return {
    url,
    source: pos(source),
    frontMatter: {},
    title: options.title ?? "Page",
    lang: "en",
    dir: "ltr",
    headings,
    html: options.html ?? "",
    markdown: options.markdown ?? "",
    kind: "doc",
  };
}

/** The five-page fixture the acceptance criteria ask for: three guide pages, a reference page, and an about page. */
function fivePages(): readonly Page[] {
  return [
    page("/reference/cli/", {
      title: "CLI reference",
      html: "<p>Run the command.</p><p>The install flag prints help.</p>",
    }),
    page("/guide/deploy/", {
      title: "Deploy the site",
      html: '<p>Build the site and install it behind a proxy.</p><p>Install again after a release.</p><a href="/guide/configure/">Configure first</a>',
    }),
    page("/guide/configure/", {
      title: "Configure the site",
      html:
        '<p>Install the engine, then install the plugin.</p><p>Install notes cover install order.</p><a href="/guide/deploy/">Deploy</a>',
    }),
    page("/guide/install/", {
      title: "Install the engine",
      headings: ["Install"],
      html: '<p>Download the package.</p><a href="/guide/configure/">Next</a>',
    }),
    page("/about/", {
      title: "About",
      html: "<p>A page about the project.</p>",
    }),
  ];
}

test("five pages rank by query terms and inbound links", () => {
  const ranked = rankPages(fivePages(), "install");

  assert.deepEqual(
    ranked.map((entry) => entry.page.url),
    ["/guide/install/", "/guide/configure/", "/guide/deploy/", "/reference/cli/", "/about/"],
  );
  assert.equal(ranked[0]?.score, 12);
  assert.equal(ranked[0]?.inboundLinks, 0);
  assert.equal(ranked[1]?.score, 6);
  assert.equal(ranked[1]?.inboundLinks, 2);
  assert.equal(ranked[2]?.inboundLinks, 1);
  assert.equal(ranked[4]?.score, 0);
});

test("title, headings, and body carry their documented weights, and headings are not counted as body", () => {
  const ranked = rankPages(
    [
      page("/body/", { title: "Other", html: "<p>Install once.</p>" }),
      page("/heading/", { title: "Other", headings: ["Install"], html: "<h2>Install</h2><p>Nothing.</p>" }),
      page("/title/", { title: "Install", html: "<p>Nothing.</p>" }),
      page("/none/", { title: "Other", html: "<p>Nothing.</p>" }),
    ],
    "install",
  );

  assert.deepEqual(
    ranked.map((entry) => entry.page.url),
    ["/title/", "/heading/", "/body/", "/none/"],
  );
  assert.deepEqual(ranked.map((entry) => entry.score), [8, 4, 1, 0]);
});

test("the same input always gives the same order, with URL code points breaking ties", () => {
  const pages = [page("/m/", { title: "Same" }), page("/z/", { title: "Same" }), page("/a/", { title: "Same" })];
  const before = pages.map((entry) => entry.url);

  const first = rankPages(pages, "same");
  const second = rankPages([...pages].reverse(), "same");

  assert.deepEqual(first.map((entry) => entry.page.url), ["/a/", "/m/", "/z/"]);
  assert.deepEqual(second.map((entry) => entry.page.url), first.map((entry) => entry.page.url));
  assert.deepEqual(second.map((entry) => entry.score), first.map((entry) => entry.score));
  assert.deepEqual(pages.map((entry) => entry.url), before, "ranking does not mutate the input");
});

test("an empty or stopword-only query returns every page with score zero, ordered by URL", () => {
  const expected = ["/about/", "/guide/configure/", "/guide/deploy/", "/guide/install/", "/reference/cli/"];

  for (const query of ["", "   ", "the and of", "The OF this", "در و از"]) {
    const ranked = rankPages(fivePages(), query);
    assert.deepEqual(ranked.map((entry) => entry.page.url), expected, query);
    assert.ok(ranked.every((entry) => entry.score === 0), query);
  }
});

test("duplicate query terms count once", () => {
  const once = rankPages(fivePages(), "install");
  const twice = rankPages(fivePages(), "install install INSTALL");

  assert.deepEqual(twice.map((entry) => entry.page.url), once.map((entry) => entry.page.url));
  assert.deepEqual(twice.map((entry) => entry.score), once.map((entry) => entry.score));
});

test("Persian and Arabic forms match across ZWNJ, letter variants, and diacritics", () => {
  const pages = [
    page("/fa/a/", { title: "می‌رود", html: "<p>متن</p>" }),
    page("/fa/b/", { title: "ميرود", html: "<p>متن</p>" }),
    page("/fa/c/", { title: "کتاب", html: "<p>متن</p>" }),
    page("/fa/d/", { title: "كِتَاب", html: "<p>متن</p>" }),
    page("/fa/e/", { title: "دیگر", html: "<p>متن</p>" }),
  ];

  for (const query of ["میرود", "می‌رود", "ميرود"]) {
    const ranked = rankPages(pages, query);
    assert.deepEqual(
      ranked.slice(0, 2).map((entry) => entry.page.url),
      ["/fa/a/", "/fa/b/"],
      query,
    );
    assert.ok(ranked.slice(2).every((entry) => entry.score === 0), query);
  }

  const ketab = rankPages(pages, "کتاب");
  assert.deepEqual(
    ketab.slice(0, 2).map((entry) => entry.page.url),
    ["/fa/c/", "/fa/d/"],
  );
  assert.ok(ketab.slice(2).every((entry) => entry.score === 0));
});

test("inbound links raise an equal match, with and without the site base", () => {
  const pages = [
    page("/docs/guide/a/", { title: "Alpha", html: '<p>Alpha</p><a href="/guide/b/">B</a>' }),
    page("/docs/guide/b/", { title: "Alpha", html: "<p>Alpha</p>" }),
  ];

  for (const options of [{ base: "/docs" }, {}]) {
    const ranked = rankPages(pages, "alpha", options);
    assert.deepEqual(
      ranked.map((entry) => entry.page.url),
      ["/docs/guide/b/", "/docs/guide/a/"],
      JSON.stringify(options),
    );
    assert.equal(ranked[0]?.inboundLinks, 1);
  }
});

test("a page with only Markdown contributes links through permalink", () => {
  const pages = [
    page("/guide/a/", { title: "Alpha", source: "guide/a.md", markdown: "[Beta](b.md)" }),
    page("/guide/b/", { title: "Alpha", source: "guide/b.md" }),
  ];

  const ranked = rankPages(pages, "alpha");
  assert.deepEqual(ranked.map((entry) => entry.page.url), ["/guide/b/", "/guide/a/"]);
  assert.equal(ranked[0]?.inboundLinks, 1);
});

test("self-links are ignored, repeated links count once per page, and anchors and queries still name the page", () => {
  const pages = [
    page("/z/", {
      title: "Alpha",
      html: '<a href="/z/">self</a><a href="/b/?from=z#top">B</a><a href="/b/">B again</a>',
    }),
    page("/a/", { title: "Alpha" }),
    page("/b/", { title: "Alpha" }),
    page("/c/", { title: "Alpha", html: '<a href="/b/">B</a>' }),
  ];

  const ranked = rankPages(pages, "alpha");
  assert.deepEqual(
    ranked.map((entry) => entry.page.url),
    ["/b/", "/a/", "/c/", "/z/"],
  );
  assert.equal(ranked[0]?.inboundLinks, 2);
});

/** The fixture root, one folder per focused ranking fixture. */
const FIXTURES = fileURLToPath(new URL("../fixtures/packs-rank/", import.meta.url));

/** Built models, so a fixture is read once per test run. */
const models = new Map<string, Promise<Site>>();

/** The model of one fixture site. */
function fixture(name: string): Promise<Site> {
  let model = models.get(name);
  if (model === undefined) {
    model = buildModel(join(FIXTURES, name)).then((result) => result.site);
    models.set(name, model);
  }
  return model;
}

test("navigation proximity raises an equal lexical match near the task focus", () => {
  const pages = [
    page("/guide/configure/", { title: "Install", html: "<p>Steps.</p>" }),
    page("/reference/cli/", { title: "Install", html: "<p>Steps.</p>" }),
    page("/guide/install/", { title: "Install", html: "<p>Steps.</p>" }),
  ];

  const ranked = rankPages(pages, "install", { focus: "/guide/install/" });
  assert.deepEqual(
    ranked.map((entry) => entry.page.url),
    ["/guide/install/", "/guide/configure/", "/reference/cli/"],
  );
  assert.ok(ranked[0]?.reasons.some((reason) => reason.factor === "navigation"));
  assert.ok(ranked[1]?.reasons.some((reason) => reason.factor === "navigation"));
  assert.ok(ranked[2]?.reasons.every((reason) => reason.factor !== "navigation"));
});

test("docs fixture: the primary page and the supporting page it requires rank first", async () => {
  const site = await fixture("docs");
  const ranked = rankPages(site.pages, "install", { focus: "/guide/install/" });

  assert.deepEqual(
    ranked.slice(0, 2).map((entry) => entry.page.url),
    ["/guide/install/", "/guide/requirements/"],
  );
  assert.equal(ranked[0]?.reasons.find((reason) => reason.factor === "navigation")?.code, "focus:/guide/install/");

  const supporting = ranked[1];
  assert.ok(Math.abs((supporting?.score ?? 0) - 4.8) < 1e-9);
  assert.equal(supporting?.reasons.length, 1);
  assert.equal(supporting?.reasons[0]?.factor, "dependency");
  assert.equal(supporting?.reasons[0]?.code, "dependency:/guide/install/");
});

test("docs fixture: a generated duplicate stays behind its canonical source with a trust reason", async () => {
  const site = await fixture("docs");
  const ranked = rankPages(site.pages, "configuration");
  const generated = ranked.find((entry) => entry.page.url === "/reference/config-generated/");

  assert.deepEqual(
    ranked.slice(0, 2).map((entry) => entry.page.url),
    ["/reference/config/", "/reference/config-generated/"],
  );
  assert.ok(ranked[0]!.score > generated!.score);
  assert.ok(
    generated?.reasons.some((reason) => reason.factor === "trust" && reason.code === "generated" && reason.contribution < 0),
  );
  assert.ok(generated?.reasons.some((reason) => reason.code === "status:beta" && reason.contribution < 0));
  assert.ok(ranked[0]?.reasons.every((reason) => reason.code !== "generated"));
});

test("versions fixture: version and locale duplicates carry reasons naming the canonical page", async () => {
  const site = await fixture("versions");
  const ranked = rankPages(site.pages, "install", { focus: "/v2/guide/install/", lang: "en" });

  assert.deepEqual(
    ranked.slice(0, 2).map((entry) => entry.page.url),
    ["/v2/guide/install/", "/v2/guide/requirements/"],
  );

  const old = ranked.find((entry) => entry.page.url === "/v1/guide/install/");
  assert.ok(old?.reasons.some((reason) => reason.factor === "version" && reason.code === "version:v1" && reason.contribution < 0));
  assert.ok(
    old?.reasons.some(
      (reason) =>
        reason.factor === "trust" && reason.code === "duplicate:/v2/guide/install/" && reason.contribution < 0,
    ),
  );

  const translation = ranked.find((entry) => entry.page.url === "/fa/guide/install/");
  assert.ok(
    translation?.reasons.some((reason) => reason.factor === "locale" && reason.code === "locale:fa" && reason.contribution < 0),
  );
  assert.ok(
    translation?.reasons.some((reason) => reason.code === "duplicate:/v2/guide/install/" && reason.contribution < 0),
  );
  const canonicalIndex = ranked.findIndex((entry) => entry.page.url === "/v2/guide/install/");
  const translationIndex = ranked.findIndex((entry) => entry.page.url === "/fa/guide/install/");
  assert.ok(canonicalIndex >= 0 && translationIndex > canonicalIndex);
});

test("dependency-only requirements inherit version and duplicate handling from their canonical version", () => {
  const pages = [
    page("/v1/guide/install/", {
      title: "Install the engine",
      source: "v1/guide/install.md",
      html: '<p>Install the old package.</p><a href="/v1/guide/requirements/">Requirements</a>',
    }),
    page("/v1/guide/requirements/", {
      title: "Requirements",
      source: "v1/guide/requirements.md",
      html: "<p>Node 20 or newer.</p>",
    }),
    page("/v2/guide/install/", {
      title: "Install the engine",
      source: "v2/guide/install.md",
      html: '<p>Install the engine once.</p><a href="/v2/guide/requirements/">Requirements</a>',
    }),
    page("/v2/guide/requirements/", {
      title: "Requirements",
      source: "v2/guide/requirements.md",
      html: "<p>Node 24 or newer.</p>",
    }),
  ];

  const ranked = rankPages(pages, "install");
  const v1 = ranked.find((entry) => entry.page.url === "/v1/guide/requirements/");
  const v2 = ranked.find((entry) => entry.page.url === "/v2/guide/requirements/");
  assert.ok(v1 !== undefined && v2 !== undefined);

  assert.ok(
    v1.reasons.every((reason) => reason.factor !== "lexical"),
    "the requirements page does not match the query",
  );
  assert.ok(
    v1.reasons.some((reason) => reason.factor === "version" && reason.code === "version:v1" && reason.contribution < 0),
  );
  assert.ok(
    v1.reasons.some(
      (reason) =>
        reason.factor === "trust" && reason.code === "duplicate:/v2/guide/requirements/" && reason.contribution < 0,
    ),
  );
  assert.ok(v2.reasons.some((reason) => reason.code === "canonical" && reason.contribution === 0));
  assert.ok(v2.score > v1.score);
  assert.ok(ranked.indexOf(v2) < ranked.indexOf(v1));

  for (const entry of [v1, v2]) {
    assert.equal(entry.score, entry.reasons.reduce((sum, reason) => sum + reason.contribution, 0), entry.page.url);
  }

  const reversed = rankPages([...pages].reverse(), "install");
  assert.deepEqual(
    reversed.map((entry) => ({ url: entry.page.url, score: entry.score, reasons: entry.reasons })),
    ranked.map((entry) => ({ url: entry.page.url, score: entry.score, reasons: entry.reasons })),
  );
});

test("every selected item exposes reasons whose contributions add up to its score", async () => {
  const runs = [
    rankPages((await fixture("docs")).pages, "install", { focus: "/guide/install/" }),
    rankPages((await fixture("docs")).pages, "configuration"),
    rankPages((await fixture("versions")).pages, "install", { focus: "/v2/guide/install/", lang: "en" }),
  ];

  for (const ranked of runs) {
    const selected = ranked.filter((entry) => entry.score > 0);
    assert.ok(selected.length > 0);
    for (const entry of selected) {
      assert.ok(entry.reasons.length > 0, entry.page.url);
      assert.equal(entry.score, entry.reasons.reduce((sum, reason) => sum + reason.contribution, 0), entry.page.url);
      for (const reason of entry.reasons) {
        assert.equal(typeof reason.factor, "string");
        assert.equal(typeof reason.code, "string");
        assert.ok(Number.isFinite(reason.contribution));
      }
    }
  }
});

test("equivalent fixture input gives an identical ranking and identical reasons", async () => {
  const site = await fixture("versions");
  const options = { focus: "/v2/guide/install/", lang: "en" };
  const project = (ranked: ReturnType<typeof rankPages>) =>
    ranked.map((entry) => ({ url: entry.page.url, score: entry.score, reasons: entry.reasons }));

  const forward = project(rankPages(site.pages, "install", options));
  const reversed = project(rankPages([...site.pages].reverse(), "install", options));

  assert.deepEqual(reversed, forward);
});
