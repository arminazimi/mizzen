---
title: Schema table
description: A JSON Schema from the site's data folder as a table of properties, types, defaults, and descriptions.
layout: doc
permalink: /components/schema-table/
---

A schema table turns a JSON Schema into the properties table a reference page needs: name, type, whether it is required, its default, its allowed values, and its description. Nested properties are indented under their parent, and `$ref` is followed within the same document.

## Syntax

```markdown
::schema-table{data="widget" label="Widget options"}
```

## Options

| Name | Type | Default | What it does |
| --- | --- | --- | --- |
| `data` | string | required | The schema's path under `_data`, without its extension: `widget` reads `_data/widget.json` or `_data/widget.yml`; `guides/steps` reads `_data/guides/steps.yml`. |
| `label` | string | `Properties` | The accessible name of the scroll region. |

## Example

::schema-table{data="schema-table" label="Widget options"}

The file behind this table is `_data/schema-table.json`:

```json
{
  "type": "object",
  "required": ["name"],
  "properties": {
    "name": { "type": "string", "description": "The widget's name." },
    "size": { "enum": ["s", "m", "l"], "default": "m" }
  }
}
```

## Notes

- The schema is read from `_data`, so the page and the schema stay separate. A schema that is not there renders a message naming the missing file.
- `$ref` must point inside the same document, such as `#/$defs/option`. A reference to another file is ignored.
- Deeply nested schemas stop expanding after eight levels and show the row without its children.
- The table scrolls inside its own region and is reachable by keyboard.
