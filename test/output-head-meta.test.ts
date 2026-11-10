import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FrontMatter, Page, Site, SiteConfig } from "../src/contracts/index.ts";
import type { Trail } from "../src/contracts/nav.ts";
import { navState } from "../src/nav/tree.ts";
import { buildModel } from "../src/model/build.ts";
import { headMeta } from "../src/outputs/head-meta.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

function config(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
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
    ...overrides,
  };
}

function site(cfg: SiteConfig = config()): Site {
  return { config: cfg, pages: [], nav: {}, data: {} };
}

function page(url: string, frontMatter: FrontMatter = {}, overrides: Partial<Page> = {}): Page {
  return {
    url,
    source: pos,
    frontMatter,
    title: "Install",
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
    ...overrides,
  };
}

const trail: Trail = [
  { title: "Guide", url: "/guide/" },
  { title: "Install", url: "/guide/install/" },
];

function metaValue(head: ReturnType<typeof headMeta>, key: string): string | undefined {
  return head.meta.find((tag) => tag.name === key)?.content;
}

function ldOf(head: ReturnType<typeof headMeta>, type: string): Readonly<Record<string, unknown>> | undefined {
  return head.jsonLd.find((ld) => ld["@type"] === type);
}

// The shapes the test checks come from schema.org: each type's required properties and the value types it expects.
// Only the objects Mizzen writes are covered; the list is the shape, not the whole vocabulary.
const ABSOLUTE = /^https?:\/\//;

function assertTechArticle(ld: Readonly<Record<string, unknown>>): void {
  assert.equal(ld["@context"], "https://schema.org");
  assert.equal(typeof ld.headline, "string", "TechArticle.headline is text");
  assert.notEqual(ld.headline, "", "TechArticle.headline is not empty");
  assert.equal(typeof ld.inLanguage, "string", "TechArticle.inLanguage is text");
  const publisher = ld.publisher as Record<string, unknown> | undefined;
  assert.equal(publisher?.["@type"], "Organization", "TechArticle.publisher is an Organization");
  assert.equal(typeof publisher?.name, "string", "Organization.name is text");
  if (ld.url !== undefined) assert.match(String(ld.url), ABSOLUTE, "TechArticle.url is absolute");
  if (ld.image !== undefined) assert.match(String(ld.image), ABSOLUTE, "TechArticle.image is absolute");
}

function assertWebSite(ld: Readonly<Record<string, unknown>>): void {
  assert.equal(ld["@context"], "https://schema.org");
  assert.equal(typeof ld.name, "string", "WebSite.name is text");
  assert.notEqual(ld.name, "", "WebSite.name is not empty");
  if (ld.url !== undefined) assert.match(String(ld.url), ABSOLUTE, "WebSite.url is absolute");
}

function assertBreadcrumbList(ld: Readonly<Record<string, unknown>>): void {
  assert.equal(ld["@context"], "https://schema.org");
  const items = ld.itemListElement;
  assert.ok(Array.isArray(items) && items.length > 0, "BreadcrumbList.itemListElement is a non-empty list");
  items.forEach((raw: unknown, index: number) => {
    const item = raw as Record<string, unknown>;
    assert.equal(item["@type"], "ListItem", "each entry is a ListItem");
    assert.equal(item.position, index + 1, "positions count from 1 in order");
    assert.equal(typeof item.name, "string", "ListItem.name is text");
    if (item.item !== undefined) assert.match(String(item.item), ABSOLUTE, "ListItem.item is absolute");
  });
}

function assertValidJsonLd(head: ReturnType<typeof headMeta>): void {
  for (const ld of head.jsonLd) {
    const type = ld["@type"];
    if (type === "TechArticle") assertTechArticle(ld);
    else if (type === "WebSite") assertWebSite(ld);
    else if (type === "BreadcrumbList") assertBreadcrumbList(ld);
    else assert.fail(`unexpected JSON-LD type ${String(type)}`);
    // Every value survives a JSON round trip, since the layout writes it as an application/ld+json script.
    assert.deepEqual(JSON.parse(JSON.stringify(ld)), ld);
  }
}

test("a doc page gets a title with the site name, a canonical link, Open Graph tags, and a TechArticle", () => {
  const head = headMeta(site(config({ title: "Example", url: "https://example.com" })), page("/guide/install/", { description: "How to install" }), trail);

  assert.equal(head.title, "Install | Example");
  assert.equal(metaValue(head, "description"), "How to install");
  assert.deepEqual(head.links, [{ rel: "canonical", href: "https://example.com/guide/install/" }]);
  assert.equal(metaValue(head, "og:type"), "article");
  assert.equal(metaValue(head, "og:title"), "Install");
  assert.equal(metaValue(head, "og:description"), "How to install");
  assert.equal(metaValue(head, "og:url"), "https://example.com/guide/install/");
  assert.equal(metaValue(head, "og:site_name"), "Example");
  assert.equal(metaValue(head, "twitter:card"), "summary");
  assert.equal(metaValue(head, "og:image"), undefined, "no image means no og:image");

  const article = ldOf(head, "TechArticle");
  assert.ok(article, "a doc page has a TechArticle");
  assert.equal(article.headline, "Install");
  assert.equal(article.description, "How to install");
  assert.equal(article.url, "https://example.com/guide/install/");
  assert.equal(article.inLanguage, "en");
  assert.deepEqual(article.publisher, { "@type": "Organization", name: "Example" });
});

test("the home page is a WebSite with the site description and no breadcrumb", () => {
  const cfg = config({ title: "Example", description: "A docs site", url: "https://example.com", base: "/example" });
  const head = headMeta(site(cfg), page("/example/", {}, { title: "Home", kind: "doc" }), []);

  assert.equal(head.title, "Example");
  assert.equal(metaValue(head, "description"), "A docs site");
  assert.equal(metaValue(head, "og:type"), "website");
  assert.equal(metaValue(head, "og:title"), "Example");
  assert.deepEqual(head.links, [{ rel: "canonical", href: "https://example.com/example/" }]);
  assert.equal(head.jsonLd.length, 1, "no trail means no BreadcrumbList");
  const web = ldOf(head, "WebSite");
  assert.ok(web);
  assert.equal(web.name, "Example");
  assert.equal(web.url, "https://example.com/example/");
  assert.equal(web.description, "A docs site");
  assertValidJsonLd(head);
});

test("front matter canonical_url and description win over the computed values", () => {
  const cfg = config({ title: "Example", url: "https://example.com", description: "Site summary" });
  const head = headMeta(
    site(cfg),
    page("/", { canonical_url: "https://original.example/install/", description: "Page summary" }, { url: "/" }),
    [],
  );
  assert.deepEqual(head.links, [{ rel: "canonical", href: "https://original.example/install/" }]);
  assert.equal(metaValue(head, "description"), "Page summary");
  assert.equal(metaValue(head, "og:url"), "https://original.example/install/");
  assert.equal(ldOf(head, "WebSite")?.description, "Page summary");
});

test("the home page falls back to the site description, but other pages do not", () => {
  const cfg = config({ title: "Example", url: "https://example.com", description: "Site summary" });
  const other = headMeta(site(cfg), page("/guide/install/"), trail);
  assert.equal(metaValue(other, "description"), undefined);
  assert.equal(metaValue(other, "og:description"), undefined);
  const home = headMeta(site(cfg), page("/", {}, { url: "/" }), []);
  assert.equal(metaValue(home, "description"), "Site summary");
});

test("without config.url there is no canonical link, no og:url, and no absolute image", () => {
  const head = headMeta(site(config({ title: "Example" })), page("/guide/install/", { image: "/social.png" }), trail);
  assert.deepEqual(head.links, []);
  assert.equal(metaValue(head, "og:url"), undefined);
  assert.equal(metaValue(head, "og:image"), undefined, "a relative image cannot become absolute");
  assert.equal(metaValue(head, "twitter:card"), "summary");
  const article = ldOf(head, "TechArticle");
  assert.equal(article?.url, undefined);
  assert.equal(article?.image, undefined);
  assertValidJsonLd(head);
});

test("an image front matter gives og:image and a large Twitter card; a path is made absolute and an https link is kept", () => {
  const cfg = config({ title: "Example", url: "https://example.com" });
  const local = headMeta(site(cfg), page("/guide/install/", { image: "/images/install.png" }), trail);
  assert.equal(metaValue(local, "og:image"), "https://example.com/images/install.png");
  assert.equal(metaValue(local, "twitter:card"), "summary_large_image");
  assert.equal(ldOf(local, "TechArticle")?.image, "https://example.com/images/install.png");

  const remote = headMeta(site(cfg), page("/guide/install/", { image: "https://cdn.example/card.png" }), trail);
  assert.equal(metaValue(remote, "og:image"), "https://cdn.example/card.png");
});

test("og: false drops Open Graph, Twitter, and the structured-data image but keeps the canonical link and the description", () => {
  const cfg = config({ title: "Example", url: "https://example.com" });
  const head = headMeta(
    site(cfg),
    page("/guide/install/", { og: false, image: "/images/install.png", description: "How to install" }),
    trail,
  );
  assert.deepEqual(head.links, [{ rel: "canonical", href: "https://example.com/guide/install/" }]);
  assert.equal(metaValue(head, "description"), "How to install");
  for (const key of ["og:type", "og:title", "og:description", "og:url", "og:site_name", "og:image", "twitter:card"]) {
    assert.equal(metaValue(head, key), undefined, `${key} is dropped`);
  }
  assert.equal(ldOf(head, "TechArticle")?.image, undefined, "the structured-data image is dropped");
  assert.equal(ldOf(head, "TechArticle")?.url, "https://example.com/guide/install/", "the canonical URL stays");
});

test("the breadcrumb lists the trail in order, with absolute item URLs, and leaves out item URLs without a site url", () => {
  const head = headMeta(site(config({ title: "Example", url: "https://example.com" })), page("/guide/install/"), trail);
  const crumbs = ldOf(head, "BreadcrumbList");
  assert.ok(crumbs);
  assert.deepEqual(crumbs.itemListElement, [
    { "@type": "ListItem", position: 1, name: "Guide", item: "https://example.com/guide/" },
    { "@type": "ListItem", position: 2, name: "Install", item: "https://example.com/guide/install/" },
  ]);
  assertValidJsonLd(head);

  const relative = headMeta(site(config({ title: "Example" })), page("/guide/install/"), trail);
  const relativeCrumbs = ldOf(relative, "BreadcrumbList");
  assert.deepEqual(relativeCrumbs?.itemListElement, [
    { "@type": "ListItem", position: 1, name: "Guide" },
    { "@type": "ListItem", position: 2, name: "Install" },
  ]);
  assertValidJsonLd(relative);
});

test("every JSON-LD object of every page of fixtures/docs-site matches its schema.org shape", async () => {
  const root = fileURLToPath(new URL("../fixtures/docs-site", import.meta.url));
  const { site: model } = await buildModel(root);
  const docs = model.pages.filter((p) => p.kind === "doc");
  assert.ok(docs.length > 0, "the fixture has doc pages");

  let withTrail = 0;
  for (const p of docs) {
    const listName = Object.keys(model.nav).find((name) => navState(model.nav[name] ?? [], p.url).trail.length > 0);
    const pageTrail = listName === undefined ? [] : navState(model.nav[listName] ?? [], p.url).trail;
    if (pageTrail.length > 0) withTrail += 1;
    const head = headMeta(model, p, pageTrail);
    assert.ok(head.title.length > 0, `${p.url} has a title`);
    assertValidJsonLd(head);
  }
  assert.ok(withTrail > 0, "some fixture pages have a breadcrumb");
});
