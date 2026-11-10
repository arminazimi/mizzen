---
title: Install and quickstart
description: Create a Slipway site with npm create slipway, build it with the engine, and publish it to GitHub Pages.
layout: doc
permalink: /install/
---

Slipway is a documentation engine and a theme. The engine, Mizzen, turns Markdown in your repository into a site; the theme, Lateen, renders it. A Slipway site needs Node, not Ruby, and there is no Jekyll build step.

## Requirements

- [Node 24](https://nodejs.org/) or later.
- Git, and a GitHub repository when you want the included workflow to publish the site.

## Create a site

Run the starter in an empty folder:

```sh
npm create slipway@latest my-site
```

It asks for the folder, a title, the repository, and the language, then writes a working docs site. Agents and scripts can pass every answer as a flag and skip the questions:

```sh
npm create slipway@latest my-site --title "My docs" --repository me/my-docs --lang en --yes
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `<dir>` | required | Folder for the site. It must be empty or not exist. |
| `--title` | the folder name | Site title. |
| `--repository` | | The GitHub repository as `owner/name` or an https URL. It sets `url` and `base` and adds "Edit this page" links. |
| `--lang` | `en` | Language code, such as `en`, `fa`, or `pt-BR`. |
| `--yes`, `-y` | | Never prompt. Without a terminal it never prompts either. |

The new site has these files:

```text
mizzen.yml                        the site config
docs/index.md                     the home page
docs/quickstart.md                the first guide
docs/configuration.md             the configuration reference
.github/workflows/deploy.yml      build and publish to GitHub Pages
content-schemas.json              which schema checks which file
schema/                           the config and front matter schemas
```

## Build and preview

From the site folder, install the engine and the theme, then check and build:

```sh
npm install --save-dev @velella/mizzen @velella/lateen
npx mizzen check .
npx mizzen build . --out dist
```

`check` builds to a temporary folder and prints diagnostics, so it is the command to run before you commit. `build` writes the site to `dist`; change the folder with `--out`. A build fails on an unknown config key, an unknown layout, or two files that write the same path. Installing both packages in `package.json` also pins the versions for the next person.

To read the result in a browser, serve the output folder rather than opening a file directly:

```sh
npx serve dist
```

## Write a page

Every Markdown file under `source` (set in `mizzen.yml`) is a page. Add `docs/about.md`:

```markdown
---
title: About
description: Who we are.
---

We write documentation.
```

The page is published at `/about/`. A title in front matter is optional: without it, the first `#` heading is the title, and without that the file name is. Links are ordinary Markdown links. Keep them relative to the page's published URL, or absolute:

```markdown
See [Install and quickstart](../install/) and the [configuration reference](../config/).
```

## Publish to GitHub Pages

The generated workflow builds the site with the deploy Action on every push to `main`:

```yaml
- uses: arminazimi/slipway/action/deploy@main
  with:
    path: .
```

In the repository, open **Settings → Pages** and set the source to **GitHub Actions** once. The workflow does the rest: it installs Node and the engine, builds the site, and publishes the output. Classic GitHub Pages, which ran Jekyll, cannot build a Slipway site.

## Next steps

- [Customize a site](../guides/customize/) changes the logo, footer, navigation, and page-agent menu.
- The [configuration reference](../config/) lists every key in `mizzen.yml`.
- [Migrate from 0.2](../guides/migration/) moves an existing Jekyll-based site to the engine.
