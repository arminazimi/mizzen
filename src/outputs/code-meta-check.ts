import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Output, OutputContext, OutputFile } from "../contracts/output.ts";
import type { SourcePos } from "../contracts/source.ts";
import { invalidMetaParts, type InvalidCodeMeta } from "../markdown/plugins/code.ts";
import { spanFromPosition } from "../source/spans.ts";

/*
 * Build-level check for fence meta that names lines the fence does not have. The `code` plugin parses
 * valid lines and drops the rest so rendering never breaks; this output re-parses each page's Markdown
 * and reports what was dropped, with the fence's source position. It writes no files.
 */

/** Stable id of the finding; one line list part is one finding. */
const ID = "code.invalid-meta";

/** Human name of each line list, for the message. */
const LIST_NAME: Record<InvalidCodeMeta["where"], string> = {
  highlight: "highlighted lines",
  ins: "inserted lines",
  del: "deleted lines",
};

const HELP = "Use comma-separated lines and ascending ranges, such as 1,3-5.";

/** A parser with positions and no plugins: fences are fences even inside directives and code groups. */
type MarkdownParser = {
  parse(file: string): Root;
};

const parser = unified().use(remarkParse) as unknown as MarkdownParser;

/** Walks the tree in document (pre-order) order. */
function visit(node: Nodes, visitFn: (node: Nodes) => void): void {
  visitFn(node);
  if ("children" in node) {
    for (const child of node.children) visit(child, visitFn);
  }
}

/** The number of lines a fence's value occupies; an empty fence has none. */
function lineCount(value: string): number {
  return value === "" ? 0 : value.split(/\r?\n/).length;
}

/** The fence's span in the source file, shifted by the line its Markdown body starts on. */
function posOf(node: Nodes, file: string, bodyLine: number): SourcePos {
  const position = node.position;
  if (position === undefined) return { file, line: bodyLine, column: 1, endLine: bodyLine, endColumn: 1 };
  const delta = bodyLine - 1;
  return spanFromPosition(file, {
    start: { line: position.start.line + delta, column: position.start.column },
    end: { line: position.end.line + delta, column: position.end.column },
  });
}

/** One sentence naming the part, why it is unusable, and the fence's last line when that is the reason. */
function messageOf({ where, value, reason }: InvalidCodeMeta, lines: number): string {
  const list = LIST_NAME[where];
  switch (reason) {
    case "value":
      return `"${value}" in the ${list} is not a line or a range.`;
    case "start":
      return `"${value}" in the ${list} starts before line 1.`;
    case "range":
      return `"${value}" in the ${list} ends before it starts.`;
    case "file":
      return `"${value}" in the ${list} is past the block's last line (${lines}).`;
  }
}

/**
 * Every invalid fence-meta line in `markdown`, in document order, each with the fence's source span.
 * `file` is the source path and `bodyLine` is the 1-based line its body starts on, as `Page.source`
 * gives them. A fence without meta, or with only valid lines, reports nothing.
 */
export function invalidCodeMeta(markdown: string, file: string, bodyLine = 1): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  visit(parser.parse(markdown), (node) => {
    if (node.type !== "code" || node.meta === null || node.meta === undefined) return;
    const lines = lineCount(node.value);
    const invalid = invalidMetaParts(node.meta, lines);
    if (invalid.length === 0) return;
    const pos = posOf(node, file, bodyLine);
    for (const part of invalid) {
      diagnostics.push({ id: ID, severity: "warning", message: messageOf(part, lines), pos, help: HELP });
    }
  });
  return diagnostics;
}

/**
 * Re-parses every page's Markdown and reports each fence-meta line that is not a line of that fence.
 * No file is written; findings go through `ctx.report` in page order, then document order, so the
 * same site always reports the same findings in the same order.
 */
export const codeMetaCheck: Output = {
  name: "code-meta-check",
  async run(site: Site, ctx: OutputContext): Promise<readonly OutputFile[]> {
    for (const page of site.pages) {
      for (const diagnostic of invalidCodeMeta(page.markdown, page.source.file, page.source.line)) {
        ctx.report(diagnostic);
      }
    }
    return [];
  },
};
