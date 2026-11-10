import type { SourcePos } from "./source.ts";

/** How serious a diagnostic is. An `error` fails the build; a `warning` is reported; `info` is for the reader's information only. */
export type Severity = "error" | "warning" | "info";

/** A safe, mechanical repair: replace the characters of one source span with `text`. See ADR 0027. */
export interface DiagnosticFix {
  /** Path of the file to change, relative to the repository root, using `/` on every platform. */
  readonly file: string;
  /** Line where the replaced span starts (1-based). */
  readonly line: number;
  /** Column where the replaced span starts (1-based, in Unicode code points; a tab is one column). */
  readonly column: number;
  /** Line where the replaced span ends. */
  readonly endLine: number;
  /** Column of the last replaced character (inclusive). */
  readonly endColumn: number;
  /** What replaces the span; the empty string deletes it. */
  readonly text: string;
  /** A short phrase for people, such as `Add a trailing slash`. */
  readonly description?: string;
}

/** One finding of the engine, a registry, a plugin, or a theme, such as a broken link or an unknown config key. */
export interface Diagnostic {
  /** Stable identifier, such as `config.unknown-key`; a check ID is never reused for another meaning. */
  readonly id: string;
  /** Whether the finding fails the build. */
  readonly severity: Severity;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** Where in the source the problem is, when it has a place. */
  readonly pos?: SourcePos;
  /** How to fix it, when the fix is known. */
  readonly help?: string;
  /** A safe, mechanical repair as data, when there is one, so an agent or `mizzen fix` can apply it. `help` stays for people. */
  readonly fix?: DiagnosticFix;
}
