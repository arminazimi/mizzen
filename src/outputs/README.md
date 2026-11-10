# Outputs

Each `*.ts` file in this folder is an output: a unit that turns the site model into files. The pipeline (`../pipeline/build.ts`) finds them at runtime and runs them in file-name order. Adding a file here needs no other edit.

## Export

A file exports one `Output` (the contract is in `../contracts/output.ts`), under any export name:

- `name`: equal to the file name without `.ts`. The config's `outputs` map switches an output off by this name, as in `outputs: { robots: false }`.
- `run(site, ctx)`: returns the files it writes, each `{ path, contents }`. `path` is relative to the output folder and uses `/`. `contents` is a string (UTF-8) or a `Uint8Array`. Return them sorted by path.

`ctx.renderPage(page)` renders a page to a complete HTML document through the theme. `ctx.report(diagnostic)` records a finding. An output does not throw for a problem in the content; it reports it.

A file that exports no `Output` is a helper and is not run. `app-pages.ts` is one: it exports `isAppPage`, which the other outputs call. A file that exports two outputs is an error, and so is a file whose output `name` differs from its file name.

## Rules

- Every output runs before anything is written. A path outside the output folder is an error and is not written. When two outputs write the same path, the first one (in file-name order) wins and the other is an error.
- A site's own file wins over an output's file at the same path: the site's file is copied byte for byte, the output's file is skipped, and no diagnostic is reported. A site's `llms.txt` replaces the generated one this way.
- The four root files a site may own are `sitemap.xml`, `llms.txt`, `llms-full.txt`, and `robots.txt`, listed as `SITE_FILE_PATHS` in `site-files.ts`. That unit writes no file of its own: the site's copy comes from the assets unit and the precedence above is what skips the generated one. Switching the matching output off in `outputs` removes the generated fallback, never the site's file.
- The site is written to a staging folder beside the output folder and swapped in only when complete.
- Output must be deterministic: the same site gives the same bytes, in the same order.

## Example

`robots.ts`:

```ts
import type { Output } from "../contracts/output.ts";

export const robots: Output = {
  name: "robots",
  async run() {
    return [{ path: "robots.txt", contents: "User-agent: *\nAllow: /\n" }];
  },
};
```
</content>