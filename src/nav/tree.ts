import type { NavGroup, NavItem, NavLink, Pager, Trail } from "../contracts/nav.ts";

/** Everything the chrome needs for one page against one navigation list. */
export interface NavState {
  /** The leaf whose `url` equals the page URL, when the page is listed. */
  readonly current?: NavLink;
  /** The leaf whose `match` prefix covers the page URL, when the page is not listed. */
  readonly active?: NavLink;
  /** Ancestors from the root of the list to the current page or active section. */
  readonly trail: Trail;
  /** Previous and next leaves in reading order; empty when the page is not listed. */
  readonly pager: Pager;
}

function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}

/** True when `url` is under `prefix`, observing path-segment boundaries. */
function under(url: string, prefix: string): boolean {
  if (!url.startsWith(prefix)) return false;
  if (prefix.endsWith("/")) return true;
  const boundary = url.charAt(prefix.length);
  return boundary === "" || boundary === "/";
}

/** Walks the tree depth-first, collecting every link (leaves) in reading order. */
function leaves(items: readonly NavItem[]): NavLink[] {
  const out: NavLink[] = [];
  for (const item of items) {
    if (isGroup(item)) out.push(...leaves(item.children));
    else out.push(item);
  }
  return out;
}

/** The first leaf under `items`, in reading order. */
function firstLeaf(items: readonly NavItem[]): NavLink | undefined {
  for (const item of items) {
    if (isGroup(item)) {
      const found = firstLeaf(item.children);
      if (found !== undefined) return found;
    } else {
      return item;
    }
  }
  return undefined;
}

/**
 * Path of items from the list root to the leaf where `pick` returns true.
 * Groups on the path become `NavLink`s whose `url` is the matched leaf's `match`
 * when set, otherwise the group's first leaf (so breadcrumbs link the section).
 */
function pathTo(
  items: readonly NavItem[],
  pick: (link: NavLink) => boolean,
): NavLink[] | undefined {
  for (const item of items) {
    if (isGroup(item)) {
      const child = pathTo(item.children, pick);
      if (child === undefined) continue;
      const leaf = child.at(-1)!;
      const head = firstLeaf(item.children)!;
      const section: NavLink = { title: item.title, url: leaf.match ?? head.url };
      return [section, ...child];
    }
    if (pick(item)) return [item];
  }
  return undefined;
}

/** Previous and next among `order` for the leaf at `url`. */
function pagerFor(order: readonly NavLink[], url: string): Pager {
  const index = order.findIndex((leaf) => leaf.url === url);
  if (index < 0) return {};
  const prev = index > 0 ? order[index - 1] : undefined;
  const next = index < order.length - 1 ? order[index + 1] : undefined;
  return {
    ...(prev === undefined ? {} : { prev }),
    ...(next === undefined ? {} : { next }),
  };
}

/**
 * From one navigation list and a page URL, compute the current page, the active
 * section (`match` prefix), the breadcrumb trail, and previous/next leaves.
 *
 * A page listed by exact `url` is `current` and not `active`. A page that only
 * falls under a `match` prefix marks that section `active` (large generated
 * sections stay one sidebar entry). The pager follows leaf reading order and is
 * empty when the page is not listed.
 */
export function navState(items: readonly NavItem[], url: string): NavState {
  const order = leaves(items);
  const current = order.find((leaf) => leaf.url === url);

  let active: NavLink | undefined;
  if (current === undefined) {
    for (const leaf of order) {
      if (leaf.match === undefined || !under(url, leaf.match)) continue;
      if (active === undefined || leaf.match.length > (active.match?.length ?? 0)) {
        active = leaf;
      }
    }
  }

  const trailPath =
    current !== undefined
      ? pathTo(items, (leaf) => leaf.url === url)
      : active !== undefined
        ? pathTo(items, (leaf) => leaf === active)
        : undefined;

  return {
    ...(current === undefined ? {} : { current }),
    ...(active === undefined ? {} : { active }),
    trail: trailPath ?? [],
    pager: current === undefined ? {} : pagerFor(order, url),
  };
}
