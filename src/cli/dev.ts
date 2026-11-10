/**
 * `mizzen dev`: build the site, serve the output with pretty URLs, watch the source and the theme, and reload the
 * browser over Server-Sent Events after every rebuild. The latest build's diagnostics are served as JSON and drawn
 * in an overlay, so a failed build is visible without leaving the browser.
 *
 * The reload and overlay client is added to HTML responses as they are served. Nothing on disk is changed: the output
 * folder stays exactly what `mizzen build` writes, so it can be published as it is.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "../config/load.ts";
import type { Diagnostic } from "../contracts/index.ts";
import { build } from "../pipeline/build.ts";
import { formatJson, formatText } from "../pipeline/diagnostics.ts";

/** Where the browser connects for reload events. Outside the site's base path, so it never collides with a page. */
export const EVENTS_PATH = "/__mizzen/events";

/** Where the browser reads the latest build's diagnostics, as `{ version, diagnostics }`. */
export const DIAGNOSTICS_PATH = "/__mizzen/diagnostics";

/** The attribute that marks the injected reload client, so a test or a person can tell a dev page from a built one. */
export const RELOAD_MARKER = "data-mizzen-dev";

/** The attribute that marks the injected diagnostics overlay, so a test knows the client renders one. */
export const OVERLAY_MARKER = "data-mizzen-overlay";

/** Folder under the site root that `mizzen dev` writes to when `--out` is not given. Hidden, so discovery skips it. */
export const DEFAULT_DEV_OUT = ".mizzen/dev";

/** Port the dev server binds when `--port` is not given. Port `0` asks the operating system for a free one. */
export const DEFAULT_DEV_PORT = 3000;

/** Host the dev server binds when `--host` is not given. Loopback only, so a dev build is not served to the network. */
export const DEFAULT_DEV_HOST = "127.0.0.1";

/** How long changes are collected before one rebuild, so an editor's burst of writes builds once. */
const WATCH_DELAY = 40;

/** Folders that never affect a build and would otherwise make the watcher rebuild in a loop. */
const IGNORED = new Set(["node_modules", ".git", ".tmp", ".mizzen"]);

/**
 * The inline client: one SSE connection per page, closed before the reload so it does not reconnect first, and an
 * overlay that fetches the latest diagnostics and redraws on every load. When the list is empty the overlay is hidden,
 * so a clean build replaces the previous failure with nothing.
 */
const RELOAD_CLIENT =
  `<script ${RELOAD_MARKER}>(()=>{` +
  `const source=new EventSource(${JSON.stringify(EVENTS_PATH)});` +
  `source.addEventListener("reload",()=>{source.close();location.reload();});` +
  `const overlay=document.createElement("div");` +
  `overlay.setAttribute(${JSON.stringify(OVERLAY_MARKER)},"");` +
  `overlay.hidden=true;` +
  `overlay.style.cssText="position:fixed;inset-block-end:0;inset-inline:0;z-index:2147483647;max-block-size:50vh;overflow:auto;margin:0;padding:12px 16px;background:Canvas;color:CanvasText;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;border-block-start:1px solid GrayText;";` +
  `(document.body||document.documentElement).appendChild(overlay);` +
  `const show=(items)=>{overlay.textContent="";` +
  `if(!items.length){overlay.hidden=true;return;}` +
  `const head=document.createElement("strong");` +
  `head.textContent="mizzen dev: "+items.length+" diagnostic"+(items.length===1?"":"s");` +
  `overlay.appendChild(head);` +
  `const list=document.createElement("ul");` +
  `list.style.cssText="margin:4px 0 0;padding-inline-start:20px;";` +
  `for(const d of items){` +
  `const item=document.createElement("li");` +
  `const where=d.pos?d.pos.file+":"+d.pos.line+":"+d.pos.column+" ":"";` +
  `item.textContent=where+d.severity+": "+d.message+(d.help?" - "+d.help:"");` +
  `list.appendChild(item);}` +
  `overlay.appendChild(list);overlay.hidden=false;};` +
  `const load=()=>fetch(${JSON.stringify(DIAGNOSTICS_PATH)},{cache:"no-store"})` +
  `.then((response)=>response.ok?response.json():{diagnostics:[]})` +
  `.then((report)=>show(report.diagnostics||[]))` +
  `.catch(()=>{});` +
  `load();})();</script>`;

/** What one dev rebuild wrote and how long it took. */
export interface DevBuild {
  /** Wall-clock milliseconds the build took, from call to the output folder being in place. */
  readonly milliseconds: number;
  /** Every file written, relative to the output folder, sorted by path. */
  readonly files: readonly string[];
  /** Findings of the build, sorted. The site is written even when there are errors. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Options of {@link dev}. */
export interface DevOptions {
  /** The site root: the folder that holds `mizzen.yml`. */
  readonly root: string;
  /** The folder the site is written to. Changed as a whole by every build. */
  readonly out: string;
  /** The theme's root folder, as `mizzen build` takes it. */
  readonly themeRoot: string;
  /** Port to bind; `0` binds an ephemeral one. Default: {@link DEFAULT_DEV_PORT}. */
  readonly port?: number;
  /** Host to bind. Default: {@link DEFAULT_DEV_HOST}. */
  readonly host?: string;
  /** Layout for a page that names none in its front matter or in `defaults`. */
  readonly defaultLayout?: string;
  /** Reuse an unchanged build from `.mizzen/cache`, as `mizzen build` does. Off by default. */
  readonly cache?: boolean;
  /** Receives one line per rebuild and any diagnostic text. Default: silent. */
  readonly log?: (message: string) => void;
}

/** A running dev server. */
export interface DevServer {
  /** The site root as a URL, with a trailing slash and the config's `base` when it has one. */
  readonly url: string;
  /** The bound host. */
  readonly host: string;
  /** The bound port, after port `0` was resolved. */
  readonly port: number;
  /** The output folder the server reads. */
  readonly out: string;
  /** Resolves once {@link close} has finished. */
  readonly closed: Promise<void>;
  /** Builds once, broadcasts a reload, and resolves with the timing; builds run one at a time, in call order. */
  rebuild(reason?: string): Promise<DevBuild>;
  /** Stops the watchers and the server, ends every reload connection, and waits for a build in flight. */
  close(): Promise<void>;
}

/** True when `child` is `parent` or sits inside it. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The `Content-Type` of a served file, from its extension. Unknown files are bytes, never guessed. */
function contentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".pdf":
      return "application/pdf";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

/** The page with the reload client just before `</body>`, or at the end when it has no body. */
export function withReloadClient(html: string): string {
  const at = html.toLowerCase().lastIndexOf("</body");
  if (at === -1) return `${html}${RELOAD_CLIENT}`;
  return `${html.slice(0, at)}${RELOAD_CLIENT}${html.slice(at)}`;
}

/**
 * Serves `root` on `host:port`, rebuilding whenever a source or theme file changes. The returned server keeps the
 * process alive until {@link DevServer.close}; callers own signals and lifetime.
 */
export async function dev(options: DevOptions): Promise<DevServer> {
  const root = resolve(options.root);
  const out = resolve(options.out);
  const themeRoot = resolve(options.themeRoot);
  const host = options.host ?? DEFAULT_DEV_HOST;
  const port = options.port ?? DEFAULT_DEV_PORT;
  const log = options.log ?? (() => {});
  const base = loadConfig(root).config.base;

  const clients = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  let latestDiagnostics: readonly Diagnostic[] = [];
  let timer: NodeJS.Timeout | undefined;
  let closing = false;
  let shuttingDown: Promise<void> | undefined;

  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  const broadcast = (): void => {
    const message = `event: reload\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`;
    for (const client of clients) {
      try {
        client.write(message);
      } catch {
        clients.delete(client);
      }
    }
  };

  const buildOnce = async (reason: string): Promise<DevBuild> => {
    const started = performance.now();
    try {
      const result = await build({
        root,
        out,
        themeRoot,
        ...(options.defaultLayout === undefined ? {} : { defaultLayout: options.defaultLayout }),
        ...(options.cache === true ? { cache: true } : {}),
      });
      const milliseconds = performance.now() - started;
      latestDiagnostics = result.diagnostics;
      if (result.diagnostics.length > 0) log(formatText(result.diagnostics).replace(/\n$/, ""));
      log(`mizzen dev: ${reason} in ${Math.round(milliseconds)} ms`);
      broadcast();
      return { milliseconds, files: result.files, diagnostics: result.diagnostics };
    } catch (err) {
      // A build that throws still has a finding; the overlay shows it instead of an empty page after the reload.
      latestDiagnostics = [
        {
          id: "dev.build-failed",
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      ];
      broadcast();
      throw err;
    }
  };

  // Builds run one at a time. A change that lands during a build waits for it instead of building twice at once.
  let tail = Promise.resolve();
  const rebuild = (reason = "rebuild"): Promise<DevBuild> => {
    if (closing) return Promise.reject(new Error("mizzen dev: the server is closed"));
    const run = tail.then(
      () => buildOnce(reason),
      () => buildOnce(reason),
    );
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const ignored = (dir: string, filename: string | Buffer | null): boolean => {
    if (filename === null) return false;
    const name = typeof filename === "string" ? filename : filename.toString();
    if (name === "") return false;
    const abs = resolve(dir, name);
    if (isInside(out, abs)) return true;
    return name
      .split(/[\\/]/)
      .some((part) => IGNORED.has(part) || part === ".DS_Store" || part.endsWith("~"));
  };

  const schedule = (reason: string): void => {
    if (closing) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void rebuild(reason).catch((err: unknown) => {
        log(`mizzen dev: rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, WATCH_DELAY);
    timer.unref();
  };

  const watchTree = (dir: string, label: string): void => {
    try {
      const watcher = watch(dir, { recursive: true }, (_event, filename) => {
        if (!ignored(dir, filename)) schedule(`change in ${label}`);
      });
      watcher.on("error", (err) => log(`mizzen dev: watcher error: ${err.message}`));
      watchers.push(watcher);
    } catch (err) {
      log(`mizzen dev: cannot watch ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const fileAt = async (path: string): Promise<string | undefined> => {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      // A missing file falls through to the next candidate.
    }
    return undefined;
  };

  /** Maps a URL path to a file: `a/` → `a/index.html`, `a` → `a`, `a/index.html`, or `a.html`. */
  const fileFor = async (pathname: string): Promise<string | undefined> => {
    let path = pathname;
    if (base !== "" && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || "/";
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0")) return undefined;
    const relativePath = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
    if (relativePath.split("/").some((segment) => segment === "..")) return undefined;
    const candidate = resolve(out, relativePath);
    if (!isInside(out, candidate)) return undefined;
    if (relativePath === "" || relativePath.endsWith("/")) return fileAt(join(candidate, "index.html"));
    return (await fileAt(candidate)) ?? (await fileAt(join(candidate, "index.html"))) ?? (await fileAt(`${candidate}.html`));
  };

  const send = async (req: IncomingMessage, res: ServerResponse, file: string, status: number): Promise<void> => {
    let body = await readFile(file);
    const type = contentType(file);
    if (type.startsWith("text/html")) body = Buffer.from(withReloadClient(body.toString("utf8")), "utf8");
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": body.byteLength,
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
  };

  const events = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 1000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    res.on("error", () => clients.delete(res));
  };

  const server: Server = createServer((req, res) => {
    const fail = (err: unknown): void => {
      const message = `mizzen dev: ${err instanceof Error ? err.message : String(err)}`;
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`${message}\n`);
    };
    const handle = async (): Promise<void> => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === EVENTS_PATH) {
        events(req, res);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      if (url.pathname === DIAGNOSTICS_PATH) {
        const body = formatJson(latestDiagnostics);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        if (req.method === "HEAD") res.end();
        else res.end(body);
        return;
      }
      const file = await fileFor(url.pathname);
      if (file !== undefined) {
        await send(req, res, file, 200);
        return;
      }
      const notFound = await fileAt(join(out, "404.html"));
      if (notFound !== undefined) await send(req, res, notFound, 404);
      else {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404\n");
      }
    };
    handle().catch(fail);
  });

  try {
    await buildOnce("initial build");
  } catch (err) {
    log(`mizzen dev: initial build failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => rejectListen(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  const shownHost = host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const url = `http://${shownHost}:${boundPort}${base}/`;

  watchTree(root, "the site");
  // A theme inside the site root is already covered by the recursive watcher above.
  if (!isInside(root, themeRoot)) watchTree(themeRoot, "the theme");

  const close = (): Promise<void> => {
    if (shuttingDown !== undefined) return shuttingDown;
    closing = true;
    shuttingDown = (async () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers) watcher.close();
      await tail.catch(() => undefined);
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // Already gone.
        }
      }
      clients.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      resolveClosed();
    })();
    return shuttingDown;
  };

  return {
    url,
    host,
    port: boundPort,
    out,
    closed,
    rebuild,
    close,
  };
}
