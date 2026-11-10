import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadRegistry } from "../src/render/registry.ts";

function theme(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "registry-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", name: "temp-theme" }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const manifest = `export const theme = {
  name: "temp",
  folders: ["layouts", "chrome", "components", "tokens", "styles"],
} as const;
`;

test("a temporary component folder is found without edits elsewhere", async () => {
  const root = theme({
    "src/index.ts": manifest,
    "layouts/doc.ts": "export default function doc() { return \"doc\"; }\n",
    "chrome/footer/index.ts": "export default function footer() { return \"footer\"; }\n",
    "chrome/footer/style.css": "footer { display: block; }\n",
    "components/callout/index.ts":
      'export const directive = "note";\nexport default function callout() { return "callout"; }\n',
    "components/callout/style.css": ".callout {}\n",
    "components/callout/client.ts": "export function mount() {}\n",
  });
  try {
    const registry = await loadRegistry(root);
    assert.equal(registry.theme.name, "temp");
    assert.deepEqual([...registry.theme.folders], ["layouts", "chrome", "components", "tokens", "styles"]);
    assert.equal(registry.diagnostics.length, 0);

    assert.ok(registry.layouts.doc);
    assert.equal(registry.layouts.doc.file, "layouts/doc.ts");
    assert.equal(registry.layouts.doc.layout({} as never), "doc");

    assert.ok(registry.chrome.footer);
    assert.equal(registry.chrome.footer.css, "chrome/footer/style.css");
    assert.equal(registry.chrome.footer.client, undefined);
    assert.equal(registry.chrome.footer.chrome({} as never), "footer");

    assert.ok(registry.components.callout);
    assert.equal(registry.components.callout.directive, "note");
    assert.equal(registry.components.callout.css, "components/callout/style.css");
    assert.equal(registry.components.callout.client, "components/callout/client.ts");
    assert.equal(registry.components.callout.component({} as never), "callout");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("duplicate names and missing default exports are errors", async () => {
  const root = theme({
    // Listing `components` twice forces the same unit name to be discovered again.
    "src/index.ts": `export const theme = { name: "temp", folders: ["components", "components"] } as const;\n`,
    "components/callout/index.ts": 'export const directive = "note";\nexport default function callout() { return "callout"; }\n',
    "components/broken/index.ts": "export const notDefault = 1;\n",
  });
  try {
    const registry = await loadRegistry(root);
    assert.ok(registry.components.callout);
    const ids = registry.diagnostics.map((d) => d.id).sort();
    assert.ok(ids.includes("registry.duplicate-name"));
    assert.ok(ids.includes("registry.missing-default"));
    assert.ok(registry.diagnostics.some((d) => /callout/.test(d.message)));
    assert.ok(registry.diagnostics.some((d) => /broken/.test(d.message)));
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("duplicate directive names across components are errors", async () => {
  const root = theme({
    "src/index.ts": `export const theme = { name: "temp", folders: ["components"] } as const;\n`,
    "components/a/index.ts": 'export const directive = "x";\nexport default function a() { return "a"; }\n',
    "components/b/index.ts": 'export const directive = "x";\nexport default function b() { return "b"; }\n',
  });
  try {
    const registry = await loadRegistry(root);
    assert.ok(registry.components.a);
    assert.ok(registry.components.b);
    assert.equal(registry.diagnostics.length, 1);
    assert.equal(registry.diagnostics[0]?.id, "registry.duplicate-name");
    assert.match(registry.diagnostics[0]?.message ?? "", /directive "x"/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("units are discovered in code-point order and tokens/styles folders are skipped", async () => {
  const root = theme({
    "src/index.ts": `export const theme = { name: "temp", folders: ["layouts", "components", "tokens", "styles"] } as const;\n`,
    "layouts/z.ts": "export default function z() { return \"z\"; }\n",
    "layouts/a.ts": "export default function a() { return \"a\"; }\n",
    "components/m/index.ts": "export default function m() { return \"m\"; }\n",
    "tokens/color.json": "{}\n",
    "styles/base.css": "html {}\n",
  });
  try {
    const registry = await loadRegistry(root);
    assert.deepEqual(Object.keys(registry.layouts), ["a", "z"]);
    assert.deepEqual(Object.keys(registry.components), ["m"]);
    assert.deepEqual(registry.chrome, {});
    assert.equal(registry.diagnostics.length, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});
