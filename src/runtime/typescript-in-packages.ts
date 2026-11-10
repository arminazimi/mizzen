import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

let registered = false;

/**
 * Lets Node import a `.ts` file that lives inside `node_modules`. Node strips types from `.ts` files on its own but
 * refuses to do it for an installed package, and a theme is installed as a package that ships its TypeScript source.
 * The hook reads such a file, strips its types, and hands it back as an ES module. It does nothing for any other file,
 * and registering it a second time does nothing.
 */
export function allowTypeScriptInPackages(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".ts") && url.includes("/node_modules/")) {
        const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
        return { format: "module", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
