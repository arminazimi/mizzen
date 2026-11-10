# Facts

Each `*.ts` file in this folder is one derived fact: a value the engine computes from the finished site model and puts in `Site.data` under the fact's name. A fact runs at the end of the model stage, after pages are sorted and `_data` is loaded, so a layout or component can read it during render. Adding a fact needs no edit to a shared index; deleting one is deleting its file.

## Export

A file exports exactly one `Fact` (the type is in `../facts.ts`), under any export name:

```ts
import type { Fact } from "../facts.ts";

export const words: Fact = {
  name: "words",
  compute({ pages }) {
    return { total: pages.reduce((sum, page) => sum + page.markdown.split(/\s+/).length, 0) };
  },
};
```

- `name` must equal the file name without `.ts`; a mismatch is an error naming the file, and the fact is skipped. The name is also the key in `Site.data`, so `_data/words.yml` is the site's own `words`.
- `compute(ctx)` returns the value, or a promise of it. It receives `root` and `sourceDir` as absolute paths, the site `config`, the final sorted `pages`, and the `_data` record. Facts do not see each other's values; each one reads `_data` only.
- The value must be deterministic: the same site gives the same value. Do not read the clock, the environment, or a random source.

## Precedence and diagnostics

A key the site already has in `_data` wins: the fact does not run, its value is not stored, and no diagnostic is reported. `_data` is the site's source of truth, and a fact is a fallback the engine derives when the site has not written the value itself.

A file the loader cannot import, or that does not export exactly one fact with a matching name, is a `facts.load-failed` error and is left out. A fact that throws or returns `undefined` is a `facts.compute-failed` warning and is left out; the other facts still run. The key order of `Site.data` is sorted by code point, so two runs on the same input have the same order.

A fact is not a second config file: it derives a value from the site, and a setting a site may choose belongs in `mizzen.yml`.
