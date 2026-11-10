import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { directionFromLang, loadConfig, loadConfigText } from "../src/config/load.ts";

const F = "mizzen.yml";

function site(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "config-load-"));
  for (const [path, text] of Object.entries(files)) {
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a missing file uses defaults and the folder name as title", () => {
  const root = site();
  try {
    const { config, diagnostics } = loadConfig(root);
    assert.deepEqual(diagnostics, []);
    assert.equal(config.title, basename(root));
    assert.equal(config.base, "");
    assert.equal(config.lang, "en");
    assert.equal(config.dir, "ltr");
    assert.deepEqual(config.languages, []);
    assert.equal(config.source, ".");
    assert.deepEqual(config.include, []);
    assert.deepEqual(config.exclude, []);
    assert.equal(config.navigation, "_data/navigation.yml");
    assert.deepEqual(config.defaults, []);
    assert.equal("repository" in config, false);
    assert.deepEqual(config.theme, {});
    assert.deepEqual(config.search, {});
    assert.deepEqual(config.redirects, {});
    assert.deepEqual(config.outputs, {});
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a valid file fills defaults and keeps set keys", () => {
  const root = site({
    [F]: [
      "title: Docs",
      "url: https://example.github.io",
      "base: /docs",
      "lang: fa",
      "repository:",
      "  url: https://github.com/example/example",
      "search:",
      "  text: 120",
      "",
    ].join("\n"),
  });
  try {
    const { config, diagnostics } = loadConfig(root);
    assert.deepEqual(diagnostics, []);
    assert.equal(config.title, "Docs");
    assert.equal(config.url, "https://example.github.io");
    assert.equal(config.base, "/docs");
    assert.equal(config.lang, "fa");
    assert.equal(config.dir, "rtl");
    assert.deepEqual(config.repository, {
      url: "https://github.com/example/example",
      branch: "main",
      dir: "",
    });
    assert.deepEqual(config.search, { text: 120 });
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("dir unset follows lang, including language tags with a region", () => {
  assert.equal(directionFromLang("en"), "ltr");
  assert.equal(directionFromLang("fa"), "rtl");
  assert.equal(directionFromLang("fa-IR"), "rtl");
  assert.equal(directionFromLang("ar"), "rtl");
  assert.equal(directionFromLang("he"), "rtl");
  assert.equal(directionFromLang("ur"), "rtl");
  assert.equal(directionFromLang("ckb"), "rtl");
  const { config } = loadConfigText("lang: he\n", F, "site");
  assert.equal(config.dir, "rtl");
  const explicit = loadConfigText("lang: fa\ndir: ltr\n", F, "site");
  assert.equal(explicit.config.dir, "ltr");
});

test("an unknown key reports its line number", () => {
  const src = "title: Docs\ntitel: Typo\nlang: en\n";
  const { config, diagnostics } = loadConfigText(src, F, "site");
  assert.equal(config.title, "Docs");
  assert.equal(diagnostics.length, 1);
  const d = diagnostics[0]!;
  assert.equal(d.id, "config.unknown-key");
  assert.equal(d.severity, "error");
  assert.match(d.message, /titel/);
  assert.equal(d.pos?.file, F);
  assert.equal(d.pos?.line, 2);
  assert.equal(d.pos?.column, 1);
  assert.equal(d.pos?.endLine, 2);
});

test("a nested unknown key points at the nested key's line", () => {
  const src = "theme:\n  color: red\n";
  const { diagnostics } = loadConfigText(src, F, "site");
  const d = diagnostics.find((x) => x.id === "config.unknown-key");
  assert.ok(d);
  assert.match(d.message, /color/);
  assert.equal(d.pos?.line, 2);
  assert.equal(d.pos?.column, 3);
});

test("an invalid value reports its line", () => {
  const src = "title: Docs\nbase: example\n";
  const { diagnostics } = loadConfigText(src, F, "site");
  const d = diagnostics.find((x) => x.id === "config.invalid");
  assert.ok(d);
  assert.equal(d.pos?.line, 2);
  assert.ok((d.pos?.column ?? 0) >= 1);
});

test("invalid YAML is a diagnostic with its line", () => {
  const src = "title: ok\nbad: [unclosed\nother: 1\n";
  const { config, diagnostics } = loadConfigText(src, F, "site");
  assert.equal(config.title, "site");
  assert.ok(diagnostics.length > 0);
  assert.equal(diagnostics[0]!.id, "config.invalid-yaml");
  assert.equal(diagnostics[0]!.pos?.file, F);
  assert.ok(diagnostics[0]!.pos!.line >= 2);
});

test("a config that is not a mapping is a diagnostic", () => {
  const { diagnostics, config } = loadConfigText("- a\n- b\n", F, "folder");
  assert.equal(config.title, "folder");
  assert.equal(diagnostics[0]?.id, "config.not-a-mapping");
});

test("loadConfig reads mizzen.yml from the site root", () => {
  const root = site({ [F]: "title: From File\n" });
  try {
    const { config, diagnostics } = loadConfig(root);
    assert.deepEqual(diagnostics, []);
    assert.equal(config.title, "From File");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("options.path picks another file", () => {
  const root = mkdtempSync(join(tmpdir(), "config-load-"));
  try {
    mkdirSync(root, { recursive: true });
    const custom = join(root, "custom.yml");
    writeFileSync(custom, "title: Custom\n");
    const { config } = loadConfig(root, { path: custom });
    assert.equal(config.title, "Custom");
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("a byte order mark is ignored", () => {
  const { config, diagnostics } = loadConfigText("﻿title: Hi\n", F, "site");
  assert.deepEqual(diagnostics, []);
  assert.equal(config.title, "Hi");
});

test("search false and empty search both load", () => {
  assert.equal(loadConfigText("search: false\n", F, "s").config.search, false);
  assert.deepEqual(loadConfigText("search: {}\n", F, "s").config.search, {});
});
