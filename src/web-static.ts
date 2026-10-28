import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(fileURLToPath(new URL("../web/", import.meta.url)));

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** Map a URL path onto a file inside web/, or null when it escapes that directory. */
export function resolveWebFile(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (relative === "" || relative.includes("\0")) return null;
  const extension = extname(relative).toLowerCase();
  if (CONTENT_TYPES[extension] === undefined) return null;
  const full = resolve(WEB_ROOT, relative);
  const rootReal = realpathSync(WEB_ROOT);
  if (!existsSync(full)) return null;
  const fullReal = realpathSync(full);
  if (fullReal !== rootReal && !fullReal.startsWith(rootReal + sep)) return null;
  if (!statSync(fullReal).isFile()) return null;
  return fullReal;
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}
