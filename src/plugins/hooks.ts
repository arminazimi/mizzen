import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Diagnostic, MaybePromise, OutputFile, Page, Plugin, PluginHooks, Site } from "../contracts/index.ts";

/**
 * The site's code file, at the site root: plugins and nothing else.
 * The settings of the site belong to `mizzen.yml`, so this file can never set one.
 */
export const CODE_CONFIG_FILE = "mizzen.config.ts";

/** The hooks a plugin may implement, in the order the pipeline runs them. */
export type HookName = keyof PluginHooks;

/** The hook names in pipeline order. */
const HOOK_NAMES: readonly HookName[] = ["content", "model", "outputs"];

/** Options of {@link loadCodeConfig}. */
export interface LoadCodeOptions {
  /** Path of the code file, absolute or under `siteRoot`. Default: `<siteRoot>/mizzen.config.ts`. */
  readonly path?: string;
}

/** What {@link loadCodeConfig} read from a site's code file. */
export interface LoadedCode {
  /** The plugins to run, in the order the file lists them; empty when the file is missing or lists none. */
  readonly plugins: readonly Plugin[];
  /** Problems in the file; empty when it is missing or usable. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * One hook stage: the value after every plugin had its turn, and one diagnostic per plugin the stage had to drop.
 * The stage never fails: the value it hands back is always usable.
 */
export interface HookResult<T> {
  readonly value: T;
  readonly diagnostics: readonly Diagnostic[];
}

/** What a stage does with one plugin's hook and the value the stage carries. */
type HookCall<T> = (plugin: Plugin, value: T) => MaybePromise<T>;

/** Names what a hook must return ("a page"), or returns `undefined` when the value is usable. */
type ValueCheck<T> = (value: T) => string | undefined;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An error about the code file itself; the file is the whole problem, so its position is its first line. */
function fileDiagnostic(file: string, id: string, message: string, help: string): Diagnostic {
  return { id, severity: "error", message, pos: { file, line: 1, column: 1, endLine: 1, endColumn: 1 }, help };
}

/**
 * An error about one plugin's hook, naming the plugin so the site owner knows which one to fix, at the code file the
 * plugins come from.
 */
function hookDiagnostic(plugin: Plugin, message: string): Diagnostic {
  return {
    id: "plugin.hook-failed",
    severity: "error",
    message: `Plugin "${plugin.name}" ${message}`,
    pos: { file: CODE_CONFIG_FILE, line: 1, column: 1, endLine: 1, endColumn: 1 },
    help: "Fix the plugin or remove it from the site's code file.",
  };
}

/** Why a listed entry is not a plugin, or `undefined` when the runner can use it. */
function pluginProblem(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "it is not an object";
  if (typeof value.name !== "string" || value.name === "") return "it has no non-empty `name`";
  for (const hook of HOOK_NAMES) {
    const unit = value[hook];
    if (unit !== undefined && typeof unit !== "function") return `its \`${hook}\` is not a function`;
  }
  return undefined;
}

/**
 * Loads the site's code file (`mizzen.config.ts`) and returns the plugins it lists.
 *
 * A site without the file is an ordinary site, not a problem: no plugins and no diagnostics. The file default-exports
 * `{ plugins: [...] }` and sets no config key, so anything else it exports is read by nobody. A file
 * Node cannot import and a default export that is not a code config each come back as one error that names the file,
 * with no plugins; an entry that is not a plugin comes back as an error and is dropped, and the sound entries still run.
 */
export async function loadCodeConfig(siteRoot: string, options: LoadCodeOptions = {}): Promise<LoadedCode> {
  const root = resolve(siteRoot);
  const abs = options.path === undefined ? join(root, CODE_CONFIG_FILE) : resolve(root, options.path);
  if (!(await exists(abs))) return { plugins: [], diagnostics: [] };

  const rel = relative(root, abs).split("\\").join("/");
  const file = rel === "" ? CODE_CONFIG_FILE : rel;

  let mod: Record<string, unknown>;
  try {
    // Node keeps a module for the life of the process, so key the URL by the file's content: an edit is a new module,
    // while unchanged content reuses the one already imported.
    const digest = createHash("sha256").update(await readFile(abs)).digest("hex");
    mod = (await import(`${pathToFileURL(abs).href}?v=${digest}`)) as Record<string, unknown>;
  } catch (err) {
    return {
      plugins: [],
      diagnostics: [
        fileDiagnostic(
          file,
          "plugin.load-failed",
          `Failed to load ${file}: ${detailOf(err)}.`,
          "Fix the file so Node can import it, or remove it.",
        ),
      ],
    };
  }

  const exported = mod.default;
  if (!isPlainObject(exported)) {
    return {
      plugins: [],
      diagnostics: [
        fileDiagnostic(
          file,
          "plugin.invalid-code-config",
          `${file} must default-export the site's plugins.`,
          "Default-export `{ plugins: [...] }`.",
        ),
      ],
    };
  }
  const listed = exported.plugins;
  if (!Array.isArray(listed)) {
    return {
      plugins: [],
      diagnostics: [
        fileDiagnostic(
          file,
          "plugin.invalid-code-config",
          `The default export of ${file} has no \`plugins\` list.`,
          "Default-export `{ plugins: [...] }`; the list is empty when the site has no plugin.",
        ),
      ],
    };
  }

  const diagnostics: Diagnostic[] = [];
  const plugins: Plugin[] = [];
  listed.forEach((entry, index) => {
    const problem = pluginProblem(entry);
    if (problem !== undefined) {
      diagnostics.push(
        fileDiagnostic(
          file,
          "plugin.invalid-plugin",
          `Plugin ${index + 1} of ${file} is dropped: ${problem}.`,
          "Every entry of `plugins` is an object with a `name` and any of the `content`, `model`, and `outputs` hooks.",
        ),
      );
      return;
    }
    plugins.push(entry as Plugin);
  });

  return { plugins, diagnostics };
}

/**
 * Runs one hook of every plugin in the order the plugins are listed, so each hook gets what the hook before it returned.
 *
 * A plugin that does not implement the hook is skipped, and a promise is awaited before the next plugin runs. A hook
 * that throws, or returns a value the stage cannot use, is an error naming the plugin; the value the stage carried
 * before that plugin is kept and the plugins after it still run, so one bad plugin costs its own work and nothing more.
 * Nothing here changes the value handed in: a plugin that wants a change returns a new value.
 */
async function runStage<T>(
  plugins: readonly Plugin[],
  hook: HookName,
  start: T,
  call: HookCall<T>,
  check: ValueCheck<T>,
): Promise<HookResult<T>> {
  const diagnostics: Diagnostic[] = [];
  let value = start;
  for (const plugin of plugins) {
    if (typeof plugin[hook] !== "function") continue;
    try {
      const next = await call(plugin, value);
      const expected = check(next);
      if (expected !== undefined) {
        diagnostics.push(
          hookDiagnostic(plugin, `returned something that is not ${expected} from its ${hook} hook; the value before it is kept.`),
        );
        continue;
      }
      value = next;
    } catch (err) {
      diagnostics.push(hookDiagnostic(plugin, `failed in its ${hook} hook: ${detailOf(err)}.`));
    }
  }
  return { value, diagnostics };
}

/** Runs the `content` hooks of `page`: once per page, after its Markdown is parsed and before the model is assembled. */
export function runContentHooks(plugins: readonly Plugin[], page: Page): Promise<HookResult<Page>> {
  return runStage(plugins, "content", page, (plugin, value) => plugin.content!(value), (value) =>
    isPlainObject(value) ? undefined : "a page",
  );
}

/** Runs the `model` hooks of the assembled `site`: once, before anything is rendered. */
export function runModelHooks(plugins: readonly Plugin[], site: Site): Promise<HookResult<Site>> {
  return runStage(plugins, "model", site, (plugin, value) => plugin.model!(value), (value) =>
    isPlainObject(value) ? undefined : "a site model",
  );
}

/**
 * Runs the `outputs` hooks of the files the outputs produced, with the site model they came from: once, before the
 * files are written.
 */
export function runOutputsHooks(
  plugins: readonly Plugin[],
  files: readonly OutputFile[],
  site: Site,
): Promise<HookResult<readonly OutputFile[]>> {
  return runStage(plugins, "outputs", files, (plugin, value) => plugin.outputs!(value, site), (value) =>
    Array.isArray(value) ? undefined : "a list of output files",
  );
}
