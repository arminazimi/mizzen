/** Options that shape a page's output URL. */
export interface PermalinkOptions {
  /** Front matter `permalink`. When set, it wins over the path derived from the file. */
  readonly permalink?: string;
  /**
   * Site `base` from config: a path starting with `/` and without a trailing slash, or `""` at a
   * domain root. Every URL the engine writes carries it.
   */
  readonly base?: string;
}

const PAGE_EXT = /\.(md|markdown|html|htm)$/i;

/** Normalize a site-relative path so it starts with `/`. */
function asUrlPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Prefix `url` with `base`. `base` is `""` or `/docs`-shaped (no trailing slash). */
function withBase(base: string, url: string): string {
  if (base === "") return url;
  if (url === "/") return `${base}/`;
  return `${base}${url}`;
}

/**
 * Derive the pretty URL for a source path: `a/b.md` → `/a/b/`; `a/index.md` and `a/README.md` → `/a/`.
 */
function fromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  const withoutExt = normalized.replace(PAGE_EXT, "");
  const segments = withoutExt.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1];
  if (last === "index" || last === "README") segments.pop();
  if (segments.length === 0) return "/";
  return `/${segments.join("/")}/`;
}

/**
 * Turn a source path into the page URL, including `base`.
 *
 * Unset front matter uses the file path (pretty URLs). Front matter `permalink` wins when set.
 */
export function permalink(path: string, options: PermalinkOptions = {}): string {
  const base = options.base ?? "";
  const fromFrontMatter = options.permalink;
  const url =
    fromFrontMatter !== undefined && fromFrontMatter.trim() !== ""
      ? asUrlPath(fromFrontMatter)
      : fromPath(path);
  return withBase(base, url);
}
