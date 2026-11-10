import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Nodes, Root } from "mdast";
import remarkParse from "remark-parse";
import { unified, type Plugin } from "unified";

/** A Markdown plugin unit discovered from `plugins/<name>.ts`. */
export interface MarkdownPlugin {
  readonly name: string;
  readonly order: number;
  readonly plugin: Plugin<[], Root>;
}

/** Compares by code point, never by locale (ADR 0022, rule 5). */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readUnit(mod: Record<string, unknown>): MarkdownPlugin | null {
  const fromDefault = mod.default;
  if (
    fromDefault !== null &&
    typeof fromDefault === "object" &&
    typeof (fromDefault as MarkdownPlugin).name === "string" &&
    typeof (fromDefault as MarkdownPlugin).order === "number" &&
    typeof (fromDefault as MarkdownPlugin).plugin === "function"
  ) {
    return fromDefault as MarkdownPlugin;
  }
  if (
    typeof mod.name === "string" &&
    typeof mod.order === "number" &&
    typeof mod.plugin === "function"
  ) {
    return { name: mod.name, order: mod.order, plugin: mod.plugin as Plugin<[], Root> };
  }
  return null;
}

/** Load every `*.ts` plugin from `plugins/`, sorted by `order` then `name`. */
export async function loadMarkdownPlugins(): Promise<readonly MarkdownPlugin[]> {
  const dir = fileURLToPath(new URL("./plugins/", import.meta.url));
  const names = (await readdir(dir)).filter((n) => n.endsWith(".ts")).sort(byCodePoint);
  const loaded: MarkdownPlugin[] = [];
  for (const file of names) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as Record<string, unknown>;
    const unit = readUnit(mod);
    if (!unit) {
      throw new Error(`Markdown plugin ${file} must export { name, order, plugin }`);
    }
    loaded.push(unit);
  }
  return loaded.sort((a, b) => a.order - b.order || byCodePoint(a.name, b.name));
}

/** Shift every node's start/end line so body line 1 maps to `bodyLine` in the source file. */
function offsetPositions(node: Nodes, delta: number): void {
  if (delta === 0) return;
  if (node.position) {
    node.position.start.line += delta;
    node.position.end.line += delta;
  }
  if ("children" in node) {
    for (const child of node.children) offsetPositions(child, delta);
  }
}

type MarkdownProcessor = {
  parse(file: string): Root;
  run(tree: Root, file?: string): Promise<Root>;
};

let processorPromise: Promise<MarkdownProcessor> | undefined;

async function getProcessor(): Promise<MarkdownProcessor> {
  if (!processorPromise) {
    processorPromise = (async () => {
      const plugins = await loadMarkdownPlugins();
      // remark-parse first; discovered plugins (GFM at order 0) follow in stable order.
      const processor = unified().use(remarkParse);
      for (const unit of plugins) {
        processor.use(unit.plugin);
      }
      return processor.freeze() as unknown as MarkdownProcessor;
    })();
  }
  return processorPromise;
}

/**
 * Parse Markdown into mdast with positions.
 *
 * `bodyLine` is the 1-based source line where `body` starts (from front matter).
 * Every mdast position is offset so it refers to the full source file.
 */
export async function parseMarkdown(body: string, bodyLine = 1): Promise<Root> {
  const processor = await getProcessor();
  const tree = await processor.run(processor.parse(body), body);
  offsetPositions(tree, bodyLine - 1);
  return tree;
}
