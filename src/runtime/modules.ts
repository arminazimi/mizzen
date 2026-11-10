import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/** The extension this engine's own modules have: `.ts` when run from source, `.js` when run from the built package. */
export const OWN_EXTENSION = extname(fileURLToPath(import.meta.url));

/**
 * The name of a loadable module file without its extension, or `null` for any other file. A module is a `.ts` or a
 * `.js` file; a declaration file (`.d.ts`) and a dot file are not modules. The engine's own folders of facts, outputs
 * and Markdown plugins hold `.ts` files in the source tree and `.js` files in the built package, and a folder a site
 * points the engine at may hold either.
 */
export function moduleName(fileName: string): string | null {
  if (fileName.startsWith(".") || fileName.endsWith(".d.ts")) return null;
  for (const extension of [".ts", ".js"]) {
    if (fileName.endsWith(extension)) return fileName.slice(0, -extension.length);
  }
  return null;
}
