// Writes fixtures/docs-site/rules/: about 550 rule pages, the shape of a linter's generated reference.
// The output is committed. The generator is deterministic (fixed seed, no clock), so running it twice
// gives no diff, and `node fixtures/docs-site/generate.ts --check` fails when the folder is stale.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "rules");
const COUNT = 550;

/** mulberry32: a tiny seeded generator, so the pages never change between runs. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seeded(1033);
const pick = (list) => list[Math.floor(random() * list.length)];

const categories = ["build", "cache", "config", "deploy", "hooks", "logs", "network", "secrets", "targets", "artifacts"];
const severities = ["error", "warning", "info"];
const subjects = ["artifact", "environment", "hook", "target", "token", "manifest", "release", "cache entry", "log line", "build step"];
const problems = ["is missing", "is empty", "is duplicated", "is older than expected", "is larger than the limit", "uses a deprecated form", "is not readable", "points at nothing"];

/** The rule table: the id is `<category>-<n>`, numbered within its category so ids are stable. */
const counts = new Map();
const rules = Array.from({ length: COUNT }, () => {
  const category = pick(categories);
  const n = (counts.get(category) ?? 0) + 1;
  counts.set(category, n);
  const subject = pick(subjects);
  const problem = pick(problems);
  const severity = pick(severities);
  return { id: `${category}-${String(n).padStart(3, "0")}`, category, severity, subject, problem, limit: 1 + Math.floor(random() * 99), withFrontMatter: random() < 0.4 };
});

/** One page. Some start with front matter, the others with an h1, as in Evergreen's generated pages. */
function page(rule) {
  const title = `Rule ${rule.id}`;
  const summary = `Reports when a ${rule.subject} ${rule.problem}.`;
  const head = rule.withFrontMatter ? `---\ntitle: ${title}\ndescription: ${summary}\n---\n\n` : `# ${title}\n\n`;
  const body = `${summary}\n\n## Details\n\n| Property | Value |\n| --- | --- |\n| Category | \`${rule.category}\` |\n| Severity | \`${rule.severity}\` |\n| Limit | ${rule.limit} |\n\n## Fix\n\nChange the ${rule.subject} so it no longer ${rule.problem}, then run \`beacon doctor\` again.\n\n\`\`\`bash\nbeacon doctor --rule ${rule.id}\n\`\`\`\n\nSee [all rules](./index.md) or the [doctor command](../reference/doctor.md).\n`;
  return head + body;
}

function index() {
  const rows = rules.map((rule) => `| [${rule.id}](./${rule.id}.md) | ${rule.category} | ${rule.severity} |`).join("\n");
  return `# Rules\n\n${rules.length} rules, one page each, written by \`generate.mjs\`. This section stands in for a large generated reference: pages in a folder, a table of contents that lists them all, and a navigation entry that matches the folder by prefix.\n\n| Rule | Category | Severity |\n| --- | --- | --- |\n${rows}\n`;
}

const files = new Map<string, string>([["index.md", index()], ...rules.map((rule) => [`${rule.id}.md`, page(rule)] as [string, string])]);

if (process.argv.includes("--check")) {
  const onDisk = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  const wanted = [...files.keys()].sort();
  const stale = wanted.filter((name) => !onDisk.includes(name) || readFileSync(join(dir, name), "utf8") !== files.get(name));
  const extra = onDisk.filter((name) => !wanted.includes(name));
  if (stale.length || extra.length) {
    console.error(`rules/ is stale: ${[...stale, ...extra.map((n) => `${n} (left over)`)].slice(0, 5).join(", ")}. Run node fixtures/docs-site/generate.ts.`);
    process.exit(1);
  }
  console.log(`rules/ is current (${files.size} pages)`);
} else {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (name.endsWith(".md") && !files.has(name)) rmSync(join(dir, name));
  for (const [name, text] of files) writeFileSync(join(dir, name), text);
  console.log(`wrote ${files.size} pages to rules/`);
}
