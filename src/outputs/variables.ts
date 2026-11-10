import type { Output, OutputContext, OutputFile, Page, Site, SourcePos } from "../contracts/index.ts";
import { placeholdersOf } from "../markdown/plugins/placeholders.ts";

/**
 * `variables.json`: every `{{name}}` placeholder a doc page uses, with its declaration when the site has one and
 * every page that uses it.
 *
 * Declarations live in `_data/variables.yml`, because the site config schema is frozen and a data file is
 * the no-contract home. The file is a list of `{ name, default, type }`:
 *
 * ```yaml
 * - name: api_key
 *   default: YOUR_KEY
 *   type: string
 * ```
 *
 * A name a page uses without a declaration is still listed, with `default: null` and `type: "unknown"`, so a theme's
 * form can show every variable a reader may replace. A variable declared but unused by any page is listed with an
 * empty `pages` list, because the declaration is part of the site's vocabulary.
 *
 * A name declared twice with different defaults or types is reported as `variables.conflict`; the first value wins, so
 * the file stays deterministic. `Site.data` keeps no source positions, so the diagnostic names the declarations file
 * without an exact line.
 *
 * No variable at all writes no file. Entries sort by name and pages by URL, both by code point, and the JSON uses two
 * spaces and a trailing line feed, so two builds of the same site write the same bytes.
 *
 */

/** One variable as `_data/variables.yml` declares it. `default` and `type` are optional. */
export interface VariableDeclaration {
  /** The name between the braces, trimmed: `api_key` in `{{api_key}}`. */
  readonly name: string;
  /** The value the form starts with, when the declaration gives one. */
  readonly default?: unknown;
  /** What kind of value the variable takes, such as `string` or `url`, when the declaration gives one. */
  readonly type?: string;
}

/** One entry of `variables.json`, with a fixed key order: `name`, `default`, `type`, `pages`. */
export interface VariableEntry {
  /** The variable name. */
  readonly name: string;
  /** The declared default, `null` for a variable no declaration covers, or absent when the declaration has none. */
  readonly default?: unknown;
  /** The declared type, `unknown` for a variable no declaration covers, or absent when the declaration has none. */
  readonly type?: string;
  /** Every doc page that uses the variable, by URL, sorted by code point. Empty for a declaration no page uses. */
  readonly pages: readonly string[];
}

/** Two declarations of one name whose defaults or types disagree. */
export interface VariableConflict {
  /** The name declared twice. */
  readonly name: string;
  /** The declaration that supplied the value the entry keeps. */
  readonly first: VariableDeclaration;
  /** The later declaration that disagrees with the kept value. */
  readonly duplicate: VariableDeclaration;
}

/** What {@link variablesOf} found: the entries that go in the file, and the declarations that disagree. */
export interface Variables {
  /** One entry per distinct name, sorted by name. */
  readonly entries: readonly VariableEntry[];
  /** Conflicting declarations, sorted by name. */
  readonly conflicts: readonly VariableConflict[];
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A mapping from a data file, as opposed to an array or a scalar. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality for the values a YAML or JSON declaration can hold. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => same(item, b[index]));
  }
  if (isMapping(a) && isMapping(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return false;
}

/** One name's declarations folded into the values the entry carries. */
interface DeclaredVariable {
  /** Whether a declaration supplied a default, so an explicit `null` stays distinct from no default. */
  hasDefault: boolean;
  default?: unknown;
  /** The declaration that supplied `default`, named in a conflict. */
  defaultFrom?: VariableDeclaration;
  type?: string;
  /** The declaration that supplied `type`, named in a conflict. */
  typeFrom?: VariableDeclaration;
}

/**
 * The declarations in `site.data.variables`, the list `_data/variables.yml` loads into. A missing value, a value that
 * is not a list, an item that is not a mapping, and a declaration without a non-empty string `name` are ignored, so a
 * partial file still contributes the declarations it can. Names and types are trimmed.
 */
export function declarationsOf(data: Readonly<Record<string, unknown>>): readonly VariableDeclaration[] {
  const value = data["variables"];
  if (!Array.isArray(value)) return [];

  const declarations: VariableDeclaration[] = [];
  for (const item of value) {
    if (!isMapping(item)) continue;
    const rawName = item["name"];
    if (typeof rawName !== "string") continue;
    const name = rawName.trim();
    if (name === "") continue;
    const rawType = item["type"];
    declarations.push({
      name,
      ...(Object.hasOwn(item, "default") ? { default: item["default"] } : {}),
      ...(typeof rawType === "string" && rawType.trim() !== "" ? { type: rawType.trim() } : {}),
    });
  }
  return declarations;
}

/**
 * The entries and conflicts of a site: the union of the names its pages use and the names it declares, sorted by name.
 *
 * `used` maps each name to the pages that use it. A name without a declaration gets `default: null` and
 * `type: "unknown"`. A later declaration of a name fills a default or type the first one left out; when both give a
 * value and the values differ, the later one is a conflict, the first value is kept, and the entry still lists every
 * page that uses the name. This is the pure step {@link variables} runs, so a test can build the map by hand.
 */
export function variablesOf(
  used: ReadonlyMap<string, readonly string[]>,
  declarations: readonly VariableDeclaration[],
): Variables {
  const names = new Set<string>(used.keys());
  for (const declaration of declarations) names.add(declaration.name);

  const declared = new Map<string, DeclaredVariable>();
  const conflicts: VariableConflict[] = [];

  for (const declaration of declarations) {
    const prior = declared.get(declaration.name);
    const hasDefault = Object.hasOwn(declaration, "default");
    if (prior === undefined) {
      declared.set(declaration.name, {
        hasDefault,
        ...(hasDefault ? { default: declaration.default, defaultFrom: declaration } : {}),
        ...(declaration.type === undefined ? {} : { type: declaration.type, typeFrom: declaration }),
      });
      continue;
    }

    const defaultDiffers = hasDefault && prior.hasDefault && !same(declaration.default, prior.default);
    const typeDiffers = declaration.type !== undefined && prior.type !== undefined && declaration.type !== prior.type;
    if (defaultDiffers || typeDiffers) {
      const first = (defaultDiffers ? prior.defaultFrom : prior.typeFrom) ?? declaration;
      conflicts.push({ name: declaration.name, first, duplicate: declaration });
      continue;
    }

    if (hasDefault && !prior.hasDefault) {
      prior.hasDefault = true;
      prior.default = declaration.default;
      prior.defaultFrom = declaration;
    }
    if (declaration.type !== undefined && prior.type === undefined) {
      prior.type = declaration.type;
      prior.typeFrom = declaration;
    }
  }

  const entries: VariableEntry[] = [];
  for (const name of [...names].sort(byCodePoint)) {
    const pages = [...(used.get(name) ?? [])].sort(byCodePoint);
    const declaration = declared.get(name);
    entries.push(
      declaration === undefined
        ? { name, default: null, type: "unknown", pages }
        : {
            name,
            ...(declaration.hasDefault ? { default: declaration.default } : {}),
            ...(declaration.type === undefined ? {} : { type: declaration.type }),
            pages,
          },
    );
  }

  return { entries, conflicts: conflicts.sort((a, b) => byCodePoint(a.name, b.name)) };
}

/**
 * Every variable each doc page uses, keyed by name. Each name's list holds its page URLs once each, sorted by code
 * point. App and asset pages are left out: they are programs or files, not documents. The pages are parsed again with
 * the same parser the build used, which is how {@link placeholdersOf} keeps positions exact.
 */
export async function usedVariables(pages: readonly Page[]): Promise<ReadonlyMap<string, readonly string[]>> {
  const found = new Map<string, Set<string>>();
  for (const page of [...pages].sort((a, b) => byCodePoint(a.url, b.url))) {
    if (page.kind !== "doc") continue;
    // A page with no braces has no placeholder, so it is not parsed again: most pages of most sites skip this.
    if (!page.markdown.includes("{{")) continue;
    for (const placeholder of await placeholdersOf(page)) {
      const urls = found.get(placeholder.name);
      if (urls === undefined) found.set(placeholder.name, new Set([page.url]));
      else urls.add(page.url);
    }
  }

  const used = new Map<string, readonly string[]>();
  for (const [name, urls] of found) used.set(name, [...urls].sort(byCodePoint));
  return used;
}

/** The only span `site.data` can name: the declaration file, whose positions the data stage does not keep. */
const DECLARATIONS_POS: SourcePos = { file: "_data/variables.yml", line: 1, column: 1, endLine: 1, endColumn: 1 };

/**
 * Writes `variables.json` with one entry per variable. See the module comment for the shape, the declaration file, and
 * the rules. A conflicting declaration is reported as `variables.conflict` and does not stop the file from being
 * written, with the first value. A site with no variable writes no file.
 */
export const variables: Output = {
  name: "variables",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const { entries, conflicts } = variablesOf(await usedVariables(site.pages), declarationsOf(site.data));

    for (const conflict of conflicts) {
      ctx.report({
        id: "variables.conflict",
        severity: "error",
        message: `The variable ${JSON.stringify(conflict.name)} is declared more than once with different defaults or types.`,
        pos: DECLARATIONS_POS,
        help: "Keep one declaration for each variable, or make the duplicates agree.",
      });
    }

    if (entries.length === 0) return [];
    return [{ path: "variables.json", contents: `${JSON.stringify(entries, null, 2)}\n` }];
  },
};
