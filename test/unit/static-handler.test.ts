/**
 * Example-based unit tests for the static-asset handler.
 *
 * Tests all branches of `resolveAsset` against a temporary fixture
 * directory, plus `serveAsset` Cache-Control header behaviour.
 *
 * @see .kiro/specs/visualizer-scaffold/design.md § Component 1
 * @see .kiro/specs/visualizer-scaffold/requirements.md § Requirements 6–9, N5
 *
 * **Validates: Requirements 6.1, 6.3, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 9.1, 9.2, N5**
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  resolveAsset,
  serveAsset,
  MIME_TABLE,
} from '../../src/collector/receiver/static-handler.js';
import type { AssetResolution } from '../../src/collector/receiver/static-handler.js';

// ── Fixture setup ───────────────────────────────────────────────────────

let assetRoot: string;

beforeAll(() => {
  assetRoot = mkdtempSync(join(tmpdir(), 'static-handler-test-'));

  // index.html — SPA entry
  writeFileSync(join(assetRoot, 'index.html'), '<html><body>hello</body></html>');

  // A plain JS file (non-hashed)
  writeFileSync(join(assetRoot, 'app.js'), 'console.log("app")');

  // A CSS file
  writeFileSync(join(assetRoot, 'style.css'), 'body { margin: 0; }');

  // assets/ directory with a hashed JS file
  mkdirSync(join(assetRoot, 'assets'), { recursive: true });
  writeFileSync(
    join(assetRoot, 'assets', 'index-BxK4H1mN.js'),
    'console.log("hashed")',
  );

  // A non-hashed file in assets/
  writeFileSync(join(assetRoot, 'assets', 'logo.png'), Buffer.from([0x89, 0x50]));

  // Create fixture files for every MIME_TABLE extension
  for (const ext of Object.keys(MIME_TABLE)) {
    const filename = `testfile${ext}`;
    const filePath = join(assetRoot, filename);
    // Only create if not already created above
    try {
      writeFileSync(filePath, `content for ${ext}`, { flag: 'wx' });
    } catch (err: unknown) {
      // Only ignore EEXIST — rethrow unexpected errors
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
        throw err;
      }
    }
  }

  // A file with an unknown extension
  writeFileSync(join(assetRoot, 'data.xyz'), 'unknown');
});

afterAll(() => {
  rmSync(assetRoot, { recursive: true, force: true });
});

// ── Mock ServerResponse ─────────────────────────────────────────────────

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | number>;
  body: Buffer;
}

/**
 * Minimal mock of `node:http.ServerResponse` that captures writeHead,
 * setHeader, and end calls for assertion.
 */
function createMockResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
  };

  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    writeHead(statusCode: number, headers?: Record<string, string | number>) {
      captured.statusCode = statusCode;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          captured.headers[k.toLowerCase()] = v;
        }
      }
      return res;
    },
    setHeader(name: string, value: string | number) {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        captured.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
      return res;
    },
  }) as unknown as ServerResponse;

  return { res, captured };
}

// ── resolveAsset tests ──────────────────────────────────────────────────

describe('resolveAsset', () => {
  it('serves an existing .html file with correct MIME type', () => {
    const result = resolveAsset('/index.html', assetRoot);
    expect(result).toMatchObject({
      kind: 'serve',
      mimeType: 'text/html; charset=utf-8',
    });
  });

  it('serves an existing .js file with correct MIME type', () => {
    const result = resolveAsset('/app.js', assetRoot);
    expect(result).toMatchObject({
      kind: 'serve',
      mimeType: 'application/javascript',
    });
  });

  it('returns 404 for a missing file with extension', () => {
    const result = resolveAsset('/missing.js', assetRoot);
    expect(result).toEqual({ kind: 'reject', status: 404 });
  });

  it('returns SPA fallback for an extensionless path', () => {
    const result = resolveAsset('/dashboard', assetRoot);
    expect(result).toMatchObject({ kind: 'spa-fallback' });
  });

  it('returns 403 for path traversal attempt', () => {
    const result = resolveAsset('/../../../etc/passwd', assetRoot);
    expect(result).toEqual({ kind: 'reject', status: 403 });
  });

  it('returns 400 for null byte in path', () => {
    const result = resolveAsset('/index\x00.html', assetRoot);
    expect(result).toEqual({ kind: 'reject', status: 400 });
  });

  it('returns 400 for encoded null byte (%00) in path', () => {
    const result = resolveAsset('/index%00.html', assetRoot);
    expect(result).toEqual({ kind: 'reject', status: 400 });
  });

  it('returns 400 for malformed percent-encoding', () => {
    const result = resolveAsset('/file%zz.html', assetRoot);
    expect(result).toEqual({ kind: 'reject', status: 400 });
  });

  it('returns 403 for encoded traversal (%2e%2e)', () => {
    const result = resolveAsset('/%2e%2e/%2e%2e/etc/passwd', assetRoot);
    expect(result).toEqual({ kind: 'reject', status: 403 });
  });

  it('serves root path (/) as index.html via SPA fallback', () => {
    // '/' is extensionless and no file named '' exists → SPA fallback
    const result = resolveAsset('/', assetRoot);
    // '/' resolves to assetRoot itself which is a directory, not a file,
    // and '/' is extensionless → SPA fallback
    expect(result).toMatchObject({ kind: 'spa-fallback' });
  });
});

// ── MIME_TABLE coverage ─────────────────────────────────────────────────

describe('MIME_TABLE entries', () => {
  for (const [ext, expectedMime] of Object.entries(MIME_TABLE)) {
    it(`serves ${ext} with Content-Type ${expectedMime}`, () => {
      const result = resolveAsset(`/testfile${ext}`, assetRoot);
      expect(result.kind).toBe('serve');
      if (result.kind === 'serve') {
        expect(result.mimeType).toBe(expectedMime);
      }
    });
  }
});

describe('unknown extension', () => {
  it('serves unknown extension with application/octet-stream', () => {
    const result = resolveAsset('/data.xyz', assetRoot);
    expect(result.kind).toBe('serve');
    if (result.kind === 'serve') {
      expect(result.mimeType).toBe('application/octet-stream');
    }
  });
});

// ── serveAsset Cache-Control tests ──────────────────────────────────────

describe('serveAsset', () => {
  describe('Cache-Control headers', () => {
    it('sets immutable cache for hashed filename', async () => {
      const resolution = resolveAsset('/assets/index-BxK4H1mN.js', assetRoot);
      expect(resolution.kind).toBe('serve');
      if (resolution.kind !== 'serve') return;
      expect(resolution.isHashed).toBe(true);

      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(captured.headers['content-type']).toBe('application/javascript');
    });

    it('sets no-cache for non-hashed filename', async () => {
      const resolution = resolveAsset('/app.js', assetRoot);
      expect(resolution.kind).toBe('serve');
      if (resolution.kind !== 'serve') return;
      expect(resolution.isHashed).toBe(false);

      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.headers['cache-control']).toBe('no-cache');
    });

    it('sets no-cache for SPA fallback', async () => {
      const resolution = resolveAsset('/some-route', assetRoot);
      expect(resolution.kind).toBe('spa-fallback');

      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.statusCode).toBe(200);
      expect(captured.headers['cache-control']).toBe('no-cache');
      expect(captured.headers['content-type']).toBe('text/html; charset=utf-8');
    });
  });

  describe('rejection responses', () => {
    it('writes JSON error for 400 rejection', async () => {
      const resolution: AssetResolution = { kind: 'reject', status: 400 };
      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.statusCode).toBe(400);
      expect(captured.headers['content-type']).toBe('application/json');
      expect(JSON.parse(captured.body.toString())).toEqual({ error: 'bad request' });
    });

    it('writes JSON error for 403 rejection', async () => {
      const resolution: AssetResolution = { kind: 'reject', status: 403 };
      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.statusCode).toBe(403);
      expect(JSON.parse(captured.body.toString())).toEqual({ error: 'forbidden' });
    });

    it('writes JSON error for 404 rejection', async () => {
      const resolution: AssetResolution = { kind: 'reject', status: 404 };
      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.statusCode).toBe(404);
      expect(JSON.parse(captured.body.toString())).toEqual({ error: 'not found' });
    });
  });

  describe('serve response', () => {
    it('sets Content-Length for served files', async () => {
      const resolution = resolveAsset('/app.js', assetRoot);
      expect(resolution.kind).toBe('serve');

      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.headers['content-length']).toBeDefined();
      expect(Number(captured.headers['content-length'])).toBeGreaterThan(0);
    });

    it('returns file content in body', async () => {
      const resolution = resolveAsset('/app.js', assetRoot);
      expect(resolution.kind).toBe('serve');

      const { res, captured } = createMockResponse();
      await serveAsset(resolution, res);

      expect(captured.body.toString()).toBe('console.log("app")');
    });
  });
});
