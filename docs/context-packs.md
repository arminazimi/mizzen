# Context packs: task requests through the CLI

`mizzen pack --request` compiles a versioned task request into one context pack. The pack is either
Markdown an agent can paste or the same evidence as JSON, and the command explains what it selected,
what it left out, and what each decision cost.

This page documents the contract implemented in `src/contracts/context-request.ts`,
`src/packs/task.ts`, `src/packs/compile.ts`, and `src/outputs/context-pack.ts`, and exercised end to
end by `test/pack-journeys.test.ts`. Every example below is a real request shape and a real output
field; there is no separate "request mode" inside the pack pipeline.

```console
$ mizzen pack [dir] --request <file|-> [--format markdown|json] [--out <path>]
```

`<dir>` is the site root (the folder holding `mizzen.yml`). `--request -` reads the request from
standard input; any other value is a JSON file path resolved from the current directory. `--request`
cannot be combined with `--topic` or `--budget`; the request carries its own task and budget.

## The request contract

The contract version is **1**. The JSON Schema is `schema/context-request.schema.json` (draft
2020-12, closed with `additionalProperties: false`); `parseContextRequest` validates against it and
then applies the cross-field rules. A request needs `version`, a `task.goal`, and
`budget.maxTokens`. Every other key is optional and gets a documented default:

| Key | Meaning | Default |
| --- | --- | --- |
| `version` | Contract version; only `1` is accepted. | required |
| `task.goal` | One non-empty sentence; the ranking query and the pack title. | required |
| `task.kind` | `explain`, `implement`, `review`, `debug`, `migrate`, or `other`. Parsing never infers it. | absent (default weights) |
| `include` | Hints that pin or raise pages: URL, source path, section id, or topic. | `[]` |
| `exclude` | Hints that remove pages before ranking. | `[]` |
| `constraints.locale` | BCP 47 language tag; lower-cased when parsed. | unconstrained |
| `constraints.version` | `{exact}`, `{min}`, or `{max}` over version folders such as `v2` or `v1.2`. | unconstrained |
| `budget.maxTokens` | Positive whole-token upper bound. | required |
| `budget.reservedTokens` | Tokens held back from optional content; must be below `maxTokens`. | `0` |
| `requiredEvidence.refs` | Page URLs, source paths, section ids, or heading texts that must survive. | `[]` |
| `requiredEvidence.source` | Add each selected page's exact source span. | `false` |
| `requiredEvidence.versions` | Add each selected page's version folder and locale. | `false` |
| `requiredEvidence.warnings` | Add the warnings attached to selected pages. | `false` |
| `requiredEvidence.dependencies` | Add the pages a selected page links to. | `false` |

Contradictions are refused before the site is read: a hint that is both included and excluded, a
required ref that is excluded verbatim, a reserve that leaves nothing under `maxTokens`, an empty
version range, `exact` combined with `min` or `max`, and a backwards range. A ref whose page a
constraint later keeps out is refused while compiling; see
[Omissions and required-evidence failures](#omissions-and-required-evidence-failures). A parsed
request has one stable form — keys in a fixed order, hints trimmed, locale lower-cased — so the same
input always gives the same bytes. Parsing is local and synchronous: no network, model, clock, or
site read.

There is no caret syntax in version 1. A bounded request is written with `min` and `max` (inclusive),
for example `{ "min": "v1", "max": "v2" }`; a single folder uses `{ "exact": "v2" }`.

## Four task kinds, exercised end to end

`test/pack-journeys.test.ts` drives four requests through `main()` against temporary sites:

| Journey | `task.kind` | What the test proves |
| --- | --- | --- |
| Setup / install | `implement` | The include hint pins the install page first, `exclude` drops the deploy page, `locale: en` drops the Persian page, and the required source/version lines appear on every item. |
| Debugging a failed deploy | `debug` | The troubleshooting page is first, the excluded deploy page is absent, and the debug profile reaches ranking. |
| API usage | `explain` | The API page is selected and its `/api/search?q=install` endpoint survives trimming. |
| Version-bound migration | `migrate` | `{ "min": "v1", "max": "v2" }` selects v1, v2, and current docs, and never v3. |

Each journey also asserts the hard budget: `accounting.used` and `accounting.upper` are within
`maxTokens`, and a fitting pack has no warnings.

The other kinds are `review` and the neutral `other`. A kind changes ranking only through its
weight profile; no scoring branch reads the kind itself. An absent kind uses the default weights.

## How ranking uses task intent, trust, and examples

`task.goal` is tokenised into query terms (English, Persian, and Arabic stopwords are dropped). Each
term scores once per occurrence in the page title, the headings, and the rendered body. The default
weights are title 8, headings 4, body 1. A `task.kind` merges its profile over those defaults:

| Kind | What its profile favours |
| --- | --- |
| `explain` | inbound links (`0.6`) and navigation proximity (`0.4`), with a balanced review view (`0.25`). |
| `implement` | runnable examples (`0.5`). |
| `debug` | drift findings (`0.5`), because diagnostics are what a debugging task reads. |
| `migrate` | the requested version (`0.5`) and status trust (`0.6`), so stale or deprecated pages lose. |
| `review` | review freshness and coverage (`0.5`) and status trust (`0.6`). |
| `other` | the default weights, unchanged. |

`include` and `exclude` shape the candidates before ranking. An include hint that names pages — by
URL, source path, section id, or a matching title/heading topic — pins those pages ahead of the
ranked order; a hint that no candidate page matches joins the query as topic words. An exclude hint
removes matching pages and can never be overridden by required evidence: an identical entry in
`exclude` and `requiredEvidence.refs` is refused as `context-request.evidence-excluded` while
parsing, and a ref whose page an exclude hint or constraint keeps out is refused as
`context-pack.evidence-excluded` while compiling.

One trust snapshot is taken before ranking from the same site data as `trust.json`
(`src/outputs/trust.ts`). Its entries are projected into the ranker's example, drift, review-age,
and review-coverage inputs, and are read only when the evidence's build equals the pack's own build
identity; another build's evidence raises no page. The same entry is published on the selected item
as `item.trust`, so an item's rank reasons and its published evidence describe one build. Measured
examples, drift, and review move a page by a fraction of their weight: a fully passing example set,
a clean drift count, and a fresh recorded review gain; any failing example, drift finding, overdue
or uncovered review loses; missing, unknown, or malformed evidence loses half and is never read as
clean. `examples: "none"` and an incomplete example set are neutral. Deprecated, rejected,
superseded, generated, and duplicate pages lose trust; negative contributions are scaled together so
a matching page never scores below zero.

Every item's `rank` is `{ score, reasons }`, where `reasons` is an ordered list of
`{ factor, code, contribution }`. `score` is exactly the sum of the contributions. A page pinned
only by an include hint and matching no query term can still be selected with score `0` and an empty
reason list, because the hint pinned it, not the ranking.

## The token budget and the estimator margin

The estimator is `src/packs/tokens.ts`: script-aware counting with no tokenizer, named
`"script-aware"`, with a documented relative error margin of `0.15`. Every estimate exposes

```
upper = ceil(tokens * (1 + margin))
```

and the hard budget is enforced on `upper`, not on the point estimate. `compilePack` trims in
`hard` mode: the title, every section header, the separators, the kept bodies, and the required
provenance lines are priced together, and the exact final Markdown's upper bound must fit
`budget.maxTokens`. `budget.reservedTokens` is removed from the trim limit before anything is
allocated to optional content; it is held back, not redistributed. Required evidence and a page's
mandatory heading and first paragraph are never trimmed. Pages join in rank order only while that
serialization still fits; when the final bound is over budget, the lowest-ranked page that was not
forced by required evidence gives way.

`accounting` publishes every number the decision used:

| Field | Meaning |
| --- | --- |
| `requested` | `budget.maxTokens`. |
| `reserved` | The estimator's planning upper bound for the content that may not be dropped: each page's mandatory lead plus the required provenance lines. When the pack is over budget, it is the upper bound of the fixed content that actually survived (pinned sections included). This is **not** `budget.reservedTokens`; the request's reserve is consumed inside trimming and is not echoed as a separate field. |
| `selected` | The estimated tokens of the selected item bodies — the part trimming may drop. |
| `required` | The estimated tokens of the required provenance lines added by `requiredEvidence.source`, `versions`, `warnings`, and `dependencies`. |
| `overhead` | Title, section headers (URL and source lines), and separators. |
| `used` | `estimateTokens(markdown).tokens`, the exact Markdown that was written. |
| `remaining` | `requested - used`; negative only when the pack is over budget. |
| `method` / `margin` | `"script-aware"` and `0.15`. |
| `upper` | `ceil(used * (1 + margin))`; a fitting pack has `upper <= requested`. |
| `minimum` | When the pack cannot fit, `{ tokens, upper }` for the smallest feasible serialization; otherwise `null`. |

`selected + required + overhead` is exactly `used`, so no cost is hidden.

## Omissions and required-evidence failures

A pack never silently drops evidence. There are three distinct outcomes:

1. **The pack fits.** Optional pages and sections that did not fit are named with a reason.
2. **The fixed content cannot fit.** The pack is still written (exit `0`), the required and
   mandatory content is kept whole, and a warning explains the overrun. `accounting.minimum` gives
   the smallest feasible cost. The warning ids are `pack.trim.required-over-budget`,
   `pack.trim.over-budget`, or `context-pack.over-budget`. Warnings go to stderr and to the JSON
   `warnings` array.
3. **Required evidence does not exist or is excluded.** No pack is written (exit `1`). The error ids
   are `context-pack.missing-evidence` (a ref names no selected page or kept section) and
   `context-pack.evidence-excluded` (a ref names a page that `exclude` or a constraint keeps out).
   A request that matches no page at all is `context-pack.no-pages` (exit `1`).

The JSON `selection` names every omission:

- `selection.omitted` — ranked candidate pages that did not fit, in rank order, each with `id`,
  `span`, `score`, `reasons`, and `reason: "budget"`.
- `selection.omissions` — top-level sections left out of a selected page, in item and document
  order, each with `item`, `id` (a `<file>:<line>:<column>` block id), `text` (the heading), `span`,
  `tokens`, and `reason`. The reason is `"budget"` or `"duplicate"`; a duplicate also names the kept
  `duplicateOf.item` and `duplicateOf.section`.

A required section ref is pinned into trimming, so it can never appear in `selection.omissions`. The
pack's `coverage` separately reports the four evidence kinds a request can demand: `source`,
`version`, `warning`, and `dependency`, each with `satisfied`, the item URLs in `missing`, and a
stable reason when unsatisfied. Selecting a page never satisfies `version` on its own for an unversioned page
(`version.unknown`), and `dependency` is reported unavailable because the site model does not carry
dependency evidence (`dependency.unavailable`).

### Inspecting omissions as an agent

Ask for JSON, write it to a file, and read the selection and accounting:

```console
$ mizzen pack . --request task.json --format json --out pack.json
$ jq '{omitted: .selection.omitted, omissions: .selection.omissions,
       accounting: .accounting, warnings: .warnings, coverage: .coverage}' pack.json
```

If `selection.omitted` is non-empty, the budget, not relevance, removed those pages; raise
`budget.maxTokens`, narrow the task, or accept the named omission. If `accounting.minimum` is not
`null`, even the required and mandatory content is over budget and the `warnings` array says which
id applied. If `warnings` is empty and `accounting.upper <= accounting.requested`, the pack fits.
On stderr, the same warning is printed by `mizzen pack`; stdout carries only the pack.

## Version-bound selection

`constraints.version` is matched against a page's version folder, taken from its source path
(`v2/guide/install.md` → `v2`; `content/versions.ts` decides the rule):

- `exact` keeps one folder only. Unversioned current docs are excluded by `exact`.
- `min` and `max` are inclusive and compared numerically, so `v2`, `v2.0`, and `v2.0.0` are equal and
  `v10` sorts after `v9`.
- With only `min`/`max`, pages outside every version folder are current docs and remain eligible.
- Pages outside the range are removed before ranking, so they appear in neither `items` nor
  `selection.omitted`.
- A required page outside the range is an error (`context-pack.evidence-excluded`), never a silent
  inclusion.

A section ref is `path:line:column`, such as `guide/install.md:9:1`. It must match a real kept
top-level section id or heading text after trimming. A ref that names no kept section — for example
a line with no heading — is `context-pack.missing-evidence`; it does not degrade to a whole-page
match. This is covered by the section-ref case in `test/pack-journeys.test.ts`.

## Determinism and `--out`

The same request on the same tree produces byte-identical output. Compilation reads no clock,
network, environment, or absolute path. The build identity is the engine version plus one SHA-256
over every doc page's URL and source hash (`src/outputs/build-hash.ts`); each item repeats that
identity in `item.build` and carries `item.hash`, the SHA-256 of its source body. Items follow the
selection order (forced evidence, include-pinned pages, then rank order), sections and omissions
follow document order, and nothing is ordered by locale or by the clock.

`--out` writes the same bytes it would print, through a staging folder beside the destination and a
rename, so a reader never sees a partial pack; stdout stays empty and the staging folder is removed.
Without `--out`, stdout receives the payload only — diagnostics and errors go to stderr.

`test/pack-journeys.test.ts` runs the same request twice for both formats, compares the bytes, and
compares each `--out` file with the stdout bytes.

## CLI usage, errors, and exit codes

```console
$ mizzen pack . --request task.json                     # Markdown to stdout
$ mizzen pack . --request task.json --format json       # structured evidence to stdout
$ mizzen pack . --request - --format json < task.json   # request from stdin
$ mizzen pack . --request task.json --out pack.md       # atomic file write, empty stdout
```

| Exit | Meaning |
| --- | --- |
| `0` | A pack was written. An over-budget pack still exits `0`; its warning explains the overrun. |
| `1` | The request was valid but produced no context: no matching pages, missing required evidence, excluded required evidence, or model errors. |
| `2` | Usage or request error: malformed JSON, schema or cross-field problems, an oversized request, an unknown task kind, an unknown option, a bad `--format`, or `--request` combined with `--topic`/`--budget`. |

A request file or stream is bounded at 1 MiB (`MAX_REQUEST_BYTES`). Bytes past the limit are refused
as `context-request.too-large` before `JSON.parse`, as one line on stderr. Within the limit, a
malformed document reports the JSON parser's message; a structurally valid document reports every
schema or cross-field problem, one line each, as

```
<name> <json-pointer>: <stable-code>: <message>
```

stdout stays empty for every one of these errors. An unknown `task.kind` is reported at
`/task/kind` with `context-request.enum`; a missing `budget` is reported at `/budget` with
`context-request.missing`.

## Verifying this page

The claims above are pinned by six tests in `test/pack-journeys.test.ts`:

1. `four task journeys compile end to end inside their constraints and hard budget`
2. `a compiled pack explains selection, omission, source, and every token`
3. `an impossible hard budget keeps required evidence and publishes the over-budget minimum`
4. `version bounds exclude other folders and a section ref without a section is missing evidence`
5. `the same request on the same tree is byte-identical and --out writes the same bytes`
6. `malformed, oversized, and invalid requests are usage errors with clean stdout`

Run them with:

```console
$ node --test test/pack-journeys.test.ts
$ npm run typecheck
```

The broader contract tests are `test/cli-pack-request.test.ts`, `test/cli-pack-request-limits.test.ts`,
`test/packs-task.test.ts`, `test/packs-rank.test.ts`, `test/packs-trim.test.ts`,
`test/packs-tokens.test.ts`, and `test/output-context-pack.test.ts`.
