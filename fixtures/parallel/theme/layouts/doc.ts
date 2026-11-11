import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";

// One counter per thread, so every render gets a file name no other thread makes.
let counter = 0;

/**
 * A layout that holds its thread for a moment and, when `MIZZEN_PARALLEL_TRACE` names a folder, records the interval
 * it blocked for as one JSON file per render. A test sweeps those intervals to see how much of the pool ran at once.
 *
 * The render stage is synchronous, so the hold is a real block: `Atomics.wait` cannot run on the main thread, where a
 * single-worker build renders, so there the layout only records and returns.
 */
export default function doc({ page }: { readonly page: { readonly title: string; readonly url: string; readonly html: string } }): string {
  const trace = process.env.MIZZEN_PARALLEL_TRACE;
  if (trace !== undefined) {
    const start = process.hrtime.bigint();
    if (!isMainThread) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    const end = process.hrtime.bigint();
    mkdirSync(trace, { recursive: true });
    writeFileSync(
      join(trace, `${process.pid}-${threadId}-${counter++}.json`),
      JSON.stringify({ url: page.url, start: start.toString(), end: end.toString() }),
    );
  }
  return `<!DOCTYPE html>\n<html lang="en" dir="ltr"><head><title>${page.title}</title></head><body>\n${page.html}\n</body></html>\n`;
}
