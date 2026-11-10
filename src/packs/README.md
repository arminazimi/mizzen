# `packs/`

Pure helpers for agent packs: functions that answer questions about text and pages for a model, without reading the
site, the disk, the clock, or the network. Every export is a deterministic transform of its arguments.

- `tokens.ts`: `estimateTokens(text)` returns `{ tokens, method }`, a model-agnostic token estimate with a documented
  error margin. The rules and the margin are in the module's header comment; the reference counts are in
  `../../test/packs-tokens.test.ts`.
- `trim.ts`: `trimPages(pages, budget, options)` drops whole trailing sections until the pages fit a token budget,
  always keeping each page's heading and first paragraph and never splitting a fence. It parses with
  `parseMarkdown` so every section and diagnostic carries a source position; `keep` pins sections by id or text.
