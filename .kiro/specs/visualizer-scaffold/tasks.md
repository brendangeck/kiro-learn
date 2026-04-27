# Implementation Plan: Visualizer Scaffold

Tasks are organised in dependency order. Dependencies and devDependencies land first so the toolchain is available. The UI source directory comes next — it needs the deps to type-check. The daemon's static handler follows because it's backend-only and testable without the UI. The installer update is a one-line change that depends on nothing else. Build script integration wires everything together. Tests come last, after the code they exercise exists. A final verification pass confirms the full chain works end-to-end.

Every task cites the requirement sub-clauses it implements. Test tasks cite the correctness property or requirement they validate.

- [x] 1. Add UI dependencies to root `package.json`
  - All UI build-time deps go into devDependencies. No workspaces, no separate package.json. This unblocks every subsequent task.

  - [x] 1.1 Add React, Vite, Cloudscape, and testing deps as devDependencies
    - Add to root `package.json` devDependencies: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `vite`, `@cloudscape-design/components`, `@cloudscape-design/global-styles`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`.
    - Use caret ranges for all (e.g. `^19.x` for React, `^6.x` for Vite — use latest stable at implementation time).
    - Do NOT add any of these as production `dependencies`.
    - Do NOT add a `workspaces` field.
    - Run `npm install` and verify it succeeds.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2. Create the `ui/` source directory and toolchain config
  - Stand up the UI project structure with its own tsconfig and vite config. No separate package.json.

  - [x] 2.1 Create `ui/tsconfig.json`
    - Browser-targeted config: `"jsx": "react-jsx"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, `"lib": ["ES2023", "DOM", "DOM.Iterable"]`, `"strict": true`, `"verbatimModuleSyntax": true`, `"isolatedModules": true`, `"noEmit": true`, `"skipLibCheck": true`.
    - `"include": ["src"]`.
    - Do NOT extend the root `tsconfig.json` — the two are independent.
    - _Requirements: 1.2, 1.3, 1.6_

  - [x] 2.2 Create `ui/vite.config.ts`
    - Configure `@vitejs/plugin-react`.
    - Set `base` conditionally: `'/'` when `command === 'serve'` (dev), `'/ui/'` when building (prod).
    - Set `build.outDir: '../dist/ui'`, `build.emptyOutDir: true`, `build.sourcemap: false`.
    - Configure dev server: `port: 5173`, `host: '127.0.0.1'`, proxy `/healthz` and `/v1` to `http://127.0.0.1:21100`.
    - _Requirements: 3.1, 3.2, 4.3, 13.1, 13.3, 13.4_

  - [x] 2.3 Create `ui/index.html`
    - Standard Vite entry HTML with `<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`.
    - _Requirements: 1.1, 2 (UI source structure)_

  - [x] 2.4 Create `ui/src/types/health.ts`
    - Export `interface HealthzResponse { status: 'ok'; version: string; }`.
    - This is a duplicate of the backend's wire shape — no cross-import from `src/`.
    - _Requirements: 11 (Scaffold Page), 14 (Guard boundary), N11_

  - [x] 2.5 Create `ui/src/main.tsx`
    - Import `@cloudscape-design/global-styles/index.css`.
    - Mount `<App />` into `#root` via `createRoot` inside `<StrictMode>`.
    - _Requirements: 1.1, 11.5_

  - [x] 2.6 Create `ui/src/App.tsx` — the Scaffold Page with placeholder layout
    - Render Cloudscape `TopNavigation` with identity text `"kiro-learn"` and version from `/healthz`.
    - Render `AppLayout` (or `AppLayoutToolbar`) with `navigationHide` and `toolsHide`.
    - Main content layout (top to bottom):
      - `StatusIndicator` reflecting daemon health (success/error/loading).
      - **Metric cards row**: `ColumnLayout` with 4 columns, each a `Container` with a `Header` and a `Box` displaying `0`. Cards: "Total Memories", "Total Events", "Projects", "Concepts". Values are hardcoded `0` — no API calls beyond `/healthz`.
      - **Graph placeholder**: `Container` with `Header` "Memory Graph" and a styled empty `div` (min-height 400px) containing centered `StatusIndicator` type `pending` with text "Graph visualization coming soon".
    - Implement health poll: `fetch('/healthz')` on mount, then every 10 seconds via `setInterval`.
    - Clean up interval on unmount.
    - Extract a `MetricCard` helper component for reuse by the dashboard spec.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 12.1, 12.2, 12.3, 12.4, 12.5_

  - [x] 2.7 Verify `ui/` type-checks
    - Run `npx tsc --noEmit -p ui/tsconfig.json` and confirm zero errors.
    - _Requirements: 1.2, 1.5_

- [x] 3. Implement the static handler in the daemon
  - New module `src/collector/receiver/static-handler.ts` plus receiver integration. Backend-only, testable without the UI bundle.

  - [x] 3.1 Create `src/collector/receiver/static-handler.ts`
    - Export `MIME_TABLE` constant with the extension→Content-Type mapping per design (`.html`, `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, `.ico`, `.woff`, `.woff2`, `.map`).
    - Export `AssetResolution` type: `{ kind: 'serve', absolutePath, mimeType, isHashed }` | `{ kind: 'spa-fallback', indexPath }` | `{ kind: 'reject', status: 400 | 403 | 404 }`.
    - Export `resolveAsset(urlPath: string, assetRoot: string): AssetResolution` implementing the algorithm from design § Component 1: null byte check → decode → resolve → prefix check → file existence → SPA fallback vs 404.
    - Export `serveAsset(resolution: AssetResolution, res: ServerResponse): Promise<void>` that reads the file, sets Content-Type, Content-Length, Cache-Control (hashed → immutable, non-hashed → no-cache), and writes the response. For rejections, writes JSON error body.
    - Use only `node:http`, `node:fs`, `node:fs/promises`, `node:path`. No third-party deps.
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 9.1, 9.2, 9.3, N4, N5_

  - [x] 3.2 Implement `loadDaemonVersion()` in `src/collector/receiver/index.ts`
    - Read `package.json` version once at module load via `readFileSync`, relative to the compiled receiver file (`../../package.json`).
    - Cache in a module-level `const daemonVersion`.
    - On read failure, log `[kiro-learn] could not read package version` to stderr and default to `'unknown'`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 3.3 Wire static handler and `/healthz` version into `startReceiver`
    - Compute `assetRoot` once at startup: `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')`.
    - Check `existsSync(assetRoot)` at startup, store as `uiBundleAvailable` boolean.
    - Add routing block for `/ui`, `/ui/`, `/ui/*` before the existing 404 fallback:
      - Non-GET methods on `/ui*` → 405 with `Allow: GET` header.
      - If `!uiBundleAvailable` → 404.
      - Otherwise: strip `/ui` prefix, call `resolveAsset`, call `serveAsset`.
    - Extend `/healthz` response from `{ status: 'ok' }` to `{ status: 'ok', version: daemonVersion }`.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 10.1, 10.4, N18_

- [x] 4. Update installer `deployPayload`
  - One-line change plus a graceful-skip guard.

  - [x] 4.1 Add `'ui'` to the subdirectory copy list in `deployPayload`
    - Change the `for` loop from `['shim', 'collector', 'installer', 'types']` to `['shim', 'collector', 'installer', 'types', 'ui']`.
    - Add `if (!existsSync(src)) continue;` guard inside the loop so pre-visualizer builds (no `dist/ui/`) don't break the installer.
    - _Requirements: 5.1, 5.2, 5.3, N19_

- [x] 5. Update build scripts and typecheck
  - Wire the Vite build into the root build command and update typecheck to cover both targets.

  - [x] 5.1 Update root `package.json` scripts
    - `"build"`: `"tsc -p tsconfig.build.json && npx vite build --config ui/vite.config.ts"`
    - Add `"build:node"`: `"tsc -p tsconfig.build.json"`
    - Add `"build:ui"`: `"npx vite build --config ui/vite.config.ts"`
    - Add `"dev:ui"`: `"npx vite --config ui/vite.config.ts"`
    - Update `"typecheck"`: `"tsc --noEmit -p tsconfig.build.json && tsc --noEmit -p ui/tsconfig.json"` (or keep existing if it already covers both via project references).
    - _Requirements: 3.3, 13.2, 4.1 (build integration)_

  - [x] 5.2 Verify `npm run build` produces `dist/ui/`
    - Run `npm run build` from the repo root.
    - Confirm `dist/ui/index.html` exists and references assets prefixed with `/ui/`.
    - Confirm at least one hashed `.js` file exists under `dist/ui/assets/`.
    - _Requirements: 3.4, 3.5, 4.1, 4.2_

  - [x] 5.3 Verify root `tsconfig.build.json` does NOT compile `ui/`
    - Confirm `tsconfig.build.json` `include` array does not contain `ui/` or `ui/**`.
    - Run `npm run build:node` and confirm no files from `ui/` appear in `dist/`.
    - _Requirements: 1.4_

- [x] 6. Guard tests — `src/` ↔ `ui/` boundary
  - Prevent accidental cross-imports between the two independent compilation units.

  - [x] 6.1 Create `test/unit/no-ui-in-src.test.ts`
    - Walk all `.ts` files under `src/`. Assert none contain import specifiers referencing `ui/` or `../ui/`.
    - Follow the pattern of `test/unit/no-collector-in-shim.test.ts`.
    - _Requirements: 14.1, N12_

  - [x] 6.2 Create `test/unit/no-src-in-ui.test.ts`
    - Walk all `.ts` and `.tsx` files under `ui/src/`. Assert none contain import specifiers referencing `src/` or `../../src/`.
    - _Requirements: 14.2, N11_

- [x] 7. Static handler tests
  - Example and property tests for the security-critical static-handler logic.

  - [x] 7.1 Add `arbitraryUrlPath()` generator to `test/helpers/arbitrary.ts`
    - Generate URL path strings including `..` segments, percent-encoded characters (`%2e%2e`, `%00`, `%2f`), mixed separators, extensionless paths, paths with extensions, empty strings, very long strings.
    - Used by the three property tests below.
    - _Requirements: N17_

  - [x] 7.2 Create `test/unit/static-handler.test.ts` — example tests
    - Test all branches of `resolveAsset` against a fixture directory (created via `mkdtempSync`):
      - Serve existing `.html` file → `{ kind: 'serve', mimeType: 'text/html; charset=utf-8' }`.
      - Serve existing `.js` file → correct MIME.
      - 404 for missing file with extension (e.g. `/missing.js`).
      - SPA fallback for extensionless path (e.g. `/dashboard`) → `{ kind: 'spa-fallback' }`.
      - 403 for `/../../../etc/passwd` traversal attempt.
      - 400 for null byte in path.
      - 400 for malformed percent-encoding (e.g. `%zz`).
      - Every MIME_TABLE entry produces the correct Content-Type.
      - Unknown extension → `application/octet-stream`.
      - Cache-Control: hashed filename → `public, max-age=31536000, immutable`; non-hashed → `no-cache`.
    - _Requirements: 6.1, 6.3, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 9.1, 9.2, N5_

  - [x] 7.3 Property test: path-traversal containment (Property 1)
    - New file `test/unit/static-handler-traversal.property.test.ts`.
    - For all generated URL paths from `arbitraryUrlPath()`, `resolveAsset(path, fixtureAssetRoot)` either produces a `serve`/`spa-fallback` with a path inside `fixtureAssetRoot`, or produces a `reject`. No accepted path resolves outside.
    - _Requirements: 7.5, N14_

  - [x] 7.4 Property test: MIME correctness (Property 2)
    - New file `test/unit/static-handler-mime.property.test.ts`.
    - For all extensions in MIME_TABLE, when a file with that extension exists in the fixture, `resolveAsset` returns the matching Content-Type.
    - _Requirements: 8.3, N14_

  - [x] 7.5 Property test: SPA fallback determinism (Property 3)
    - New file `test/unit/static-handler-spa-fallback.property.test.ts`.
    - For all extensionless paths that pass traversal validation, `resolveAsset` returns `serve` or `spa-fallback`, never `reject` with 404.
    - _Requirements: 9.4, N14_

- [x] 8. Receiver integration tests
  - End-to-end tests for the static routes wired into the real receiver.

  - [x] 8.1 Create `test/unit/receiver-static-routes.test.ts`
    - Start a real receiver with a fixture `dist/ui/` directory.
    - `GET /ui` → 200, body is `index.html` content, Content-Type `text/html`.
    - `GET /ui/` → same as above.
    - `GET /ui/assets/test.js` → 200, correct MIME, correct body.
    - `GET /ui/nonexistent-route` (extensionless) → 200, SPA fallback (index.html).
    - `GET /ui/missing.css` → 404.
    - `POST /ui` → 405 with `Allow: GET` header.
    - Start receiver with no `dist/ui/` → `GET /ui` returns 404, `GET /healthz` still works.
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 9.1, 9.2, N18, N20_

  - [x] 8.2 Create `test/unit/healthz-version.test.ts`
    - Start receiver, `GET /healthz` → response includes `status: 'ok'` and `version` matching the package.json version.
    - Two consecutive calls return the same version (cached).
    - Response still has `Content-Type: application/json`.
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [x] 9. Installer test
  - Verify `deployPayload` handles the new `ui/` subdirectory correctly.

  - [x] 9.1 Create `test/unit/installer-deploy-ui.test.ts`
    - Set up a mock `dist/` with `shim/`, `collector/`, `installer/`, `types/`, and `ui/` subdirectories.
    - Run `deployPayload`. Assert `~/.kiro-learn/lib/ui/` exists with expected contents.
    - Set up a mock `dist/` WITHOUT `ui/`. Run `deployPayload`. Assert it completes without error and the other four subdirectories are copied.
    - _Requirements: 5.1, 5.2, 5.3, N19_

- [x] 10. UI smoke test
  - Minimal test that mounts the React app and confirms it renders.

  - [x] 10.1 Update Vitest config for UI test files
    - Update root `vitest.config.ts` to include `ui/src/**/*.test.tsx` (or `test/unit/ui-*.test.ts`) in the test glob.
    - Configure `jsdom` environment for files matching the UI test pattern.
    - _Requirements: 15.4_

  - [x] 10.2 Create `test/unit/ui-app-smoke.test.ts`
    - Import `App` from `../../ui/src/App.js`.
    - Mock `global.fetch` to return `{ status: 'ok', version: '0.8.0' }`.
    - Render `<App />` via `@testing-library/react`'s `render`.
    - Assert the rendered output contains the text `"kiro-learn"` (top nav).
    - Assert the rendered output contains `"Total Memories"` (metric card).
    - Assert the rendered output contains `"Total Events"` (metric card).
    - Assert the rendered output contains `"Projects"` (metric card).
    - Assert the rendered output contains `"Concepts"` (metric card).
    - Assert the rendered output contains `"Memory Graph"` (graph placeholder header).
    - Assert the rendered output contains `"Graph visualization coming soon"` (graph placeholder body).
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8_

- [x] 11. Checkpoint — intermediate green build
  - Run `npm run typecheck && npm run lint && npm run test` and confirm green before final verification.

- [x] 12. Final verification
  - End-to-end sanity pass confirming the full chain works.

  - [x] 12.1 Run the full local gate
    - `npm run build` — confirms both tsc and vite complete.
    - `npm run typecheck` — confirms both tsconfigs pass.
    - `npm run lint` — confirms no lint violations in new/modified files.
    - `npm run test` — confirms all new and existing tests pass.
    - Verify `dist/ui/index.html` exists and references `/ui/`-prefixed assets.
    - _Requirements: all, N1_

  - [ ]* 12.2 Manual end-to-end smoke
    - Optional. Build, run `kiro-learn start`, open `http://127.0.0.1:21100/ui` in a browser. Confirm:
      - Cloudscape page renders with top nav showing "kiro-learn" and version.
      - StatusIndicator shows "Daemon healthy".
      - Four metric cards visible: "Total Memories: 0", "Total Events: 0", "Projects: 0", "Concepts: 0".
      - Graph placeholder area visible with "Memory Graph" header and "Graph visualization coming soon" text.
    - Not automated — every behaviour is covered by the test suite above.

  - [ ]* 12.3 Verify `npm pack` includes `dist/ui/`
    - Optional. Run `npm pack --dry-run` after build and confirm `dist/ui/index.html` appears in the file list.
    - _Requirements: 4.1, 4.2_

  - [ ]* 12.4 Bundle size check
    - Optional. After build, check `du -sh dist/ui/` and confirm total is under 2 MiB uncompressed.
    - _Requirements: N3_

## Notes

- Tasks marked with `*` are optional polish. All non-`*` tasks cover every acceptance criterion and correctness property.
- The static handler (`static-handler.ts`) is the security-critical piece. Property test for path-traversal (Task 7.3) is the most important test in this spec.
- The UI smoke test (Task 10.2) imports from `ui/src/` into a test file under `test/unit/`. This is a test-time cross-reference, not a production import — it does not violate the guard tests which scan `src/` and `ui/src/` only.
- No React Router is installed. The scaffold is a single view. Routing is added by a later spec.
- No React Flow is installed. Deferred to `visualizer-graph`.
- `deployPayload`'s new `existsSync` guard (Task 4.1) makes it tolerant of any missing subdirectory, not just `ui/`. This is a minor robustness improvement that benefits all subdirectories.

## Execution order summary

1. Task 1 (deps) unblocks everything.
2. Task 2 (UI source) depends on Task 1.
3. Task 3 (static handler) depends on Task 1 only (backend code, no UI deps needed).
4. Task 4 (installer) depends on nothing; can run in parallel with 2 and 3.
5. Task 5 (build scripts) depends on Tasks 1, 2, 3.
6. Tasks 6–10 (tests) depend on the code they test.
7. Task 11 (checkpoint) depends on all prior.
8. Task 12 (final verification) depends on Task 11.
