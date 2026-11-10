import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { build } from "../src/pipeline/build.ts";

function tree(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

test("a build links hashed base and per-page CSS under base, and writes the files and the fonts they name", async () => {
  const parent = mkdtempSync(join(tmpdir(), "build-css-"));
  try {
    const theme = join(parent, "theme");
    tree(theme, {
      "src/index.ts": 'export const theme = { name: "t", folders: ["layouts", "chrome", "styles"] };\n',
      "layouts/doc.ts": 'export default (p: any) => `<html><head><title>${p.page.title}</title></head><body>${p.page.html}</body></html>`;\n',
      "layouts/doc.css": ".layout { color: red; }\n",
      "chrome/header/index.ts": "export default () => '';\n",
      "chrome/header/style.css": ".header { margin: 0; }\n",
      "styles/base.css": '@font-face { font-family: F; src: url("../fonts/f.woff2"); }\nbody { margin: 0; }\n',
      "fonts/f.woff2": "font-bytes",
    });
    const site = join(parent, "site");
    tree(site, {
      "mizzen.yml": "title: T\nbase: /docs\nurl: https://example.com\n",
      "index.md": "---\ntitle: Home\nlayout: doc\n---\n\nHello\n",
    });
    const out = join(parent, "out");
    const result = await build({ root: site, out, themeRoot: theme, defaultLayout: "doc" });
    assert.deepEqual(result.diagnostics.filter((d) => d.severity === "error"), []);

    const html = readFileSync(join(out, "index.html"), "utf8");
    const links = [...html.matchAll(/<link rel="stylesheet" href="\/docs\/(assets\/theme\/[^"]+\.css)">/g)].map((m) => m[1]!);
    assert.equal(links.length, 2);
    assert.match(links[0]!, /^assets\/theme\/base-[0-9a-f]{16}\.css$/);
    assert.match(links[1]!, /^assets\/theme\/page-[0-9a-f]{16}\.css$/);
    for (const link of links) {
      assert.ok(result.files.includes(link), `${link} is listed as written`);
      assert.ok(existsSync(join(out, link)), `${link} exists`);
    }
    const base = readFileSync(join(out, links[0]!), "utf8");
    assert.match(base, /\.header/, "chrome CSS is in the base bundle");
    assert.match(readFileSync(join(out, links[1]!), "utf8"), /\.layout/, "the layout's CSS is in the page bundle");
    const font = /url\(\/docs\/(assets\/theme\/fonts\/f-[0-9a-f]{16}\.woff2)\)/.exec(base);
    assert.ok(font, "the font url points at its hashed copy under base");
    assert.ok(existsSync(join(out, font[1]!)));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
