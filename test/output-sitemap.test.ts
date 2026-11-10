import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Page, Site } from "../src/contracts/content.ts";
import type { Diagnostic } from "../src/contracts/diagnostic.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { buildModel } from "../src/model/build.ts";
import { sitemap } from "../src/outputs/sitemap.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** The sitemap protocol's schema, sitemaps.org `sitemap/0.9/sitemap.xsd` (last modified 2008-03-26). */
const SITEMAP_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
            targetNamespace="http://www.sitemaps.org/schemas/sitemap/0.9"
            xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
            elementFormDefault="qualified">
  <xsd:annotation>
    <xsd:documentation>
      XML Schema for Sitemap files.
      Last Modifed 2008-03-26.
      The import is not in the published file: its extension points are strict, so the XHTML schema that declares
      xhtml:link has to be resolvable for a sitemap with alternates to validate.
    </xsd:documentation>
  </xsd:annotation>

  <xsd:import namespace="http://www.w3.org/1999/xhtml" schemaLocation="xhtml.xsd"/>

  <xsd:element name="urlset">
    <xsd:annotation>
      <xsd:documentation>
        Container for a set of up to 50,000 document elements.
        This is the root element of the XML file.
      </xsd:documentation>
    </xsd:annotation>
    <xsd:complexType>
      <xsd:sequence>
        <xsd:any namespace="##other" minOccurs="0" maxOccurs="unbounded" processContents="strict"/>
        <xsd:element name="url" type="tUrl" maxOccurs="unbounded"/>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>

  <xsd:complexType name="tUrl">
    <xsd:annotation>
      <xsd:documentation>
        Container for the data needed to describe a document to crawl.
      </xsd:documentation>
    </xsd:annotation>
    <xsd:sequence>
      <xsd:element name="loc" type="tLoc"/>
      <xsd:element name="lastmod" type="tLastmod" minOccurs="0"/>
      <xsd:element name="changefreq" type="tChangeFreq" minOccurs="0"/>
      <xsd:element name="priority" type="tPriority" minOccurs="0"/>
      <xsd:any namespace="##other" minOccurs="0" maxOccurs="unbounded" processContents="strict"/>
    </xsd:sequence>
  </xsd:complexType>

  <xsd:simpleType name="tLoc">
    <xsd:annotation>
      <xsd:documentation>
        REQUIRED: The location URI of a document.
        The URI must conform to RFC 2396 (http://www.ietf.org/rfc/rfc2396.txt).
      </xsd:documentation>
    </xsd:annotation>
    <xsd:restriction base="xsd:anyURI">
      <xsd:minLength value="12"/>
      <xsd:maxLength value="2048"/>
    </xsd:restriction>
  </xsd:simpleType>

  <xsd:simpleType name="tLastmod">
    <xsd:annotation>
      <xsd:documentation>
        OPTIONAL: The date the document was last modified. The date must conform
        to the W3C DATETIME format (http://www.w3.org/TR/NOTE-datetime).
        Example: 2005-05-10
        Lastmod may also contain a timestamp.
        Example: 2005-05-10T17:33:30+08:00
      </xsd:documentation>
    </xsd:annotation>
    <xsd:union>
      <xsd:simpleType>
        <xsd:restriction base="xsd:date"/>
      </xsd:simpleType>
      <xsd:simpleType>
        <xsd:restriction base="xsd:dateTime"/>
      </xsd:simpleType>
    </xsd:union>
  </xsd:simpleType>

  <xsd:simpleType name="tChangeFreq">
    <xsd:annotation>
      <xsd:documentation>
        OPTIONAL: Indicates how frequently the content at a particular URL is
        likely to change. The value "always" should be used to describe
        documents that change each time they are accessed. The value "never"
        should be used to describe archived URLs. Please note that web
        crawlers may not necessarily crawl pages marked "always" more often.
        Consider this element as a friendly suggestion and not a command.
      </xsd:documentation>
    </xsd:annotation>
    <xsd:restriction base="xsd:string">
      <xsd:enumeration value="always"/>
      <xsd:enumeration value="hourly"/>
      <xsd:enumeration value="daily"/>
      <xsd:enumeration value="weekly"/>
      <xsd:enumeration value="monthly"/>
      <xsd:enumeration value="yearly"/>
      <xsd:enumeration value="never"/>
    </xsd:restriction>
  </xsd:simpleType>

  <xsd:simpleType name="tPriority">
    <xsd:annotation>
      <xsd:documentation>
        OPTIONAL: The priority of a particular URL relative to other pages
        on the same site. The value for this element is a number between
        0.0 and 1.0 where 0.0 identifies the lowest priority page(s).
        The default priority of a page is 0.5. Priority is used to select
        between pages on your site. Setting a priority of 1.0 for all URLs
        will not help you, as the relative priority of pages on your site
        is what will be considered.
      </xsd:documentation>
    </xsd:annotation>
    <xsd:restriction base="xsd:decimal">
      <xsd:minInclusive value="0.0"/>
      <xsd:maxInclusive value="1.0"/>
    </xsd:restriction>
  </xsd:simpleType>

</xsd:schema>
`;

/** The part of XHTML that a sitemap's `xhtml:link` alternates use, so the strict extension point can check them. */
const XHTML_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
            targetNamespace="http://www.w3.org/1999/xhtml"
            xmlns="http://www.w3.org/1999/xhtml"
            elementFormDefault="qualified">
  <xsd:annotation>
    <xsd:documentation>The link element of XHTML, as a sitemap's hreflang alternates write it.</xsd:documentation>
  </xsd:annotation>

  <xsd:element name="link">
    <xsd:complexType>
      <xsd:attribute name="rel" type="xsd:string" use="required"/>
      <xsd:attribute name="hreflang" type="xsd:string" use="required"/>
      <xsd:attribute name="href" type="xsd:anyURI" use="required"/>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>
`;

function site(pages: readonly Page[], url?: string | null, base = "", config: Partial<Site["config"]> = {}): Site {
  return {
    config: {
      title: "Example",
      ...(url === undefined || url === null ? {} : { url }),
      base,
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
      ...config,
    },
    pages,
    nav: {},
    data: {},
  };
}

function page(url: string, kind: Page["kind"] = "doc", frontMatter: Page["frontMatter"] = {}, lang = "en"): Page {
  return {
    url,
    source: pos,
    frontMatter,
    title: url,
    lang,
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind,
  };
}

/** A multilingual site: the default language at the root and two prefixed ones. */
const LANGUAGES = [
  { code: "en", name: "English", prefix: "" },
  { code: "fa", name: "فارسی", prefix: "/fa" },
  { code: "de", name: "Deutsch", prefix: "/de" },
] as const;

/** A context that keeps every diagnostic, so a test can check what the output reported. */
function collecting(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  const ctx: OutputContext = {
    renderPage: () => Promise.reject(new Error("the sitemap never renders a page")),
    report: (d) => reported.push(d),
  };
  return { ctx, reported };
}

async function sitemapXml(model: Site): Promise<string> {
  const { ctx, reported } = collecting();
  const files: readonly OutputFile[] = await sitemap.run(model, ctx);
  assert.deepEqual(reported, [], "no diagnostic for a valid site");
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "sitemap.xml");
  return String(files[0]?.contents);
}

/** The `<loc>` values of a sitemap, in the order they appear. */
function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1] ?? "");
}

/**
 * A `<loc>` value and an alternate's `[hreflang, href]` pair, in document order, so a test sees both the order of
 * the entries and where each alternate sits.
 */
function addresses(xml: string): string[][] {
  return [...xml.matchAll(/<loc>([^<]*)<\/loc>|hreflang="([^"]*)" href="([^"]*)"/g)].map((m) =>
    m[1] === undefined ? [m[2] ?? "", m[3] ?? ""] : ["loc", m[1]],
  );
}

test("every doc page of fixtures/docs-site gets an absolute URL, and sitemap: false and app pages are left out", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: built } = await buildModel(root);
  // The fixture has no mizzen.yml, so its config has no `url`; the sitemap needs one, so the test sets it.
  const model: Site = { ...built, config: { ...built.config, url: "https://example.com" } };
  const xml = await sitemapXml(model);

  const expected = model.pages
    .filter((p) => p.kind === "doc" && p.frontMatter.sitemap !== false)
    .map((p) => `https://example.com${p.url}`)
    .sort();
  assert.ok(model.pages.some((p) => p.url === "/quickstart/" && p.kind === "doc"), "the fixture has a doc at /quickstart/");
  assert.ok(model.pages.some((p) => p.kind === "app"), "the fixture has an app page");
  assert.deepEqual(locs(xml).slice().sort(), expected);
  assert.ok(!locs(xml).some((u) => u.includes("/dashboard/")), "the app page is not in the sitemap");
});

test("the sitemap is exactly what the protocol describes for a site with a base and an updated page", async () => {
  const model = site(
    [
      page("/evergreen/guide/install/", "doc"),
      page("/evergreen/", "doc", { updated: "2026-11-01" }),
      page("/evergreen/hidden/", "doc", { sitemap: false }),
      page("/evergreen/dashboard/", "app"),
      page("/evergreen/logo.svg", "asset"),
    ],
    "https://arminazimi.github.io/",
    "/evergreen",
  );
  assert.equal(
    await sitemapXml(model),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "  <url>",
      "    <loc>https://arminazimi.github.io/evergreen/</loc>",
      "    <lastmod>2026-11-01</lastmod>",
      "  </url>",
      "  <url>",
      "    <loc>https://arminazimi.github.io/evergreen/guide/install/</loc>",
      "  </url>",
      "</urlset>",
      "",
    ].join("\n"),
  );
});

test("lastmod is the updated date as YYYY-MM-DD; a time after it is dropped, and a missing or impossible date is left out", async () => {
  const model = site(
    [
      page("/a/", "doc", { updated: "2026-10-18 09:30:00 +0330" }),
      page("/b/", "doc", { updated: "2026-02-30" }),
      page("/c/", "doc", { updated: "soon" }),
      page("/d/", "doc", { date: "2026-01-01" }),
      page("/e/", "doc", { updated: 20261018 }),
    ],
    "https://x.io",
  );
  const xml = await sitemapXml(model);
  assert.deepEqual(
    [...xml.matchAll(/<url>\n {4}<loc>([^<]*)<\/loc>(?:\n {4}<lastmod>([^<]*)<\/lastmod>)?/g)].map((m) => [m[1], m[2] ?? null]),
    [
      ["https://x.io/a/", "2026-10-18"],
      ["https://x.io/b/", null],
      ["https://x.io/c/", null],
      ["https://x.io/d/", null],
      ["https://x.io/e/", null],
    ],
  );
});

test("a site without a url writes no sitemap and warns, and so does a url that is not absolute", async () => {
  const pages = [page("/guide/", "doc")];
  for (const url of [undefined, "", "   ", "example.com"]) {
    const { ctx, reported } = collecting();
    const files = await sitemap.run(site(pages, url), ctx);
    assert.deepEqual(files, [], `url ${JSON.stringify(url)}`);
    assert.equal(reported.length, 1, `url ${JSON.stringify(url)}`);
    assert.equal(reported[0]?.severity, "warning");
    assert.match(reported[0]?.id ?? "", /^sitemap\.(no-url|invalid-url)$/);
  }
});

test("a URL that has characters XML reserves is escaped, and a non-ASCII URL is percent-encoded", async () => {
  const model = site([page("/q&a/", "doc"), page("/café/", "doc")], "https://x.io");
  const xml = await sitemapXml(model);
  assert.deepEqual(locs(xml), ["https://x.io/caf%C3%A9/", "https://x.io/q&amp;a/"]);
});

test("entries come back sorted by URL, whatever order the model listed them in", async () => {
  const model = site([page("/b/", "doc"), page("/a/c/", "doc"), page("/a/", "doc")], "https://x.io");
  assert.deepEqual(locs(await sitemapXml(model)), ["https://x.io/a/", "https://x.io/a/c/", "https://x.io/b/"]);
});

test("a translated page lists every language plus x-default, in language order", async () => {
  const model = site(
    [
      page("/guide/", "doc", { translation_key: "guide" }),
      page("/fa/guide/", "doc", { translation_key: "guide" }, "fa"),
      page("/de/guide/", "doc", { translation_key: "guide" }, "de"),
      page("/fa/", "doc", {}, "fa"),
    ],
    "https://x.io",
    "",
    { languages: LANGUAGES },
  );
  const xml = await sitemapXml(model);
  assert.ok(
    xml.includes(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ),
    "the XHTML namespace is declared when alternates exist",
  );
  assert.deepEqual(addresses(xml), [
    ["loc", "https://x.io/de/guide/"],
    ["de", "https://x.io/de/guide/"],
    ["en", "https://x.io/guide/"],
    ["fa", "https://x.io/fa/guide/"],
    ["x-default", "https://x.io/guide/"],
    // The untranslated home page has no alternates, even on a multilingual site.
    ["loc", "https://x.io/fa/"],
    ["loc", "https://x.io/fa/guide/"],
    ["de", "https://x.io/de/guide/"],
    ["en", "https://x.io/guide/"],
    ["fa", "https://x.io/fa/guide/"],
    ["x-default", "https://x.io/guide/"],
    ["loc", "https://x.io/guide/"],
    ["de", "https://x.io/de/guide/"],
    ["en", "https://x.io/guide/"],
    ["fa", "https://x.io/fa/guide/"],
    ["x-default", "https://x.io/guide/"],
  ]);
});

test("x-default points at the site's default language, whatever sorts first", async () => {
  const model = site(
    [
      page("/guide/", "doc", { translation_key: "guide" }),
      page("/fa/guide/", "doc", { translation_key: "guide" }, "fa"),
      page("/de/guide/", "doc", { translation_key: "guide" }, "de"),
    ],
    "https://x.io",
    "",
    { lang: "fa", languages: LANGUAGES },
  );
  const xml = await sitemapXml(model);
  assert.match(xml, /hreflang="x-default" href="https:\/\/x\.io\/fa\/guide\/"/);
});

test("a translation left out of the sitemap is not advertised as an alternate", async () => {
  const model = site(
    [
      page("/guide/", "doc", { translation_key: "guide" }),
      page("/fa/guide/", "doc", { translation_key: "guide", sitemap: false }, "fa"),
    ],
    "https://x.io",
    "",
    { languages: LANGUAGES },
  );
  const xml = await sitemapXml(model);
  assert.deepEqual(locs(xml), ["https://x.io/guide/"]);
  assert.ok(!xml.includes("xhtml"), "one language left, so no alternates and no XHTML namespace");
});

test("alternates are escaped like the URLs they point at", async () => {
  const model = site(
    [
      page("/q&a/", "doc", { translation_key: "qa" }),
      page("/fa/q&a/", "doc", { translation_key: "qa" }, "fa"),
    ],
    "https://x.io",
    "",
    { languages: LANGUAGES },
  );
  assert.deepEqual(addresses(await sitemapXml(model)), [
    ["loc", "https://x.io/fa/q&amp;a/"],
    ["en", "https://x.io/q&amp;a/"],
    ["fa", "https://x.io/fa/q&amp;a/"],
    ["x-default", "https://x.io/q&amp;a/"],
    ["loc", "https://x.io/q&amp;a/"],
    ["en", "https://x.io/q&amp;a/"],
    ["fa", "https://x.io/fa/q&amp;a/"],
    ["x-default", "https://x.io/q&amp;a/"],
  ]);
});

test("a single-language site keeps today's sitemap byte for byte, even with languages configured", async () => {
  const model = site([page("/guide/install/", "doc", { updated: "2026-11-01" }), page("/", "doc")], "https://x.io", "", {
    languages: LANGUAGES,
  });
  assert.equal(
    await sitemapXml(model),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "  <url>",
      "    <loc>https://x.io/</loc>",
      "  </url>",
      "  <url>",
      "    <loc>https://x.io/guide/install/</loc>",
      "    <lastmod>2026-11-01</lastmod>",
      "  </url>",
      "</urlset>",
      "",
    ].join("\n"),
  );
});

test("alternates come out the same whatever order the model listed its pages in", async () => {
  const pages = [
    page("/guide/", "doc", { translation_key: "guide" }),
    page("/fa/guide/", "doc", { translation_key: "guide" }, "fa"),
    page("/de/guide/", "doc", { translation_key: "guide" }, "de"),
    page("/fa/", "doc", {}, "fa"),
    page("/de/", "doc", {}, "de"),
  ];
  const config = { languages: LANGUAGES };
  const forward = await sitemapXml(site(pages, "https://x.io", "", config));
  const backward = await sitemapXml(site([...pages].reverse(), "https://x.io", "", config));
  assert.equal(forward, backward);
  assert.match(forward, /x-default/);
});

test("a site with no doc pages writes an empty urlset, which the protocol allows", async () => {
  const xml = await sitemapXml(site([page("/logo.svg", "asset")], "https://x.io"));
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>'));
});

/** Validate a sitemap with xmllint against the sitemap XSD and the XHTML XSD its alternates use. */
function assertValidSitemap(xml: string): void {
  const dir = mkdtempSync(join(tmpdir(), "sitemap-xsd-"));
  try {
    const xsd = join(dir, "sitemap.xsd");
    const file = join(dir, "sitemap.xml");
    writeFileSync(xsd, SITEMAP_XSD);
    writeFileSync(join(dir, "xhtml.xsd"), XHTML_XSD);
    writeFileSync(file, xml);
    const run = spawnSync("xmllint", ["--noout", "--schema", xsd, file], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hasXmllint = !spawnSync("xmllint", ["--version"]).error;

test(
  "the sitemap validates against the sitemap XSD",
  { skip: hasXmllint ? false : "xmllint is not installed" },
  async () => {
    const model = site(
      [
        page("/evergreen/", "doc", { updated: "2026-11-01" }),
        page("/evergreen/q&a/", "doc", { updated: "2026-10-18 09:30:00 +0330" }),
        page("/evergreen/café/", "doc"),
        page("/evergreen/hidden/", "doc", { sitemap: false }),
      ],
      "https://arminazimi.github.io",
      "/evergreen",
    );
    assertValidSitemap(await sitemapXml(model));
  },
);

test(
  "a sitemap with alternates validates against the sitemap XSD",
  { skip: hasXmllint ? false : "xmllint is not installed" },
  async () => {
    const model = site(
      [
        page("/evergreen/guide/", "doc", { translation_key: "guide", updated: "2026-11-01" }),
        page("/evergreen/fa/guide/", "doc", { translation_key: "guide" }, "fa"),
        page("/evergreen/de/guide/", "doc", { translation_key: "guide" }, "de"),
        page("/evergreen/q&a/", "doc", { translation_key: "qa" }),
        page("/evergreen/fa/q&a/", "doc", { translation_key: "qa" }, "fa"),
      ],
      "https://arminazimi.github.io",
      "/evergreen",
      { languages: LANGUAGES },
    );
    assertValidSitemap(await sitemapXml(model));
  },
);
