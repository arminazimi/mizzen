/**
 * A span in a source file, from its first character to its last. `file` is relative to the repository root,
 * using `/` on every platform; lines and columns are 1-based and the end is inclusive, so it names the last
 * character of the node. `endLine` is the same as `line` for a one-line node.
 */
export interface SourcePos {
  /** Path of the source file, relative to the repository root. */
  readonly file: string;
  /** Line where the node starts. */
  readonly line: number;
  /** Column where the node starts (inclusive). */
  readonly column: number;
  /** Line where the node ends (the same as `line` for a one-line node). */
  readonly endLine: number;
  /** Column of the node's last character (inclusive). */
  readonly endColumn: number;
}
