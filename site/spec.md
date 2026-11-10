---
title: The Spec
description: The agent-editable site spec.
layout: doc
permalink: /spec/
date: 2026-10-26
author: Slipway
---

Slipway implements the agent-editable site spec, version 0.1. The spec says what a site publishes so an agent can change it safely: where its content lives, which fields a page accepts, which source line produced each part of a built page, how to find the editing instructions from the live site, and how a person hands a precise edit to an agent.

The spec covers editing only. Whether a site is healthy and readable by agents — broken links, accessibility, `llms.txt`, Markdown twins — is Seaworthy's question, and no requirement here repeats it.

The normative text is [`spec/agent-editable/0.1.md`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/0.1.md). The levels are in [`levels.md`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/levels.md), the machine-readable test list in [`tests.json`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/tests.json), and the checker's output in [`report.schema.json`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/report.schema.json). This page is a summary; where the two disagree, those files win.

## What a site publishes

| Part | Where it lives | What an agent gets |
| --- | --- | --- |
| Editing instructions | `AGENTS.md` at the root of the source folder | The layout, the rules, the output folder to leave alone, and how to check a change. |
| Content schemas | `content-schemas.json` at the root of the source folder, with the JSON Schemas it names | The keys each configuration file and each kind of page accepts. |
| Source map | `/sourcemap.json` at the root of the output folder | The source file, and the line, behind each built page, heading, and link. |
| Agent-skills index | `/.well-known/agent-skills/index.json` in the output | The skills the live site offers, including the one that describes how to edit it. |
| Edit prompts | `data-source` on headings, `data-edit-prompt` on a control | A prompt such as `Edit docs/intro.md:23`, built from the page the person is reading. |
| Text direction | `dir` on the root element and on mixed-direction runs | Whether the page is right-to-left, in the markup rather than only in the author's head. |

### Editing instructions and schemas

`AGENTS.md` is for whoever edits the site, not for whoever develops the generator or the theme. It names the folder content lives in, the output folder agents must not edit, and the `content-schemas.json` index. Its relative paths must still exist, and a "Never" or "Do not" section lists the edits that break the site.

`content-schemas.json` maps source paths to schemas. Each entry names a glob, a `target` (`front-matter` for the YAML block at the top of a file, `file` for the whole file), and a JSON Schema — a path inside the source folder or an `https` URL. A file that matches several entries must satisfy all of them. Every configuration file must match a `file` entry and every content file must match a `front-matter` entry.

### The source map

`/sourcemap.json` follows the [source map format](https://github.com/arminazimi/slipway/blob/main/spec/sourcemap/v0.md), with its schema in [`schema/sourcemap.schema.json`](https://github.com/arminazimi/slipway/blob/main/schema/sourcemap.schema.json). At L0 and L1 it lists each page's `url` and `source`. At L2 each page also carries `sections` and `links`, so an edit can name a heading's line and a link's exact target. Each section's `id` is a heading id on the built page, and each `source` and `url` must resolve to a file.

### The agent-skills index and edit prompts

`/.well-known/agent-skills/index.json` is a JSON object whose `skills` array lists what the site offers, each with `name`, `description`, and `url`. At least one skill describes editing the site: its `SKILL.md` gives the site repository's absolute `https` URL and names `AGENTS.md`.

A heading listed in the map carries `data-source="<source>:<line>"`, so a control, or any tool reading the page, can build a prompt. The prompt names the source path, the line, and the section's current text, and nothing else from the page. It may copy itself or open a destination the person chooses; it never sends the prompt or page content on its own. A control that needs JavaScript is hidden in the served HTML and shown by its script.

### Right-to-left text

A page whose `lang` is a right-to-left language has `dir="rtl"` on its root element, and one that is not does not. In the title, each `h1`, and each link inside a `nav`, a run of one direction inside text of the other is isolated in a `bdi` element, an element with `dir`, or between isolate marks. Both are SHOULD requirements: a failure is a warning, not a lower level.

## Levels

The levels are cumulative: a site reaches a level when it meets every MUST of that level and of every level below it. A SHOULD that fails is a warning and never lowers the level. L3 is the highest level.

| Level | Adds | An agent can |
| --- | --- | --- |
| L0 | `AGENTS.md` and a page-to-file map | find the file behind any page and the rules for editing it. |
| L1 | content schemas | write front matter and config that the site accepts. |
| L2 | section-to-line maps and edit prompts | edit the exact line a person points at. |
| L3 | the agent-skills index | find all of the above from the live site alone. |

Every requirement has a stable id such as `ae.sourcemap.present`, a keyword (MUST or SHOULD), a level, a scope (`source`, `output`, or `both`), a rationale, and a check, which says how a checker decides it without network access. The one exception is the `https` part of `ae.schemas.resolve`, which runs only when the checker's network option is on. An id that changes meaning gets a new id; a removed id is never reused. The keywords are read as defined in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174).

Two L2 requirements — `ae.edit-prompt.content` and `ae.edit-prompt.no-send` — are review checks. A person decides them, and a checker reports them as not run.

## How a checker reports

The [doctor](https://github.com/arminazimi/slipway/tree/main/packages/doctor) runs every automated test on the source folder and, with `--build <dir>`, on the built output. Each test ends as `pass`, `fail`, or `not-run`. A test that needs the output folder fails when no output folder is given, because the site has not shown that it meets it.

The report follows [`report.schema.json`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/report.schema.json): `spec`, `version`, `generator`, `level` (`L0` to `L3`, or `null` when an L0 MUST fails), `notRun`, `tests`, and `findings`. A finding has the test `id`, a `severity` (`error` for a failed MUST, `warning` for a failed SHOULD), a `message`, and when known the `file`, `line`, `column`, `key`, `allowed`, and `fix`. A finding on a built page that the source map covers names the source file instead, at the line of the section it is about, and keeps the built file in `output`, so an agent edits the source and not the output. A shortened report, at `L1` because an L2 MUST fails and the two review checks are not run:

```json
{
  "spec": "agent-editable",
  "version": "0.1",
  "generator": "unknown",
  "level": "L1",
  "notRun": ["ae.edit-prompt.content", "ae.edit-prompt.no-send"],
  "tests": [],
  "findings": [
    {
      "id": "ae.sourcemap.ids",
      "severity": "error",
      "in": "source",
      "file": "docs/intro.md",
      "line": 6,
      "key": "install",
      "message": "is an h2, the map says h1",
      "output": { "file": "docs/intro/index.html" }
    }
  ]
}
```

`--format json` prints that report, and `--format sarif` prints SARIF 2.1.0 for code scanning: each test is a rule, with the test id as `ruleId`, the severity as the result's level, and the file and line as its location.

## Where the files live

| Artifact | File |
| --- | --- |
| The spec, requirement by requirement | [`spec/agent-editable/0.1.md`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/0.1.md) |
| The levels and how a checker reports one | [`spec/agent-editable/levels.md`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/levels.md) |
| One test per requirement | [`spec/agent-editable/tests.json`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/tests.json) |
| The checker's report | [`spec/agent-editable/report.schema.json`](https://github.com/arminazimi/slipway/blob/main/spec/agent-editable/report.schema.json) |
| The content-schema index | [`schema/content-schemas.schema.json`](https://github.com/arminazimi/slipway/blob/main/schema/content-schemas.schema.json) |
| The source map format and schema | [`spec/sourcemap/v0.md`](https://github.com/arminazimi/slipway/blob/main/spec/sourcemap/v0.md) and [`schema/sourcemap.schema.json`](https://github.com/arminazimi/slipway/blob/main/schema/sourcemap.schema.json) |

The spec and `tests.json` change together: a test in this repository fails when an id, level, keyword, or scope differs between them. Version 0.1 is a draft and may change without notice until 1.0; a requirement id that exists in 0.1 keeps its meaning in 1.0 or is retired, never reused.

## In Slipway's own build

The engine writes `/sourcemap.json`, a Markdown twin of each page (the same address with `.md` in place of the HTML file), and an `AGENTS.md` for the built site. A site that ships one of the root files the engine generates — `llms.txt`, `llms-full.txt`, `robots.txt`, or `sitemap.xml` — keeps its own copy byte for byte; without one, the generated file is used.

Start with the [configuration reference](../config/) and the [front matter](../front-matter/) keys, then [install Slipway](../install/) and build a page. The [doctor](https://github.com/arminazimi/slipway/tree/main/packages/doctor) checks the result against the spec and prints the level it reaches.
