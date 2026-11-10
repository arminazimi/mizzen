import type { RepositoryConfig } from "../contracts/config.ts";
import type { Site } from "../contracts/content.ts";

/** Branch edit links point to when the config names none, the same default the theme uses. */
const DEFAULT_BRANCH = "main";

/** The repository host an edit URL is shaped for. */
type Host = "github" | "gitlab";

/** One page's edit link: where the page is, which source file it comes from, and the repository URL that edits it. */
export interface EditLink {
  /** Output URL of the page, including `base`, such as `/guide/install/`. */
  readonly url: string;
  /** The source file, relative to the repository root, with forward slashes. */
  readonly source: string;
  /** The page's file on the repository's web editor at the configured branch. */
  readonly editUrl: string;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The host whose edit URL shape applies, from the repository's web URL: `github` for a host that names GitHub,
 * `gitlab` for gitlab.com and a self-hosted GitLab (whose host names `gitlab`), and `undefined` for any other forge,
 * which has no edit URL the engine can write without guessing. A URL the parser rejects also reads as `undefined`.
 */
function hostOf(repository: RepositoryConfig): Host | undefined {
  let host: string;
  try {
    host = new URL(repository.url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return undefined;
}

/** The repository's web URL without trailing slashes. */
function webRoot(url: string): string {
  return url.replace(/\/+$/, "");
}

/** A source path with forward slashes and no leading `./` or `/`, as the repository browser names it. */
function sourcePath(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

/** Encodes each segment of a `/`-separated path, keeping the separators. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * The edit URL of one file: `${root}/edit/${branch}/${path}` on GitHub and `${root}/-/edit/${branch}/${path}` on
 * GitLab. The branch is one encoded segment, so a branch name with `/` stays a single path part, and each segment of
 * the file path is encoded while its `/` separators stay, so spaces and other characters survive the URL.
 */
function editUrlOf(root: string, host: Host, branch: string, path: string): string {
  const edit = host === "gitlab" ? "/-/edit" : "/edit";
  return `${root}${edit}/${encodeURIComponent(branch)}/${encodePath(path)}`;
}

/**
 * One edit link per document page that has a repository and a source file it can name: the page's URL, its source
 * file relative to the repository root, and the URL that opens that file in GitHub's or GitLab's web editor.
 *
 * App pages, asset pages, and a page with an empty source path have no edit link. `repository.dir` is already part of
 * `page.source.file` (the model names every source from the repository root), so this adds nothing to it. A
 * repository on another forge, or an unparseable URL, yields no links: the two shapes are the ones the config's
 * `repository` is for, and guessing a third would produce a URL that 404s.
 *
 * Links come back sorted by page URL, then by source path, whatever order the model had.
 */
export function editLinksOf(site: Site): readonly EditLink[] {
  const repository = site.config.repository;
  if (repository === undefined) return [];
  const host = hostOf(repository);
  if (host === undefined) return [];

  const root = webRoot(repository.url);
  const branch = repository.branch ?? DEFAULT_BRANCH;
  const links: EditLink[] = [];

  for (const page of site.pages) {
    if (page.kind !== "doc") continue;
    const source = sourcePath(page.source.file);
    if (source.trim() === "") continue;
    links.push({ url: page.url, source, editUrl: editUrlOf(root, host, branch, source) });
  }

  return links.sort((a, b) => byCodePoint(a.url, b.url) || byCodePoint(a.source, b.source));
}
