import type { Diagnostic, Page, Site, SourcePos } from "../contracts/index.ts";
import { placeholdersOf, type Placeholder } from "../markdown/plugins/placeholders.ts";
import { declarationsOf } from "../outputs/variables.ts";

/**
 * The diagnostic for a `{{name}}` placeholder that no variable declares.
 *
 * The `placeholders` Markdown plugin (N32) keeps every placeholder a code span or code block carries, and the
 * `variables` output (N33) reads the site's vocabulary from `_data/variables.yml`, a list of `{ name, default, type }`.
 * A placeholder whose name is not in that list is usually a typo: the reader's form has nothing to fill in, and
 * `variables.json` lists the name with `default: null`. This unit reports it once per occurrence, at the exact span in
 * the page's source file, and changes no HTML, no Markdown, and no output file.
 *
 * Diagnostic codes:
 *
 * | Code | Severity | Meaning |
 * | --- | --- | --- |
 * | `placeholder.undefined` | `warning` | A placeholder in code has no declaration in `_data/variables.yml`. |
 *
 * A warning, like `footnote.missing-definition` and the model-time link check: a placeholder is valid content even
 * when the site has not declared it, and a later step may supply the declaration. Declared names, escaped `\{{name}}`
 * runs, and placeholders outside code produce nothing.
 *
 * Only document pages are inspected, because `variables` also leaves app and asset pages out: those are programs and
 * files, not prose a reader fills in. Pages are visited by URL and placeholders by source order, so the findings are
 * deterministic.
 */

/** The stable id of the undefined-placeholder finding. */
export const UNDEFINED_PLACEHOLDER = "placeholder.undefined";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The source span of a placeholder, in the page's source file. */
function posOf(page: Page, placeholder: Placeholder): SourcePos {
  return {
    file: page.source.file,
    line: placeholder.line,
    column: placeholder.column,
    endLine: placeholder.endLine,
    endColumn: placeholder.endColumn,
  };
}

/** The finding for one placeholder whose name no declaration covers. */
function diagnosticOf(page: Page, placeholder: Placeholder): Diagnostic {
  return {
    id: UNDEFINED_PLACEHOLDER,
    severity: "warning",
    message: `Placeholder "{{${placeholder.name}}}" has no declared variable.`,
    pos: posOf(page, placeholder),
    help: `Declare "${placeholder.name}" in \`_data/variables.yml\`, or escape it as \`\\{{${placeholder.name}}}\` to keep it literal.`,
  };
}

/**
 * Every placeholder in `pages` whose name is not in `declared`, in page URL order and then source order. Each
 * placeholder is parsed again by {@link placeholdersOf}, so the reported span is exact for the page's source file;
 * nothing is mutated.
 */
export async function undefinedPlaceholders(
  pages: readonly Page[],
  declared: ReadonlySet<string>,
): Promise<readonly Diagnostic[]> {
  const found: Diagnostic[] = [];
  for (const page of [...pages].sort((a, b) => byCodePoint(a.url, b.url))) {
    if (page.kind !== "doc") continue;
    // A page with no braces has no placeholder, so most pages of most sites skip the second parse.
    if (!page.markdown.includes("{{")) continue;
    for (const placeholder of await placeholdersOf(page)) {
      if (declared.has(placeholder.name)) continue;
      found.push(diagnosticOf(page, placeholder));
    }
  }
  return found;
}

/**
 * The undefined-placeholder findings of a site, using the declarations in `site.data.variables` (the list
 * `_data/variables.yml` loads into). A site with no declarations reports every placeholder it uses.
 */
export async function placeholderDiagnostics(site: Site): Promise<readonly Diagnostic[]> {
  const declared = new Set(declarationsOf(site.data).map((declaration) => declaration.name));
  return undefinedPlaceholders(site.pages, declared);
}
