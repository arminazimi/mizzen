import type { Site } from "../contracts/content.ts";
import type { Output, OutputFile } from "../contracts/output.ts";
import { discoverVersions, type VersionStatus } from "../content/versions.ts";

/** Where the file lands, relative to the output folder. */
const FILE = "versions.json";

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One version a page path exists in, and the URL that serves it. */
interface VersionEntry {
  /** The version folder, such as `v2`. */
  readonly version: string;
  /** The output URL of the page in that version, including `base`. */
  readonly url: string;
  /** How the page differs from the newest version: `added`, `removed`, or no key when unchanged. */
  readonly status?: VersionStatus;
}

/** One page path and every version it exists in. */
interface VersionsPage {
  /** The path inside the version folders, such as `guide/install.md`. */
  readonly path: string;
  /** The versions in version order, oldest first. */
  readonly versions: readonly VersionEntry[];
}

/**
 * Writes `versions.json`: every path that lives in a documentation version folder, the versions it exists in, and the
 * URL that serves it in each, so a version switcher reads one file instead of guessing how folders map to URLs.
 *
 * The model comes from `discoverVersions` (`content/versions.ts`), with its detection rules and its version order:
 * `v1`, `v2`, `v10`, or the order a caller supplies. Pages outside every version are left out, and a site with no
 * versioned page gets no file at all, so the output adds nothing to a site that does not keep versions. A path that
 * exists in only one version still gets one entry; the version switcher then shows that version alone.
 *
 * The shape is fixed and the bytes are stable:
 *
 * ```json
 * {
 *   "pages": [
 *     {
 *       "path": "guide/install.md",
 *       "versions": [
 *         { "version": "v1", "url": "/v1/guide/install/", "status": "removed" },
 *         { "version": "v2", "url": "/v2/guide/install/" }
 *       ]
 *     }
 *   ],
 *   "byUrl": {
 *     "/v1/guide/install/": "guide/install.md",
 *     "/v2/guide/install/": "guide/install.md"
 *   }
 * }
 * ```
 *
 * `pages` is sorted by `path` (code point) and each page's `versions` keeps `discoverVersions`' version order. A
 * version entry carries `status` only when the page is `added` in or `removed` from the newest version, so a page that
 * is unchanged omits the key. `byUrl` maps every URL back to its `path`, in code-point order, which is the lookup a
 * switcher on a rendered page needs; the URLs include `base`, like every URL in the model, while the file itself is
 * written at the output folder's root as `versions.json`. Two spaces of indentation and a final LF match the other
 * JSON outputs.
 */
export const versions: Output = {
  name: "versions",
  async run(site: Site): Promise<readonly OutputFile[]> {
    const grouped = new Map<string, VersionEntry[]>();

    for (const entry of discoverVersions(site.pages)) {
      if (entry.version === null) continue;
      const version: VersionEntry = {
        version: entry.version,
        url: entry.page.url,
        ...(entry.status === undefined ? {} : { status: entry.status }),
      };
      const existing = grouped.get(entry.path);
      if (existing === undefined) grouped.set(entry.path, [version]);
      else existing.push(version);
    }

    if (grouped.size === 0) return [];

    const pages: VersionsPage[] = [...grouped.entries()]
      .sort(([a], [b]) => byCodePoint(a, b))
      .map(([path, versions]) => ({ path, versions }));

    const byUrl = new Map<string, string>();
    for (const page of pages) {
      for (const version of page.versions) byUrl.set(version.url, page.path);
    }
    const urls = [...byUrl.keys()].sort(byCodePoint);

    const body = {
      pages,
      byUrl: Object.fromEntries(urls.map((url) => [url, byUrl.get(url) as string])),
    };

    return [{ path: FILE, contents: `${JSON.stringify(body, null, 2)}\n` }];
  },
};
