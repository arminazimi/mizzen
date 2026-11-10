import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Island } from "../src/contracts/index.ts";
import { buildIsland, buildIslandModules, islandScript, islandUrl, minifyJs, stripTypes } from "../src/render/islands.ts";

/** Runs a function body and returns its result, so a minified body can be compared with the original. */
function evaluate(body: string): unknown {
  return new Function(body)();
}

test("stripTypes removes annotations, interfaces, and type-only imports", () => {
  const source = [
    'import type { Shape } from "./shape.ts";',
    "interface Options { open: boolean }",
    "export function toggle(el: HTMLElement, opts: Options): boolean {",
    "  const next = (opts.open as boolean) === true;",
    "  el.hidden = !next;",
    "  return next;",
    "}",
    "",
  ].join("\n");
  const out = stripTypes(source, "components/callout/client.ts");
  assert.doesNotMatch(out, /interface|: HTMLElement|: boolean|import type|as boolean/);
  assert.match(out, /export function toggle\(el\s*,\s*opts\s*\)/);
});

test("stripTypes names the file when Node cannot strip the syntax", () => {
  assert.throws(() => stripTypes("enum Mode { On }", "components/menu/client.ts"), /components\/menu\/client\.ts/);
});

test("minifyJs removes comments and indentation and keeps the module shape", () => {
  const source = [
    "// toggle the menu",
    "/** Opens the menu. */",
    "export function open(el) {",
    "    /* not needed */",
    "    el.hidden = false;   // visible now",
    "    return el;",
    "}",
    "",
  ].join("\n");
  const out = minifyJs(source);
  assert.doesNotMatch(out, /\/\/|\/\*|not needed|visible now|Opens/);
  assert.ok(out.length < source.length / 2, `expected a large reduction, got ${out.length} of ${source.length}`);
  assert.match(out, /export function open\(el\)\{/);
  assert.match(out, /el\.hidden=false;/);
});

test("minifyJs copies strings, template literals, and regular expressions as written", () => {
  const source = [
    'const label = "  keep  // this /* too */  ";',
    "const quoted = 'it\\'s   spaced';",
    "const tpl = `a  ${ 1 + 1 }  b // c`;",
    "const re = /[ /]+a  b/gi;",
  ].join("\n");
  const out = minifyJs(source);
  assert.ok(out.includes('"  keep  // this /* too */  "'));
  assert.ok(out.includes("'it\\'s   spaced'"));
  assert.ok(out.includes("`a  ${ 1 + 1 }  b // c`"));
  assert.ok(out.includes("/[ /]+a  b/gi"));
});

test("minifyJs keeps a line break where automatic semicolon insertion depends on it", () => {
  const body = "function f() {\n  return\n    1\n}\nreturn f();";
  assert.equal(evaluate(minifyJs(body)), undefined);
  assert.equal(evaluate(body), undefined);

  const postfix = "let a = 1, b = 5;\na\n++b\nreturn [a, b];";
  assert.deepEqual(evaluate(minifyJs(postfix)), evaluate(postfix));
});

test("minifyJs keeps the spaces that stop tokens from merging", () => {
  const cases = [
    "let a = 2, b = 3; return a - -b;",
    "let a = 2, b = 3; return a + +b;",
    "let a = 2, b = 3; return a - - b;",
    "let a = 2, b = 3; return a++ + ++b;",
    "return 1 .toString();",
    "return 'x' in { x: 1 } ? 'yes' : 'no';",
    "return typeof 1 === 'number';",
    "let a = 4; return a / /4/.source.length;",
    "const xs = [1, 2, 3]; return xs.map((x) => x * 2).join(' ');",
    "return 0x1e - 1;",
    "return 1e+3 - 1;",
  ];
  for (const body of cases) {
    assert.deepEqual(evaluate(minifyJs(body)), evaluate(body), body);
  }
});

test("minifyJs keeps word boundaries across comments", () => {
  assert.equal(minifyJs("const a = typeof/* c */b;"), "const a=typeof b;");
  assert.equal(evaluate(minifyJs("let x = 1; return x/* c */+ 2;")), 3);
});

test("minifyJs keeps program behavior for a small island", () => {
  const body = `
    const items = [
      { label: "one", n: 1 },
      { label: "two", n: 2 },
    ];
    let total = 0;
    for (const item of items) {
      // count each item once
      total += item.n;
    }
    const greet = (name = "world") => \`hi \${name}\`;
    const pattern = /\\s+/g;
    return { total, text: greet(), words: "a  b   c".split(pattern) };
  `;
  assert.deepEqual(evaluate(minifyJs(body)), evaluate(body));
});

test("minifyJs rejects an unterminated string or template", () => {
  assert.throws(() => minifyJs("const s = 'open;"), /Unterminated string/);
  assert.throws(() => minifyJs("const t = `open"), /Unterminated template/);
});

test("islandScript returns no script tag for a page without islands", () => {
  assert.equal(islandScript([]), "");
});

test("islandScript writes one module script that imports each island once, in order", () => {
  const islands: Island[] = [
    { name: "callout", src: "/docs/assets/callout.js" },
    { name: "tabs", src: "/docs/assets/tabs.js" },
    { name: "callout", src: "/docs/assets/callout.js" },
  ];
  const out = islandScript(islands);
  assert.equal(out, '<script type="module">import "/docs/assets/callout.js";import "/docs/assets/tabs.js";</script>');
  assert.equal(out.match(/<script\b/g)?.length, 1);
});

test("islandScript keeps a source that would close the script element inside the string", () => {
  const out = islandScript([{ name: "x", src: "/a</script><script>alert(1)" }]);
  assert.equal(out.match(/<\/script>/g)?.length, 1);
  assert.match(out, /import "\/a\\u003c\/script>/);
});

test("islandScript adds the nonce the content security policy requires", () => {
  const out = islandScript([{ name: "tabs", src: "/docs/assets/tabs.js" }], 'abc"<');
  assert.equal(out, '<script type="module" nonce="abc&quot;&lt;">import "/docs/assets/tabs.js";</script>');
});

test("buildIsland strips types and minifies a client.ts file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "islands-"));
  try {
    const file = join(dir, "client.ts");
    await writeFile(
      file,
      [
        "// the callout island",
        "export function init(root: HTMLElement): void {",
        "  const btn: HTMLButtonElement | null = root.querySelector('button');",
        "  btn?.addEventListener('click', () => { root.classList.toggle('open'); });",
        "}",
        "",
      ].join("\n"),
    );
    const out = await buildIsland(file);
    assert.doesNotMatch(out, /HTMLElement|HTMLButtonElement|\/\/|void/);
    assert.match(out, /export function init\(root\)\{/);
    assert.match(out, /addEventListener\('click'/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildIsland names the file when it cannot strip the types", async () => {
  const dir = await mkdtemp(join(tmpdir(), "islands-"));
  try {
    const file = join(dir, "client.ts");
    await writeFile(file, "export enum Mode { Open }\n");
    await assert.rejects(buildIsland(file), /client\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildIslandModules builds each client and every relative file it imports, once, with .js specifiers", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-islands-"));
  try {
    mkdirSync(join(root, "chrome", "a"), { recursive: true });
    mkdirSync(join(root, "chrome", "b"), { recursive: true });
    writeFileSync(join(root, "chrome", "a", "client.ts"), 'import { KEY } from "./key.ts";\nimport type { T } from "./types.ts";\nexport const a: T = KEY;\n');
    writeFileSync(join(root, "chrome", "a", "key.ts"), 'export const KEY = "k";\n');
    writeFileSync(join(root, "chrome", "a", "types.ts"), "export type T = string;\n");
    writeFileSync(join(root, "chrome", "b", "client.ts"), 'import { KEY } from "../a/key.ts";\nexport const b = KEY;\n');
    const modules = await buildIslandModules(root, ["chrome/a/client.ts", "chrome/b/client.ts"]);
    assert.deepEqual([...modules.keys()], [
      "assets/theme/islands/chrome/a/client.js",
      "assets/theme/islands/chrome/a/key.js",
      "assets/theme/islands/chrome/b/client.js",
    ]);
    assert.match(modules.get("assets/theme/islands/chrome/a/client.js")!, /from"\.\/key\.js"/);
    assert.match(modules.get("assets/theme/islands/chrome/b/client.js")!, /from"\.\.\/a\/key\.js"/);
    assert.doesNotMatch(modules.get("assets/theme/islands/chrome/a/client.js")!, /types/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("buildIslandModules rejects a package import, which a browser cannot resolve", async () => {
  const root = mkdtempSync(join(tmpdir(), "mizzen-islands-"));
  try {
    mkdirSync(join(root, "chrome", "a"), { recursive: true });
    writeFileSync(join(root, "chrome", "a", "client.ts"), 'import { h } from "preact";\nexport const a = h;\n');
    await assert.rejects(buildIslandModules(root, ["chrome/a/client.ts"]), /imports "preact"/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("islandUrl puts the module under the site's base", () => {
  assert.equal(islandUrl("/slipway", "chrome/drawer/client.ts"), "/slipway/assets/theme/islands/chrome/drawer/client.js");
  assert.equal(islandUrl("", "chrome/drawer/client.ts"), "/assets/theme/islands/chrome/drawer/client.js");
});

test("optionalFonts lists the woff2 files of faces declared font-display: optional, once each", async () => {
  const { optionalFonts } = await import("../src/pipeline/build.ts");
  const css =
    '@font-face{font-family:A;font-display:optional;src:url(/f/a.woff2)format("woff2")}' +
    '@font-face{font-family:B;font-display:swap;src:url(/f/b.woff2)format("woff2")}' +
    '@font-face{font-family:A;font-display: optional;src:url("/f/a.woff2") format("woff2")}';
  assert.deepEqual(optionalFonts(css), ["/f/a.woff2"]);
  assert.deepEqual(optionalFonts("body{color:red}"), []);
});
