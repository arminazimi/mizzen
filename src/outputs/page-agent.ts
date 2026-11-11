import { stringify } from "yaml";
import { parseAgentInstructions, type AgentBlock } from "../content/agent-instructions.ts";
import { discoverVersions } from "../content/versions.ts";
import type { Direction } from "../contracts/config.ts";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { version } from "../index.ts";
import { hashOf } from "./build-hash.ts";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Strips the site `base` from a page URL, along whole path segments only. Every URL the model carries includes
 * `base`, while the output folder is what deploys under `base` (GitHub Pages project sites), so the file path must
 * not repeat it. A URL that does not start with the base (which the model never makes) passes through untouched.
 */
function underBase(url: string, base: string): string {
  if (base === "") return url;
  if (url === base || url.startsWith(`${base}/`)) return url.slice(base.length) || "/";
  return url;
}

/**
 * The file a page's agent instructions land at: the page's URL with `agent.json` in place of the HTML file, so a
 * pretty URL (`/guide/install/`) gives `/guide/install/agent.json`, the site root gives `/agent.json`, and a URL that
 * already names an HTML file (`/404.html`) gives `/404.agent.json`. The last name keeps the page JSON's `404.json`
 * free, because both outputs run in one build. Returns undefined for a URL that names a file of another kind, which
 * has no page address to put a file beside.
 */
export function agentPath(url: string): string | undefined {
  const last = url.slice(url.lastIndexOf("/") + 1);
  if (/\.html?$/i.test(last)) {
    const stem = last.replace(/\.html?$/i, "");
    return `${url.slice(0, url.length - last.length)}${stem}.agent.json`;
  }
  if (last.includes(".")) return undefined;
  return `${url.endsWith("/") ? url : `${url}/`}agent.json`;
}

/**
 * The span of a page's front matter, from its first line to the closing fence. The model keeps the parsed front
 * matter, not its YAML, so this is the closest real span a diagnostic about the `agent:` block can name. Undefined
 * when the page has no front matter, where the block can only come from the config's `defaults`.
 */
function frontMatterSpan(page: Page): Diagnostic["pos"] {
  const close = page.source.line - 1;
  if (close < 2) return undefined;
  return { file: page.source.file, line: 1, column: 1, endLine: close, endColumn: 1 };
}

/** Every diagnostic of the parsed block, moved from the synthetic YAML to the page's own front matter. */
function atPage(page: Page, diagnostic: Diagnostic): Diagnostic {
  return { ...diagnostic, pos: frontMatterSpan(page) ?? page.source };
}

/**
 * The `agent:` block of one page, read with N24's parser.
 *
 * The model stores front matter already parsed, so the block goes back through YAML to reach the one parser that
 * knows its keys and types. That keeps a page's `agent.json` exactly as tolerant as the parser: unknown keys are
 * warnings and are left out, a wrong type is an error and that key is left out, and the keys that are readable are
 * still written. A block with no readable key writes no file, and neither does a page without a block.
 *
 * Diagnostics name the page's front-matter span rather than the exact key: the line of each key is gone by the time
 * the model holds the page. `report` is how the output passes them on; a build fails on the errors as usual.
 */
export function readAgentBlock(page: Page, report: (diagnostic: Diagnostic) => void): AgentBlock {
  const value: unknown = page.frontMatter.agent;
  if (value === undefined || value === null) return {};

  let yaml: string;
  try {
    yaml = stringify({ agent: value });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    report({
      id: "agent.invalid-block",
      severity: "error",
      message: `The \`agent\` block of ${page.url} cannot be read: ${detail}.`,
      pos: frontMatterSpan(page) ?? page.source,
      help: "Write `agent:` as a mapping of `edit`, `owner`, `rules`, `source`, and `notes`.",
    });
    return {};
  }

  const result = parseAgentInstructions(yaml, page.source.file);
  for (const diagnostic of result.diagnostics) report(atPage(page, diagnostic));
  return result.agent;
}

/**
 * The JSON body of one page's agent instructions, with a fixed key order so the same page gives the same bytes.
 * The block's keys follow `edit`, `owner`, `rules`, `source`, `notes`; a key the block does not set is left out.
 */
export interface PageAgent {
  /** Output URL, including `base`. */
  readonly url: string;
  /** The source file, relative to the site root, with forward slashes. */
  readonly source: string;
  /** The page's language, a BCP 47 tag. */
  readonly lang: string;
  /** The page's text direction. */
  readonly dir: Direction;
  /** The documentation version folder, or `null` when the page is outside every version. */
  readonly version: string | null;
  /** The build identity the instructions were read from. */
  readonly build: {
    /** The engine version that wrote the file. */
    readonly engine: string;
    /** SHA-256 of the page's source body, the manifest's `hashes.source` value. */
    readonly hash: string;
  };
  readonly agent: AgentBlock;
}

/** The documentation version folder of each doc page, by URL; `content/versions.ts` decides the rule. */
function versionsOf(site: Site): ReadonlyMap<string, string> {
  const versions = new Map<string, string>();
  for (const entry of discoverVersions(site.pages)) {
    if (entry.version !== null) versions.set(entry.page.url, entry.version);
  }
  return versions;
}

/** The block's keys in the output's fixed order, with the unset ones left out. */
function orderedAgent(block: AgentBlock): AgentBlock {
  return {
    ...(block.edit !== undefined ? { edit: block.edit } : {}),
    ...(block.owner !== undefined ? { owner: block.owner } : {}),
    ...(block.rules !== undefined ? { rules: block.rules } : {}),
    ...(block.source !== undefined ? { source: block.source } : {}),
    ...(block.notes !== undefined ? { notes: block.notes } : {}),
  };
}

/** A page's source file, relative to the site root, with forward slashes on every platform. */
function sourceOf(page: Page): string {
  return page.source.file.replace(/\\/g, "/");
}

/**
 * Writes `<url>/agent.json` beside each document page that has an `agent:` block: the page's URL, its source file,
 * its locale and documentation version, the build identity, and the block (`edit`, `owner`, `rules`, `source`,
 * `notes`), so an agent that opens one page also gets that page's rules without reading the whole site or the HTML.
 *
 * The instructions' claims trace back to the build: `build.hash` is the SHA-256 of the page's source body, the same
 * value `.mizzen/manifest.json` records under `hashes.source`, and `build.engine` is the engine version. `version` is
 * the documentation version folder (`content/versions.ts`), and `lang`/`dir` are the page's locale. No absolute path,
 * clock, or unselected page is written.
 *
 * A page without the block writes no file, and so does an app or asset page, a page whose URL names a file of another
 * kind, and a block whose every key is unreadable. A block with errors still writes its readable keys, and the errors
 * are reported. The site `base` is stripped from the path, as the HTML output strips it, so a project site writes
 * `guide/install/agent.json` into the output folder. Files come back sorted by path, whatever
 * order the model had.
 */
export const pageAgent: Output = {
  name: "page-agent",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const files: OutputFile[] = [];
    const versions = versionsOf(site);
    for (const page of site.pages) {
      if (page.kind !== "doc") continue;
      const url = agentPath(page.url);
      if (url === undefined) continue;
      const block = readAgentBlock(page, (diagnostic) => ctx.report(diagnostic));
      const agent = orderedAgent(block);
      if (Object.keys(agent).length === 0) continue;
      const body: PageAgent = {
        url: page.url,
        source: sourceOf(page),
        lang: page.lang,
        dir: page.dir,
        version: versions.get(page.url) ?? null,
        build: { engine: version, hash: hashOf(page.markdown) },
        agent,
      };
      files.push({
        path: underBase(url, site.config.base).replace(/^\//, ""),
        contents: `${JSON.stringify(body, null, 2)}\n`,
      });
    }
    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
