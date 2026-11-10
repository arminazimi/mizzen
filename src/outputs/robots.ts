import type { Site } from "../contracts/content.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";

/**
 * The absolute address of the sitemap, `<url><base>/sitemap.xml`, or `undefined` when the config has no `url`. The
 * `Sitemap:` line of `robots.txt` must be absolute, so without a `url` the line is left out. A trailing slash on `url`
 * is dropped, so the address never has `//` in it.
 */
export function sitemapUrl(site: Site): string | undefined {
  const url = site.config.url?.replace(/\/+$/, "");
  if (url === undefined || url === "") return undefined;
  return `${url}${site.config.base}/sitemap.xml`;
}

/** The text of `robots.txt`: every crawler may read every path, and the sitemap is named when its address is known. LF line endings. */
export function robotsText(sitemap: string | undefined): string {
  const lines = ["User-agent: *", "Allow: /"];
  if (sitemap !== undefined) lines.push("", `Sitemap: ${sitemap}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Writes `robots.txt` at the root of the output folder: every crawler may read every path, and the file names the
 * sitemap by its absolute address (`Sitemap:`). Without `url` in the config the file is still written, without the
 * `Sitemap:` line, and a warning says how to add it; a warning never stops the build.
 */
export const robots: Output = {
  name: "robots",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    const sitemap = sitemapUrl(site);
    if (sitemap === undefined) {
      ctx.report({
        id: "robots.no-sitemap",
        severity: "warning",
        message: "robots.txt has no Sitemap line because the site has no `url`.",
        help: "Set `url` to the scheme and host of the published site, such as `https://example.com`.",
      });
    }
    return [{ path: "robots.txt", contents: robotsText(sitemap) }];
  },
};
