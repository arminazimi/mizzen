import type { Direction, SiteConfig } from "./config.ts";
import type { NavTree } from "./nav.ts";
import type { SourcePos } from "./source.ts";

/** What a page is: Markdown or HTML content (`doc`), a page with its own program (`app`), or a file copied as is (`asset`). */
export type PageKind = "doc" | "app" | "asset";

/** The `status` front matter values the engine checks. */
export type PageStatus = "experimental" | "beta" | "deprecated" | "proposed" | "accepted" | "rejected" | "superseded";

/** Instructions for agents that edit a page. */
export interface AgentInstructions {
  /** `false` for a generated page that must be changed at its source. */
  readonly edit?: boolean;
  /** The file to edit instead of this page. */
  readonly source?: string;
  /** A short instruction for the agent. */
  readonly notes?: string;
}

/** A page's front matter. The keys the engine reads are typed; every other key is kept and passed to the layout. */
export interface FrontMatter {
  /** Page title. */
  readonly title?: string;
  /** Meta description, `llms.txt` entry, and search excerpt. */
  readonly description?: string;
  /** Name of the theme layout that renders the page. */
  readonly layout?: string;
  /** Output URL, a path starting with `/`. */
  readonly permalink?: string;
  /** Old paths that redirect to this page. */
  readonly redirect_from?: string | readonly string[];
  /** A path or URL this page redirects to. */
  readonly redirect_to?: string;
  /** Page language, a BCP 47 tag. */
  readonly lang?: string;
  /** Text direction. */
  readonly dir?: Direction;
  /** Sort order among siblings in navigation built from folders. */
  readonly order?: number;
  /** Lifecycle status, checked by the engine and shown by the theme. */
  readonly status?: PageStatus;
  /** Instructions for agents editing this page. */
  readonly agent?: AgentInstructions;
  /** `false` keeps the page out of the search index. */
  readonly search?: boolean;
  /** `false` keeps the page out of the build. */
  readonly published?: boolean;
  /** The page's social image. */
  readonly image?: string;
  /** Links translations of the same page. */
  readonly translation_key?: string;
  /** Any other key, kept for the layout. */
  readonly [key: string]: unknown;
}

/** A heading in a page, for the table of contents and anchor links. */
export interface Heading {
  /** Level, 1 to 6. */
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  /** The `id` of the heading element, unique within the page. */
  readonly id: string;
  /** The heading's plain text. */
  readonly text: string;
  /** Where the heading starts in the source. */
  readonly pos: SourcePos;
}

/** One page of the site model. */
export interface Page {
  /** Output URL including `base`, such as `/evergreen/guide/install/`. */
  readonly url: string;
  /** Where the page's content starts in its source file. */
  readonly source: SourcePos;
  /** Front matter after `defaults` are applied. */
  readonly frontMatter: FrontMatter;
  /** Page title: from front matter, else the first `h1`, else the file name. */
  readonly title: string;
  /** Page language, a BCP 47 tag. */
  readonly lang: string;
  /** Text direction. */
  readonly dir: Direction;
  /** Headings in document order. */
  readonly headings: readonly Heading[];
  /** The rendered body, with `data-source` on every block. */
  readonly html: string;
  /** The Markdown body without front matter, as the page's Markdown twin is written. */
  readonly markdown: string;
  /** What kind of page this is. */
  readonly kind: PageKind;
}

/** The site model: everything a build knows, assembled once and read by rendering and outputs. */
export interface Site {
  /** The site config. */
  readonly config: SiteConfig;
  /** Every page, sorted by URL. */
  readonly pages: readonly Page[];
  /** The navigation lists. */
  readonly nav: NavTree;
  /** Files from `_data/`, keyed by file name without extension. */
  readonly data: Readonly<Record<string, unknown>>;
}
