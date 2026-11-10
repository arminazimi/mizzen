import type { Site } from "../contracts/content.ts";
import type { LinkTag } from "../contracts/render.ts";
import type { Output, OutputFile } from "../contracts/output.ts";

/** The file an OpenSearch description is served from, at the site root. */
export const OPENSEARCH_PATH = "opensearch.xml";

/** The namespace every OpenSearch 1.1 description declares. */
const NAMESPACE = "http://a9.com/-/spec/opensearch/1.1/";

/** Escapes the five characters XML reserves, so any title, description, or URL can sit in an element or an attribute. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The scheme and host the description's absolute URLs start with, from `url` in the site config. A trailing slash is
 * dropped, so the address never has `//` in it. Without a `url` there is no absolute search address and no file.
 */
export function opensearchOrigin(site: Site): string | undefined {
  const url = site.config.url?.trim().replace(/\/+$/, "") ?? "";
  return url === "" ? undefined : url;
}

/**
 * The address of the site's `opensearch.xml`: the site `url` plus `base`, so a site under `/docs` serves it at
 * `https://example.com/docs/opensearch.xml`. `undefined` when the config has no `url`.
 */
export function opensearchUrl(site: Site): string | undefined {
  const origin = opensearchOrigin(site);
  if (origin === undefined) return undefined;
  return `${origin}${site.config.base}/${OPENSEARCH_PATH}`;
}

/**
 * The `<link>` a page's head carries so browsers find the description without fetching it: `rel="search"` with the
 * description's type, the site title, and the absolute address. `undefined` when the config has no `url`, because
 * there is no `opensearch.xml` to point at.
 */
export function opensearchLink(site: Site): LinkTag | undefined {
  const href = opensearchUrl(site);
  if (href === undefined) return undefined;
  return {
    rel: "search",
    href,
    attrs: { type: "application/opensearchdescription+xml", title: site.config.title },
  };
}

/**
 * The address the site's search page reads `q` from: the site `url` plus `base` and a slash, with `{searchTerms}`
 * where the browser puts the query. OpenSearch substitutes the placeholder, so the braces stay literal in the file.
 */
function searchTemplate(site: Site, origin: string): string {
  return `${origin}${site.config.base}/?q={searchTerms}`;
}

/**
 * The text of `opensearch.xml`, an OpenSearch 1.1 description: the site title as the short name, the site description
 * (or the title when the config has none), UTF-8 input, and one `rel="results"` `text/html` URL, GET, whose template
 * is the search page. Values are XML-escaped and the file ends in one LF.
 */
export function opensearchDescription(site: Site, origin: string): string {
  const title = site.config.title;
  const description = site.config.description?.trim();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<OpenSearchDescription xmlns="${NAMESPACE}">`,
    `  <ShortName>${escapeXml(title)}</ShortName>`,
    `  <Description>${escapeXml(description === undefined || description === "" ? title : description)}</Description>`,
    `  <Url rel="results" type="text/html" method="get" template="${escapeXml(searchTemplate(site, origin))}"/>`,
    "  <InputEncoding>UTF-8</InputEncoding>",
    "</OpenSearchDescription>",
    "",
  ].join("\n");
}

/**
 * Writes `opensearch.xml` at the root of the output folder, so a browser can add the site's search as a search
 * provider. The description needs an absolute search address, so a site whose config has no `url` gets no file; the
 * engine cannot invent one. The head link that points at the file comes from {@link opensearchLink}.
 */
export const opensearch: Output = {
  name: "opensearch",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const origin = opensearchOrigin(site);
    if (origin === undefined) return [];
    return [{ path: OPENSEARCH_PATH, contents: opensearchDescription(site, origin) }];
  },
};
