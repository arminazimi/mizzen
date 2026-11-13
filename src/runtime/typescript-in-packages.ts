import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

let registered = false;

/**
 * True for a `file:` URL whose pathname names a `.ts` file beneath a `node_modules` directory. The pathname, not the
 * whole URL, decides: a `?v=<digest>` content-version query leaves the extension intact, while a non-file URL or a
 * file outside `node_modules` stays Node's business.
 */
function isPackageTypeScript(url: string): boolean {
  const parsed = new URL(url);
  return parsed.protocol === "file:" && parsed.pathname.includes("/node_modules/") && parsed.pathname.endsWith(".ts");
}

/**
 * Lets Node import a `.ts` file that lives inside `node_modules`. Node strips types from `.ts` files on its own but
 * refuses to do it for an installed package, and a theme is installed as a package that ships its TypeScript source.
 * The hook reads such a file, strips its types, and hands it back as an ES module. A query on the URL does not matter,
 * so a content-keyed import reloads changed bytes. It does nothing for any other file, and registering it a second time
 * does nothing.
 */
export function allowTypeScriptInPackages(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    load(url, context, nextLoad) {
      if (isPackageTypeScript(url)) {
        const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
        return { format: "module", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
