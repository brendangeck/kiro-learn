# Contributing to kiro-learn

Thanks for your interest in contributing. This guide covers the basics to get you up and running.

## Prerequisites

- **Node.js 22** or later
- **npm** (comes with Node)
- **kiro-cli** (only needed for integration tests that hit Amazon Bedrock)

## Setup

```bash
git clone https://github.com/brendangeck/kiro-learn.git
cd kiro-learn
npm install
npm run build
```

## Running tests

```bash
# Unit tests (fast, no external dependencies)
npm run test

# Integration tests (requires kiro-cli + AWS credentials)
npm run test:integ

# Both
npm run test:all
```

## Linting and formatting

```bash
npm run lint          # ESLint
npm run format:check  # Prettier (check only)
npm run format        # Prettier (auto-fix)
npm run typecheck     # TypeScript type checking
```

## Code style

- **ESM-only** — the package uses `"type": "module"`. All imports use explicit `.js` extensions (`import { foo } from './bar.js'`).
- **Strict TypeScript** — the project enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. Use `import type { ... }` for type-only imports.
- **Modularity boundaries** — certain import paths are forbidden and enforced by guard tests. See `AGENTS.md` for the full list.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Make your changes.
3. Run the full check suite:
   ```bash
   npm run typecheck && npm run lint && npm run test
   ```
4. Commit with a clear message. The project uses [Conventional Commits](https://www.conventionalcommits.org/) for automated releases.
5. Open a pull request against `main`.

## Understanding the codebase

The [documentation site](https://kiro-learn.mintlify.app) has architecture pages covering every subsystem. Start with the [Architecture Overview](https://kiro-learn.mintlify.app/architecture/overview) for the big picture.

The `AGENTS.md` file at the repo root is a detailed technical reference for the source layout, conventions, and gotchas.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
