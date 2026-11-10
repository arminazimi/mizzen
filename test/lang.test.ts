import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config/load.ts";
import { parseFrontMatter } from "../src/content/frontmatter.ts";
import { directionFromLang, pageLang } from "../src/content/lang.ts";
import type { FrontMatter } from "../src/contracts/index.ts";

const SITE = { lang: "en", languages: [] };
const FA_SITE = { lang: "en", languages: [{ code: "fa", name: "فارسی", prefix: "/fa" }] };

test("front matter lang and dir win over the path and the site", () => {
  assert.deepEqual(
    pageLang("fa/guide.md", { config: FA_SITE, frontMatter: { lang: "en-GB", dir: "rtl" } }),
    { lang: "en-GB", dir: "rtl" },
  );
  // Front matter lang alone: the direction derives from it, not from the path or the site.
  assert.deepEqual(pageLang("fa/guide.md", { config: FA_SITE, frontMatter: { lang: "de" } }), {
    lang: "de",
    dir: "ltr",
  });
  // Front matter dir alone: the language still resolves down the chain.
  assert.deepEqual(pageLang("fa/guide.md", { config: FA_SITE, frontMatter: { dir: "ltr" } }), {
    lang: "fa",
    dir: "ltr",
  });
});

test("a path under a configured language prefix resolves to that language", () => {
  assert.deepEqual(pageLang("fa/install.md", { config: FA_SITE }), { lang: "fa", dir: "rtl" });
  assert.deepEqual(pageLang("fa/reference/deploy.md", { config: FA_SITE }), {
    lang: "fa",
    dir: "rtl",
  });
  // A trailing slash on the prefix changes nothing.
  const slash = { lang: "en", languages: [{ code: "fa", name: "فارسی", prefix: "/fa/" }] };
  assert.deepEqual(pageLang("fa/install.md", { config: slash }), { lang: "fa", dir: "rtl" });
});

test("a prefix matches whole path segments only", () => {
  assert.deepEqual(pageLang("fabric.md", { config: FA_SITE }), { lang: "en", dir: "ltr" });
  assert.deepEqual(pageLang("faq.md", { config: FA_SITE }), { lang: "en", dir: "ltr" });
});

test("without a matching prefix the page takes the site lang", () => {
  assert.deepEqual(pageLang("guide/install.md", { config: FA_SITE }), { lang: "en", dir: "ltr" });
  assert.deepEqual(pageLang("guide.md", { config: SITE }), { lang: "en", dir: "ltr" });
  // An empty front matter lang falls through to the chain.
  assert.deepEqual(pageLang("fa/guide.md", { config: FA_SITE, frontMatter: { lang: "" } }), {
    lang: "fa",
    dir: "rtl",
  });
});

test("a right-to-left language derives rtl, case-insensitively", () => {
  assert.equal(directionFromLang("fa"), "rtl");
  assert.equal(directionFromLang("fa-IR"), "rtl");
  assert.equal(directionFromLang("he"), "rtl");
  assert.equal(directionFromLang("ur-PK"), "rtl");
  assert.equal(directionFromLang("AR"), "rtl");
  assert.equal(directionFromLang("en"), "ltr");
  assert.equal(directionFromLang("EN"), "ltr");
  assert.deepEqual(pageLang("guide.md", { config: { lang: "AR", languages: [] } }), {
    lang: "AR",
    dir: "rtl",
  });
});

test("front matter values that are not usable fall through to the chain", () => {
  // YAML can hold anything; the engine treats junk as unset rather than trusting it.
  const junk = { lang: 42, dir: "auto" } as unknown as FrontMatter;
  assert.deepEqual(pageLang("fa/guide.md", { config: FA_SITE, frontMatter: junk }), {
    lang: "fa",
    dir: "rtl",
  });
});

test("every page in fixtures/rtl-site resolves to fa and rtl", () => {
  const root = fileURLToPath(new URL("../fixtures/rtl-site", import.meta.url));
  const { config } = loadConfig(root, { path: join(root, "fixture.yml") });
  assert.equal(config.lang, "fa");
  assert.equal(config.dir, "rtl");

  for (const file of readdirSync(root).filter((f) => f.endsWith(".md"))) {
    const source = readFileSync(join(root, file), "utf8");
    const { data } = parseFrontMatter(source, file);
    const resolved = pageLang(file, { config, frontMatter: data as FrontMatter });
    assert.equal(resolved.lang, "fa", `${file}: lang`);
    assert.equal(resolved.dir, "rtl", `${file}: dir`);
  }
});

test("a Persian fixture page can still pin its own lang and dir", () => {
  const config = { lang: "fa", languages: [{ code: "fa", name: "فارسی", prefix: "" }] };
  assert.deepEqual(pageLang("guide.md", { config }), { lang: "fa", dir: "rtl" });
  assert.deepEqual(
    pageLang("en/guide.md", {
      config: { lang: "fa", languages: [{ code: "en", name: "English", prefix: "/en" }] },
    }),
    { lang: "en", dir: "ltr" },
  );
});
