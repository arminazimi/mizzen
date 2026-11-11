import type { Diagnostic } from "../../contracts/diagnostic.ts";
import type { SourcePos } from "../../contracts/source.ts";

/** The id of the finding a failing executable example reports. */
export const EXAMPLE_FAILED_ID = "example-failed";

/** The id of the finding that says examples ran without an OS sandbox. */
export const EXAMPLE_SANDBOX_ID = "example-sandbox";

/**
 * The protections the example runners enforce even when the host has no OS sandbox. They bound a run, but they are not
 * isolation: a best-effort protection is a limit the runner applies, not a boundary the operating system enforces.
 */
export const EXAMPLE_BEST_EFFORT_PROTECTIONS: readonly string[] = [
  "working folder",
  "environment allow-list",
  "timeout",
  "output cap",
];

/** Options of {@link exampleFailed}. */
export interface ExampleFailedOptions {
  /** The fence's span in its page's source, so the finding points at the example. */
  readonly pos: SourcePos;
  /** The page's address, such as `/guide/install/`, which names the page in the message. */
  readonly page: string;
  /** The output the example says it produces. */
  readonly expected: string;
  /** The output the example produced. */
  readonly actual: string;
  /** The process exit code, when the example runs a command and the runner knows it. */
  readonly exitCode?: number;
}

/** One bounded view of a first difference: the code-point offset and a window of each side. */
export interface FirstDifference {
  /** Code point where the strings first differ, or the shorter length when one is a prefix of the other. */
  readonly offset: number;
  /** A bounded window of `expected`, starting before the difference. */
  readonly expected: string;
  /** A bounded window of `actual`, starting before the difference. */
  readonly actual: string;
}

/** Code points of shared context kept before the difference. */
const CONTEXT_BEFORE = 16;

/** Code points of each side kept from the start of the window. */
const WINDOW = 72;

/** Characters kept in the displayed window, so escaping lots of control characters cannot make it long. */
const DISPLAY_MAX = 80;

/** Escapes a text for one message line: no raw newline, tab, backslash, or control character survives. */
function display(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) out += `\\u{${code.toString(16)}}`;
    else out += char;
  }
  return out;
}

/** Keeps at most `DISPLAY_MAX` characters of a display string, marking a cut. */
function clamp(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= DISPLAY_MAX) return text;
  return `${chars.slice(0, DISPLAY_MAX).join("")}…`;
}

/** A bounded window of `chars` from `start`, with ellipses where either end is cut. */
function windowOf(chars: readonly string[], start: number): string {
  const end = Math.min(chars.length, start + WINDOW);
  const body = display(chars.slice(start, end).join(""));
  return clamp(`${start > 0 ? "…" : ""}${body}${end < chars.length ? "…" : ""}`);
}

/**
 * Finds the first code-point difference between two strings and returns a bounded window of each side with one line
 * of context. It never throws: multiline and binary-ish text is escaped, and long output is cut with `…`. Deterministic.
 */
export function firstDifference(expected: string, actual: string): FirstDifference {
  const left = Array.from(expected);
  const right = Array.from(actual);
  const shared = Math.min(left.length, right.length);
  let offset = 0;
  while (offset < shared && left[offset] === right[offset]) offset++;
  const start = Math.max(0, offset - CONTEXT_BEFORE);
  return { offset, expected: windowOf(left, start), actual: windowOf(right, start) };
}

/**
 * Reports that examples are running without an OS sandbox on `platform`, so a build never silently presents
 * best-effort limits as isolation.
 *
 * The message names what is still enforced and what is not, so a reader can judge the trust a passing example carries.
 * The severity is `warning`: the build may still be right, but its example results are weaker than on a host that can
 * confine writes. Deterministic: the same platform always gives the same finding, with no position and no fix.
 */
export function exampleSandboxUnavailable(platform: string): Diagnostic {
  return {
    id: EXAMPLE_SANDBOX_ID,
    severity: "warning",
    message:
      `Examples run without an OS sandbox on ${platform}, so writes outside their working folder, reads of the host, ` +
      `and the network are not confined. Best-effort only: ${EXAMPLE_BEST_EFFORT_PROTECTIONS.join(", ")}.`,
    help:
      "Run the build on macOS with sandbox-exec or Linux with bwrap to confine writes, or accept that examples run with " +
      "the engine's own permissions.",
  };
}

/**
 * Reports a failing executable example: the page, the fence's source line, and a bounded first difference between the
 * output the example expected and the output it produced. The severity is `warning`, because stale documentation is
 * reported and carried by the trust model without failing every build.
 */
export function exampleFailed(options: ExampleFailedOptions): Diagnostic {
  const diff = firstDifference(options.expected, options.actual);
  const exitCode = options.exitCode === undefined ? "" : ` (exit code ${options.exitCode})`;
  return {
    id: EXAMPLE_FAILED_ID,
    severity: "warning",
    message: `The example on ${options.page} at ${options.pos.file}:${options.pos.line} failed${exitCode}: expected "${diff.expected}" but got "${diff.actual}".`,
    pos: options.pos,
    help: "Update the example's expected output, or fix what it demonstrates.",
  };
}
