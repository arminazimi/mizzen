---
title: Terminal
description: A shell session with prompts, output, and a copy button that takes only the commands.
layout: doc
permalink: /components/terminal/
redirect_from:
  - /blocks/terminal/
---

A terminal shows a shell session: lines that start with `$` are commands, and every other line is output. The copy button copies only the commands, so a reader never pastes the output back into the shell.

## Syntax

```markdown
:::terminal
$ npm install slipway
added 1 package

$ npm run build
Built 12 pages.
:::
```

## Options

None. The prompt is `$ `.

## Example

:::terminal
$ npm install slipway
added 1 package

$ node packages/engine/bin/slipway.ts build site --out dist
Written 12 pages to dist
:::

## Notes

- A line that starts with `$` is a command; the prompt is not part of the copied text. Every other line is output, kept as written.
- Write one command per line. For a multi-line command, use a code block instead.
- The copy button is made by JavaScript and starts hidden; the session still reads without it.
- The command and output colors come from the code tokens, in light and dark.
