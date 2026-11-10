/** A link in the navigation. */
export interface NavLink {
  /** Text of the link. */
  readonly title: string;
  /** Target URL including `base`. */
  readonly url: string;
  /** URL prefix that marks the link as current, when it is wider than `url`. */
  readonly match?: string;
}

/** A group of navigation items under a title. */
export interface NavGroup {
  /** Title of the group. */
  readonly title: string;
  /** Items in the group, in order. */
  readonly children: readonly NavItem[];
}

/** One entry of a navigation list: a link or a group. */
export type NavItem = NavLink | NavGroup;

/** The navigation lists by name, such as `main` and `docs`. */
export type NavTree = Readonly<Record<string, readonly NavItem[]>>;

/** The breadcrumb of a page: its ancestors from the site root to the page itself. */
export type Trail = readonly NavLink[];

/** The pages before and after a page in reading order. */
export interface Pager {
  /** The previous page, if there is one. */
  readonly prev?: NavLink;
  /** The next page, if there is one. */
  readonly next?: NavLink;
}
