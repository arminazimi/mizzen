import type { VNode } from "preact";
import { render as renderToString } from "preact-render-to-string";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Pager, Trail } from "../contracts/nav.ts";
import type { Component, Head, Island, Layout } from "../contracts/render.ts";
import type { SourcePos } from "../contracts/source.ts";
import { parseSpan } from "../source/spans.ts";

/** A theme component the render host can call, with the CSS and island it ships. */
export interface ThemeComponent {
  /** The Preact component (the folder's default export). */
  readonly component: Component;
  /** Identifier of the component's `style.css`, when it has one (a path the CSS stage understands). */
  readonly css?: string;
  /** Client island, when the component ships `client.ts`. */
  readonly island?: Island;
}

/** What {@link renderPage} needs to turn one page into an HTML document. */
export interface RenderOptions {
  readonly site: Site;
  readonly page: Page;
  /** The layout named by the page's front matter (looked up by the caller). */
  readonly layout: Layout;
  /** Theme components keyed by the name written on `<sl-component name=…>`. */
  readonly components: Readonly<Record<string, ThemeComponent>>;
  readonly trail: Trail;
  readonly pager: Pager;
  readonly head: Head;
}

/** The HTML document plus the islands and CSS the page actually used. */
export interface RenderResult {
  /** Full HTML document, starting with `<!DOCTYPE html>`. */
  readonly html: string;
  /** Islands of components that appeared on the page, in name order. */
  readonly islands: readonly Island[];
  /** CSS identifiers of components that appeared on the page, in name order. */
  readonly css: readonly string[];
  /** Findings from resolving components (unknown names, bad props). */
  readonly diagnostics: readonly Diagnostic[];
}

/** An open tag, where quoted attribute values may contain `>` (a Mermaid arrow, for one). */
const OPEN = /<sl-component\b((?:"[^"]*"|'[^']*'|[^"'>])*)>/gi;
const ATTR = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Escapes a value for use inside a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Reads HTML attributes from an open-tag attribute string into a name → value map. */
function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let match = ATTR.exec(raw); match; match = ATTR.exec(raw)) {
    const name = match[1]!.toLowerCase();
    out[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

/** The named character references that can appear in an attribute value from the Markdown stage. */
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' };

/** Decodes one named or numeric character reference; an unknown or invalid one stays as written. */
function decodeEntity(
  match: string,
  hex: string | undefined,
  decimal: string | undefined,
  named: string | undefined,
): string {
  if (named !== undefined) return ENTITIES[named.toLowerCase()] ?? match;
  const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(decimal ?? "", 10);
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
}

/**
 * Decodes the character references in an attribute value from the Markdown stage. `rehype-stringify` writes
 * quotes as numeric references (`&#x22;`), so named ones alone are not enough.
 */
function decodeAttr(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, decodeEntity);
}

/** Parses a `data-src` value, a full span or a point, into a {@link SourcePos}. */
function parseDataSrc(value: string | undefined): SourcePos | undefined {
  return value ? parseSpan(value) : undefined;
}

/** Puts `data-src` on the first opening tag of a rendered fragment, unless it already has one. */
function keepDataSrc(html: string, dataSrc: string | undefined): string {
  if (!dataSrc) return html;
  return html.replace(/^(\s*<\/?[a-zA-Z][\w:-]*)((?:\s[^>]*)?)(\/?>)/, (full, start: string, attrs: string, end: string) => {
    if (start.includes("</") || /\sdata-src\s*=/i.test(attrs)) return full;
    return `${start}${attrs} data-src="${escapeAttr(dataSrc)}"${end}`;
  });
}

/**
 * Finds the matching `</sl-component>` for an open tag, counting nesting.
 * Returns the inner HTML and the index just after the close tag, or `undefined` when unclosed.
 */
function findClose(html: string, from: number): { inner: string; end: number } | undefined {
  let depth = 1;
  let i = from;
  while (i < html.length && depth > 0) {
    const nextOpen = html.toLowerCase().indexOf("<sl-component", i);
    const nextClose = html.toLowerCase().indexOf("</sl-component>", i);
    if (nextClose < 0) return undefined;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1;
      i = nextOpen + 1;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return { inner: html.slice(from, nextClose), end: nextClose + "</sl-component>".length };
    }
    i = nextClose + 1;
  }
  return undefined;
}

/** Turns one page's body HTML into resolved component HTML and records what was used. */
function resolveComponents(
  html: string,
  page: Page,
  site: Site,
  components: Readonly<Record<string, ThemeComponent>>,
): { html: string; used: string[]; diagnostics: Diagnostic[] } {
  const used: string[] = [];
  const diagnostics: Diagnostic[] = [];
  let out = "";
  let cursor = 0;
  OPEN.lastIndex = 0;
  for (let match = OPEN.exec(html); match; match = OPEN.exec(html)) {
    const start = match.index;
    out += html.slice(cursor, start);
    const attrs = parseAttrs(match[1] ?? "");
    const name = attrs.name ?? "";
    const dataSrc = attrs["data-src"];
    const close = findClose(html, start + match[0].length);
    if (!close) {
      const pos = parseDataSrc(dataSrc);
      diagnostics.push({
        id: "render.unclosed-component",
        severity: "warning",
        message: `Unclosed <sl-component${name ? ` name="${name}"` : ""}>.`,
        ...(pos ? { pos } : {}),
      });
      out += match[0];
      cursor = start + match[0].length;
      continue;
    }
    const entry = name ? components[name] : undefined;
    if (!entry) {
      const pos = parseDataSrc(dataSrc);
      diagnostics.push({
        id: "render.unknown-component",
        severity: "warning",
        message: name ? `Unknown component "${name}".` : "Missing name on <sl-component>.",
        ...(pos ? { pos } : {}),
        help: "Register the component in the theme or fix the name.",
      });
      // Pass the children through so the page still reads.
      const nested = resolveComponents(close.inner, page, site, components);
      out += nested.html;
      used.push(...nested.used);
      diagnostics.push(...nested.diagnostics);
      cursor = close.end;
      OPEN.lastIndex = cursor;
      continue;
    }
    used.push(name);
    const nested = resolveComponents(close.inner, page, site, components);
    used.push(...nested.used);
    diagnostics.push(...nested.diagnostics);
    let props: Readonly<Record<string, unknown>> = {};
    if (attrs["data-props"] !== undefined && attrs["data-props"] !== "") {
      try {
        const parsed: unknown = JSON.parse(decodeAttr(attrs["data-props"]));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          props = parsed as Readonly<Record<string, unknown>>;
        } else {
          const pos = parseDataSrc(dataSrc);
          diagnostics.push({
            id: "render.bad-props",
            severity: "warning",
            message: `data-props on component "${name}" must be a JSON object.`,
            ...(pos ? { pos } : {}),
          });
        }
      } catch {
        const pos = parseDataSrc(dataSrc);
        diagnostics.push({
          id: "render.bad-props",
          severity: "warning",
          message: `data-props on component "${name}" is not valid JSON.`,
          ...(pos ? { pos } : {}),
        });
      }
    }
    const node = entry.component({ props, page, site, html: nested.html });
    const rendered = typeof node === "string" ? node : renderToString(node as VNode);
    out += keepDataSrc(rendered, dataSrc);
    cursor = close.end;
    OPEN.lastIndex = cursor;
  }
  out += html.slice(cursor);
  return { html: out, used, diagnostics };
}

/** Ensures a doctype and an `<html lang dir>` taken from the page. */
function withDocument(markup: string, page: Page): string {
  let html = markup.trim();
  if (!/^<!DOCTYPE\s+html>/i.test(html)) {
    if (/^<html[\s>]/i.test(html)) html = `<!DOCTYPE html>\n${html}`;
    else html = `<!DOCTYPE html>\n<html lang="${escapeAttr(page.lang)}" dir="${escapeAttr(page.dir)}">\n${html}\n</html>`;
  }
  return html.replace(/<html(\s[^>]*)?>/i, (_full, rawAttrs: string | undefined) => {
    let attrs = rawAttrs ?? "";
    if (/\slang\s*=/i.test(attrs)) attrs = attrs.replace(/\slang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` lang="${escapeAttr(page.lang)}"`);
    else attrs += ` lang="${escapeAttr(page.lang)}"`;
    if (/\sdir\s*=/i.test(attrs)) attrs = attrs.replace(/\sdir\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` dir="${escapeAttr(page.dir)}"`);
    else attrs += ` dir="${escapeAttr(page.dir)}"`;
    return `<html${attrs}>`;
  });
}

/** Compares by code point (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Renders one page through its layout to an HTML document string.
 *
 * Resolves each `<sl-component name data-props data-src>` in `page.html` to the registered
 * theme component, keeps `data-src` on the component's root, and collects the islands and CSS
 * those components ship. Prepends a doctype and sets `<html lang dir>` from the page.
 */
export function renderPage(options: RenderOptions): RenderResult {
  const { site, page, layout, components, trail, pager, head } = options;
  const resolved = resolveComponents(page.html, page, site, components);
  const uniqueNames = [...new Set(resolved.used)].sort(byCodePoint);
  const islands: Island[] = [];
  const css: string[] = [];
  for (const name of uniqueNames) {
    const entry = components[name];
    if (!entry) continue;
    if (entry.island) islands.push(entry.island);
    if (entry.css !== undefined) css.push(entry.css);
  }
  const resolvedPage: Page = { ...page, html: resolved.html };
  const node = layout({ site, page: resolvedPage, trail, pager, head, islands });
  const body = typeof node === "string" ? node : renderToString(node as VNode);
  return {
    html: withDocument(body, page),
    islands,
    css,
    diagnostics: resolved.diagnostics,
  };
}
