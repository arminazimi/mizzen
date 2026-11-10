import type { Page, Site } from "./content.ts";
import type { Pager, Trail } from "./nav.ts";

/** What a theme's component returns; the render host turns it into HTML. The engine does not look inside it. */
export type RenderNode = unknown;

/** A `<meta>` tag. */
export interface MetaTag {
  /** The `name` attribute, or `property` for Open Graph tags. */
  readonly name: string;
  /** The `content` attribute. */
  readonly content: string;
  /** Use `property` instead of `name`. */
  readonly property?: boolean;
}

/** A `<link>` tag. */
export interface LinkTag {
  /** The `rel` attribute. */
  readonly rel: string;
  /** The `href` attribute. */
  readonly href: string;
  /** Any other attributes, such as `hreflang`. */
  readonly attrs?: Readonly<Record<string, string>>;
}

/** What goes in `<head>`: set by the engine, added to by the layout. */
export interface Head {
  /** The document title. */
  readonly title: string;
  /** Meta tags. */
  readonly meta: readonly MetaTag[];
  /** Link tags (canonical, alternates, icons). */
  readonly links: readonly LinkTag[];
  /** JSON-LD objects, written as `application/ld+json` scripts. */
  readonly jsonLd: readonly Readonly<Record<string, unknown>>[];
}

/** A client script for one component: a plain ES module loaded only on pages that use the component. */
export interface Island {
  /** The island's name, equal to its component's. */
  readonly name: string;
  /** URL of the module including `base`. */
  readonly src: string;
}

/** Props of a layout, which renders one whole page. */
export interface LayoutProps {
  /** The whole site model. */
  readonly site: Site;
  /** The page being rendered. */
  readonly page: Page;
  /** The page's breadcrumb. */
  readonly trail: Trail;
  /** The page's previous and next pages. */
  readonly pager: Pager;
  /** The head, to be rendered or extended. */
  readonly head: Head;
  /** Islands the page uses, to be loaded at the end of the body. */
  readonly islands: readonly Island[];
}

/** Props of a chrome part (header, sidebar, footer, table of contents), which the layout places. */
export interface ChromeProps {
  /** The whole site model. */
  readonly site: Site;
  /** The page being rendered. */
  readonly page: Page;
  /** The page's breadcrumb. */
  readonly trail: Trail;
  /** The page's previous and next pages. */
  readonly pager: Pager;
}

/** Props of a component used inside page content, with the props the content gave it. */
export interface ComponentProps<P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> {
  /** The attributes written on the component in the Markdown. */
  readonly props: P;
  /** The page it appears in. */
  readonly page: Page;
  /** The whole site model. */
  readonly site: Site;
  /** The component's body, already rendered to HTML. */
  readonly html: string;
}

/** A layout unit: the default export of `layouts/<name>.ts`. */
export type Layout = (props: LayoutProps) => RenderNode;

/** A chrome unit: the default export of `chrome/<name>/index.ts`. */
export type Chrome = (props: ChromeProps) => RenderNode;

/** A component unit: the default export of `components/<name>/index.ts`. */
export type Component<P extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>> = (props: ComponentProps<P>) => RenderNode;
