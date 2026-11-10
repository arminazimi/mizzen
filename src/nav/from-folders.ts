import type { NavItem, NavLink } from "../contracts/nav.ts";

/** A page to place in the navigation built from folders. */
export interface FolderPage {
  /** Path of the source file under the source folder, `/`-separated, such as `guide/install.md`. */
  readonly path: string;
  /** Output URL, including `base`. */
  readonly url: string;
  /** Page title, as the page resolves it (front matter, first `h1`, or file name). */
  readonly title: string;
  /** Sort order among siblings, from front matter `order`. */
  readonly order?: number;
}

/** A folder while the tree is built. */
interface Folder {
  readonly name: string;
  /** The folder's `index` page; its title names the group and it is not listed as a child. */
  index?: FolderPage;
  readonly folders: Map<string, Folder>;
  readonly pages: FolderPage[];
}

/** A navigation item with the keys it sorts by. */
interface Sortable {
  readonly item: NavItem;
  readonly order?: number;
  readonly title: string;
  /** Final tie-breaker among siblings: the file name or the folder name. */
  readonly name: string;
}

/** An `index` or `README` page, whatever its extension; matches the folder index rule in `permalink.ts`. */
const INDEX_FILE = /^(index|README)\.[^.]+$/;

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Siblings sort by `order` (missing `order` last), then by title, then by name. */
function compareSiblings(a: Sortable, b: Sortable): number {
  const ao = a.order ?? Infinity;
  const bo = b.order ?? Infinity;
  if (ao !== bo) return ao < bo ? -1 : 1;
  return byCodePoint(a.title, b.title) || byCodePoint(a.name, b.name);
}

function newFolder(name: string): Folder {
  return { name, folders: new Map(), pages: [] };
}

/** Places one page in the folder tree, creating its folders on the way. */
function insert(root: Folder, page: FolderPage): void {
  const segments = page.path.split("/").filter((segment) => segment !== "");
  const file = segments.pop();
  if (file === undefined) return;

  let folder = root;
  for (const name of segments) {
    let next = folder.folders.get(name);
    if (next === undefined) {
      next = newFolder(name);
      folder.folders.set(name, next);
    }
    folder = next;
  }

  const isIndex = INDEX_FILE.test(file);
  // The site's own home page at the top level is not a sidebar entry.
  if (isIndex && folder === root) return;
  if (isIndex && folder.index === undefined) folder.index = page;
  else folder.pages.push(page);
}

/** The items of one folder, sorted. Folders with no listed pages produce no group. */
function itemsOf(folder: Folder): NavItem[] {
  const entries: Sortable[] = folder.pages.map((page) => {
    const link: NavLink = { title: page.title, url: page.url };
    return {
      item: link,
      ...(page.order === undefined ? {} : { order: page.order }),
      title: page.title,
      name: page.path.split("/").pop() ?? page.path,
    };
  });

  for (const child of folder.folders.values()) {
    const children = itemsOf(child);
    if (children.length === 0) continue;
    const title = child.index?.title ?? child.name;
    const order = child.index?.order;
    entries.push({
      item: { title, children },
      ...(order === undefined ? {} : { order }),
      title,
      name: child.name,
    });
  }

  return entries.sort(compareSiblings).map((entry) => entry.item);
}

/**
 * Builds a navigation list from the folders of a site, for when there is no navigation file.
 *
 * Each folder becomes a group titled by its `index` page, or by its name when it has none. The `index` page is
 * not listed inside its own group. Pages at the top level are listed directly; the site's top-level `index` is the
 * home page and is not listed. Siblings sort by `order` (missing `order` last), then by title, compared by code point.
 * Folders with no listed pages produce no group.
 */
export function navFromFolders(pages: readonly FolderPage[]): NavItem[] {
  const root = newFolder("");
  for (const page of pages) insert(root, page);
  return itemsOf(root);
}
