import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import { discoverVersions, type VersionedPage } from "../content/versions.ts";
import { diffMarkdown } from "../versions/diff.ts";

/** A section only the newer version has, reduced to what the viewer needs. */
interface AddedSectionJson {
  readonly heading: string;
  readonly id: string;
  readonly occurrence: number;
  /** The section's text in the newer version. */
  readonly text: string;
}

/** A section only the older version has, reduced to what the viewer needs. */
interface RemovedSectionJson {
  readonly heading: string;
  readonly id: string;
  readonly occurrence: number;
  /** The section's text in the older version. */
  readonly text: string;
}

/** A section both versions have with different text, or in a different place. */
interface EditedSectionJson {
  readonly heading: string;
  readonly id: string;
  readonly occurrence: number;
  readonly oldText: string;
  readonly newText: string;
}

/** The body of one `diff/<version>/<page>.json`. */
interface VersionDiffJson {
  /** The page's path inside its version, such as `guide/install.md`. */
  readonly path: string;
  /** The older version folder. */
  readonly from: string;
  /** The newer version folder. */
  readonly to: string;
  readonly added: readonly AddedSectionJson[];
  readonly removed: readonly RemovedSectionJson[];
  readonly changed: readonly EditedSectionJson[];
  readonly moved: readonly EditedSectionJson[];
}

/** A Markdown extension a page source carries, removed before it names a JSON file. */
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i;

/** Everything a URL-safe slug keeps: letters, marks, numbers, and the three separators. */
const SLUG_UNSAFE = /[^\p{L}\p{M}\p{N}._-]+/gu;

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One path segment as a URL-safe slug: lowercased, a Markdown extension removed, every run of other
 * characters replaced by `-`, and leading or trailing dots and hyphens trimmed. Trimming the dots keeps a
 * `.` or `..` segment from surviving as a traversal; an empty result is dropped by {@link diffPath}.
 */
function slug(segment: string): string {
  return segment
    .normalize("NFC")
    .toLowerCase()
    .replace(MARKDOWN_EXTENSION, "")
    .replace(SLUG_UNSAFE, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .replace(/\.{2,}/gu, ".");
}

/**
 * The file a page's diff lands at: `diff/` and the version being compared to, then the page's path inside
 * the version. Including the newer version keeps one file per versioned page when a page differs across
 * three or more versions, and makes the address mirror the page's version and path.
 * Every segment is a {@link slug}, so the result has `/` only between segments and no `.` or `..` segment.
 */
function diffPath(version: string, path: string): string {
  const folder = slug(version) || "version";
  const segments = path
    .split("/")
    .map(slug)
    .filter((segment) => segment !== "" && segment !== "." && segment !== "..");
  if (segments.length === 0) segments.push("index");
  return `diff/${folder}/${segments.join("/")}.json`;
}

/** The pages of each version, keyed by their path inside the version, in path order. */
interface VersionGroups {
  /** The version folders in version order, as `discoverVersions` sorted them. */
  readonly versions: readonly string[];
  /** Every path that exists in at least one version, with the page each version holds for it. */
  readonly pages: ReadonlyMap<string, ReadonlyMap<string, VersionedPage>>;
}

/** Group the model's doc pages by version-relative path, keeping the first page when a path repeats in one version. */
function group(pages: readonly VersionedPage[]): VersionGroups {
  const versions: string[] = [];
  const byPath = new Map<string, Map<string, VersionedPage>>();

  for (const entry of pages) {
    if (entry.version === null) continue;
    if (!versions.includes(entry.version)) versions.push(entry.version);
    let byVersion = byPath.get(entry.path);
    if (byVersion === undefined) {
      byVersion = new Map();
      byPath.set(entry.path, byVersion);
    }
    if (!byVersion.has(entry.version)) byVersion.set(entry.version, entry);
  }

  return { versions, pages: byPath };
}

/** The one-sided sections, with the source range left out so the file stays small. */
function addedSections(diff: ReturnType<typeof diffMarkdown>): readonly AddedSectionJson[] {
  return diff.added.map(({ heading, id, occurrence, newText }) => ({ heading, id, occurrence, text: newText }));
}

/** The removed sections, with the source range left out so the file stays small. */
function removedSections(diff: ReturnType<typeof diffMarkdown>): readonly RemovedSectionJson[] {
  return diff.removed.map(({ heading, id, occurrence, oldText }) => ({ heading, id, occurrence, text: oldText }));
}

/** The edited and moved sections; a moved section also carries its edit when it has one. */
function editedSections(sections: ReturnType<typeof diffMarkdown>["changed"]): readonly EditedSectionJson[] {
  return sections.map(({ heading, id, occurrence, oldText, newText }) => ({
    heading,
    id,
    occurrence,
    oldText,
    newText,
  }));
}

/** Whether the diff says anything at all. */
function isEmpty(diff: ReturnType<typeof diffMarkdown>): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0 && diff.moved.length === 0;
}

/**
 * Writes one `diff/<version>/<page>.json` per versioned page that differs from the version before it.
 *
 * Pages are grouped by their path inside a version with `discoverVersions` (N15). Detection uses that
 * module's default rule, a `vN` folder as the first source segment: the output has no options of its own and
 * the config schema is frozen, so a site that needs custom roots, a version list, or renamed pages would need
 * the caller to pass those options. Versions are compared only when adjacent, and only when both hold the same
 * path: a page added or removed in a version has no counterpart to compare with and writes no file, and a page
 * whose sections all match writes none either. A page in three versions can therefore have one file for each
 * adjacent pair that changed it, addressed under the newer version's folder.
 *
 * The body holds `path`, `from`, `to`, and the four section lists from `diffMarkdown` (N16): added and removed
 * sections carry their heading, id, occurrence, and text; changed and moved sections carry both texts. Source
 * ranges are left out to keep the files small, which is all a diff viewer needs. The JSON uses two-space
 * indentation and ends with a line feed, and the files come back sorted by path, so a build is byte-stable.
 *
 * A page's output path is slugged segment by segment, so a folder name cannot be empty, `.`, or `..`, and a
 * path only uses `/` between segments. Generated files live under `diff/`. A site's own folder named `diff/`
 * keeps precedence at the same paths: the site's copy is written and the generated file is skipped, as it is
 * for every output (ADR 0023; see `outputs/README.md`).
 */
export const versionDiff: Output = {
  name: "version-diff",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const entries = discoverVersions(site.pages.filter((page) => page.kind === "doc"));
    const { versions, pages } = group(entries);
    if (versions.length < 2) return [];

    const paths = [...pages.keys()].sort(byCodePoint);
    const files: OutputFile[] = [];
    const claimed = new Map<string, string>();

    for (let index = 1; index < versions.length; index += 1) {
      const from = versions[index - 1];
      const to = versions[index];
      if (from === undefined || to === undefined) continue;

      for (const path of paths) {
        const byVersion = pages.get(path);
        const older = byVersion?.get(from);
        const newer = byVersion?.get(to);
        if (older === undefined || newer === undefined) continue;

        const diff = diffMarkdown(older.page.markdown, newer.page.markdown);
        if (isEmpty(diff)) continue;

        const filePath = diffPath(to, path);
        const other = claimed.get(filePath);
        if (other !== undefined) {
          ctx.report({
            id: "version-diff.path-collision",
            severity: "warning",
            message: `Version diff for ${path} in ${to} writes "${filePath}", which the page from "${other}" already writes.`,
            pos: newer.page.source,
            help: "Rename one of the pages so their slugs differ.",
          });
          continue;
        }
        claimed.set(filePath, newer.page.source.file);

        const body: VersionDiffJson = {
          path,
          from,
          to,
          added: addedSections(diff),
          removed: removedSections(diff),
          changed: editedSections(diff.changed),
          moved: editedSections(diff.moved),
        };
        files.push({ path: filePath, contents: `${JSON.stringify(body, null, 2)}\n` });
      }
    }

    return files.sort((a, b) => byCodePoint(a.path, b.path));
  },
};
