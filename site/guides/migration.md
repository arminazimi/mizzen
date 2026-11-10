---
title: Migrate from 0.2
description: Move a Jekyll-based Slipway 0.2 site to the 0.3 engine and theme, keeping URLs and front matter.
layout: doc
permalink: /guides/migration/
---

0.2 built a site with Jekyll: a gem or `remote_theme`, `_config.yml`, Liquid, and `_includes`. 0.3 replaces that with the Mizzen engine and the Lateen theme, which run on Node. Your Markdown, most front matter, and the shape of `_data/navigation.yml` carry over; the Jekyll machinery and the Liquid that called it do not.

## Before you start

- Commit the site or work on a copy. The migration tool writes files.
- Install [Node 24](https://nodejs.org/).
- Keep the 0.2 site deployable while you migrate. A 0.2 repository can stay on `remote_theme: arminazimi/slipway@v0.2.0`, or on the `legacy/jekyll` branch; neither gets new features.

## 1. Run the migration tool

Run it on the site folder, first as a dry run:

```sh
npx slipway migrate ../my-site --dry-run
npx slipway migrate ../my-site
```

From a checkout of this repository, before the `migrate` command is published, run the same tool directly:

```sh
node tools/migrate/run.ts ../my-site --dry-run
node tools/migrate/run.ts ../my-site
```

The report lists every file it changed, every file it removed, and every step left for a person. It does three things:

- **Config.** Converts `_config.yml` to the new config, keeps comments on keys that survive, and lists each dropped key with its reason. It removes `_config.yml` only after the new file is valid.
- **Content.** Renames the front matter keys that changed and turns a standalone callout include into a `:::callout` directive. Every other Liquid tag or output stays where it is and is reported with its file and line.
- **Navigation.** Checks `_data/navigation.yml` against the engine's schema and reports problems with their line. It never rewrites navigation, because a URL such as `docs/x` needs a person's decision.

The tool writes `slipway.yml`, the name from before the engine and theme were renamed. Rename it once:

```sh
mv slipway.yml mizzen.yml
```

That is the only config file 0.3 reads.

## 2. Remove the Jekyll machinery

From the site root:

```sh
rm -rf _layouts _includes _plugins _site .jekyll-cache
rm -f Gemfile Gemfile.lock slipway-theme.gemspec .ruby-version _config.remote.yml
```

`_data/navigation.yml` stays: the engine reads the same shape. Remove copies of the old theme's CSS and JavaScript from `assets/`; keep the images and files the site owns.

## 3. Remove the files 0.3 generates

The 0.2 theme generated these files. 0.3 writes its own copy on every build, and a file in the site wins over a generated one silently, so a leftover would hide the new output:

```sh
find . -name '*.twin.html' -delete
rm -f search.json sitemap.xml llms.txt llms-full.txt sourcemap.json
```

Keep one only when you intend to own that path.

## 4. Replace what the old theme provided

### Layouts

The theme ships `base`, `doc`, `home`, `not-found`, and `versions`. The migration tool renames `page` and `default` to `doc`; the others keep their names. Every other 0.2 layout (`post`, `archive`, `author`, `tags`, `feed`, `adr`, `adr-index`, `changelog`, `changelog-feed`, `glossary`, `links`, `translation-status`) is gone: rewrite the page with `doc` or without a layout. The 0.2 layouts that generated `llms.txt`, `llms-full.txt`, `search.json`, `sitemap.xml`, and `sourcemap.json` have no replacement page; remove those pages with step 3.

### Liquid and blocks

The engine does not run Liquid. The tool converts the callout include; everything else it reports must become Markdown or a directive.

| 0.2 include | 0.3 |
| --- | --- |
| `blocks/callout.html` | `:::callout{type="tip"}` … `:::` |
| `blocks/steps.html` | `:::steps` around an ordered list |
| `blocks/code-group.html` | `:::code-tabs` |
| `blocks/file-tree.html` | `:::file-tree` |
| `blocks/terminal.html` | `:::terminal` |
| `blocks/figure.html` | `:::figure{src="…" alt="…"}` |
| `blocks/embed.html` | `::embed{src="…" title="…"}` |
| `blocks/endpoint.html` | `:::endpoint` |
| `blocks/kbd.html` | `:kbd[Ctrl+K]` |
| `blocks/badge.html` | `::badge{label="New"}` |

The other 0.2 blocks have no one-line replacement. Rewrite them as Markdown or with a theme component, or delete them when they were marketing blocks that 0.3 does not ship.

### The home page

The `home` layout reads `hero`, `actions`, and `sections` from front matter. The 0.2 `cta_text`, `cta_url`, and `variant` keys are gone; move the button into `actions`:

```yaml
---
title: My docs
layout: home
hero:
  eyebrow: Documentation
  title: My docs
  lead: Build the site, preview it, and publish it to GitHub Pages.
actions:
  - label: Quickstart
    url: /quickstart/
    primary: true
sections:
  - title: Guides
    url: /guides/
    description: Customize the site and migrate from 0.2.
    links:
      - title: Install
        url: /install/
---
```

### Overrides

`_includes/head-custom.html`, `_includes/footer-custom.html`, `assets/css/custom.css`, and `assets/images/social.png` are not read in 0.3. Remove them. Put anything you still need in the page body or a theme component; the theme's [customization guide](../customize/) covers the `theme.options` blocks it does read.

### Config and theme options

A `slipway:` group dissolves. `languages` and `search` move to the top level; `header`, `fonts`, `logo`, `tokens`, `analytics`, `persian`, and `arabic` move under `theme.options`; `comments`, `social`, `tokens.font_display`, `persian.jalali`, and `arabic.hijri` are dropped. The 0.3 theme reads `announcement`, `logo`, `footer`, `pageAgent`, and `feedback`; an option it does not read has no effect.

Other renames:

- `baseurl` becomes `base`, with the same value: a leading `/` and no trailing slash.
- `defaults[].scope.path` becomes `defaults[].path`; `scope.type` is dropped because there are no collections.
- `permalink` is dropped because the file path gives the URL. A page that needs another URL sets `permalink`, and `redirects` covers the old one.
- `theme` and `remote_theme` are dropped when they named `slipway-theme` or `arminazimi/slipway`, the theme that ships by default.
- `plugins` are dropped. Optional front matter, `README.md` indexes, redirects, the sitemap, and SEO tags are built in.

The [configuration reference](../../config/) describes the new keys.

## 5. Build and deploy

```sh
npm install --save-dev @velella/mizzen @velella/lateen
npx mizzen check .
npx mizzen build . --out dist
```

`check` builds to a temporary folder and prints diagnostics. `build` writes `dist`; a build fails on an unknown layout, an unknown config key, or two files writing the same path. Set `url` in `mizzen.yml` to publish a sitemap and canonical links.

Classic GitHub Pages cannot build a 0.3 site because it ran Jekyll. Build on Node in a workflow, publish the output folder, and deploy it with the Pages actions; in the repository's Pages settings, the source is **GitHub Actions**, not a branch. The starter workflow is in [Install and quickstart](../../install/).

## Staying on 0.2

A site that is not ready to move can stay on 0.2.0. Keep `remote_theme: arminazimi/slipway@v0.2.0`, or use the `legacy/jekyll` branch, which is the last Jekyll release. Neither gets new features, and neither can use the engine's docs layouts or the outputs it generates.
