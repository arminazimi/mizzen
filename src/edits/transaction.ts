/**
 * One all-or-nothing write of several files (#58, M2.6).
 *
 * An edit touches three artifacts that must agree: the source, its proof, and the provenance
 * ledger. Writing them one at a time lets a failure leave a changed source with a missing or stale
 * proof. This module stages every artifact's bytes beside its target first, checks that nothing
 * changed after the caller read it, and only then commits each with one rename. If a commit fails,
 * the artifacts already committed are put back from the bytes read before staging.
 *
 * A target that is a directory, a path listed twice, or a parent that cannot be a directory is
 * refused before anything is staged. A target the caller expected to exist but that changed (or
 * disappeared) since it was read is refused as stale input, again before any rename. Staging
 * folders are always removed; an incomplete rollback is reported in the error rather than hidden.
 *
 * {@link TransactionHooks} exists so tests can inject a failure at a fixed step. The edit CLI never
 * passes it.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** One file's new bytes, committed by one rename. */
export interface TransactionArtifact {
  /** The target path. It is resolved from the current directory. */
  readonly path: string;
  /** The new bytes. A string is written as UTF-8, so line endings are kept as given. */
  readonly content: string | Uint8Array;
  /** How diagnostics name the file; defaults to the path. */
  readonly label?: string;
  /**
   * SHA-256 the target must still have when every artifact is staged, or `null` when it must still
   * be absent. Omitted means the target is not checked.
   */
  readonly expectedBeforeHash?: string | null;
}

/**
 * Test seams. Production callers pass nothing; each hook runs at the named point and a thrown error
 * is handled exactly as the equivalent filesystem failure would be.
 */
export interface TransactionHooks {
  /** After every artifact is staged, before any rename. Throw to abandon before committing. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Immediately before the rename of artifact `index`. Throw to fail after earlier renames. */
  readonly beforeRename?: (index: number, artifact: TransactionArtifact) => void | Promise<void>;
  /** Before restoring artifact `index` during rollback. Throw to make the rollback incomplete. */
  readonly beforeRestore?: (index: number, artifact: TransactionArtifact) => void | Promise<void>;
}

/** Why a transaction was refused or failed. */
export type TransactionErrorCode = "invalid-target" | "stale-input" | "write-failed";

/** A refused or failed transaction. `rolledBack` is false only when a restore also failed. */
export class TransactionError extends Error {
  readonly code: TransactionErrorCode;
  /** The artifact the failure names, when it has one. */
  readonly path: string | undefined;
  /** Labels of the artifacts committed before the failure. */
  readonly committed: readonly string[];
  /** True when nothing was committed, or every committed artifact was put back. */
  readonly rolledBack: boolean;
  /** Why the rollback did not finish, when it did not. */
  readonly rollbackError: string | undefined;

  constructor(
    code: TransactionErrorCode,
    message: string,
    detail: {
      readonly path?: string | undefined;
      readonly committed?: readonly string[];
      readonly rolledBack?: boolean;
      readonly rollbackError?: string;
    } = {},
  ) {
    super(message);
    this.name = "TransactionError";
    this.code = code;
    this.path = detail.path;
    this.committed = detail.committed ?? [];
    this.rolledBack = detail.rolledBack ?? true;
    this.rollbackError = detail.rollbackError;
  }
}

/** One staged artifact and the bytes it replaces. */
interface Prepared {
  readonly artifact: TransactionArtifact;
  readonly target: string;
  readonly label: string;
  readonly prior: { readonly bytes: Buffer; readonly mode: number } | undefined;
  readonly temp: string;
}

/** The bytes of a content value. A string is UTF-8, never normalized. */
function bytesOf(content: string | Uint8Array): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

/** SHA-256 of the bytes, as 64 lowercase hex characters. */
function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The reason an errno error gives, as one phrase. */
function reasonOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "it does not exist";
  if (code === "EISDIR") return "it is a directory";
  if (code === "ENOTDIR") return "a parent is not a directory";
  if (code === "EACCES" || code === "EPERM") return "it is not writable";
  return error instanceof Error ? error.message : String(error);
}

/** The target's current bytes and mode, or undefined when it is absent. A directory is refused. */
async function priorOf(target: string, label: string): Promise<{ bytes: Buffer; mode: number } | undefined> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new TransactionError("invalid-target", `${label}: cannot inspect the target: ${reasonOf(error)}.`, {
      path: label,
    });
  }
  if (info.isDirectory()) {
    throw new TransactionError("invalid-target", `${label}: the target is a directory, not a file.`, {
      path: label,
    });
  }
  try {
    return { bytes: await readFile(target), mode: info.mode & 0o7777 };
  } catch (error) {
    throw new TransactionError("invalid-target", `${label}: cannot read the target: ${reasonOf(error)}.`, {
      path: label,
    });
  }
}

/** The file a target names, with an existing symlink and symlinked parents resolved. */
async function identityOf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    try {
      return join(await realpath(dirname(target)), basename(target));
    } catch {
      return target;
    }
  }
}

/** Creates `dir` and its missing parents, recording only the folders this call creates. */
async function ensureParent(dir: string, label: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let current = dir;
  for (;;) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) {
        throw new TransactionError(
          "invalid-target",
          `${label}: "${current}" is a parent that is not a directory.`,
          { path: label },
        );
      }
      break;
    } catch (error) {
      if (error instanceof TransactionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new TransactionError("invalid-target", `${label}: cannot inspect "${current}": ${reasonOf(error)}.`, {
          path: label,
        });
      }
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const folder of missing.reverse()) {
    try {
      await mkdir(folder);
      created.push(folder);
    } catch (error) {
      throw new TransactionError("invalid-target", `${label}: cannot create "${folder}": ${reasonOf(error)}.`, {
        path: label,
      });
    }
  }
}

/** Removes staging folders, ignoring what is already gone. */
async function discardStaging(folders: readonly string[]): Promise<void> {
  await Promise.allSettled(folders.map((folder) => rm(folder, { recursive: true, force: true })));
}

/** Removes the empty folders this transaction created, deepest first. */
async function discardCreated(folders: readonly string[]): Promise<void> {
  for (const folder of [...folders].reverse()) {
    try {
      await rmdir(folder);
    } catch {
      // A folder that gained another file, or was already removed, is not ours to delete.
    }
  }
}

/** Stages the artifact's new bytes beside its target, preserving the target's mode when it exists. */
async function stage(
  artifact: TransactionArtifact,
  target: string,
  prior: { readonly bytes: Buffer; readonly mode: number } | undefined,
): Promise<string> {
  const staging = await mkdtemp(join(dirname(target), ".edit-transaction-"));
  try {
    const temp = join(staging, "artifact");
    await writeFile(temp, bytesOf(artifact.content));
    if (prior !== undefined) await chmod(temp, prior.mode);
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Puts an artifact's prior bytes back in one rename, or removes it when it did not exist. */
async function restore(item: Prepared): Promise<void> {
  if (item.prior === undefined) {
    await rm(item.target, { force: true });
    return;
  }
  const staging = await mkdtemp(join(dirname(item.target), ".edit-restore-"));
  try {
    const temp = join(staging, "artifact");
    await writeFile(temp, item.prior.bytes);
    await chmod(temp, item.prior.mode);
    await rename(temp, item.target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Stages every artifact, commits them with one rename each, and restores the ones already
 * committed when a later rename fails. Nothing is written when staging or a stale-input check
 * refuses the set, so a caller that gets an error knows the tree is as it was unless the error
 * reports `rolledBack: false`.
 */
export async function commitArtifacts(
  artifacts: readonly TransactionArtifact[],
  hooks: TransactionHooks = {},
): Promise<void> {
  const staging: string[] = [];
  const created: string[] = [];
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  let succeeded = false;

  try {
    for (const artifact of artifacts) {
      const target = resolve(artifact.path);
      const label = artifact.label ?? target;
      const identity = await identityOf(target);
      if (seen.has(identity)) {
        throw new TransactionError("invalid-target", `${label}: the transaction lists this path more than once.`, {
          path: label,
        });
      }
      seen.add(identity);

      const prior = await priorOf(target, label);
      if (artifact.expectedBeforeHash !== undefined) {
        const actual = prior === undefined ? null : hashBytes(prior.bytes);
        if (actual !== artifact.expectedBeforeHash) {
          throw new TransactionError(
            "stale-input",
            `${label}: the file changed after it was read; nothing was written.`,
            { path: label },
          );
        }
      }

      await ensureParent(dirname(target), label, created);
      const folder = await stage(artifact, target, prior);
      staging.push(folder);
      prepared.push({ artifact, target, label, prior, temp: join(folder, "artifact") });
    }
  } catch (error) {
    await discardStaging(staging);
    await discardCreated(created);
    if (error instanceof TransactionError) throw error;
    throw new TransactionError("write-failed", `staging the edit failed: ${reasonOf(error)}; nothing was written.`);
  }

  try {
    // The hook runs before the stale check so a test can change a target between staging and commit.
    await hooks.beforeCommit?.();

    // Re-read immediately before renaming: a target that changed since it was read refuses the
    // whole set, so a proof or ledger is never written over someone else's bytes.
    for (const item of prepared) {
      if (item.artifact.expectedBeforeHash === undefined) continue;
      let current: Buffer | undefined;
      try {
        current = await readFile(item.target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new TransactionError(
            "write-failed",
            `${item.label}: the file cannot be read before writing: ${reasonOf(error)}; nothing was written.`,
            { path: item.label },
          );
        }
      }
      const actual = current === undefined ? null : hashBytes(current);
      if (actual !== item.artifact.expectedBeforeHash) {
        throw new TransactionError(
          "stale-input",
          `${item.label}: the file changed while the edit was staged; nothing was written.`,
          { path: item.label },
        );
      }
    }

    const committed: Prepared[] = [];
    try {
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index]!;
        await hooks.beforeRename?.(index, item.artifact);
        await rename(item.temp, item.target);
        committed.push(item);
      }
      succeeded = true;
    } catch (error) {
      const failed = prepared[committed.length];
      const restored: string[] = [];
      const failures: string[] = [];
      for (let index = committed.length - 1; index >= 0; index -= 1) {
        const item = committed[index]!;
        try {
          await hooks.beforeRestore?.(index, item.artifact);
          await restore(item);
          restored.unshift(item.label);
        } catch (restoreError) {
          failures.push(`${item.label}: ${reasonOf(restoreError)}`);
        }
      }

      const rollback =
        committed.length === 0
          ? "nothing was replaced"
          : failures.length === 0
            ? `the files already replaced were restored (${restored.join(", ")})`
            : `rollback incomplete: ${failures.join("; ")}; check the tree`;
      throw new TransactionError(
        "write-failed",
        `${failed?.label ?? "the edit"}: writing the file failed: ${reasonOf(error)}; ${rollback}.`,
        {
          path: failed?.label,
          committed: committed.map((item) => item.label),
          rolledBack: failures.length === 0,
          ...(failures.length === 0 ? {} : { rollbackError: failures.join("; ") }),
        },
      );
    }
  } catch (error) {
    if (error instanceof TransactionError) throw error;
    throw new TransactionError(
      "write-failed",
      `committing the edit failed: ${reasonOf(error)}; nothing was written.`,
    );
  } finally {
    await discardStaging(staging);
    // A failed transaction leaves no folder it created behind; a successful one keeps them.
    if (!succeeded) await discardCreated(created);
  }
}
