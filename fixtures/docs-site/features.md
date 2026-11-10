# Features

Every Markdown construct the components support, once, so each component epic has a real page to render.

## Code fences

A title and line marks (`{2,4-5}` highlights lines):

```js title="beacon.config.js" {2,4-5}
export default {
  build: "npm run build",
  publish: "dist",
  environments: {
    staging: { target: "s3://beacon-staging" },
  },
};
```

A diff:

```diff title="beacon.yml"
- publish: build
+ publish: dist
```

## Code tabs

````tabs
```bash title="npm"
npm install -g beacon
```

```bash title="Homebrew"
brew install beacon
```

```bash title="Go"
go install github.com/example/beacon@latest
```
````

## Tabs

::::tabs
:::tab{label="macOS"}
Use Homebrew, or download the `darwin` archive.
:::

:::tab{label="Linux"}
Use the `linux` archive and put `beacon` on your `PATH`.
:::

:::tab{label="Windows"}
Use the `windows` archive and add its folder to `Path`.
:::
::::

## Callouts

:::callout{type=warning title="Rollbacks are not undeploys"}
`beacon rollback` points an environment at an older artifact. It does not delete the newer one.
:::

> [!NOTE]
> Credentials never appear in `beacon.yml`; see [security](security.md).

> [!TIP]
> Run `beacon deploy staging --dry-run` first.

## Tables

| Environment | Target | Hooks |
| --- | --- | --- |
| `staging` | `s3://beacon-staging` | none |
| `production` | `s3://beacon-prod` | `after` |

## Steps

:::steps
1. Run `beacon init`.
2. Edit `beacon.yml` and set `build`.
3. Run `beacon deploy staging`.
:::

## File tree

:::file-tree
- beacon.yml # the only file Beacon reads
- dist/
  - index.html
  - assets/
    - app.js
- .beacon/
  - cache/
:::
