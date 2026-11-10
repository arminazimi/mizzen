/** Text direction of a page or site. */
export type Direction = "ltr" | "rtl";

/** One language of a multi-language site, in switcher order. */
export interface LanguageConfig {
  /** BCP 47 tag, such as `fa`. */
  readonly code: string;
  /** Name shown in the language switcher, in that language. */
  readonly name: string;
  /** URL prefix of this language's pages, such as `/fa`; empty for the default language. */
  readonly prefix: string;
}

/** Front matter applied to every page under a folder, unless the page sets the key itself. */
export interface DefaultsEntry {
  /** Folder relative to `source`; `""` for every page. */
  readonly path: string;
  /** Front matter keys and values to apply. */
  readonly values: Readonly<Record<string, unknown>>;
}

/** Where the source lives, for "Edit this page" links and the "Edit with your agent" prompt. */
export interface RepositoryConfig {
  /** The repository's web URL, such as `https://github.com/arminazimi/evergreen`. */
  readonly url: string;
  /** Branch that edit links point to. Default `main`. */
  readonly branch?: string;
  /** The site root's folder inside the repository, such as `docs`. Default `""`. */
  readonly dir?: string;
}

/** Which theme builds the site and the options handed to it. */
export interface ThemeConfig {
  /** Theme package or folder. Default: the theme that ships with the engine. */
  readonly name?: string;
  /** Passed to the theme unread; the theme validates it against its own schema. */
  readonly options?: Readonly<Record<string, unknown>>;
}

/** Search settings. */
export interface SearchConfig {
  /** The most characters of a page's body the index keeps. Default `300`; titles and headings are always indexed. */
  readonly text?: number;
}

/**
 * The site config, as ADR 0024 defines it: exactly the keys of the site config file, after the loader has checked them.
 * Every key is optional in the file; the loader fills the defaults, so the keys marked required here are always present.
 */
export interface SiteConfig {
  /** Site name for the header, page titles, `llms.txt`, and JSON-LD. Default: the folder name. */
  readonly title: string;
  /** One-sentence summary of the site, for the home page's meta description and `llms.txt`. */
  readonly description?: string;
  /** Scheme and host of the published site, without a trailing slash. Without it canonical links, the sitemap, and social images are relative or left out, with a warning. */
  readonly url?: string;
  /** Path the site lives under, starting with `/` and without a trailing slash; `""` at a domain root. Every URL the engine writes carries it. */
  readonly base: string;
  /** Default language of every page, as a BCP 47 tag. Default `en`. */
  readonly lang: string;
  /** Default text direction. Default: from `lang`. */
  readonly dir: Direction;
  /** The site's languages in switcher order. Default `[]`. */
  readonly languages: readonly LanguageConfig[];
  /** Folder that holds the content, relative to the site root. Default `.`. */
  readonly source: string;
  /** Paths under `source` that discovery would skip but should be copied or built, such as `.well-known`. Default `[]`. */
  readonly include: readonly string[];
  /** Paths under `source` that are neither pages nor copied. Default `[]`. */
  readonly exclude: readonly string[];
  /** Navigation file, relative to the site root. Default `_data/navigation.yml`. */
  readonly navigation: string;
  /** Front matter applied by folder; later entries win over earlier ones, and a page always wins. Default `[]`. */
  readonly defaults: readonly DefaultsEntry[];
  /** Where the source lives, for edit links. */
  readonly repository?: RepositoryConfig;
  /** The theme and its options. */
  readonly theme: ThemeConfig;
  /** `false` builds no search index. Default `{}`. */
  readonly search: false | SearchConfig;
  /** Redirect pages: old path under `base` to a path on the site or an `https` URL. Default `{}`. */
  readonly redirects: Readonly<Record<string, string>>;
  /** Turns an output off by its name (`false`). Default: every output on. */
  readonly outputs: Readonly<Record<string, boolean>>;
}
