// Serve the packed client (dist/) from the workshop server in production, with
// the response headers that keep player modules where the sandbox put them: a
// Content-Security-Policy that allows only the page's own scripts and workers
// (the inline blocks by hash, three.js from the one CDN the import map names,
// WebAssembly inside workers) and the workshop for connect-src; nosniff; no
// referrer. Local development keeps using any static server; this is for the
// one process that serves both the page and the API.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

const sha256 = (s: string) => "'sha256-" + createHash("sha256").update(s).digest("base64") + "'";

/**
 * The directories the import map points at (the page loads three.js from one CDN path), as
 * CSP sources: a path that ends in "/" matches only below it, so `https://cdn.jsdelivr.net/npm/three@0.170.0/build/`
 * allows that package's build and nothing else the CDN serves.
 */
export function importMapSources(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let map: { imports?: Record<string, string> } = {};
    try { map = JSON.parse(m[1]); } catch { continue; }
    for (const v of Object.values(map.imports ?? {})) {
      try { const u = new URL(v); if (u.protocol !== "https:") continue; out.add(u.origin + u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1)); } catch {}
    }
  }
  return [...out];
}

/**
 * The policy for one packed page. Scripts: its own files, the inline blocks by hash (the
 * import map and the module script; the JSON and text blocks hash too, harmlessly), the
 * import map's CDN directories, and 'wasm-unsafe-eval' so the worker may instantiate a module. Workers
 * and fetches: the page's own origin, plus `connect` (the workshop, when it is elsewhere).
 * Styles: the inline block by hash; CSSOM writes need no allowance. Nothing else.
 */
export function cspFor(html: string, { connect = [] as string[] } = {}): string {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => sha256(m[1]));
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => sha256(m[1]));
  const cdn = importMapSources(html);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${[...cdn, ...scripts].join(" ")}`.trim(),
    "worker-src 'self'",
    `connect-src 'self' ${connect.join(" ")}`.trim(),
    `style-src 'self' ${styles.join(" ")}`.trim(),
    "img-src 'self' data: blob:",
    "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ].join("; ");
}

export type StaticOptions = { connect?: string[] };

/**
 * A handler for GET and HEAD under `dir` (index.html for a directory). Returns false when the
 * request is not for a file here (the caller answers). Paths are resolved inside `dir` only:
 * dot segments, encoded or not, never reach the file system. Headers are the same on every
 * file, so a worker script carries the policy too.
 */
export function staticHandler(dir: string, { connect = [] }: StaticOptions = {}) {
  const root = path.resolve(dir);
  const indexFile = path.join(root, "index.html");
  if (!existsSync(indexFile)) throw new Error(`no index.html under ${root}: run node pack.mjs first`);
  const csp = cspFor(readFileSync(indexFile, "utf8"), { connect });
  // HSTS is honoured by browsers only over TLS, so it is harmless on a local http server and useful behind force_https
  const common = { "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "strict-transport-security": "max-age=31536000" };
  return function serve(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname); } catch { return false; }
    if (pathname.includes("\0") || pathname.split("/").some(seg => seg === "..")) return false;
    let file = path.resolve(root, "." + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) return false;
    try { if (statSync(file).isDirectory()) file = path.join(file, "index.html"); } catch { return false; }
    if (!existsSync(file)) return false;
    const ext = path.extname(file).toLowerCase();
    const body = readFileSync(file);
    res.writeHead(200, { ...common, "content-type": MIME[ext] ?? "application/octet-stream", "content-length": body.length,
      "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600" });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  };
}

