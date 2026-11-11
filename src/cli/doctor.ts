/**
 * `mizzen doctor [dir] [--format text|json|sarif] [--theme <dir>]`: a read-only preflight of one site.
 *
 * It checks the runtime, the config, the content, the output paths, and the toolchain, and reports through the
 * engine's diagnostics contract, so `--format json` and `--format sarif` work as they do for `check`. A site with an
 * error exits 1; a clean site exits 0. Nothing is written to the site: the checks that need a build write into a
 * temporary folder, as `check` does.
 */
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { buildModel } from "../model/build.ts";
import { build } from "../pipeline/build.ts";
import { createDiagnostics, sortDiagnostics } from "../pipeline/diagnostics.ts";

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

/** Sorted findings, with a help line on every config finding that has none. */
function finalize(all: readonly Diagnostic[]): readonly Diagnostic[] {
  return sortDiagnostics(
    all.map((found) =>
      found.id.startsWith("config.") && found.help === undefined ? { ...found, help: CONFIG_HELP } : found,
    ),
  );
}

/**
 * Checks the site at `options.root` without writing to it.
 *
 * A site whose source folder is missing stops after the config; a site without a theme still gets its content
 * checked. With both present, a build into a temporary folder checks the content, the theme, and every output path
 * together. Findings come back sorted, so text, JSON, and SARIF output stay stable.
 */
export async function doctor(options: DoctorOptions): Promise<readonly Diagnostic[]> {
  const diagnostics = createDiagnostics();
  const root = resolve(options.root);

  const runtime = runtimeDiagnostic(options.nodeVersion);
  if (runtime !== undefined) diagnostics.report(runtime);

  let source: string | undefined;
  let sourceName: string | undefined;
  let configFindings: readonly Diagnostic[] = [];
  try {
    const loaded = loadConfig(root);
    configFindings = loaded.diagnostics;
    sourceName = loaded.config.source;
    source = resolve(root, loaded.config.source);
  } catch (err) {
    diagnostics.error("doctor.config-unreadable", `Cannot read the site config: ${messageOf(err)}`, {
      help: "Make mizzen.yml readable, then run `mizzen doctor` again.",
    });
  }

  if (source === undefined) {
    for (const found of configFindings) diagnostics.report(found);
    return finalize(diagnostics.all);
  }

  if (!(await exists(source))) {
    // The model needs the source folder, so the config findings above are all this run can report.
    for (const found of configFindings) diagnostics.report(found);
    diagnostics.error("doctor.source-missing", `The source folder "${sourceName ?? ""}" does not exist under "${root}".`, {
      help: "Create it, or set `source` in mizzen.yml to the folder that holds the site's pages.",
    });
    return finalize(diagnostics.all);
  }

  if (options.themeRoot === undefined) {
    diagnostics.error("doctor.missing-theme", "No theme root was found for this site, so its pages cannot be rendered.", {
      help: "Pass `--theme <dir>`, or set `theme.name` in the site config to a folder or package.",
    });
    try {
      for (const found of (await buildModel(root)).diagnostics) diagnostics.report(found);
    } catch (err) {
      diagnostics.error("doctor.content-failed", `The content check could not run: ${messageOf(err)}`, {
        help: "Fix the problem named above, then run `mizzen doctor` again.",
      });
    }
    return finalize(diagnostics.all);
  }

  const parent = await mkdtemp(join(tmpdir(), "mizzen-doctor-"));
  try {
    const result = await build({
      root,
      out: join(parent, "out"),
      themeRoot: options.themeRoot,
      ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
    });
    for (const found of result.diagnostics) diagnostics.report(found);
  } catch (err) {
    diagnostics.error("doctor.build-failed", `The build check could not run: ${messageOf(err)}`, {
      help: "Fix the problem named above, then run `mizzen doctor` again.",
    });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
  return finalize(diagnostics.all);
}
