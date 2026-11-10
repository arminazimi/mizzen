import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";
import type { Ajv2020 as Ajv2020Class } from "ajv/dist/2020.js";

type Schema = { properties?: Record<string, Schema>; $defs?: Record<string, Schema>; $ref?: string; [key: string]: unknown };

const schema = JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8")) as Schema;
const contract = readFileSync(new URL("../src/contracts/config.ts", import.meta.url), "utf8");

// ajv is CommonJS: its default export is the class at run time, but its types name it.
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as typeof Ajv2020Class;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

/** The property names of `interface <name>` in the config contract. */
function contractKeys(name: string): string[] {
  const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(contract)?.[1];
  assert.ok(body, `interface ${name} is in the contract`);
  return [...body.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((m) => m[1]!);
}

const sorted = (keys: Iterable<string>) => [...keys].sort();

test("the schema is JSON Schema draft 2020-12 and closed", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
});

test("every key of SiteConfig is in the schema and vice versa, at every level", () => {
  const defs = schema.$defs!;
  assert.deepEqual(sorted(Object.keys(schema.properties!)), sorted(contractKeys("SiteConfig")));
  assert.deepEqual(sorted(Object.keys(defs.language!.properties!)), sorted(contractKeys("LanguageConfig")));
  assert.deepEqual(sorted(Object.keys(defs.defaultsEntry!.properties!)), sorted(contractKeys("DefaultsEntry")));
  assert.deepEqual(sorted(Object.keys(schema.properties!.repository!.properties!)), sorted(contractKeys("RepositoryConfig")));
  assert.deepEqual(sorted(Object.keys(schema.properties!.theme!.properties!)), sorted(contractKeys("ThemeConfig")));
  const search = (schema.properties!.search as { oneOf: Schema[] }).oneOf.find((s) => s.properties)!;
  assert.deepEqual(sorted(Object.keys(search.properties!)), sorted(contractKeys("SearchConfig")));
});

test("every property has a description", () => {
  const missing: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
    if (node === null || typeof node !== "object") return;
    const props = (node as Schema).properties;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (typeof (value as Schema).description !== "string" || (value as Schema).description === "") missing.push(`${path}.${key}`);
      }
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
  };
  walk(schema, "#");
  assert.deepEqual(missing, []);
});

test("the defaults in the schema match the documented SiteConfig defaults", () => {
  const p = schema.properties!;
  const defaults = Object.fromEntries(Object.entries(p).filter(([, v]) => "default" in v).map(([k, v]) => [k, v.default]));
  assert.deepEqual(defaults, {
    base: "",
    lang: "en",
    languages: [],
    source: ".",
    include: [],
    exclude: [],
    navigation: "_data/navigation.yml",
    defaults: [],
    search: {},
    redirects: {},
    outputs: {},
  });
  assert.equal(p.repository!.properties!.branch!.default, "main");
  assert.equal(p.repository!.properties!.dir!.default, "");
  const search = (p.search as { oneOf: Schema[] }).oneOf.find((s) => s.properties)!;
  assert.equal(search.properties!.text!.default, 300);
  // Documented in the contract's doc comments, so the two cannot drift.
  for (const text of ['Default `en`', 'Default `.`', 'Default `_data/navigation.yml`', 'Default `main`', 'Default `300`']) {
    assert.ok(contract.includes(text), text);
  }
});

test("valid configs pass", () => {
  const valid: unknown[] = [
    {},
    { title: "Example", base: "/example", url: "https://example.github.io", lang: "fa", dir: "rtl" },
    { languages: [{ code: "fa", name: "فارسی", prefix: "/fa" }, { code: "en", name: "English", prefix: "" }] },
    { source: "docs", include: [".well-known"], exclude: ["drafts"], navigation: "nav.yml" },
    { defaults: [{ path: "", values: { layout: "doc" } }, { path: "guide", values: {} }] },
    { repository: { url: "https://github.com/example/example" } },
    { repository: { url: "https://github.com/example/example", branch: "dev", dir: "docs" } },
    { theme: { name: "./my-theme", options: { anything: { goes: [1, 2] } } } },
    { search: false },
    { search: {} },
    { search: { text: 120 } },
    { redirects: { "/old/": "/new/", "/gone/": "https://example.com/" } },
    { outputs: { twins: false, llms: true } },
  ];
  for (const config of valid) assert.equal(validate(config), true, `${JSON.stringify(config)}: ${ajv.errorsText(validate.errors)}`);
});

test("invalid configs fail", () => {
  const invalid: Array<[string, unknown]> = [
    ["an unknown top-level key", { titel: "Typo" }],
    ["a key of the old config file", { baseurl: "/x" }],
    ["title not a string", { title: 3 }],
    ["url with a path", { url: "https://example.com/docs" }],
    ["url with a trailing slash", { url: "https://example.com/" }],
    ["url without a scheme", { url: "example.com" }],
    ["base without a leading slash", { base: "example" }],
    ["base with a trailing slash", { base: "/example/" }],
    ["base of only a slash", { base: "/" }],
    ["dir other than ltr or rtl", { dir: "auto" }],
    ["languages not a list", { languages: { code: "fa" } }],
    ["a language without a prefix", { languages: [{ code: "fa", name: "فارسی" }] }],
    ["a language with an extra key", { languages: [{ code: "fa", name: "فارسی", prefix: "/fa", rtl: true }] }],
    ["include not a list of strings", { include: [1] }],
    ["an empty source", { source: "" }],
    ["a defaults entry without values", { defaults: [{ path: "" }] }],
    ["a defaults entry with a scope", { defaults: [{ scope: { path: "" }, values: {} }] }],
    ["repository without a url", { repository: { branch: "main" } }],
    ["repository with an unknown key", { repository: { url: "https://github.com/e/e", source_dir: "docs" } }],
    ["theme with an unknown key", { theme: { color: "red" } }],
    ["theme options not an object", { theme: { options: [] } }],
    ["search true", { search: true }],
    ["search with an unknown key", { search: { depth: 2 } }],
    ["search text negative", { search: { text: -1 } }],
    ["search text not an integer", { search: { text: 1.5 } }],
    ["a redirect key without a leading slash", { redirects: { old: "/new/" } }],
    ["a redirect to a plain http URL", { redirects: { "/old/": "http://example.com/" } }],
    ["a redirect to a relative path", { redirects: { "/old/": "new/" } }],
    ["outputs with a non-boolean", { outputs: { twins: "off" } }],
    ["the whole config a list", []],
  ];
  for (const [name, config] of invalid) assert.equal(validate(config), false, name);
});
