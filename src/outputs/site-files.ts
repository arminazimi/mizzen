import type { Output, OutputFile } from "../contracts/output.ts";

/**
 * The files a site may own at the root of the output folder, sorted by code point (ADR 0022, rule 5). A site that has
 * one of them in its source keeps it byte for byte; the matching output's file is skipped, with no diagnostic.
 */
export const SITE_FILE_PATHS = ["llms-full.txt", "llms.txt", "robots.txt", "sitemap.xml"] as const;

/**
 * The named home of the site-file rule: `sitemap.xml` (`sitemap.ts`), `llms.txt` (`llms.ts`), `llms-full.txt`
 * (`llms-full.ts`), and `robots.txt` (`robots.ts`) are the root files a site may ship itself.
 *
 * The output writes no file of its own. Discovery lists a site's own copy as an asset, `copyAssets` copies it to the
 * output folder, and `pipeline/build.ts` skips a generated file whose path the site already has. A site's file
 * therefore wins silently, and switching the matching output off in `outputs` neither removes the site's file nor is
 * needed to keep it: the copy is the site's either way. This unit exists so the rule has one place, and
 * `test/output-site-files.test.ts` builds a site with all four files and checks every one of them byte for byte.
 */
export const siteFiles: Output = {
  name: "site-files",
  async run(): Promise<readonly OutputFile[]> {
    return [];
  },
};
