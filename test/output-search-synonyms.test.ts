import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocument } from "yaml";
import type { Diagnostic, Site } from "../src/contracts/index.ts";
import type { OutputContext, OutputFile } from "../src/contracts/output.ts";
import { readSynonyms, searchSynonyms, synonymConfig, type Synonyms } from "../src/outputs/search-synonyms.ts";

function site(data: Readonly<Record<string, unknown>> = {}, options: Readonly<Record<string, unknown>> = {}): Site {
  return {
    config: {
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
      theme: { options },
      search: {},
      redirects: {},
      outputs: {},
    },
    pages: [],
    nav: {},
    data,
  };
}

/** A context that records diagnostics and refuses to render, since this output never does. */
function recordingContext(): { ctx: OutputContext; reported: Diagnostic[] } {
  const reported: Diagnostic[] = [];
  return {
    ctx: {
      renderPage: () => Promise.reject(new Error("search-synonyms never renders a page")),
      report: (diagnostic) => {
        reported.push(diagnostic);
      },
    },
    reported,
  };
}

async function run(model: Site): Promise<{ files: readonly OutputFile[]; reported: Diagnostic[] }> {
  const { ctx, reported } = recordingContext();
  const files = await searchSynonyms.run(model, ctx);
  return { files, reported };
}

/** The parsed `pagefind.yml`, so a test reads the shape rather than one formatting choice. */
function parsed(contents: string | Uint8Array | undefined): unknown {
  assert.equal(typeof contents, "string");
  return parseDocument(String(contents)).toJS();
}

test("reads a synonym map from _data/search-synonyms.yml through site.data", async () => {
  const { files, reported } = await run(site({ "search-synonyms": { install: ["setup", "configure"] } }));
  assert.deepEqual(reported, []);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, "pagefind.yml");
  assert.deepEqual(parsed(files[0]?.contents), { synonyms: { install: ["configure", "setup"] } });
});

test("reads a list of entries: a one-key map, a term mapping, and a term group", async () => {
  const { files } = await run(
    site({
      "search-synonyms": [{ install: "setup" }, { term: "cache", synonyms: ["store", "buffer"] }, ["run", "execute"]],
    }),
  );
  assert.deepEqual(parsed(files[0]?.contents), {
    synonyms: { cache: ["buffer", "store"], install: ["setup"], run: ["execute"] },
  });
});

test("a flat list of strings is one group, its first item the term", async () => {
  const { files } = await run(site({ "search-synonyms": ["install", "setup", "configure"] }));
  assert.deepEqual(parsed(files[0]?.contents), { synonyms: { install: ["configure", "setup"] } });
});

test("falls back to theme.options.search.synonyms when the data file is absent", async () => {
  const { files } = await run(site({}, { search: { synonyms: { install: "setup" } } }));
  assert.equal(files.length, 1);
  assert.deepEqual(parsed(files[0]?.contents), { synonyms: { install: ["setup"] } });
});

test("the data file wins over theme options", async () => {
  const { files } = await run(
    site({ "search-synonyms": { install: "setup" } }, { search: { synonyms: { cache: "store" } } }),
  );
  assert.deepEqual(parsed(files[0]?.contents), { synonyms: { install: ["setup"] } });
});

test("an empty map, an empty list, or no setting at all writes no file", async () => {
  for (const model of [site({ "search-synonyms": {} }), site({ "search-synonyms": [] }), site({}, { search: {} }), site()]) {
    const { files, reported } = await run(model);
    assert.deepEqual(files, []);
    assert.deepEqual(reported, []);
  }
});

test("a term with no words is dropped rather than written as an empty list", async () => {
  const { files } = await run(site({ "search-synonyms": { install: [] } }));
  assert.deepEqual(files, []);
});

test("a value that is neither a map nor a list is a warning and writes no file", async () => {
  const { files, reported } = await run(site({ "search-synonyms": "install" }));
  assert.deepEqual(files, []);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.id, "search-synonyms.invalid");
  assert.equal(reported[0]?.severity, "warning");
  assert.ok(reported[0]?.help?.includes("_data/search-synonyms.yml"));
});

test("the file has a documented synonyms block and exactly one trailing newline", async () => {
  const { files } = await run(site({ "search-synonyms": { install: ["setup"] } }));
  const contents = String(files[0]?.contents);
  assert.ok(contents.startsWith("# Pagefind configuration"));
  assert.ok(contents.includes("\nsynonyms:\n"));
  assert.ok(!contents.includes("\r"), "LF only");
  assert.ok(contents.endsWith("\n") && !contents.endsWith("\n\n"), "exactly one trailing newline");
});

test("terms and words are sorted by code point, not by insertion or locale", async () => {
  const { files } = await run(
    site({ "search-synonyms": { zebra: ["last", "extra"], Apple: ["fruit"], apple: ["fruit"] } }),
  );
  const contents = String(files[0]?.contents);
  assert.ok(contents.indexOf("Apple:") < contents.indexOf("apple:"), "uppercase sorts first by code point");
  assert.ok(contents.indexOf("apple:") < contents.indexOf("zebra:"), "terms are sorted");
  assert.ok(contents.indexOf("extra") < contents.indexOf("last"), "words are sorted");
});

test("the same mappings in a different order give the same bytes", async () => {
  const first = await run(site({ "search-synonyms": { install: ["setup", "configure"], cache: ["store"] } }));
  const second = await run(site({ "search-synonyms": { cache: ["store"], install: ["configure", "setup"] } }));
  assert.equal(first.files[0]?.contents, second.files[0]?.contents);
});

test("a duplicate term merges its words and removes the term itself", async () => {
  const { files } = await run(
    site({ "search-synonyms": [{ install: ["setup", "install"] }, { install: ["configure", "setup"] }] }),
  );
  assert.deepEqual(parsed(files[0]?.contents), { synonyms: { install: ["configure", "setup"] } });
});

test("terms and words with YAML metacharacters survive a round trip", async () => {
  const synonyms: Synonyms = new Map([
    ["cache: warm", ["store#1", "with\nnewline", "- leading dash", "quote\"inside"]],
    ["tag #1", ["a: b"]],
  ]);
  const text = synonymConfig(synonyms);
  assert.deepEqual(parseDocument(text).toJS(), {
    synonyms: {
      "cache: warm": ['store#1', "with\nnewline", "- leading dash", 'quote"inside'],
      "tag #1": ["a: b"],
    },
  });
});

test("readSynonyms returns an empty map for null and undefined and undefined for a primitive", () => {
  assert.equal(readSynonyms(undefined)?.size, 0);
  assert.equal(readSynonyms(null)?.size, 0);
  assert.equal(readSynonyms("install"), undefined);
  assert.equal(readSynonyms(42), undefined);
});

test("the output is named search-synonyms and writes pagefind.yml", async () => {
  assert.equal(searchSynonyms.name, "search-synonyms");
  const { files } = await run(site({ "search-synonyms": { install: ["setup"] } }));
  assert.deepEqual(
    files.map((file) => file.path),
    ["pagefind.yml"],
  );
});
