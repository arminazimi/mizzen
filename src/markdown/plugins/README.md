# Markdown plugins

Each `*.ts` file in this folder is a remark plugin the Markdown parser discovers at
runtime. Adding a file here needs no other edit.

## Export

Every plugin file exports `{ name, order, plugin }`:

- `name`: a stable id, unique among plugins (usually the file name without `.ts`)
- `order`: lower runs earlier; GFM is `0` so it is always first
- `plugin`: a remark plugin (a function passed to `unified().use`)

The loader sorts by `order`, then by `name` (code-point order). It ignores this
README and every non-`.ts` file.

## Example

```ts
import type { Root } from "mdast";
import type { Plugin } from "unified";

export const name = "example";
export const order = 10;
export const plugin: Plugin<[], Root> = () => (tree) => {
  // transform `tree`
};
```
