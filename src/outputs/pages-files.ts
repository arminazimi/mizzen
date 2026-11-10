import { isIP } from "node:net";
import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/** The host GitHub Pages already serves: a user or organization site, never a custom domain. */
const GITHUB_IO = "github.io";

/**
 * A DNS host name: one or more labels of letters, digits, and inner hyphens, so every label starts and ends with a
 * letter or digit and no label is longer than 63 characters. The `url` parser has already lowercased and punycoded
 * the host, so a non-ASCII domain arrives here as `xn--`.
 */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host to put in `CNAME`, or `undefined` when GitHub Pages needs no custom domain: the config has no `url`, the
 * value is not an absolute `http` or `https` URL, the host is `github.io` or a `*.github.io` site (Pages already
 * serves it at that address), or the host is not a DNS name (an IP address or localhost).
 *
 * A port, path, query, and fragment in `url` are dropped, because `CNAME` holds the host only, and a trailing root dot
 * is dropped with them. `www.` is kept as written: only the config's author knows whether the site answers there.
 */
export function cnameHost(site: Site): string | undefined {
  const value = site.config.url?.trim() ?? "";
  if (value === "") return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;

  const host = parsed.hostname.replace(/\.$/, "");
  if (host === "" || host === GITHUB_IO || host.endsWith(`.${GITHUB_IO}`)) return undefined;
  if (isIP(host) !== 0) return undefined;
  if (!HOST.test(host)) return undefined;
  return host;
}

/**
 * Writes the two files GitHub Pages reads at the root of the output folder. `.nojekyll` is always written and empty,
 * so Pages serves every path as it is and does not skip folders whose names start with `_`. `CNAME` is written only
 * when the site has a custom domain, and holds the bare host followed by one newline: a `*.github.io` site is already
 * served at its own host, so it needs no `CNAME`. No diagnostic is reported; the sitemap already warns about a missing
 * or invalid `url`, and an output never fails a build for a config choice.
 */
export const pagesFiles: Output = {
  name: "pages-files",
  async run(site: Site, _ctx: OutputContext): Promise<readonly OutputFile[]> {
    const host = cnameHost(site);
    const files: OutputFile[] = [{ path: ".nojekyll", contents: "" }];
    if (host !== undefined) files.push({ path: "CNAME", contents: `${host}\n` });
    return files;
  },
};
