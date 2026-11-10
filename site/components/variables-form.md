---
title: Variables form
description: A personalization form that fills a page's code-example variables with the reader's own values, without storing them.
layout: doc
permalink: /components/variables-form/
tags:
  - components
  - code
---

A variables form turns the `{{name}}` placeholders in a page's code examples into labelled inputs. Each input starts with the variable's declared default, and the code examples update as the reader types. Values stay in the browser: the component sets no cookie, writes no storage, and makes no request. Without JavaScript the form still shows every default, so the page reads correctly and a reader can copy the values by hand.

## Syntax

```markdown
::variables-form{id="quickstart"}
```

The component reads the N33 declaration shape from the page's front matter and `site.data.variables`, or from a JSON list in its `variables` prop. A code example uses the same variable in braces:

```bash
curl -H "Authorization: Bearer {{api_key}}" {{host}}/v1/status
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `id` | string | `variables-form` | Prefix for the form's element ids. Give each form on a page its own id. |
| `variables` | JSON array | the page and site declarations | The whole list when present: `'[{"name":"api_key","default":"YOUR_KEY"}]'`. When it is absent or unreadable, the page's front matter and `site.data.variables` are used. |

A declaration is `{name, default?, type?}`, the shape the engine's variables output documents. The page's declaration wins over the site's for the same name, and a page declaration without a default keeps the site's default. The form renders nothing when there is no variable.

## Example

::variables-form{id="variables-form-example" variables='[{"name":"api_key","default":"YOUR_KEY","type":"string"},{"name":"host","default":"https://api.example.com","type":"url"}]'}

```bash
curl -H "Authorization: Bearer {{api_key}}" {{host}}/v1/status
```

Type in the form and the command follows. The literal placeholders show what the page looked like before a value was known; the form's islands fill them with the defaults when JavaScript runs.

## Notes

- The form is a `<fieldset>` with a legend, one visible label per variable, and a hint that values stay in the browser.
- Each input's default is both its value and its placeholder, so the form is complete without JavaScript.
- Focus is visible, and every style uses design tokens and logical properties, so right-to-left pages and dark mode follow.
- The legend and hint are localized through the theme's interface strings.
