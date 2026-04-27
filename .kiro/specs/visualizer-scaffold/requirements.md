# Requirements: Visualizer Scaffold

## Introduction

This document defines the requirements for the second spec in the v1 visualizer sequence: standing up the UI build toolchain, shipping a static bundle with the package, and serving it from the collector daemon. The goal is to de-risk the full UI plumbing — React + Vite + Cloudscape build, `npm pack` inclusion, daemon static-asset serving — without introducing any real dashboard content, data rendering, or graph visualisation.

After this spec, `GET /ui` on the running daemon returns a "coming soon" page that proves the end-to-end chain works: Vite builds a React app into `dist/ui/`, the installer deploys it alongside existing payload subdirectories, the daemon serves it over HTTP on loopback, and the page polls `/healthz` to confirm connectivity. Everything beyond that — read APIs, metric cards, the React Flow graph — is deferred to subsequent specs (`visualizer-read-api`, `visualizer-dashboard`, `visualizer-graph`).

The architectural decision is a single-package embedded `ui/` directory with all UI dependencies in the root `package.json` as devDependencies. No workspaces, no monorepo tooling, no separate `ui/package.json`. One `npm install`, one lockfile, one `node_modules/`. The `ui/` directory is a source directory with its own `tsconfig.json` and `vite.config.ts`, analogous to how a project might have a `docs/` or `scripts/` directory with different tooling. The root `tsconfig.build.json` continues to compile only `src/` — it ignores `ui/` entirely.

**In scope:** UI toolchain setup (React, Vite, Cloudscape, TypeScript); `ui/` source directory with entry point; Vite build producing `dist/ui/`; root build script integration; daemon static-asset serving at `GET /ui` and `GET /ui/*`; `/healthz` version field extension; installer `deployPayload` update to copy `ui/` subdirectory; scaffold page with Cloudscape layout, daemon health poll, and "coming soon" alert; Vite dev server with proxy; guard tests for `src/` ↔ `ui/` boundary; smoke test for `<App />` mount; property tests for static-handler path-traversal safety, MIME correctness, and SPA fallback determinism.

**Out of scope:** Real data endpoints (`GET /v1/...` routes), dashboard cards with real metrics, React Flow graph, React Router (added when a second view arrives), auth, HTTPS, i18n, Storybook, Tailwind/Chakra/Mantine, separate `ui/package.json` or workspace configuration, pnpm migration, any state management library beyond React's built-in state.

## Glossary

- **UI_Bundle**: The set of static files (HTML, JS, CSS, assets) produced by `vite build` and written to `dist/ui/`. Served by the daemon at runtime.
- **Static_Handler**: The code path in the receiver that serves files from the UI_Bundle directory for `GET /ui` and `GET /ui/*` requests. Implemented using only `node:http`, `node:fs`, and `node:path` — no third-party static-serving library.
- **Asset_Root**: The absolute filesystem path to the `ui/` subdirectory inside the deployed `dist/` directory. Resolved once at daemon startup relative to the receiver module's own location. All static-file reads are confined to this directory.
- **SPA_Fallback**: The behaviour where the Static_Handler serves `index.html` for `GET /ui/*` requests that do not match an existing file and whose path has no file extension. This enables client-side routing without server-side route definitions.
- **MIME_Table**: A static mapping from file extension to `Content-Type` header value, used by the Static_Handler. Covers `.html`, `.js`, `.css`, `.json`, `.svg`, `.png`, `.ico`, `.woff`, `.woff2`, `.map` at minimum.
- **Scaffold_Page**: The initial React application rendered by the UI_Bundle. Displays a Cloudscape `AppLayout` with top navigation showing "kiro-learn" and the daemon version, a health status indicator polling `/healthz`, and a "coming soon" alert. Contains no real data rendering.
- **Health_Poll**: The Scaffold_Page's periodic `fetch('/healthz')` call (every 10 seconds) that updates the `StatusIndicator` to reflect whether the daemon is reachable and healthy.
- **Receiver**: The existing `node:http` server in `src/collector/receiver/index.ts` that handles `POST /v1/events` and `GET /healthz`. This spec extends it with the Static_Handler.
- **Vite_Dev_Server**: The Vite development server started by `npm run dev:ui`, running on port 5173 with proxy rules forwarding `/healthz` and `/v1/*` to the daemon on port 21100. Used during UI development only; not part of the production bundle.
- **Guard_Test**: A test that reads source files and asserts that forbidden import patterns are absent. This spec adds two: `no-src-in-ui` (UI source must not import from `src/`) and `no-ui-in-src` (backend source must not import from `ui/`).

## Requirements

### Requirement 1: Project Structure — `ui/` Source Directory

**User Story:** As a developer, I want the UI source to live in a `ui/` directory at the repository root with its own TypeScript and Vite configuration, so the browser-targeted code is cleanly separated from the Node.js backend without introducing workspaces or a second `package.json`.

#### Acceptance Criteria

1. THE repository SHALL contain a `ui/` directory at the root with the following structure: `ui/index.html`, `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/tsconfig.json`, `ui/vite.config.ts`.
2. THE `ui/tsconfig.json` SHALL target browser environments with `"jsx": "react-jsx"`, `"module": "ESNext"`, `"moduleResolution": "Bundler"`, and `"lib": ["ES2023", "DOM", "DOM.Iterable"]`.
3. THE `ui/tsconfig.json` SHALL NOT extend the root `tsconfig.json`. The two configurations are independent — the root targets Node.js, the UI targets browsers.
4. THE root `tsconfig.build.json` SHALL continue to compile only `src/` and SHALL NOT include `ui/` in its `include` array.
5. THE root `tsconfig.json` (used for editor type-checking and `npm run typecheck`) SHALL include `ui/` in its scope so that `tsc --noEmit` catches type errors in UI source alongside backend source.
6. THERE SHALL be no `ui/package.json`. All UI dependencies are declared in the root `package.json` (Requirement 2).

### Requirement 2: Dependencies — Root `package.json` DevDependencies

**User Story:** As a developer, I want all UI build-time dependencies in the root `package.json` as devDependencies, so one `npm install` at the root installs everything and there is one lockfile and one `node_modules/`.

#### Acceptance Criteria

1. THE root `package.json` SHALL declare the following as devDependencies: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `vite`, `@cloudscape-design/components`, `@cloudscape-design/global-styles`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`.
2. THE root `package.json` SHALL NOT declare any of the packages listed in 2.1 as production `dependencies`. They are devDependencies because the daemon serves pre-built static files at runtime — React and Vite are not needed at runtime.
3. THE root `package.json` SHALL NOT contain a `workspaces` field.
4. THERE SHALL be exactly one `package-lock.json` at the repository root. No lockfile shall exist under `ui/`.
5. WHEN `npm install` is run at the repository root, THE install SHALL succeed and all UI dependencies SHALL be available for the Vite build.

### Requirement 3: Build Integration — Vite Build in Root Build Script

**User Story:** As a developer, I want `npm run build` at the root to produce both the Node.js backend in `dist/` and the UI bundle in `dist/ui/`, so a single build command produces the complete shippable artifact.

#### Acceptance Criteria

1. THE `ui/vite.config.ts` SHALL configure `@vitejs/plugin-react`, set `base: '/ui/'` for production builds, and set `build.outDir` to `'../dist/ui'` (relative to `ui/`).
2. THE `ui/vite.config.ts` SHALL set `build.emptyOutDir: true` so stale assets from prior builds are removed.
3. THE root `package.json` `"build"` script SHALL run `tsc -p tsconfig.build.json` followed by `npx vite build --config ui/vite.config.ts`, sequentially.
4. WHEN `npm run build` completes successfully, THE `dist/ui/` directory SHALL contain at minimum `index.html` and one or more hashed `.js` files.
5. THE `dist/ui/index.html` SHALL reference assets with paths prefixed by `/ui/` (consequence of `base: '/ui/'`).

### Requirement 4: Package Shipping — `dist/ui/` in `npm pack`

**User Story:** As a package consumer, I want `npm pack` to include `dist/ui/` so the published package ships the pre-built UI bundle alongside the backend.

#### Acceptance Criteria

1. THE root `package.json` `"files"` array SHALL include `"dist"` (already present), which transitively includes `dist/ui/`.
2. WHEN `npm pack` is run after a successful build, THE resulting tarball SHALL contain `dist/ui/index.html` and the associated JS/CSS assets.
3. THE `dist/ui/` directory SHALL NOT contain source maps in production builds. Vite's `build.sourcemap` SHALL be set to `false` (or omitted, as `false` is the default).

### Requirement 5: Installer — `deployPayload` Copies `ui/` Subdirectory

**User Story:** As a kiro-learn operator running `kiro-learn init`, I want the installer to deploy the UI bundle alongside the existing backend payload, so the daemon can serve it at runtime.

#### Acceptance Criteria

1. THE `deployPayload` function in `src/installer/index.ts` SHALL include `'ui'` in the list of subdirectories copied from `dist/` to `~/.kiro-learn/lib/`.
2. WHEN `deployPayload` completes, THE directory `~/.kiro-learn/lib/ui/` SHALL contain the same files as `dist/ui/`.
3. IF the `dist/ui/` subdirectory does not exist at deploy time (e.g. building from a pre-visualizer branch), THE `deployPayload` function SHALL skip the `ui` subdirectory without error. Existing subdirectories (`shim`, `collector`, `installer`, `types`) SHALL still be copied. *(Graceful degradation — the installer must not break on older builds.)*

### Requirement 6: Daemon — Static Asset Serving at `GET /ui`

**User Story:** As a kiro-learn user, I want to open `http://127.0.0.1:21100/ui` in my browser and see the scaffold page, so I can verify the daemon is running and the UI plumbing works end-to-end.

#### Acceptance Criteria

1. THE Receiver SHALL handle `GET /ui` by serving `index.html` from the Asset_Root with `Content-Type: text/html; charset=utf-8` and status `200`.
2. THE Receiver SHALL handle `GET /ui/` (with trailing slash) identically to `GET /ui`.
3. THE Receiver SHALL handle `GET /ui/<path>` where `<path>` matches an existing file in the Asset_Root by serving that file with the appropriate MIME type from the MIME_Table and status `200`.
4. THE Receiver SHALL resolve the Asset_Root once at startup by computing the path to the `ui/` subdirectory relative to the receiver module's own filesystem location (i.e. relative to `dist/collector/receiver/index.js` → `dist/ui/`).
5. THE Receiver SHALL use only `node:http`, `node:fs`, and `node:path` for static serving. No third-party static-serving library (e.g. `serve-static`, `sirv`) SHALL be introduced.
6. WHEN the Asset_Root directory does not exist at startup (e.g. pre-visualizer build), THE Receiver SHALL respond to `GET /ui` and `GET /ui/*` with `404 {"error":"not found"}`. The daemon SHALL still start and serve all other routes normally. *(Graceful degradation.)*

### Requirement 7: Daemon — Path Traversal Safety

**User Story:** As a security-conscious developer, I want the static-asset handler to reject any request that attempts to escape the Asset_Root via `..`, encoded sequences, or other path manipulation, so the daemon never serves files outside the UI bundle directory.

#### Acceptance Criteria

1. THE Static_Handler SHALL resolve the requested path to an absolute filesystem path using `path.resolve(assetRoot, normalizedRelativePath)`.
2. THE Static_Handler SHALL verify that the resolved absolute path starts with the Asset_Root path (prefix check with trailing separator). IF the resolved path does not start with the Asset_Root, THE Static_Handler SHALL respond with `403 {"error":"forbidden"}`.
3. THE Static_Handler SHALL decode percent-encoded characters in the URL path before resolving, so `%2e%2e` is treated identically to `..`.
4. THE Static_Handler SHALL reject null bytes (`%00`) in the URL path with `400 {"error":"bad request"}`.
5. FOR ALL strings `s` that a malicious client could send as the path component of `GET /ui/<s>`, THE resolved filesystem path SHALL either be inside the Asset_Root or the request SHALL be rejected. *(testable as a property — generate arbitrary path strings including `..`, encoded variants, null bytes, symlink-like segments, and verify the invariant.)*

### Requirement 8: Daemon — MIME Type Resolution

**User Story:** As a browser loading the UI bundle, I want each asset served with the correct `Content-Type` header, so scripts execute, styles apply, and fonts render without MIME-type errors.

#### Acceptance Criteria

1. THE Static_Handler SHALL maintain a MIME_Table mapping file extensions to Content-Type values. The table SHALL include at minimum: `.html` → `text/html; charset=utf-8`, `.js` → `application/javascript`, `.css` → `text/css`, `.json` → `application/json`, `.svg` → `image/svg+xml`, `.png` → `image/png`, `.ico` → `image/x-icon`, `.woff` → `font/woff`, `.woff2` → `font/woff2`, `.map` → `application/json`.
2. WHEN a requested file's extension is not in the MIME_Table, THE Static_Handler SHALL serve it with `Content-Type: application/octet-stream`.
3. FOR ALL files in the Asset_Root, THE Content-Type header SHALL be determined solely by the file's extension, not by file content inspection. *(testable as a property — for any file extension in the MIME_Table, the served Content-Type matches the table entry.)*

### Requirement 9: Daemon — SPA Fallback

**User Story:** As a future UI developer adding client-side routes, I want requests to `/ui/some-route` (where `some-route` is not a real file) to serve `index.html`, so React Router (when added later) can handle the route client-side.

#### Acceptance Criteria

1. WHEN a `GET /ui/<path>` request does not match an existing file in the Asset_Root AND the path has no file extension, THE Static_Handler SHALL serve `index.html` from the Asset_Root with status `200` and `Content-Type: text/html; charset=utf-8`.
2. WHEN a `GET /ui/<path>` request does not match an existing file in the Asset_Root AND the path has a file extension (e.g. `/ui/missing.js`), THE Static_Handler SHALL respond with `404 {"error":"not found"}`. *(Missing assets are genuine 404s, not SPA routes.)*
3. THE SPA fallback SHALL only apply after path-traversal validation passes (Requirement 7). A path like `/ui/../etc/passwd` SHALL be rejected by the traversal check, not served as a fallback.
4. FOR ALL extensionless paths under `/ui/` that pass traversal validation, THE Static_Handler SHALL deterministically return either the matching file (if it exists) or `index.html` (if it does not). *(testable as a property — the response is never a 404 for extensionless paths that pass validation.)*

### Requirement 10: Daemon — `/healthz` Version Extension

**User Story:** As the scaffold page, I want `/healthz` to return the daemon's version alongside the status, so the UI can display the version in the top navigation bar.

#### Acceptance Criteria

1. THE `/healthz` response SHALL be extended from `{"status":"ok"}` to `{"status":"ok","version":"<semver>"}` where `<semver>` is the package version string (e.g. `"0.8.0"`).
2. THE version SHALL be read from the package's `package.json` once at daemon startup and cached for the lifetime of the process. The version SHALL NOT be re-read on every `/healthz` request.
3. THE version field SHALL be a string. No parsing or validation of the version format is performed at runtime — the value is whatever `package.json` contains.
4. WHEN an existing consumer reads only the `status` field from the `/healthz` response, THE consumer SHALL continue to work unchanged. Adding `version` is an additive change. *(Backward compatibility.)*

### Requirement 11: Scaffold Page — Layout with Placeholder Dashboard and Graph Area

**User Story:** As a kiro-learn user, I want the scaffold page to show the general structure of the final visualizer — metric cards and a graph area — with placeholder values, so I can see the product shape and verify the UI plumbing works end-to-end.

#### Acceptance Criteria

1. THE Scaffold_Page SHALL render a Cloudscape `AppLayout` (or `AppLayoutToolbar`) with a top navigation element displaying "kiro-learn" and the daemon version obtained from `/healthz`.
2. THE Scaffold_Page SHALL display a Cloudscape `StatusIndicator` that reflects the daemon's health: `"success"` type with "Daemon healthy" text when `/healthz` returns `{"status":"ok",...}`, and `"error"` type with "Daemon unreachable" text when the fetch fails or returns a non-ok status.
3. THE Scaffold_Page SHALL display a row of metric cards showing placeholder values. At minimum: "Total Memories" (value: `0`), "Total Events" (value: `0`), "Projects" (value: `0`), "Concepts" (value: `0`). Each card SHALL use a Cloudscape `Container` (or `Box`) with a `Header` for the metric name and a prominent numeric display for the value.
4. THE Scaffold_Page SHALL display a graph placeholder area below the metric cards. This SHALL be a Cloudscape `Container` with `Header` text "Memory Graph" and a styled empty content area (minimum height 400px) containing centered text "Graph visualization coming soon" and a Cloudscape `StatusIndicator` of type `"pending"`.
5. THE Scaffold_Page SHALL import and apply `@cloudscape-design/global-styles/index.css` so Cloudscape components render with correct styling.
6. THE Scaffold_Page SHALL render without JavaScript errors in a modern browser (Chrome, Firefox, Safari latest stable).
7. THE metric card values SHALL be hardcoded to `0`. No API calls are made to populate them — real data comes from the `visualizer-dashboard` spec.
8. THE graph placeholder SHALL NOT import or reference React Flow. It is a static placeholder only — the real graph comes from the `visualizer-graph` spec.

### Requirement 12: Scaffold Page — Health Poll

**User Story:** As a kiro-learn user viewing the scaffold page, I want the health status to update automatically every 10 seconds, so I can see if the daemon goes down or comes back up without manually refreshing.

#### Acceptance Criteria

1. THE Scaffold_Page SHALL poll `GET /healthz` every 10 seconds after the initial page load.
2. THE Scaffold_Page SHALL perform an initial health check on mount (not wait 10 seconds for the first check).
3. WHEN the `/healthz` fetch succeeds with `{"status":"ok","version":"..."}`, THE Scaffold_Page SHALL update the `StatusIndicator` to `"success"` type and SHALL display the version in the top navigation.
4. WHEN the `/healthz` fetch fails (network error, non-200 status, or response missing `status:"ok"`), THE Scaffold_Page SHALL update the `StatusIndicator` to `"error"` type. The version display SHALL retain the last known version or show "unknown" if no successful response has been received.
5. THE Health_Poll SHALL clean up its interval timer when the component unmounts. *(Prevents memory leaks in test environments and future multi-view scenarios.)*

### Requirement 13: Vite Dev Server — Proxy Configuration

**User Story:** As a UI developer, I want `npm run dev:ui` to start a Vite dev server with hot-reload that proxies API calls to the running daemon, so I can iterate on the UI without rebuilding.

#### Acceptance Criteria

1. THE `ui/vite.config.ts` SHALL configure a Vite dev server proxy that forwards requests matching `/healthz` and `/v1/*` to `http://127.0.0.1:21100`.
2. THE root `package.json` SHALL include a `"dev:ui"` script that runs `npx vite --config ui/vite.config.ts`.
3. THE Vite dev server SHALL run on port `5173` (Vite's default).
4. THE Vite dev server configuration SHALL NOT affect the production build output. Proxy rules are dev-only.

### Requirement 14: Guard Tests — `src/` ↔ `ui/` Boundary

**User Story:** As a maintainer, I want automated tests that prevent `src/` from importing `ui/` code and `ui/` from importing `src/` code, so the backend and frontend remain independent compilation units with no accidental coupling.

#### Acceptance Criteria

1. THE repository SHALL include a guard test `test/unit/no-ui-in-src.test.ts` that reads all `.ts` files under `src/` and asserts none contain import paths referencing `ui/` or `../ui/`.
2. THE repository SHALL include a guard test `test/unit/no-src-in-ui.test.ts` that reads all `.ts` and `.tsx` files under `ui/src/` and asserts none contain import paths referencing `src/` or `../../src/`.
3. THE guard tests SHALL follow the same pattern as existing guard tests (e.g. `test/unit/no-collector-in-shim.test.ts`): read file contents with `fs.readFileSync`, scan for forbidden import patterns, and fail with a descriptive message identifying the offending file and line.

### Requirement 15: UI Smoke Test

**User Story:** As a developer, I want a single smoke test that mounts the `<App />` component and asserts it renders without crashing, so regressions in the basic render path are caught by CI.

#### Acceptance Criteria

1. THE repository SHALL include a test file for the UI smoke test (e.g. `test/unit/ui-app-smoke.test.ts` or `ui/src/__tests__/App.test.tsx`).
2. THE smoke test SHALL mount the `<App />` component using `@testing-library/react`'s `render` function in a `jsdom` environment.
3. THE smoke test SHALL assert that the rendered output contains the text "kiro-learn" (present in the top navigation).
4. THE smoke test SHALL assert that the rendered output contains the text "Total Memories" (present in the metric cards).
5. THE smoke test SHALL assert that the rendered output contains the text "Memory Graph" (present in the graph placeholder header).
6. THE smoke test SHALL assert that the rendered output contains the text "Graph visualization coming soon" (present in the graph placeholder body).
7. THE Vitest configuration SHALL be updated to include UI test files and to use the `jsdom` environment for files matching the UI test pattern.
8. WHEN `npm run test` is run, THE UI smoke test SHALL execute alongside existing backend unit tests.


## Non-functional Requirements

### Build and CI

- **N1.** THE full CI pipeline (`npm run build` + `npm run test:all`) SHALL include the Vite build and all UI tests. No separate CI job is required for the UI — it is part of the single build.
- **N2.** THE Vite build SHALL complete in under 30 seconds on commodity developer hardware. *(The scaffold page is trivial — a single component with Cloudscape imports. Build time is dominated by Cloudscape's tree-shaking, which is well under 30 s.)*
- **N3.** THE `dist/ui/` bundle size SHALL be under 2 MiB uncompressed for the scaffold page. *(Cloudscape is the largest dependency; tree-shaking should keep the scaffold well under this limit.)*

### Performance

- **N4.** THE Static_Handler SHALL read files from disk on every request (no in-memory caching). For a loopback-only, single-user daemon, filesystem caching by the OS is sufficient. *(Simplicity over performance — the daemon serves one user on localhost.)*
- **N5.** THE Static_Handler SHALL set `Cache-Control: no-cache` on `index.html` and `Cache-Control: public, max-age=31536000, immutable` on hashed asset files (files whose names contain a hash, e.g. `assets/index-abc123.js`). *(Standard Vite caching strategy — HTML is always revalidated, hashed assets are immutable.)*
- **N6.** THE `/healthz` response time SHALL not regress beyond the existing baseline (< 5 ms) as a result of adding the `version` field. *(The version is cached at startup; the response path gains one additional JSON key, which is negligible.)*

### Security

- **N7.** THE Static_Handler SHALL bind to loopback only (`127.0.0.1`), matching the existing receiver posture. No CORS headers are required in production. *(Single-user, local-only daemon — no cross-origin requests in production.)*
- **N8.** THE Static_Handler's path-traversal defence (Requirement 7) SHALL be the primary security boundary for static serving. No additional auth, no HTTPS, no CSP headers are required for v1. *(Matches existing daemon security posture — loopback-only, no auth.)*
- **N9.** THE Vite dev server proxy SHALL NOT be included in production builds. Proxy configuration is dev-server-only and has no effect on the built output.

### Modularity

- **N10.** THE `ui/` directory SHALL NOT contain a `package.json`, `package-lock.json`, or `node_modules/`. All dependency resolution flows through the root.
- **N11.** THE `ui/src/` code SHALL NOT import from `src/` (enforced by guard test, Requirement 14.2). The UI communicates with the backend exclusively via HTTP (`fetch`).
- **N12.** THE `src/` code SHALL NOT import from `ui/` (enforced by guard test, Requirement 14.1). The backend has no compile-time dependency on the UI.
- **N13.** THE Static_Handler code SHALL live in `src/collector/receiver/` (colocated with the existing HTTP handler). It is part of the receiver module, not a new top-level module.

### Testability

- **N14.** THE repository SHALL include property-based tests for the invariants called out in Requirements 7.5, 8.3, and 9.4. These tests SHALL use `fast-check` and SHALL live under `test/unit/` following the existing `*.property.test.ts` naming convention.
- **N15.** THE repository SHALL include the two guard tests specified in Requirement 14 under `test/unit/`.
- **N16.** THE repository SHALL include the UI smoke test specified in Requirement 15.
- **N17.** THE `test/helpers/arbitrary.ts` generators SHALL be extended with a generator for URL path strings (including `..` segments, percent-encoded characters, null bytes, and valid asset paths) for use in the path-traversal property tests.

### Compatibility

- **N18.** THE existing `POST /v1/events`, `GET /healthz`, and retrieval endpoints SHALL continue to function unchanged after the Static_Handler is added. Adding UI serving SHALL NOT break any existing API contract.
- **N19.** THE installer's `deployPayload` SHALL remain backward-compatible: deploying from a pre-visualizer build (no `dist/ui/`) SHALL succeed without error (Requirement 5.3).
- **N20.** THE daemon SHALL start and serve all existing routes even when `dist/ui/` is absent (Requirement 6.6). The UI is an optional enhancement, not a hard dependency.

## Out of Scope (explicit)

- Real data endpoints (`GET /v1/stats`, `/v1/projects`, `/v1/memories`, `/v1/events/{id}`, etc.) — deferred to `visualizer-read-api`.
- Dashboard cards with real metrics — deferred to `visualizer-dashboard`.
- React Flow graph with project supernodes, concept and memory nodes — deferred to `visualizer-graph`.
- React Router — added when a second view arrives in `visualizer-dashboard` or `visualizer-graph`.
- `@xyflow/react` (React Flow) dependency — not installed in this spec; deferred to `visualizer-graph`.
- Auth, HTTPS, CORS headers, CSP headers — matches existing daemon posture (loopback-only, no auth).
- i18n, Storybook, Tailwind, Chakra, Mantine — not needed for v1.
- Separate `ui/package.json` or workspace configuration — rejected architectural alternative.
- pnpm migration — orthogonal to the visualizer goal.
- Turborepo, Nx, Lerna, or any monorepo tooling — overkill for this structure.
- State management library (Redux, Zustand, Jotai, etc.) — React's built-in state is sufficient for the scaffold.
- `kiro-learn ui` convenience CLI command — not needed; the daemon serves the UI automatically.
- Changes to `kiro-learn start`, `kiro-learn stop`, or `kiro-learn status` — unchanged.
- Server-side rendering (SSR) — the UI is a client-side SPA served as static files.
- Gzip or Brotli compression of static assets — loopback-only, single-user; not worth the complexity for v1.
- ETag or Last-Modified headers beyond the Cache-Control strategy in N5 — simplicity over HTTP caching sophistication.
