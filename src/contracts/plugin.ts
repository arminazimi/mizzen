import type { Page, Site } from "./content.ts";
import type { OutputFile } from "./output.ts";

/** A value or a promise of one. */
export type MaybePromise<T> = T | Promise<T>;

/** The hooks a plugin can implement. Each receives a value and returns the (possibly changed) value; none mutates its input. */
export interface PluginHooks {
  /** Called for each page after its Markdown is parsed and before the site model is assembled. */
  content?(page: Page): MaybePromise<Page>;
  /** Called once with the assembled site model, before rendering. */
  model?(site: Site): MaybePromise<Site>;
  /** Called once with the files the outputs produced, before they are written. */
  outputs?(files: readonly OutputFile[], site: Site): MaybePromise<readonly OutputFile[]>;
}

/** A plugin: a name for diagnostics and the hooks it implements. Unused until `engine.plugins` lands. */
export interface Plugin extends PluginHooks {
  /** The plugin's name, shown in diagnostics. */
  readonly name: string;
}

/** What the site's code file default-exports: plugins and nothing else. */
export interface CodeConfig {
  /** Plugins, applied in order. */
  readonly plugins: readonly Plugin[];
}
