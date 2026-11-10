// Writes examples/product-docs/reference/: one page per command, in the shape a generator produces.
// A generator's output is committed, so `node examples/product-docs/generate.ts --check` is what CI runs.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(fileURLToPath(new URL(".", import.meta.url)), "reference");

/** Name, one-line summary, usage, and the flags worth a table row. */
const commands = [
  ["init", "writes beacon.yml", "beacon init [--force]", [["--force", "overwrite an existing file"]]],
  ["build", "runs the build command", "beacon build [--env NAME]", [["--env", "read that environment's build command"]]],
  ["deploy", "uploads an artifact and points an environment at it", "beacon deploy ENV [--dry-run] [--json]", [["--dry-run", "print what would upload"], ["--json", "one object per step"]]],
  ["releases", "lists the last artifacts", "beacon releases [--limit N]", [["--limit", "how many to print"]]],
  ["rollback", "points an environment at an older artifact", "beacon rollback ENV ARTIFACT", [["--yes", "skip the confirmation"]]],
  ["status", "prints what each environment serves", "beacon status [--json]", [["--json", "machine-readable output"]]],
  ["login", "stores a token for later runs", "beacon login [--token T]", [["--token", "read the token from a flag"]]],
  ["logout", "forgets a stored token", "beacon logout", []],
  ["targets", "lists configured targets", "beacon targets", []],
  ["env", "lists environments", "beacon env [--json]", [["--json", "machine-readable output"]]],
  ["config show", "prints the resolved configuration", "beacon config show", []],
  ["config set", "writes one key to beacon.yml", "beacon config set KEY VALUE", []],
  ["config path", "prints the file Beacon read", "beacon config path", []],
  ["validate", "checks beacon.yml without touching a target", "beacon validate", []],
  ["cache clear", "drops the local build cache", "beacon cache clear", []],
  ["cache ls", "lists cached artifacts", "beacon cache ls", []],
  ["logs", "streams the deploy log", "beacon logs ENV [--follow]", [["--follow", "keep streaming"]]],
  ["secret set", "stores a secret for hooks", "beacon secret set NAME VALUE", []],
  ["secret ls", "lists secret names, never values", "beacon secret ls", []],
  ["secret rm", "deletes a secret", "beacon secret rm NAME", []],
  ["hook run", "runs one hook by hand", "beacon hook run NAME", []],
  ["hook ls", "lists configured hooks", "beacon hook ls", []],
  ["size", "reports the artifact size per file", "beacon size [--top N]", [["--top", "how many files to print"]]],
  ["diff", "compares two artifacts", "beacon diff A B", []],
  ["purge", "removes old artifacts", "beacon purge [--keep N]", [["--keep", "how many to leave"]]],
  ["doctor", "checks the machine and the configuration", "beacon doctor", []],
  ["version", "prints the version and build date", "beacon version", []],
  ["completion", "prints a shell completion script", "beacon completion SHELL", []],
  ["help", "prints help for any command", "beacon help COMMAND", []],
];

/** One page of Markdown, written the same way every time. */
function page([name, summary, usage, flags]: any[]) {
  const slug = name.replace(/ /g, "-");
  const rows = flags.length
    ? `\n\n## Flags\n\n| Flag | What it does |\n| --- | --- |\n${flags.map(([flag, text]) => `| \`${flag}\` | ${text} |`).join("\n")}`
    : "";
  return `# beacon ${name}\n\n${summary.charAt(0).toUpperCase()}${summary.slice(1)}.\n\n## Usage\n\n\`\`\`bash\n${usage}\n\`\`\`${rows}\n\nSee [commands](../commands.md) for the everyday set.\n`;
}

function index() {
  const rows = commands.map(([name, summary]: any[]) => `| [beacon ${name}](./${name.replace(/ /g, "-")}.md) | ${summary} |`).join("\n");
  return `# Reference\n\nOne page per command, written by \`generate.mjs\`. This section stands in for a\nreal product's generated reference: a page each, no front matter, and a table of contents\nthat stays in step with the pages.\n\n| Command | What it does |\n| --- | --- |\n${rows}\n`;
}

const files = new Map<string, string>([["index.md", index()], ...commands.map(([name, ...rest]: any[]) => [`${name.replace(/ /g, "-")}.md`, page([name, ...rest])] as [string, string])]);

if (process.argv.includes("--check")) {
  const onDisk = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  const wanted = [...files.keys()].sort();
  const stale = wanted.filter((name) => !onDisk.includes(name) || readFileSync(join(dir, name), "utf8") !== files.get(name));
  const extra = onDisk.filter((name) => !wanted.includes(name));
  if (stale.length || extra.length) {
    console.error(`reference/ is not what generate.mjs writes (stale: ${stale.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
    process.exitCode = 1;
  } else {
    console.log(`reference/: ${wanted.length} pages up to date`);
  }
} else {
  for (const [name, text] of files) writeFileSync(join(dir, name), text);
  console.log(`wrote ${files.size} pages to reference/`);
}
