# Engine contracts

The TypeScript types every engine, output, and theme task codes against. They are types only: nothing here runs.

**Changing a type here needs a design note.** The contracts are frozen: a change names the type and the units it affects in its description. A task that needs a different type stops and asks for that change instead of editing these files.

Import from `index.ts` inside the engine; the theme may `import type` from here and imports nothing else from the engine.

| File | Types |
| --- | --- |
| `source.ts` | `SourcePos` |
| `diagnostic.ts` | `Diagnostic`, `Severity` |
| `config.ts` | `SiteConfig` and its parts |
| `content.ts` | `Page`, `Heading`, `FrontMatter`, `Site` |
| `nav.ts` | `NavItem`, `NavTree`, `Trail`, `Pager` |
| `output.ts` | `Output`, `OutputFile`, `OutputContext` |
| `render.ts` | `Layout`, `Chrome`, `Component` and their props, `Island`, `Head` |
| `plugin.ts` | `Plugin` and its hooks |

Every exported type has a doc comment. Types are `readonly` throughout: a stage returns a new value instead of changing its input.
