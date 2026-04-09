# Contributing to MCP Conduit

Thank you for your interest in contributing to MCP Conduit. This document explains how to get involved, what to expect from the development process, and what standards we ask contributors to follow.

## Getting Started

1. **Fork** the repository on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/mcp-conduit.git
   cd mcp-conduit
   ```
3. **Install** dependencies:
   ```bash
   npm install
   ```
4. **Build** the project:
   ```bash
   npm run build
   ```
5. **Run the test suite** to verify everything works:
   ```bash
   npm test
   ```

## Development Workflow

### Branch Naming

Use a descriptive prefix for your branch:

- `feat/short-description` — new feature
- `fix/short-description` — bug fix
- `test/short-description` — test additions or changes
- `docs/short-description` — documentation only
- `refactor/short-description` — code restructuring without behavior change

### Pull Request Process

1. Create your branch from `main`.
2. Make your changes in focused, atomic commits.
3. Ensure all tests pass (`npm test`) and no linting errors remain.
4. Open a pull request against `main` with a clear description of the change and its motivation.
5. Address review feedback. PRs require at least one approval before merge.

## Code Style

- **TypeScript strict mode** is enabled. Do not use `any` unless absolutely unavoidable, and document why.
- **ES modules** throughout (`import`/`export`, no CommonJS `require`).
- **French comments in domain logic** are preserved for historical reasons. Do not translate them, and feel free to add new comments in English.
- **JSDoc comments** must be written in English.
- Keep functions short and focused. Prefer explicit return types on public APIs.
- No unused variables or imports. Run `npm run lint` before pushing.

## Test Requirements

The project currently has **1226+ tests**. All tests must pass before a PR can be merged.

```bash
npm test
```

- **Coverage target:** 90%+ line coverage.
- **No external services required.** All tests run with in-memory mocks or embedded stores. You do not need Redis, a database server, or network access.

### Test Categories

| Category    | Location               | Purpose                                      |
|-------------|------------------------|----------------------------------------------|
| Unit        | `tests/unit/`          | Isolated function and class tests            |
| End-to-end  | `tests/e2e/`           | Full server lifecycle over HTTP              |
| Battle      | `tests/battle/`        | Stress, concurrency, and fault injection     |
| Integration | `tests/integration/`   | Multi-server and multi-transport topologies  |
| Benchmark   | `tests/benchmark/`     | Performance regression and competitive analysis |

When adding a new feature, include tests in the appropriate category. If in doubt, unit tests are always welcome.

## Commit Message Format

We follow **Conventional Commits**:

```
<type>(<optional scope>): <short summary>
```

Types: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `chore`.

Examples:

```
feat(cache): add Redis L2 write-through support
fix(batch): use Promise.allSettled for individual error responses
test(guardrails): add block action integration tests
docs: update CHANGELOG for v0.2.0
```

## Adding a New Feature — Checklist

1. **Types** — Define or extend TypeScript interfaces and types first.
2. **Implementation** — Write the feature code.
3. **Tests** — Add unit tests at minimum; integration or e2e tests when the feature touches transport or routing.
4. **Documentation** — Update relevant docs (README, CHANGELOG, inline JSDoc).
5. **Benchmark** — If the feature affects the hot path, add or update a benchmark scenario.

## Reporting Issues

Open a GitHub issue with:

- A clear, descriptive title.
- Steps to reproduce (or a minimal configuration).
- Expected behavior versus actual behavior.
- Environment details (Node.js version, OS, MCP Conduit version).

For security vulnerabilities, **do not open a public issue**. See [SECURITY.md](./SECURITY.md) for responsible disclosure instructions.

## License

MCP Conduit is licensed under the [MIT License](./LICENSE). By submitting a contribution, you agree that your work will be licensed under the same terms.
