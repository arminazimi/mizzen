/**
 * `mizzen doctor [dir] [--format text|json|sarif] [--theme <dir>]`: a read-only preflight of one site.
 *
 * It checks the runtime, the config, the content, the theme, the render, and the output, and reports through the
 * engine's diagnostics contract, so `--format json` and `--format sarif` work as they do for `check`. A site with an
 * error exits 1; a clean site exits 0. Nothing is written to the site: the checks that need a build write into a
 * temporary folder, as `check` does.
 *
 * The content and theme checks run on their own before the build, so a site without a theme still gets its content
 * checked, and a build that throws does not discard what those checks already found. {@link doctorReport} returns every
 * check's outcome as well as the findings; a skipped check also appears as an `info` finding, so machine-readable
 * output can tell a complete run from a partial one.
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { buildModel } from "../model/build.ts";
import { build } from "../pipeline/build.ts";
import { createDiagnostics, sortDiagnostics } from "../pipeline/diagnostics.ts";
import { loadRegistry } from "../render/registry.ts";
import { coverageDiagnostics, type DoctorCheck, type DoctorCheckId, type DoctorReport } from "./doctor-report.ts";

/** The oldest Node.js major the engine runs on, from `engines` in package.json. */
export const MIN_NODE_MAJOR = 24;

/** Options of {@link doctor}. */
export interface DoctorOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The theme root, already resolved by the CLI; without it the check stops at the content. */
  readonly themeRoot?: string;
  /** Layout for a page that names none, as `build` and `check` use. */
  readonly defaultLayout?: string;
  /** The Node version to check, such as `process.versions.node`; tests pass another. Default: this process's. */
  readonly nodeVersion?: string;
}

/** Help added to a config finding that does not carry its own, so every config finding is actionable. */
const CONFIG_HELP = "Fix the value named in the message; schema/config.schema.json lists every key and type.";

/** Help added to a check that could not run, pointing back at the finding that explains why. */
const CHECK_HELP = "Fix the finding named above, then run `mizzen doctor` again.";

/** Stable reasons a check can be skipped; the coverage finding repeats the one that applies. */
const SKIP_CONFIG = "the site config could not be read";
const SKIP_NO_THEME = "no theme root was found for this site";
const SKIP_BUILD = "the build check could not finish";

/** The runtime check: an error only when this Node.js is older than {@link MIN_NODE_MAJOR}. */
export function runtimeDiagnostic(version: string = process.versions.node): Diagnostic | undefined {
  const major = Number(version.split(".", 1)[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return undefined;
  return {
    id: "doctor.node-version",
    severity: "error",
    message: `Node.js ${version} is older than ${MIN_NODE_MAJOR}, the oldest version Mizzen runs on.`,
    help: `Upgrade to Node.js ${MIN_NODE_MAJOR} or later.`,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isError(finding: Diagnostic): boolean {
  return finding.severity === "error";
}

/** The identity of a finding, for dropping the copies a later stage makes of an earlier stage's finding. */
function diagnosticKey(finding: Diagnostic): string {
  const pos = finding.pos;
  const where = pos === undefined ? "" : `${pos.file}:${pos.line}:${pos.column}:${pos.endLine}:${pos.endColumn}`;
  return `${finding.id}\u0000${finding.severity}\u0000${finding.message}\u0000${where}`;
}

function passed(id: DoctorCheckId): DoctorCheck {
  return { id, state: "passed" };
}

function failed(id: DoctorCheckId, reason: string): DoctorCheck {
  return { id, state: "failed", reason };
}

function skipped(id: DoctorCheckId, reason: string): DoctorCheck {
  return { id, state: "skipped", reason };
}

/** Sorted findings, with a help line on every config finding that has none. */
function finalize(all: readonly Diagnostic[]): readonly Diagnostic[] {
  return sortDiagnostics(
    all.map((found) =>
      found.id.startsWith("config.") && found.help === undefined ? { ...found, help: CONFIG_HELP } : found,
    ),
  );
}

/**
 * Checks the site at `options.root` without writing to it, and returns the findings only.
 *
 * This is the CLI's entry point; {@link doctorReport} also returns the outcome of every declared check.
 */
export async function doctor(options: DoctorOptions): Promise<readonly Diagnostic[]> {
  return (await doctorReport(options)).diagnostics;
}

/**
 * Checks the site at `options.root` without writing to it and accounts for every declared check.
 *
 * The runtime, config, content, and theme checks run first and independently: a missing theme still leaves the content
 * checked, and a missing source still leaves the theme checked. The render and output checks run together in one build
 * into a temporary folder, so a finding from either stage is reported once. A check whose input is missing, or whose
 * stage throws, is marked `skipped` with a stable reason, and that reason is also an `info` finding so text, JSON, and
 * SARIF say what did not run. Findings come back sorted, so all three formats stay stable.
 */
export async function doctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const diagnostics = createDiagnostics();
  const checks: DoctorCheck[] = [];
  const reported = new Set<string>();
  /** Reports the findings this run has not reported yet, and returns the ones that were new. */
  const publish = (findings: readonly Diagnostic[]): Diagnostic[] => {
    const fresh: Diagnostic[] = [];
    for (const found of findings) {
      const key = diagnosticKey(found);
      if (reported.has(key)) continue;
      reported.add(key);
      diagnostics.report(found);
      fresh.push(found);
    }
    return fresh;
  };

  const runtime = runtimeDiagnostic(options.nodeVersion);
  if (runtime !== undefined) publish([runtime]);
  checks.push(runtime === undefined ? passed("runtime") : failed("runtime", "Node.js is too old"));

  const root = resolve(options.root);
  const themeRoot = options.themeRoot === undefined ? undefined : resolve(options.themeRoot);

  let source: string | undefined;
  let sourceName: string | undefined;
  try {
    const loaded = loadConfig(root);
    publish(loaded.diagnostics);
    sourceName = loaded.config.source;
    source = resolve(root, loaded.config.source);
    checks.push(loaded.diagnostics.some(isError) ? failed("config", "the site config has errors") : passed("config"));
  } catch (err) {
    diagnostics.error("doctor.config-unreadable", `Cannot read the site config: ${messageOf(err)}`, {
      help: "Make mizzen.yml readable, then run `mizzen doctor` again.",
    });
    checks.push(failed("config", SKIP_CONFIG));
  }

  const sourceExists = source !== undefined && (await exists(source));
  const missingSource = `the source folder "${sourceName ?? ""}" does not exist`;

  if (source === undefined) {
    checks.push(skipped("content", SKIP_CONFIG));
  } else if (!sourceExists) {
    diagnostics.error("doctor.source-missing", `The source folder "${sourceName ?? ""}" does not exist under "${root}".`, {
      help: "Create it, or set `source` in mizzen.yml to the folder that holds the site's pages.",
    });
    checks.push(skipped("content", missingSource));
  } else {
    try {
      const model = await buildModel(root);
      publish(model.diagnostics);
      const contentErrors = model.diagnostics.some((found) => isError(found) && !found.id.startsWith("config."));
      checks.push(contentErrors ? failed("content", "the content check found errors") : passed("content"));
    } catch (err) {
      diagnostics.error("doctor.content-failed", `The content check could not run: ${messageOf(err)}`, { help: CHECK_HELP });
      checks.push(failed("content", "the content check could not run"));
    }
  }

  if (themeRoot === undefined) {
    diagnostics.error("doctor.missing-theme", "No theme root was found for this site, so its pages cannot be rendered.", {
      help: "Pass `--theme <dir>`, or set `theme.name` in the site config to a folder or package.",
    });
    checks.push(skipped("theme", SKIP_NO_THEME));
  } else {
    try {
      const registry = await loadRegistry(themeRoot);
      publish(registry.diagnostics);
      checks.push(registry.diagnostics.some(isError) ? failed("theme", "the theme check found errors") : passed("theme"));
    } catch (err) {
      diagnostics.error("doctor.theme-failed", `The theme check could not run: ${messageOf(err)}`, { help: CHECK_HELP });
      checks.push(failed("theme", "the theme check could not run"));
    }
  }

  if (source === undefined || !sourceExists || themeRoot === undefined) {
    const reason = source === undefined ? SKIP_CONFIG : !sourceExists ? missingSource : SKIP_NO_THEME;
    checks.push(skipped("render", reason), skipped("output", reason));
  } else {
    const parent = await mkdtemp(join(tmpdir(), "mizzen-doctor-"));
    try {
      const result = await build({
        root,
        out: join(parent, "out"),
        themeRoot,
        ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
      });
      const fresh = publish(result.diagnostics);
      const renderErrors = result.diagnostics.some((found) => isError(found) && found.id.startsWith("render."));
      checks.push(renderErrors ? failed("render", "the render check found errors") : passed("render"));
      // A remaining error was produced only by the full build, so it belongs to the output stage.
      const outputErrors = fresh.some((found) => isError(found) && !found.id.startsWith("render."));
      checks.push(outputErrors ? failed("output", "the output check found errors") : passed("output"));
    } catch (err) {
      diagnostics.error("doctor.build-failed", `The build check could not run: ${messageOf(err)}`, { help: CHECK_HELP });
      checks.push(skipped("render", SKIP_BUILD), skipped("output", SKIP_BUILD));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  for (const found of coverageDiagnostics(checks)) diagnostics.report(found);
  return { checks, diagnostics: finalize(diagnostics.all) };
}
