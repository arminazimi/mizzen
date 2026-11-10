import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type YAMLMap,
} from "yaml";
import type { Diagnostic, SourcePos } from "../contracts/index.ts";

/**
 * The `agent:` block as this parser reads it.
 *
 * This is the parser's own type, not the frozen `AgentInstructions` in `contracts/content.ts`: it reads
 * `owner` and `rules` on top of `edit`, `source`, and `notes`. The front-matter schema allows extra keys
 * under `agent`, so nothing here needs a contract or schema change. When the engine wires the block in,
 * it can narrow this to `AgentInstructions` without a cast.
 */
export interface AgentBlock {
  /** `false` for a generated page that must be changed at its source. */
  edit?: boolean;
  /** The file to edit instead of this page. */
  source?: string;
  /** A short instruction for the agent. */
  notes?: string;
  /** Who to ask about the page, as written by the author (a person, a team, or a handle). */
  owner?: string;
  /** Short rules for an agent editing the page, such as `Never change the version table by hand`. */
  rules?: string[];
}

/** What {@link parseAgentInstructions} returns. */
export interface AgentInstructionsResult {
  /** The block; `{}` when the page has none or it cannot be read. */
  readonly agent: AgentBlock;
  /** Problems in the block, each at the key that caused it. Empty for a page without an `agent` block. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link parseAgentInstructions}. */
export interface AgentInstructionsOptions {
  /**
   * 1-based line of `file` where the first line of the YAML slice sits. A front-matter slice passed
   * without its fences starts on line 2, so pass `2` to report positions in the file. Default `1`.
   */
  readonly firstLine?: number;
}

/** The keys the block accepts, in code-point order so messages and help are stable. */
const KNOWN_KEYS = ["edit", "notes", "owner", "rules", "source"] as const;

/** Where a diagnostic goes: a position builder over one YAML slice. */
interface Context {
  readonly file: string;
  readonly firstLine: number;
  readonly lineCounter: LineCounter;
  readonly diagnostics: Diagnostic[];
}

/**
 * Read the `agent:` block from the raw YAML of a page's front matter.
 *
 * `yaml` is the slice between the `---` fences, parsed here rather than by the front-matter loader so
 * the block gets its own type check and its keys get exact positions. A page without the block, or
 * with `agent:` left empty, yields `{}` and no diagnostic. Unknown keys are warnings, because the
 * front-matter schema allows extra keys under `agent`; wrong types and a non-mapping `agent` are errors.
 */
export function parseAgentInstructions(
  yaml: string,
  file: string,
  options: AgentInstructionsOptions = {},
): AgentInstructionsResult {
  const firstLine = Math.max(1, options.firstLine ?? 1);
  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter });
  const diagnostics: Diagnostic[] = [];
  const ctx: Context = { file, firstLine, lineCounter, diagnostics };

  if (doc.errors.length > 0) {
    for (const error of doc.errors) {
      const start = error.linePos?.[0];
      const end = error.linePos?.[1] ?? start;
      diagnostics.push({
        id: "agent.invalid-yaml",
        severity: "error",
        message: `Invalid YAML in ${file}: ${error.message.split("\n")[0]}`,
        pos: {
          file,
          line: firstLine + (start?.line ?? 1) - 1,
          column: start?.col ?? 1,
          endLine: firstLine + (end?.line ?? start?.line ?? 1) - 1,
          endColumn: end?.col ?? start?.col ?? 1,
        },
      });
    }
    return { agent: {}, diagnostics };
  }

  const root = doc.contents;
  if (!isMap(root)) return { agent: {}, diagnostics };

  const pair = root.items.find(
    (item) => isScalar(item.key) && item.key.value === "agent",
  );
  if (pair === undefined || pair.value == null || isNull(pair.value)) {
    return { agent: {}, diagnostics };
  }

  if (!isMap(pair.value)) {
    diagnostics.push({
      id: "agent.not-a-mapping",
      severity: "error",
      message: "`agent` must be a YAML mapping of keys to values.",
      pos: posOf(ctx, pair.key),
      help: "Write `agent:` with indented keys such as `edit`, `owner`, or `rules`.",
    });
    return { agent: {}, diagnostics };
  }

  return { agent: readBlock(ctx, pair.value), diagnostics };
}

/** Read the keys of an `agent:` mapping, reporting each key that is unknown or has the wrong type. */
function readBlock(ctx: Context, map: YAMLMap<unknown, unknown>): AgentBlock {
  const block: AgentBlock = {};

  for (const item of map.items) {
    const keyNode = item.key as Node;
    if (!isScalar(item.key) || typeof item.key.value !== "string") {
      ctx.diagnostics.push({
        id: "agent.invalid-key",
        severity: "error",
        message: "An `agent` key must be a plain name.",
        pos: posOf(ctx, keyNode),
      });
      continue;
    }

    const key = item.key.value;
    const value = item.value as Node | null | undefined;
    if (value == null || isNull(value)) continue; // `key:` with no value means "unset".
    if (!isKnown(key)) {
      ctx.diagnostics.push({
        id: "agent.unknown-key",
        severity: "warning",
        message: `Unknown key \`${key}\` in the \`agent\` block.`,
        pos: posOf(ctx, keyNode),
        help: `Use one of ${KNOWN_KEYS.map((k) => `\`${k}\``).join(", ")}.`,
      });
      continue;
    }

    switch (key) {
      case "edit": {
        if (isScalar(value) && typeof value.value === "boolean") block.edit = value.value;
        else wrongType(ctx, keyNode, "edit", "a boolean");
        break;
      }
      case "notes":
      case "owner":
      case "source": {
        if (isScalar(value) && typeof value.value === "string") block[key] = value.value;
        else wrongType(ctx, keyNode, key, "a string");
        break;
      }
      case "rules": {
        if (!isSeq(value)) {
          wrongType(ctx, keyNode, "rules", "a list of strings");
          break;
        }
        const rules: string[] = [];
        for (const entry of value.items) {
          const node = entry as Node;
          if (isScalar(node) && typeof node.value === "string") rules.push(node.value);
          else {
            ctx.diagnostics.push({
              id: "agent.invalid-type",
              severity: "error",
              message: "Every entry in `agent.rules` must be a string.",
              pos: posOf(ctx, node),
              help: "Quote the rule if it contains `:`, `#`, or a leading `-`.",
            });
          }
        }
        block.rules = rules;
        break;
      }
    }
  }

  return block;
}

function isKnown(key: string): key is (typeof KNOWN_KEYS)[number] {
  return (KNOWN_KEYS as readonly string[]).includes(key);
}

/** True for a YAML `null`, `~`, or a key written with no value. */
function isNull(node: Node): boolean {
  return isScalar(node) && node.value === null;
}

function wrongType(ctx: Context, keyNode: Node, key: string, expected: string): void {
  ctx.diagnostics.push({
    id: "agent.invalid-type",
    severity: "error",
    message: `\`agent.${key}\` must be ${expected}.`,
    pos: posOf(ctx, keyNode),
  });
}

/** The span of `node` in the file, with the slice's first line offset. */
function posOf(ctx: Context, node: Node | null | undefined): SourcePos {
  const range = node?.range;
  if (!range) return { file: ctx.file, line: ctx.firstLine, column: 1, endLine: ctx.firstLine, endColumn: 1 };
  const start = ctx.lineCounter.linePos(range[0]);
  const endOffset = Math.max(range[0], (range[2] ?? range[1]) - 1);
  const end = ctx.lineCounter.linePos(endOffset);
  return {
    file: ctx.file,
    line: ctx.firstLine + start.line - 1,
    column: start.col,
    endLine: ctx.firstLine + end.line - 1,
    endColumn: end.col,
  };
}
