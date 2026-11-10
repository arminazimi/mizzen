---
title: Kbd
description: A keyboard key or key combination, styled as a key cap.
layout: doc
permalink: /components/kbd/
redirect_from:
  - /blocks/kbd/
---

A kbd element names a key or a combination in running text: `⌘K`, `Ctrl+K`, `Esc`. It is a leaf directive, so it stands on its own line rather than inside a sentence.

## Syntax

```markdown
::kbd[Ctrl+K]
```

## Options

None. The text between the brackets is shown as written.

## Example

::kbd[Ctrl+K]

::kbd[Esc]

## Notes

- Use the platform's own label when the docs target one platform. For both, write a sentence with each: "Press ⌘K on macOS or Ctrl+K elsewhere."
- The component does not switch ⌘ to Ctrl for you; that needs a client script, and the text should read correctly without one.
- For a key inside a sentence, write `<kbd>` in HTML or a code span; the directive is block-level.
