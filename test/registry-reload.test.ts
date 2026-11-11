import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { loadRegistry } from "../src/render/registry.ts";

function theme(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "registry-reload-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", name: "temp-theme" }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const FULL_MANIFEST = `export const theme = {
  name: "temp",
  folders: ["layouts", "chrome", "components"],
} as const;
`;

function units(v: string): Record<string, string> {
  return {
    "layouts/doc.ts": `export default function doc() { return "doc ${v}"; }\n`,
    "chrome/footer/index.ts": `export default function footer() { return "footer ${v}"; }\n`,
    "components/callout/index.ts": `export const directive = "note";\nexport default function callout() { return "callout ${v}"; }\n`,
  };
}

test("a layout edit is seen by the next load in the same process", async () => {
  const root = theme({ "src/index.ts": FULL_MANIFEST, ...units("one") });
  try {
    const first = await loadRegistry(root);
    assert.equal(first.layouts.doc?.layout({} as never), "doc one");
    assert.equal(first.diagnostics.length, 0);

    write(root, "layouts/doc.ts", 'export default function doc() { return "doc two"; }\n');
    const second = await loadRegistry(root);
    assert.equal(second.layouts.doc?.layout({} as never), "doc two");
    assert.notEqual(second.layouts.doc?.layout, first.layouts.doc?.layout);

    // The older registry still holds the module it loaded; nothing was rewritten in place.
    assert.equal(first.layouts.doc?.layout({} as never), "doc one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chrome edit is seen by the next load in the same process", async () => {
  const root = theme({ "src/index.ts": FULL_MANIFEST, ...units("one") });
  try {
    const first = await loadRegistry(root);
    assert.equal(first.chrome.footer?.chrome({} as never), "footer one");

    write(root, "chrome/footer/index.ts", 'export default function footer() { return "footer two"; }\n');
    const second = await loadRegistry(root);
    assert.equal(second.chrome.footer?.chrome({} as never), "footer two");
    assert.notEqual(second.chrome.footer?.chrome, first.chrome.footer?.chrome);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a component edit is seen by the next load in the same process", async () => {
  const root = theme({ "src/index.ts": FULL_MANIFEST, ...units("one") });
  try {
    const first = await loadRegistry(root);
    assert.equal(first.components.callout?.component({} as never), "callout one");
    assert.equal(first.components.callout?.directive, "note");

    write(root, "components/callout/index.ts", 'export const directive = "tip";\nexport default function callout() { return "callout two"; }\n');
    const second = await loadRegistry(root);
    assert.equal(second.components.callout?.component({} as never), "callout two");
    assert.equal(second.components.callout?.directive, "tip");
    assert.notEqual(second.components.callout?.component, first.components.callout?.component);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest edit is seen by the next load in the same process", async () => {
  const root = theme({ "src/index.ts": FULL_MANIFEST, ...units("one") });
  try {
    const first = await loadRegistry(root);
    assert.equal(first.theme.name, "temp");

    write(root, "src/index.ts", `export const theme = { name: "renamed", folders: ["layouts", "chrome", "components"] } as const;\n`);
    const second = await loadRegistry(root);
    assert.equal(second.theme.name, "renamed");
    assert.equal(second.diagnostics.length, 0);
    assert.equal(first.theme.name, "temp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unchanged entries keep their module while the edited one reloads", async () => {
  const root = theme({ "src/index.ts": FULL_MANIFEST, ...units("one") });
  try {
    const first = await loadRegistry(root);
    const second = await loadRegistry(root);

    // Same bytes, same resolved URL: Node hands back the module it already imported.
    assert.equal(second.layouts.doc?.layout, first.layouts.doc?.layout);
    assert.equal(second.chrome.footer?.chrome, first.chrome.footer?.chrome);
    assert.equal(second.components.callout?.component, first.components.callout?.component);

    write(root, "layouts/doc.ts", 'export default function doc() { return "doc two"; }\n');
    const third = await loadRegistry(root);
    assert.notEqual(third.layouts.doc?.layout, first.layouts.doc?.layout);
    assert.equal(third.chrome.footer?.chrome, first.chrome.footer?.chrome);
    assert.equal(third.components.callout?.component, first.components.callout?.component);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reloading does not leak registry state from one load into the next", async () => {
  const root = theme({
    "src/index.ts": `export const theme = { name: "temp", folders: ["layouts", "components"] } as const;\n`,
    "layouts/doc.ts": 'export default function doc() { return "doc"; }\n',
    // No default export: the first load records it and registers nothing.
    "components/broken/index.ts": "export const notDefault = 1;\n",
    "components/a/index.ts": 'export const directive = "x";\nexport default function a() { return "a"; }\n',
  });
  try {
    const first = await loadRegistry(root);
    assert.equal(first.components.broken, undefined);
    assert.ok(first.diagnostics.some((d) => d.id === "registry.missing-default" && /broken/.test(d.message)));
    assert.equal(first.diagnostics.filter((d) => d.id === "registry.duplicate-name").length, 0);

    write(root, "components/broken/index.ts", 'export default function broken() { return "broken"; }\n');
    write(root, "components/a/index.ts", 'export const directive = "x";\nexport default function a2() { return "a2"; }\n');
    const second = await loadRegistry(root);

    assert.ok(second.components.broken);
    assert.equal(second.diagnostics.length, 0);
    assert.notEqual(second.components.a?.component, first.components.a?.component);

    // The first load keeps its own answer; a later load cannot edit it into a new shape.
    assert.equal(first.components.broken, undefined);
    assert.ok(first.diagnostics.some((d) => d.id === "registry.missing-default"));
    assert.notEqual(second.layouts.doc, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid and missing units keep their diagnostics across reloads", async () => {
  const root = theme({
    "src/index.ts": `export const theme = { name: "temp", folders: ["layouts", "chrome", "components"] } as const;\n`,
    "layouts/doc.ts": 'export default function doc() { return "doc"; }\n',
    // A unit Node cannot import at all.
    "chrome/broken/index.ts": "export default function broken( {\n",
    // A directory with no entry module.
    "components/hollow/style.css": ".hollow {}\n",
  });
  try {
    const first = await loadRegistry(root);
    const loadFailed = first.diagnostics.filter((d) => d.id === "registry.load-failed").map((d) => d.message).sort();
    assert.equal(loadFailed.length, 1);
    assert.match(loadFailed[0] ?? "", /^Failed to load "chrome\/broken\/index\.ts"/);
    assert.ok(first.diagnostics.some((d) => d.id === "registry.missing-default" && /components\/hollow/.test(d.message)));
    assert.ok(first.layouts.doc);
    assert.equal(first.chrome.broken, undefined);
    assert.equal(first.components.hollow, undefined);

    write(root, "layouts/doc.ts", 'export default function doc() { return "doc two"; }\n');
    const second = await loadRegistry(root);

    assert.deepEqual(
      second.diagnostics.filter((d) => d.id === "registry.load-failed").map((d) => d.message).sort(),
      loadFailed,
    );
    assert.ok(second.diagnostics.some((d) => d.id === "registry.missing-default" && /components\/hollow/.test(d.message)));
    assert.equal(second.layouts.doc?.layout({} as never), "doc two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a unit that only ever gets the same bytes back is never re-imported", async () => {
  const root = theme({
    "src/index.ts": `export const theme = { name: "temp", folders: ["components"] } as const;\n`,
    "components/tally/index.ts": "let calls = 0;\nexport default function tally() { return ++calls; }\n",
  });
  try {
    const first = await loadRegistry(root);
    assert.equal(first.components.tally?.component({} as never), 1);
    const second = await loadRegistry(root);
    // The unchanged module is the same one, so its own state is untouched by the reload.
    assert.equal(second.components.tally?.component, first.components.tally?.component);
    assert.equal(second.components.tally?.component({} as never), 2);

    write(root, "components/tally/index.ts", "let calls = 10;\nexport default function tally() { return ++calls; }\n");
    const third = await loadRegistry(root);
    assert.notEqual(third.components.tally?.component, second.components.tally?.component);
    assert.equal(third.components.tally?.component({} as never), 11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
