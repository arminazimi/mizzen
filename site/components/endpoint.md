---
title: Endpoint
description: An HTTP method, path with highlighted parameters, parameter list, and body for API reference pages.
layout: doc
permalink: /components/endpoint/
redirect_from:
  - /blocks/endpoint/
---

An endpoint opens an API reference entry: the method badge, the path with each parameter highlighted, the list of parameters the path names, and the body that describes the request and response.

## Syntax

```markdown
:::endpoint{method=get path="/users/{id}"}
Returns one user.
:::
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `method` | string | no badge | The HTTP method, in any case. Known methods get their own badge color; any other method gets the neutral one. |
| `path` | string | empty | The path. Write parameters as `{id}` (OpenAPI) or `:id` (Express); both are highlighted and listed. |

## Example

:::endpoint{method=get path="/users/{id}"}
Returns the user with this id.

### Response

```json
{ "id": "u_123", "name": "Ada" }
```
:::

:::endpoint{method=post path="/users"}
Creates a user from the JSON body.
:::

## Notes

- The path is marked left-to-right even on a right-to-left page, because paths and parameter names are not prose.
- The parameter list is generated from the path; do not repeat it by hand.
- The body is Markdown. Use headings, code fences, and tables inside it for request and response samples.
