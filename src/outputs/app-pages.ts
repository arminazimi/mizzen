import type { Page } from "../contracts/content.ts";

/** What the app-pages unit reads. The site model already knows the app pages; the unit only answers about URLs. */
export interface AppPagesOptions {
  /** Every page of the site model. Only `url` and `kind` are read. */
  readonly pages: readonly Page[];
}

/**
 * Reduces a site URL to the path that says what it is: the query and the hash go, a trailing `index.html` goes, and a
 * trailing slash goes, so `/dashboard/`, `/dashboard`, and `/dashboard/index.html` all reduce to `/dashboard`.
 */
function asPath(url: string): string {
  let path = url.trim();
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);
  path = path.replace(/\/index\.html?$/i, "");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * True when `url` is an app page or a file inside one.
 *
 * An app page is a folder whose `index.html` has no front matter: discovery marks the folder and every file in it
 * `app`, and the site model lists the page with `kind: "app"`, whose URL is the root every file inside it shares.
 * Outputs test each URL they are about to touch and skip it when this returns true, so search, the llms files, the
 * twins, and the source map carry no app page; `copyAssets` is what still passes the files through untouched.
 */
export function isAppPage(url: string, options: AppPagesOptions): boolean {
  const path = asPath(url);
  for (const page of options.pages) {
    if (page.kind !== "app") continue;
    const root = asPath(page.url);
    // Discovery never marks the site root an app page, so an `app` page at `/` is bad input, not a root to skip.
    if (root === "/") continue;
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  return false;
}
