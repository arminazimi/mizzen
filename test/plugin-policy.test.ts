import assert from "node:assert/strict";
import { test } from "node:test";
import type { NavTree, OutputFile, Page, Plugin, Site, SiteConfig } from "../src/contracts/index.ts";
import { CODE_CONFIG_FILE, runContentHooks, runModelHooks, runOutputsHooks } from "../src/plugins/hooks.ts";
import {
  DEFAULT_HOOK_POLICY,
  DEFAULT_HOOK_TIMEOUT_MS,
  resolveHookTimeout,
} from "../src/plugins/policy.ts";

const pos = { file: "guide/install.md", line: 1, column: 1, endLine: 1, endColumn: 1 };

/** A site config with the defaults a build fills in. */
function config(): SiteConfig {
  return {
    title: "Mizzen",
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
  };
}

function page(url: string): Page {
  return {
    url,
    source: pos,
    frontMatter: {},
    title: url,
    lang: "en",
    dir: "ltr",
    headings: [],
    html: "",
    markdown: "",
    kind: "doc",
  };
}

function site(pages: readonly Page[]): Site {
  const nav: NavTree = { lists: [] };
  return { config: config(), pages, nav, data: {} };
}

/** Counts the timers the code under test arms and clears, by their delay, ignoring the test runner's own timers. */
function timerSpy(): {
  armedAt(ms: number): number;
  clearedAt(ms: number): number;
  restore(): void;
} {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const armed = new Map<number, number>();
  const cleared = new Map<number, number>();
  const delayOf = new Map<ReturnType<typeof setTimeout>, number>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const timer = realSetTimeout(callback, ms, ...args);
    if (ms !== undefined) {
      armed.set(ms, (armed.get(ms) ?? 0) + 1);
      delayOf.set(timer, ms);
    }
    return timer;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    const ms = timer === undefined ? undefined : delayOf.get(timer);
    if (ms !== undefined) cleared.set(ms, (cleared.get(ms) ?? 0) + 1);
    realClearTimeout(timer);
  }) as typeof globalThis.clearTimeout;
  return {
    armedAt(ms) {
      return armed.get(ms) ?? 0;
    },
    clearedAt(ms) {
      return cleared.get(ms) ?? 0;
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test("a pending hook misses its deadline, later hooks still run, and no timer survives", async () => {
  const order: string[] = [];
  const plugins: Plugin[] = [
    {
      name: "stuck",
      content: () => {
        order.push("stuck");
        return new Promise<Page>(() => {});
      },
    },
    {
      name: "after",
      content: (p) => {
        order.push(`after:${p.title}`);
        return { ...p, lang: "fa" };
      },
    },
  ];

  const timers = timerSpy();
  let result;
  try {
    result = await runContentHooks(plugins, page("/install/"), { timeoutMs: 37 });
  } finally {
    timers.restore();
  }

  assert.deepEqual(order, ["stuck", "after:/install/"], "the plugins after a timed-out one run in declaration order");
  assert.equal(result.value.lang, "fa", "a later hook still changes the value");
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.equal(diagnostic?.id, "plugin.hook-timeout");
  assert.equal(diagnostic?.severity, "error");
  assert.ok(diagnostic?.message.includes(`"stuck"`), `the plugin is named: ${diagnostic?.message}`);
  assert.ok(diagnostic?.message.includes("content hook"), diagnostic?.message ?? "");
  assert.ok(diagnostic?.message.includes("37 ms"), `the limit is named: ${diagnostic?.message}`);
  assert.equal(diagnostic?.pos?.file, CODE_CONFIG_FILE, "the diagnostic points at the site's code file");

  assert.equal(timers.armedAt(37), 2, "each hooked plugin gets its own deadline timer");
  assert.equal(timers.clearedAt(37), 2, "every deadline timer is cleared when the stage completes");
});

test("a rejection after the deadline is handled, not left unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const plugins: Plugin[] = [
      {
        name: "late",
        content: () =>
          new Promise<Page>((_, reject) => {
            setTimeout(() => reject(new Error("too late")), 30);
          }),
      },
      { name: "after", content: (p) => ({ ...p, title: "after" }) },
    ];

    const result = await runContentHooks(plugins, page("/install/"), { timeoutMs: 5 });
    assert.equal(result.diagnostics[0]?.id, "plugin.hook-timeout");
    assert.equal(result.value.title, "after", "the plugins after the late one still run");

    // Wait past the abandoned hook's own rejection; it must be handled by the boundary.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(unhandled, [], "the rejected hook does not surface as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("the deadline defaults, can be disabled, rejects invalid limits, and accepts very large ones", async () => {
  assert.equal(resolveHookTimeout(), DEFAULT_HOOK_TIMEOUT_MS);
  assert.equal(resolveHookTimeout({}), DEFAULT_HOOK_TIMEOUT_MS);
  assert.equal(resolveHookTimeout(DEFAULT_HOOK_POLICY), DEFAULT_HOOK_TIMEOUT_MS);
  assert.equal(resolveHookTimeout({ timeoutMs: 0 }), 0, "zero disables the deadline");
  assert.equal(resolveHookTimeout({ timeoutMs: 5.5 }), 5.5);
  assert.equal(resolveHookTimeout({ timeoutMs: Number.MAX_SAFE_INTEGER }), Number.MAX_SAFE_INTEGER);

  for (const timeoutMs of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => resolveHookTimeout({ timeoutMs }), RangeError, `${String(timeoutMs)} is invalid`);
  }
  assert.throws(() => resolveHookTimeout({ timeoutMs: "5" as unknown as number }), RangeError);
  await assert.rejects(runContentHooks([], page("/install/"), { timeoutMs: -1 }), RangeError);

  const quick: Plugin[] = [
    {
      name: "quick",
      content: async (p) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...p, title: "done" };
      },
    },
  ];
  const result = await runContentHooks(quick, page("/install/"), { timeoutMs: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(result.diagnostics, [], "a deadline beyond Node's timer maximum does not fire early");
  assert.equal(result.value.title, "done");
});

test("absent hooks and a disabled policy arm no deadline", async () => {
  const timers = timerSpy();
  try {
    const absent: Plugin[] = [{ name: "model only", model: (s) => s }];
    const content = await runContentHooks(absent, page("/install/"));
    assert.deepEqual(content.diagnostics, []);
    assert.equal(timers.armedAt(DEFAULT_HOOK_TIMEOUT_MS), 0, "a plugin without the hook arms no timer");

    const slow: Plugin[] = [
      {
        name: "not bounded",
        content: async (p) => {
          await Promise.resolve();
          return { ...p, title: "finished" };
        },
      },
    ];
    const disabled = await runContentHooks(slow, page("/install/"), { timeoutMs: 0 });
    assert.deepEqual(disabled.diagnostics, []);
    assert.equal(disabled.value.title, "finished");
    assert.equal(timers.armedAt(0), 0, "a disabled policy arms no timer");
  } finally {
    timers.restore();
  }
});

test("a malformed page is refused at the plugin that returned it", async () => {
  const plugins: Plugin[] = [
    { name: "good", content: (p) => ({ ...p, title: "kept" }) },
    { name: "bad title", content: (p) => ({ ...p, title: 7 }) as unknown as Page },
    {
      name: "bad heading",
      content: (p) => ({ ...p, headings: [{ depth: 9, id: "x", text: "X", pos }] }) as unknown as Page,
    },
    { name: "after", content: (p) => ({ ...p, lang: "fa" }) },
  ];

  const result = await runContentHooks(plugins, page("/install/"), { timeoutMs: 1_000 });
  assert.equal(result.diagnostics.length, 2);
  const [title, heading] = result.diagnostics;
  assert.equal(title?.id, "plugin.hook-failed");
  assert.ok(title?.message.includes(`"bad title"`), title?.message ?? "");
  assert.ok(title?.message.includes("content hook"), title?.message ?? "");
  assert.ok(title?.message.includes("`title`"), `the malformed field is named: ${title?.message}`);
  assert.equal(title?.pos?.file, CODE_CONFIG_FILE);
  assert.ok(heading?.message.includes("`headings[0].depth`"), heading?.message ?? "");

  assert.equal(result.value.title, "kept", "the last valid page is kept");
  assert.equal(result.value.lang, "fa", "the plugin after the bad ones still runs");
});

test("a malformed site model is refused at the plugin that returned it", async () => {
  const plugins: Plugin[] = [
    {
      name: "bad pages",
      model: (s) => ({ ...s, pages: [{ ...page("/a/"), url: 1 }] }) as unknown as Site,
    },
    { name: "bad nav", model: (s) => ({ ...s, nav: { main: "not a list" } }) as unknown as Site },
    { name: "after", model: (s) => ({ ...s, data: { kept: true } }) },
  ];

  const start = site([page("/install/")]);
  const result = await runModelHooks(plugins, start);
  assert.equal(result.diagnostics.length, 2);
  const [pages, nav] = result.diagnostics;
  assert.ok(pages?.message.includes(`"bad pages"`), pages?.message ?? "");
  assert.ok(pages?.message.includes("`pages[0].url`"), `the malformed field is named: ${pages?.message}`);
  assert.equal(pages?.pos?.file, CODE_CONFIG_FILE);
  assert.ok(nav?.message.includes("`nav.main`"), nav?.message ?? "");

  assert.equal(result.value.pages[0]?.url, "/install/", "the last valid site model is kept");
  assert.deepEqual(result.value.data, { kept: true }, "the plugin after the bad ones still runs");
});

test("escaping, duplicate, and wrongly typed output files are refused at the plugin that returned them", async () => {
  const input: OutputFile[] = [{ path: "index.html", contents: "<html></html>" }];
  const plugins: Plugin[] = [
    { name: "escaping", outputs: (files) => [...files, { path: "../secret.txt", contents: "no" }] },
    {
      name: "duplicate",
      outputs: (files) => [...files, { path: "index.html", contents: "again" }],
    },
    {
      name: "wrong contents",
      outputs: (files) => [...files, { path: "bytes.bin", contents: 42 as unknown as string }],
    },
    { name: "after", outputs: (files) => [...files, { path: "after.txt", contents: "yes" }] },
  ];

  const result = await runOutputsHooks(plugins, input, site([]), { timeoutMs: 1_000 });
  assert.equal(result.diagnostics.length, 3);
  const [escaping, duplicate, contents] = result.diagnostics;
  assert.ok(escaping?.message.includes(`"escaping"`), escaping?.message ?? "");
  assert.ok(escaping?.message.includes("`../secret.txt`") || escaping?.message.includes("../secret.txt"), escaping?.message ?? "");
  assert.ok(escaping?.message.includes("inside the output folder"), escaping?.message ?? "");
  assert.ok(duplicate?.message.includes(`"index.html"`) && duplicate?.message.includes("twice"), duplicate?.message ?? "");
  assert.ok(contents?.message.includes("neither text nor bytes"), contents?.message ?? "");
  for (const diagnostic of result.diagnostics) {
    assert.equal(diagnostic.id, "plugin.hook-failed");
    assert.equal(diagnostic.pos?.file, CODE_CONFIG_FILE, "each diagnostic points at the site's code file");
  }

  assert.deepEqual(result.value.map((file) => file.path), ["index.html", "after.txt"], "the last valid list is kept");
});

test("valid page, site, and output results keep their order and values", async () => {
  const content = await runContentHooks(
    [
      { name: "one", content: (p) => ({ ...p, title: "one" }) },
      { name: "two", content: (p) => ({ ...p, title: `${p.title}+two` }) },
    ],
    page("/install/"),
  );
  assert.deepEqual(content.diagnostics, []);
  assert.equal(content.value.title, "one+two");

  const start = site([page("/install/")]);
  const model = await runModelHooks(
    [{ name: "adds", model: (s) => ({ ...s, pages: [...s.pages, page("/added/")] }) }],
    start,
  );
  assert.deepEqual(model.diagnostics, []);
  assert.deepEqual(model.value.pages.map((p) => p.url), ["/install/", "/added/"]);

  const bytes = new Uint8Array([7, 8]);
  const files: OutputFile[] = [{ path: "index.html", contents: "<html></html>" }];
  const outputs = await runOutputsHooks(
    [{ name: "adds bytes", outputs: (list) => [...list, { path: "raw.bin", contents: bytes }] }],
    files,
    model.value,
  );
  assert.deepEqual(outputs.diagnostics, []);
  assert.deepEqual(outputs.value.map((file) => file.path), ["index.html", "raw.bin"]);
  assert.equal(outputs.value[1]?.contents, bytes, "bytes pass through unchanged");
});
