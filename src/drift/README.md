# `drift/`

Checks that compare what a page says with the code it points at. Each function is a deterministic transform of
its arguments: no clock, network, or environment reads. `codeRefsOf` and `compareClaims` also read the site's
files; neither writes. `git-age.ts` reads git history through git, which is an input like the arguments: the
same repository gives the same answer.

- `git-age.ts`: `gitAge(root, pageFile, refFiles)` compares the last commit of a page with the newest
  commit among the files it references and returns the whole days between them, or `"unknown"` when git,
  a work tree, or either history is missing. It never throws, never reads the clock, checks the
  repository once per root, and asks git about each path once across calls. The cases are in
  `../../test/drift-git-age.test.ts`.
- `code-refs.ts`: `codeRefsOf(page)` (asynchronous, parses `page.markdown`) and `codeRefsIn(tree, file?)`
  find `path:line`, `path:line:col`, `path:line-line`, and `path#Lx-Ly` references in text, inline code,
  link URLs, and `test` fences. Paths resolve from the page's source folder unless they start with `/`,
  which anchors them at the repository root. Each result carries the span of the Markdown node that holds
  it, in document order and without duplicates at the same span. The rules are in the module's header
  comment; the cases are in `../../test/drift-code-refs.test.ts`.
- `symbols.ts`: `exportedSymbols(source)` and `exportedSymbols({ file })` list the names a TypeScript file
  exports, with their kind and line. The scanner skips strings, comments, regular expressions, and nested
  blocks, and never throws: malformed source returns a `drift.symbols-syntax` diagnostic. The cases are in
  `../../test/drift-symbols.test.ts`.
- `compare.ts`: `compareClaims(pages, { root, tolerance? })` reads every reference N07 finds in a page,
  resolves its target inside `root` (never outside it), and reports `drift.missing-file`,
  `drift.missing-symbol`, `drift.moved-symbol`, `drift.line-out-of-range`, or `drift.outside-root` at the
  reference's own span. For a TypeScript target, the cited line is matched against N08's exported symbols
  within the tolerance (default 5), with a symbol claim read from the inline code of the reference's
  paragraph. The claim rule and the order of the diagnostics are in the module's header comment; the cases
  are in `../../test/drift-compare.test.ts`.
