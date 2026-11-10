# Engine contracts

The TypeScript types every engine, output, and theme task codes against ([ADR 0022](../../../../docs/adr/0022-engine.md), [ADR 0023](../../../../docs/adr/0023-engine-theme-boundary.md), [ADR 0024](../../../../docs/adr/0024-site-config.md)). They are types only: nothing here runs.

**Changing a type here needs an ADR.** The contracts are frozen: a change names the type and the units it affects in a new or amended ADR (ADR 0023, rule 5). A task that needs a different type stops and asks for that ADR instead of editing these files.

Import from `index.ts` inside the engine; the theme may `import type` from here and imports nothing else from the engine.

| File | Types |
| --- | --- |
| `source.ts` | `SourcePos` |
| `diagnostic.ts` | `Diagnostic`, `Severity` |
| `config.ts` | `SiteConfig` and its parts (ADR 0024) |
| `content.ts` | `Page`, `Heading`, `FrontMatter`, `Site` |
| `nav.ts` | `NavItem`, `NavTree`, `Trail`, `Pager` |
| `output.ts` | `Output`, `OutputFile`, `OutputContext` |
| `render.ts` | `Layout`, `Chrome`, `Component` and their props, `Island`, `Head` |
| `plugin.ts` | `Plugin` and its hooks |

Every exported type has a doc comment. Types are `readonly` throughout: a stage returns a new value instead of changing its input.
