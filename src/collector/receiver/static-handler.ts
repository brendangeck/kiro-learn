/**
 * Static-asset handler for the embedded UI bundle.
 *
 * Resolves URL paths under `/ui/` to files inside the Asset_Root,
 * enforces path-traversal safety, and serves files with correct
 * MIME types and cache headers. Uses only `node:` stdlib — no
 * third-party static-serving library.
 *
 * @see Requirements 6.1–6.5, 7.1–7.4, 8.1–8.2, 9.1–9.3, N4, N5
 */

import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, extname, join, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

// ── MIME table ──────────────────────────────────────────────────────────

/** Static mapping from file extension to Content-Type. */
export const MIME_TABLE: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ── Asset resolution ────────────────────────────────────────────────────

/** Result of resolving a URL path against the Asset_Root. */
export type AssetResolution =
  | { kind: 'serve'; absolutePath: string; mimeType: string; isHashed: boolean }
  | { kind: 'spa-fallback'; indexPath: string }
  | { kind: 'reject'; status: 400 | 403 | 404 };

/**
 * Detect whether a filename contains a Vite-style content hash.
 *
 * Vite produces filenames like `index-BxK4H1mN.js` or
 * `index-abc123.css` under `assets/`. We look for a hyphen followed
 * by 6+ hex-ish characters before the extension.
 */
function isHashedFilename(filePath: string): boolean {
  // Match patterns like "name-<hash>.ext" where hash is 6+ alphanumeric chars
  return /-[A-Za-z0-9]{6,}\.[^.]+$/.test(filePath);
}

/**
 * Resolve a URL path (the portion after `/ui`) to a filesystem path
 * inside assetRoot, or produce a rejection.
 *
 * Pure up to filesystem observation (existsSync / statSync). Never throws.
 *
 * @see Requirements 7.1–7.4, 8.1–8.2, 9.1–9.3
 */
export function resolveAsset(urlPath: string, assetRoot: string): AssetResolution {
  // Phase 1: null byte check (Req 7.4)
  if (urlPath.includes('\x00')) {
    return { kind: 'reject', status: 400 };
  }

  // Phase 2: decode + normalize (Req 7.3)
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { kind: 'reject', status: 400 };
  }

  // Phase 3: resolve to absolute path (Req 7.1)
  // Prepend '.' so '/../../etc/passwd' becomes './../../etc/passwd'
  // which path.resolve normalizes against assetRoot.
  const resolved = resolve(assetRoot, '.' + decoded);

  // Phase 4: prefix check (Req 7.2)
  if (resolved !== assetRoot && !resolved.startsWith(assetRoot + sep)) {
    return { kind: 'reject', status: 403 };
  }

  // Phase 5: file existence
  try {
    if (existsSync(resolved)) {
      const stat = statSync(resolved);
      if (stat.isFile()) {
        const ext = extname(resolved);
        const mime = MIME_TABLE[ext] ?? 'application/octet-stream';
        const isHashed = isHashedFilename(resolved);
        return { kind: 'serve', absolutePath: resolved, mimeType: mime, isHashed };
      }
    }
  } catch {
    // Filesystem errors (permission denied, etc.) — fall through to SPA/404
  }

  // Phase 6: SPA fallback vs 404 (Req 9)
  if (extname(decoded) !== '') {
    // Missing asset with extension → genuine 404
    return { kind: 'reject', status: 404 };
  }

  // Extensionless path → SPA fallback if index.html exists
  const indexPath = join(assetRoot, 'index.html');
  try {
    if (existsSync(indexPath)) {
      return { kind: 'spa-fallback', indexPath };
    }
  } catch {
    // Fall through to 404
  }

  return { kind: 'reject', status: 404 };
}

// ── Serving ─────────────────────────────────────────────────────────────

/** Error messages keyed by rejection status code. */
const REJECT_MESSAGES: Record<number, string> = {
  400: 'bad request',
  403: 'forbidden',
  404: 'not found',
};

/**
 * Serve a resolved asset to the response. Reads the file, sets headers
 * (Content-Type, Content-Length, Cache-Control), and ends the response.
 *
 * @see Requirements 6.1, 6.3, N4, N5
 */
export async function serveAsset(
  resolution: AssetResolution,
  res: ServerResponse,
): Promise<void> {
  if (resolution.kind === 'reject') {
    const message = REJECT_MESSAGES[resolution.status] ?? 'error';
    const payload = JSON.stringify({ error: message });
    res.writeHead(resolution.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  if (resolution.kind === 'spa-fallback') {
    const content = await readFile(resolution.indexPath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
    return;
  }

  // kind === 'serve'
  const content = await readFile(resolution.absolutePath);
  const cacheControl = resolution.isHashed
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  res.writeHead(200, {
    'Content-Type': resolution.mimeType,
    'Content-Length': content.length,
    'Cache-Control': cacheControl,
  });
  res.end(content);
}
