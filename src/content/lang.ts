import type { Direction, FrontMatter, LanguageConfig, SiteConfig } from "../contracts/index.ts";

/** A page's resolved language and direction. */
export interface PageLang {
  /** The page's language, a BCP 47 tag. */
  readonly lang: string;
  /** The page's text direction. */
  readonly dir: Direction;
}

/** The site settings a page's language resolves against. */
export type PageLangConfig = Pick<SiteConfig, "lang" | "languages">;

/** Options for `pageLang` besides the page's source path. */
export interface PageLangOptions {
  /** The site settings the page's language resolves against. */
  readonly config: PageLangConfig;
  /** The page's front matter, after folder `defaults` are applied. Default `{}`. */
  readonly frontMatter?: FrontMatter;
}

/** Primary language subtags that default to right-to-left (same list as the config loader and the 0.2 theme). */
const RTL = new Set([
  "ar", "arc", "ckb", "dv", "fa", "he", "ks", "ku", "ps", "sd", "syr", "ug", "ur", "yi",
]);

/** Default text direction for a BCP 47 tag: `rtl` when its primary subtag names a right-to-left language. */
export function directionFromLang(lang: string): Direction {
  const base = lang.split("-", 1)[0]?.toLowerCase() ?? "";
  return RTL.has(base) ? "rtl" : "ltr";
}

/** The URL segments of a language prefix, such as `/fa` → `["fa"]`; `""` (the default language) has none. */
function prefixSegments(prefix: string): readonly string[] {
  return prefix.split("/").filter((s) => s.length > 0);
}

/** A source path as URL segments: `fa/install.md` → `["fa", "install.md"]`. */
function pathSegments(path: string): readonly string[] {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length > 0);
}

/** The code of the language whose URL prefix the path sits under, or `undefined` when none matches. */
function langFromPrefix(path: string, languages: readonly LanguageConfig[]): string | undefined {
  const segments = pathSegments(path);
  for (const language of languages) {
    const prefix = prefixSegments(language.prefix);
    if (prefix.length > 0 && prefix.every((part, i) => segments[i] === part)) {
      return language.code;
    }
  }
  return undefined;
}

/**
 * Resolve a page's language and direction.
 *
 * Language: front matter `lang`, else the language whose URL prefix the path sits under
 * (`config.languages`), else the site `lang`. Direction: front matter `dir`, else from the
 * resolved language's right-to-left list.
 */
export function pageLang(path: string, options: PageLangOptions): PageLang {
  const frontMatter = options.frontMatter ?? {};

  const fmLang = frontMatter.lang;
  const lang =
    typeof fmLang === "string" && fmLang.trim() !== ""
      ? fmLang.trim()
      : (langFromPrefix(path, options.config.languages) ?? options.config.lang);

  const fmDir = frontMatter.dir;
  const dir: Direction = fmDir === "ltr" || fmDir === "rtl" ? fmDir : directionFromLang(lang);

  return { lang, dir };
}
