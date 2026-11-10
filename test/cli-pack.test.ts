import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { main, parseArgs, usage } from "../src/cli/index.ts";
import { estimateTokens } from "../src/packs/tokens.ts";

/** A temporary site holding `files`. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cli-pack-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function capture() {
  const writes: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    writes,
    errors,
    logs,
    io: {
      write: (text: string) => {
        writes.push(text);
      },
      error: (message: string) => {
        errors.push(message);
      },
      log: (message: string) => {
        logs.push(message);
      },
    },
  };
}

const INSTALL = `# Install the engine

Install the engine before you configure the site. Install once per machine.

## Requirements

You need Node 24 or newer and a terminal to install.

## Steps

Run the installer and follow the prompts to install.

## Troubleshooting

If the installer fails, read the log.
`;

const DEPLOY = `# Deploy the site

Deploy the built site behind a proxy.

## Build

Run the build and deploy the output folder.
`;

const TWO_TOPICS = `- topic: Install
  budget: 20000
- topic: Deploy
  budget: 20000
`;

const ONE_TOPIC = `- topic: Install
  budget: 20000
`;

/** A site with the two pages and the given topic data. */
function site(topics?: string): string {
  return tree({
    "mizzen.yml": "title: Demo\n",
    "guide/install.md": INSTALL,
    "guide/deploy.md": DEPLOY,
    ...(topics === undefined ? { "index.md": "# Home\n" } : { "_data/context-packs.yml": topics }),
  });
}

test("parseArgs: pack defaults, flags, and usage errors", () => {
  assert.deepEqual(parseArgs(["pack"]), { options: { command: "pack", root: "." } });
  assert.deepEqual(parseArgs(["pack", "site"]), { options: { command: "pack", root: "site" } });
  assert.deepEqual(parseArgs(["pack", "site", "--topic", "install", "--budget", "8000", "--out", "pack.md"]), {
    options: { command: "pack", root: "site", topic: "install", budget: 8000, out: "pack.md" },
  });
  assert.equal("error" in parseArgs(["build", "--topic", "install"]), true);
  assert.equal("error" in parseArgs(["check", "--budget", "8000"]), true);
  assert.equal("error" in parseArgs(["pack", "--budget", "0"]), true);
  assert.equal("error" in parseArgs(["pack", "--budget", "-5"]), true);
  assert.equal("error" in parseArgs(["pack", "--budget", "8.5"]), true);
  assert.equal("error" in parseArgs(["pack", "--topic", "  "]), true);
  assert.ok(usage.includes("pack [dir]"), "the usage string documents pack");
  assert.ok(usage.includes("--topic <name>"), "the usage string documents --topic");
  assert.ok(usage.includes("--budget <tokens>"), "the usage string documents --budget");
});

test("pack prints one topic's Markdown to stdout without a theme", async () => {
  const root = site(ONE_TOPIC);
  const { writes, errors, io } = capture();
  try {
    const code = await main(["pack", root], io);
    assert.equal(code, 0);
    assert.deepEqual(errors, []);
    assert.equal(writes.length, 1);
    const contents = writes[0]!;
    assert.match(contents, /^# Context pack: Install\n\n## Install the engine\n/);
    assert.match(contents, /\n- URL: \/guide\/install\/\n/);
    assert.match(contents, /\n- Source: `guide\/install\.md`\n/);
    assert.match(contents, /## Requirements/);
    // stdout is the pack itself, with its trailing newline and nothing else.
    assert.ok(contents.endsWith("\n"));
    assert.equal(contents, contents.replace(/\n$/, "") + "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--out writes the same bytes to a file and leaves stdout empty", async () => {
  const root = site(TWO_TOPICS);
  const out = join(root, "nested", "install.md");
  try {
    const stdout = capture();
    assert.equal(await main(["pack", root, "--topic", "install"], stdout.io), 0);
    const direct = stdout.writes[0]!;

    const file = capture();
    assert.equal(await main(["pack", root, "--topic", "install", "--out", out], file.io), 0);
    assert.deepEqual(file.writes, []);
    assert.deepEqual(file.errors, []);
    assert.ok(existsSync(out));
    assert.equal(readFileSync(out, "utf8"), direct);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site with several topics lists them and exits 2 without --topic", async () => {
  const root = site(TWO_TOPICS);
  const { writes, errors, io } = capture();
  try {
    assert.equal(await main(["pack", root], io), 2);
    assert.deepEqual(writes, []);
    const text = errors.join("\n");
    assert.match(text, /--topic is required/);
    assert.match(text, /- Install/);
    assert.match(text, /- Deploy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--topic selects by name, case, or slug", async () => {
  const root = site(TWO_TOPICS);
  try {
    for (const request of ["Install", "install", "INSTALL"]) {
      const { writes, errors, io } = capture();
      assert.equal(await main(["pack", root, "--topic", request], io), 0, request);
      assert.deepEqual(errors, []);
      assert.match(writes[0]!, /^# Context pack: Install\n/);
    }
    const deploy = capture();
    assert.equal(await main(["pack", root, "--topic", "deploy"], deploy.io), 0);
    assert.match(deploy.writes[0]!, /^# Context pack: Deploy\n/);
    assert.doesNotMatch(deploy.writes[0]!, /## Install the engine/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown topic exits 2 with the available topics", async () => {
  const root = site(TWO_TOPICS);
  const { writes, errors, io } = capture();
  try {
    assert.equal(await main(["pack", root, "--topic", "quantum"], io), 2);
    assert.deepEqual(writes, []);
    assert.match(errors.join("\n"), /unknown topic: quantum/);
    assert.match(errors.join("\n"), /available topics: Deploy, Install/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--budget overrides the topic's budget", async () => {
  const root = site(ONE_TOPIC);
  try {
    const roomy = capture();
    assert.equal(await main(["pack", root], roomy.io), 0);
    assert.match(roomy.writes[0]!, /## Troubleshooting/);

    const tight = capture();
    assert.equal(await main(["pack", root, "--budget", "80"], tight.io), 0);
    const contents = tight.writes[0]!;
    assert.ok(estimateTokens(contents).tokens <= 80, `pack is ${estimateTokens(contents).tokens} tokens`);
    assert.match(contents, /## Requirements/);
    assert.doesNotMatch(contents, /## Troubleshooting/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an invalid --budget is a usage error", async () => {
  const root = site(ONE_TOPIC);
  try {
    for (const value of ["0", "1.5", "many"]) {
      const { writes, errors, io } = capture();
      assert.equal(await main(["pack", root, "--budget", value], io), 2, value);
      assert.deepEqual(writes, []);
      assert.match(errors.join("\n"), /--budget must be a positive whole number of tokens/);
    }
    // A leading `-` reads as the next option, as it does for every flag.
    const negative = capture();
    assert.equal(await main(["pack", root, "--budget", "-1"], negative.io), 2);
    assert.match(negative.errors.join("\n"), /--budget needs a value/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a site without topics exits 2 with a clear message", async () => {
  const root = site();
  const { writes, errors, io } = capture();
  try {
    assert.equal(await main(["pack", root], io), 2);
    assert.deepEqual(writes, []);
    assert.match(errors.join("\n"), /no context pack topics/);
    assert.match(errors.join("\n"), /_data\/context-packs\.yml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a topic with no matching pages exits 1 and names the topic", async () => {
  const root = site("- topic: Quantum\n  query: quantum\n");
  const { writes, errors, io } = capture();
  try {
    assert.equal(await main(["pack", root], io), 1);
    assert.deepEqual(writes, []);
    assert.match(errors.join("\n"), /context-pack\.no-pages/);
    assert.match(errors.join("\n"), /no pages match the topic Quantum/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same site gives the same pack bytes", async () => {
  const root = site(ONE_TOPIC);
  try {
    const first = capture();
    const second = capture();
    assert.equal(await main(["pack", root, "--topic", "install"], first.io), 0);
    assert.equal(await main(["pack", root, "--topic", "install"], second.io), 0);
    assert.deepEqual(second.writes, first.writes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
