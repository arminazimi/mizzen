/**
 * Parallel page rendering: a pool of worker threads renders pages through the theme, so a large site spends its
 * render stage on several cores (#1563).
 *
 * The pool and its workers share one implementation of layout resolution ({@link renderOnePage}), so a page rendered
 * in a worker is byte for byte the page rendered in this process. A worker receives the site model and the theme root
 * once; it loads the theme's registry itself. A page a worker fails to render, or a worker that dies, falls back to
 * this process for that page with a diagnostic, and the build carries on.
 *
 * The pool holds a bounded window of pages: no more than {@link RenderPoolOptions.concurrency} are ever dispatched
 * and unanswered, so a prefetch of every page queues a window rather than every page at once. Closing the pool
 * cancels what is queued and in flight and settles every waiting `render`, so nothing is left running or waiting.
 *
 * A worker also owes the pool an answer within a deadline ({@link RenderPoolOptions.renderDeadlineMs}): one to finish
 * initializing and, for every batch, one to reply. A theme that parks a thread — a layout in a synchronous loop —
 * never replies, so the deadline is what keeps a hung theme from stalling a build forever. When it passes, the pool
 * retires that one worker and renders its pages here through the same fallback a failing worker uses; the other
 * workers and the queue carry on, and a reply that arrives after the deadline is ignored, since those pages are
 * already settled.
 *
 * `parallel.ts` is both the pool and the worker entry point: Node starts the same file in a thread and the
 * {@link isMainThread} guard at the bottom turns it into a worker. That keeps the unit one file, as the engine's
 * folder-per-unit rule asks.
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import type { Page, Site } from "../contracts/content.ts";
import type { Diagnostic } from "../contracts/diagnostic.ts";
import type { Pager, Trail } from "../contracts/nav.ts";
import type { Head } from "../contracts/render.ts";
import { OWN_EXTENSION } from "../runtime/modules.ts";
import { navState } from "../nav/tree.ts";
import { hreflangLinks } from "../outputs/hreflang.ts";
import { opensearchLink } from "../outputs/opensearch.ts";
import { loadRegistry, type ThemeRegistry } from "../render/registry.ts";
import { renderPage, type ThemeComponent } from "../render/render.ts";
import { islandUrl } from "../render/islands.ts";
import type { Island } from "../contracts/render.ts";

/** One page after rendering: its HTML document and what rendering found. */
export interface RenderedPage {
  /** The page's URL, which tells the pool which result is which. */
  readonly url: string;
  /** The complete HTML document, starting with `<!DOCTYPE html>`. */
  readonly html: string;
  /** Theme-relative CSS files the page needs besides the shared ones: its layout's and its components'. */
  readonly css: readonly string[];
  /** Islands the page loads: the chrome parts' and those of the components it used. Absent when the page could not be laid out. */
  readonly islands?: readonly Island[];
  /** Findings from rendering the page; an empty list when it rendered cleanly. */
  readonly diagnostics: readonly Diagnostic[];
}

/** A pool that renders pages in worker threads. */
export interface RenderPool {
  /**
   * Starts rendering `pages` now, in this order, without waiting for anyone to ask for the result. Only a bounded
   * window of them is in flight; the rest wait their turn. Pages already queued or done are skipped. A result nobody
   * asks for is dropped at {@link RenderPool.close}.
   */
  prefetch(pages: readonly Page[]): void;
  /** Renders one page, in a worker when one is free and in this process when its worker failed. */
  render(page: Page): Promise<RenderedPage>;
  /**
   * Cancels every page queued or in flight, settles their `render` promises with an error, clears every deadline, and
   * stops the workers. Safe to call more than once, and no work starts after it.
   */
  close(): Promise<void>;
}

/**
 * How long a worker may take to initialize, or to answer a batch, before the pool gives up on it and renders its pages
 * here (#108). It bounds a theme that never returns, not an honest one: no real render stage takes a minute for a
 * batch of a few pages, so a build that is only slow never sees this default.
 */
export const DEFAULT_RENDER_DEADLINE_MS = 60_000;

/** Options of {@link createRenderPool}. */
export interface RenderPoolOptions {
  /** The theme's root folder, as the worker loads it: `src/index.ts` and the unit folders beside it. */
  readonly themeRoot: string;
  /** The site model, copied to every worker once. */
  readonly site: Site;
  /** The registry this process loaded; the pool renders with it when a worker cannot render a page. */
  readonly registry: ThemeRegistry;
  /** Layout used when a page names none in its front matter or in `defaults`. */
  readonly defaultLayout?: string;
  /** How many worker threads to start; at least 2, since one thread is the case that needs no pool. */
  readonly workers: number;
  /**
   * The most pages dispatched to workers and not yet answered; more wait in the queue. Default: four per worker,
   * which keeps each thread fed without holding a whole site in flight.
   */
  readonly concurrency?: number;
  /**
   * The render deadline, in milliseconds: how long one worker may take to initialize and how long one batch may take
   * to answer. A worker that passes it is terminated on its own and its pages are rendered in this process with a
   * `render.worker-failed` warning; the other workers and the queue carry on. A whole number of at least 1. Default:
   * {@link DEFAULT_RENDER_DEADLINE_MS}; tests and callers with a tighter budget pass their own.
   */
  readonly renderDeadlineMs?: number;
}

/** Compares by code point, never by locale. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The theme's components by name, as the render host takes them, each with the island its `client.ts` makes. */
function componentsOf(registry: ThemeRegistry, base: string): Record<string, ThemeComponent> {
  const out: Record<string, ThemeComponent> = {};
  for (const [name, unit] of Object.entries(registry.components)) {
    out[name] = {
      component: unit.component,
      ...(unit.css === undefined ? {} : { css: unit.css }),
      ...(unit.client === undefined ? {} : { island: { name, src: islandUrl(base, unit.client) } }),
    };
  }
  return out;
}

/**
 * The islands of the chrome parts, in name order. A page loads all of them: the engine cannot tell which parts a
 * layout drew, and an island does nothing on a page without its markup.
 */
export function chromeIslandsOf(registry: ThemeRegistry, base: string): Island[] {
  return Object.keys(registry.chrome)
    .sort(byCodePoint)
    .flatMap((name) => {
      const client = registry.chrome[name]!.client;
      return client === undefined ? [] : [{ name, src: islandUrl(base, client) }];
    });
}

/** The navigation list the page sits in, with its breadcrumb and pager. Lists are tried in name order. */
function placeOf(site: Site, page: Page): { trail: Trail; pager: Pager } {
  for (const name of Object.keys(site.nav).sort(byCodePoint)) {
    const state = navState(site.nav[name] ?? [], page.url);
    if (state.current !== undefined || state.active !== undefined) return { trail: state.trail, pager: state.pager };
  }
  return { trail: [], pager: {} };
}

/** The head of a page: its title, description, `hreflang` alternates, and the OpenSearch link when the site has a URL. */
function headOf(site: Site, page: Page): Head {
  const description = page.frontMatter.description;
  const search = opensearchLink(site);
  return {
    title: page.title,
    meta: typeof description === "string" ? [{ name: "description", content: description }] : [],
    links: [...hreflangLinks(site, page), ...(search === undefined ? [] : [search])],
    jsonLd: [],
  };
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** What a page that cannot be laid out is written as: its own body, so the file exists and the build reports the error. */
function fallbackHtml(page: Page): string {
  return `<!DOCTYPE html>\n<html lang="${escapeText(page.lang)}" dir="${escapeText(page.dir)}">\n<head><meta charset="utf-8"><title>${escapeText(page.title)}</title></head>\n<body>\n${page.html}\n</body>\n</html>\n`;
}

/**
 * Renders one page with the layout its front matter names, else `defaultLayout`, through the theme's registry.
 *
 * This is the one layout resolution of the render stage: the in-process pipeline and the workers both call it, so
 * their HTML, diagnostics, and fallbacks are the same. A page with no layout, or an unknown one, is an error and is
 * written as its own body instead.
 */
export function renderOnePage(
  registry: ThemeRegistry,
  site: Site,
  page: Page,
  defaultLayout: string | undefined,
): RenderedPage {
  const name = page.frontMatter.layout ?? defaultLayout;
  if (name === undefined) {
    return {
      url: page.url,
      html: fallbackHtml(page),
      css: [],
      diagnostics: [
        {
          id: "render.no-layout",
          severity: "error",
          message: `Page ${page.url} has no layout.`,
          pos: page.source,
          help: "Set `layout` in its front matter or in `defaults`.",
        },
      ],
    };
  }
  if (!Object.hasOwn(registry.layouts, name)) {
    return {
      url: page.url,
      html: fallbackHtml(page),
      css: [],
      diagnostics: [
        {
          id: "render.unknown-layout",
          severity: "error",
          message: `Page ${page.url} names the layout "${name}", which the theme does not have.`,
          pos: page.source,
          help: "Use a layout from the theme's layouts/ folder.",
        },
      ],
    };
  }
  const { trail, pager } = placeOf(site, page);
  const registered = registry.layouts[name]!;
  const result = renderPage({
    site,
    page,
    layout: registered.layout,
    components: componentsOf(registry, site.config.base),
    chromeIslands: chromeIslandsOf(registry, site.config.base),
    trail,
    pager,
    head: headOf(site, page),
  });
  const css = registered.css === undefined ? result.css : [registered.css, ...result.css];
  return { url: page.url, html: result.html, css, islands: result.islands, diagnostics: result.diagnostics };
}

/** The message of a thrown value, for a diagnostic. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a `render` waiting on a pool that closed or cancelled its work is rejected with. */
function closedError(page: Page): Error {
  return new Error(`render: the pool closed before ${page.url} was rendered.`);
}

/** Messages this module posts in a worker's thread. */
type InitMessage = {
  readonly type: "init";
  readonly themeRoot: string;
  readonly site: Site;
  readonly defaultLayout: string | undefined;
};

type RenderMessage = {
  readonly type: "render";
  readonly id: number;
  readonly pages: readonly Page[];
};

type Request = InitMessage | RenderMessage;

/** Messages a worker posts back. */
type Reply =
  | { readonly type: "ready" }
  | { readonly type: "init-failed"; readonly message: string }
  | { readonly type: "done"; readonly id: number; readonly pages: readonly RenderedPage[] }
  | { readonly type: "failed"; readonly id: number; readonly message: string };

/** What a worker keeps between messages. */
interface WorkerState {
  readonly registry: ThemeRegistry;
  readonly site: Site;
  readonly defaultLayout: string | undefined;
}

/** Runs in a worker thread: loads the theme once, then renders the batches it is sent, in order. */
function startWorker(): void {
  const port = parentPort;
  if (port === null) return;
  let state: WorkerState | undefined;
  port.on("message", (message: Request) => {
    if (message.type === "init") {
      void loadRegistry(message.themeRoot).then(
        (registry) => {
          state = { registry, site: message.site, defaultLayout: message.defaultLayout };
          port.postMessage({ type: "ready" } satisfies Reply);
        },
        (error: unknown) => port.postMessage({ type: "init-failed", message: messageOf(error) } satisfies Reply),
      );
      return;
    }
    const current = state;
    if (current === undefined) {
      port.postMessage({ type: "failed", id: message.id, message: "the worker is not initialized" } satisfies Reply);
      return;
    }
    // A page that throws fails its whole batch; the main thread renders those pages itself, with the diagnostic.
    try {
      const pages = message.pages.map((page) =>
        renderOnePage(current.registry, current.site, page, current.defaultLayout),
      );
      port.postMessage({ type: "done", id: message.id, pages } satisfies Reply);
    } catch (error) {
      port.postMessage({ type: "failed", id: message.id, message: messageOf(error) } satisfies Reply);
    }
  });
}

/** One page the pool owes somebody: queued, in a batch, or done. */
interface Entry {
  readonly page: Page;
  settled: boolean;
  result: RenderedPage | undefined;
  error: unknown;
  waiters: {
    readonly resolve: (page: RenderedPage) => void;
    readonly reject: (error: unknown) => void;
  }[];
}

/** One worker thread and the batch it is rendering, if any. */
interface Slot {
  readonly worker: Worker;
  ready: boolean;
  dead: boolean;
  current: readonly Entry[] | undefined;
  batchID: number;
  /**
   * The countdown for whatever this worker owes the pool right now: its `ready` reply, or the reply to its batch.
   * Undefined while it owes nothing, and always cleared before it fires when the answer does come.
   */
  deadline: ReturnType<typeof setTimeout> | undefined;
}

/** What every worker is told once, before its first batch. */
interface PoolState {
  readonly themeRoot: string;
  readonly site: Site;
  readonly registry: ThemeRegistry;
  readonly defaultLayout: string | undefined;
  /** The most pages that may be dispatched and unanswered at once. */
  readonly concurrency: number;
  /** How long one worker may take to initialize and how long one batch may take to answer. */
  readonly deadlineMs: number;
}

/**
 * The thread pool. Pages are rendered in batches: the queued pages are split over the idle workers, so a build that
 * prefetches every page sends each worker a batch rather than one message per page, without ever holding more pages
 * in flight than the configured concurrency.
 */
class WorkerPool implements RenderPool {
  readonly #state: PoolState;
  readonly #slots: Slot[] = [];
  readonly #queue: Entry[] = [];
  readonly #entries = new Map<string, Entry>();
  #lastID = 0;
  #closed = false;
  /** Why the last worker was retired, so a page that arrives afterwards is still told what happened. */
  #lastFailure: string | undefined;

  constructor(state: PoolState, workers: number) {
    this.#state = state;
    for (let index = 0; index < workers; index++) {
      // An empty execArgv keeps the test runner's flags out of the worker; type stripping is on by default on Node 24+.
      const worker = new Worker(new URL(`./parallel${OWN_EXTENSION}`, import.meta.url), { execArgv: [], name: "mizzen-render" });
      const slot: Slot = { worker, ready: false, dead: false, current: undefined, batchID: 0, deadline: undefined };
      worker.on("message", (reply: Reply) => this.#onReply(slot, reply));
      worker.on("error", (error: unknown) => this.#fail(slot, messageOf(error)));
      worker.on("exit", (code: number) => {
        if (!this.#closed && !slot.dead) this.#fail(slot, `the worker exited with code ${code}`);
      });
      worker.postMessage({
        type: "init",
        themeRoot: state.themeRoot,
        site: state.site,
        defaultLayout: state.defaultLayout,
      } satisfies InitMessage);
      // A theme that never finishes loading would otherwise leave this worker pending forever (#108).
      this.#arm(slot, `the worker thread did not initialize within ${String(state.deadlineMs)} ms`);
      this.#slots.push(slot);
    }
  }

  prefetch(pages: readonly Page[]): void {
    if (this.#closed) return;
    for (const page of pages) this.#enqueue(page);
    this.#dispatch();
  }

  render(page: Page): Promise<RenderedPage> {
    if (this.#closed) return Promise.reject(closedError(page));
    const entry = this.#enqueue(page);
    this.#dispatch();
    if (entry.settled) {
      return entry.error === undefined && entry.result !== undefined
        ? Promise.resolve(entry.result)
        : Promise.reject(entry.error);
    }
    return new Promise<RenderedPage>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) this.#reject(entry, closedError(entry.page));
    for (const slot of this.#slots) {
      // No deadline outlives the pool: its worker is about to be terminated either way.
      this.#clearDeadline(slot);
      const batch = slot.current;
      slot.current = undefined;
      for (const entry of batch ?? []) this.#reject(entry, closedError(entry.page));
    }
    this.#entries.clear();
    await Promise.all(
      this.#slots.map(async (slot) => {
        slot.dead = true;
        await slot.worker.terminate().catch(() => undefined);
      }),
    );
  }

  /**
   * Starts the countdown for what `slot` owes the pool, replacing any countdown already running for it. When it
   * expires, the worker is retired through {@link WorkerPool.#fail} and its pages take the main-thread fallback.
   */
  #arm(slot: Slot, reason: string): void {
    this.#clearDeadline(slot);
    if (this.#closed || slot.dead) return;
    slot.deadline = setTimeout(() => {
      slot.deadline = undefined;
      this.#fail(slot, reason);
    }, this.#state.deadlineMs);
  }

  /** Stops a worker's countdown; called the moment the answer it waited for arrives, and on the way out. */
  #clearDeadline(slot: Slot): void {
    const timer = slot.deadline;
    if (timer !== undefined) {
      slot.deadline = undefined;
      clearTimeout(timer);
    }
  }

  /** Why there is no worker to take a batch, naming the failure that emptied the pool when there was one. */
  #noWorkers(): string {
    const last = this.#lastFailure;
    return last === undefined ? "no worker thread is left" : `no worker thread is left (${last})`;
  }

  /** The entry for `page`, adding it to the queue when the pool has not seen it. */
  #enqueue(page: Page): Entry {
    const known = this.#entries.get(page.url);
    if (known !== undefined) return known;
    const entry: Entry = { page, settled: false, result: undefined, error: undefined, waiters: [] };
    this.#entries.set(page.url, entry);
    this.#queue.push(entry);
    return entry;
  }

  /** Sends queued pages to every idle worker, split evenly, within the concurrency window. */
  #dispatch(): void {
    if (this.#closed) return;
    if (this.#slots.every((slot) => slot.dead)) {
      const queued = this.#queue.splice(0);
      this.#fallback(queued, this.#noWorkers());
      return;
    }
    const live = this.#slots.filter((slot) => !slot.dead);
    // Wait for the whole pool before the first batch: a worker that is ready first would otherwise take every page.
    if (live.some((slot) => !slot.ready)) return;
    const free = live.filter((slot) => slot.current === undefined);
    if (free.length === 0 || this.#queue.length === 0) return;
    const capacity = Math.min(this.#state.concurrency - this.#inFlight(), this.#queue.length);
    if (capacity <= 0) return;
    const size = Math.max(1, Math.ceil(capacity / free.length));
    let left = capacity;
    for (const slot of free) {
      if (left <= 0) break;
      const batch = this.#queue.splice(0, Math.min(size, left));
      left -= batch.length;
      slot.current = batch;
      slot.batchID = ++this.#lastID;
      slot.worker.postMessage({ type: "render", id: slot.batchID, pages: batch.map((entry) => entry.page) } satisfies RenderMessage);
      // A layout that never returns posts no reply, so the batch is what the deadline watches (#108).
      this.#arm(slot, `the worker thread did not answer its batch within ${String(this.#state.deadlineMs)} ms`);
    }
  }

  /** Pages dispatched to workers and not answered yet; the window that backpressure keeps bounded. */
  #inFlight(): number {
    let count = 0;
    for (const slot of this.#slots) count += slot.current?.length ?? 0;
    return count;
  }

  #onReply(slot: Slot, reply: Reply): void {
    // A reply from a worker the deadline already retired is stale: its pages are settled, and nothing here reopens them.
    if (this.#closed || slot.dead) return;
    if (reply.type === "ready") {
      this.#clearDeadline(slot);
      slot.ready = true;
      this.#dispatch();
      return;
    }
    if (reply.type === "init-failed") {
      this.#fail(slot, `the theme could not be loaded (${reply.message})`);
      return;
    }
    const batch = slot.current;
    if (batch === undefined || slot.batchID !== reply.id) return;
    this.#clearDeadline(slot);
    slot.current = undefined;
    if (reply.type === "failed") {
      this.#fallback(batch, reply.message);
    } else {
      const byURL = new Map(reply.pages.map((page) => [page.url, page]));
      for (const entry of batch) {
        const rendered = byURL.get(entry.page.url);
        if (rendered === undefined) this.#reject(entry, new Error(`render: the worker returned no HTML for ${entry.page.url}.`));
        else this.#resolve(entry, rendered);
      }
    }
    this.#dispatch();
  }

  /** Renders `pages` in this process, recording why, for a batch whose worker failed. */
  #fallback(entries: readonly Entry[], reason: string): void {
    for (const entry of entries) {
      try {
        this.#resolve(entry, this.#inProcess(entry.page, reason));
      } catch (error) {
        this.#reject(entry, error);
      }
    }
  }

  /** Renders one page with this process's registry, with a diagnostic that names `reason` when a worker failed. */
  #inProcess(page: Page, reason: string | undefined): RenderedPage {
    const rendered = renderOnePage(this.#state.registry, this.#state.site, page, this.#state.defaultLayout);
    if (reason === undefined) return rendered;
    const diagnostic: Diagnostic = {
      id: "render.worker-failed",
      severity: "warning",
      message: `Page ${page.url} could not be rendered in a worker thread (${reason}); it was rendered in the main thread.`,
      pos: page.source,
    };
    return { url: rendered.url, html: rendered.html, css: rendered.css, ...(rendered.islands === undefined ? {} : { islands: rendered.islands }), diagnostics: [diagnostic, ...rendered.diagnostics] };
  }

  #resolve(entry: Entry, result: RenderedPage): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.result = result;
    for (const waiter of entry.waiters) waiter.resolve(result);
    entry.waiters = [];
  }

  #reject(entry: Entry, error: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.error = error;
    for (const waiter of entry.waiters) waiter.reject(error);
    entry.waiters = [];
  }

  /** Retires a worker and renders its batch, and every later page when it was the last one, in this process. */
  #fail(slot: Slot, reason: string): void {
    if (slot.dead) return;
    this.#clearDeadline(slot);
    slot.dead = true;
    slot.ready = false;
    this.#lastFailure = reason;
    const batch = slot.current;
    slot.current = undefined;
    void slot.worker.terminate().catch(() => undefined);
    if (batch !== undefined) this.#fallback(batch, reason);
    if (this.#slots.every((each) => each.dead)) {
      const queued = this.#queue.splice(0);
      this.#fallback(queued, this.#noWorkers());
      return;
    }
    this.#dispatch();
  }
}

/**
 * Starts a pool of `options.workers` worker threads. Every worker loads the theme from `options.themeRoot` and renders
 * the pages it is sent; results are keyed by page URL, so a page rendered for one output is reused by another. A worker
 * that does not initialize, or does not answer a batch, within `options.renderDeadlineMs` is retired and its pages are
 * rendered in this process, so a hung theme cannot hold a build open.
 */
export function createRenderPool(options: RenderPoolOptions): RenderPool {
  if (!Number.isInteger(options.workers) || options.workers < 2) {
    throw new TypeError(`createRenderPool: workers must be a whole number of at least 2, not ${String(options.workers)}.`);
  }
  const concurrency = options.concurrency ?? options.workers * 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`createRenderPool: concurrency must be a whole number of at least 1, not ${String(options.concurrency)}.`);
  }
  const deadlineMs = options.renderDeadlineMs ?? DEFAULT_RENDER_DEADLINE_MS;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1) {
    throw new TypeError(`createRenderPool: renderDeadlineMs must be a whole number of at least 1 millisecond, not ${String(options.renderDeadlineMs)}.`);
  }
  const state: PoolState = {
    themeRoot: options.themeRoot,
    site: options.site,
    registry: options.registry,
    defaultLayout: options.defaultLayout,
    concurrency,
    deadlineMs,
  };
  return new WorkerPool(state, options.workers);
}

// Node runs this file as the entry point of each worker thread; the main thread only uses the exports above.
if (!isMainThread) startWorker();
