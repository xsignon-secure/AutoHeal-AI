# Changelog

All notable changes to AutoHeal AI. Versions follow [semantic versioning](https://semver.org/).

## 0.3.1 (2026-11-03)

### Security
Clears the 8 CodeQL alerts open on `main`:
- Markdown table cells in PRs, issues and the job summary escape backslashes as well as pipes, so a test title cannot break out of its cell.
- The provider is treated as the official OpenAI API only when the host is exactly `api.openai.com`.
- The dashboard's `Bearer` header, the dashboard URL and the Python import scan no longer use regexes that can be slowed down by crafted input.
- The page-object check that limits which files a fix may touch now tests `/index.` and the file extension separately.
- The simulation's flaky fixture creates its marker file atomically.

## 0.3.0 (2026-11-03)

### Added
- **Visual grounding.** The AI now sees the page at the moment of failure: Playwright's `test-failed-*.png` when there is one, otherwise the last screencast frame in `trace.zip` before the failing step ended (old and new trace formats). It is used for triage and for the fix, sent as an image to Anthropic and OpenAI, and counted in the budget by its size. New input `vision` (`auto`, `true`, `false`; env `AUTOHEAL_VISION`). The image never leaves for anywhere but your AI provider, and the PR evidence notes when the AI saw it.

### Changed
- The workflow template uses `actions/checkout@v7`, `setup-node@v7`, `download-artifact@v8`, and the heal action uploads with `upload-artifact@v7`. These run on Node 24: self-hosted runners need 2.327.1 or newer.
- Dependabot no longer proposes major updates of `typescript` and `@types/node`.

### Fixed
- Paths in reports were redacted when the shell's `PWD` looked like a password variable.

## 0.2.0 (2026-11-03)

Breaking: the workflow is now two jobs. Copy the new [`templates/autoheal.yml`](templates/autoheal.yml), and tick **Allow GitHub Actions to create and approve pull requests** in the repo's Actions settings.

### Security
- **Two jobs.** The heal job runs tests and proposed fixes with a read-only token and uploads a patch. A new publish action (`xsignon-secure/AutoHeal-AI/publish`) checks the patch in a fresh checkout (paths, file types, no symlinks, renames, deletes or mode changes; no `.github/`, `.git/` or config files), applies it with git hooks and fsmonitor off, and opens the PR. Eight tampered patches are refused in the simulation.
- **Token-level allowlist.** On top of the pattern rules, a fix may only add locators, waits, literals and names the file already uses. Fake comments inside strings, split-up strings, the `request` fixture, and swapping `process.env` or `page.route` for something already in the file are all blocked.
- Test processes no longer get `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY` or `GITHUB_STATE`.
- A run given as a URL is downloaded by a separate engine process that runs no tests; the engine that runs tests never sees a GitHub token.
- Manual runs look the failed run up first: the right commit and branch are healed, and runs from forks or `autoheal/*` branches are refused.
- Repo memory and failure text are marked as data in the AI prompt.
- Dashboard: behind a proxy the last `X-Forwarded-For` entry is used, a flood of new clients no longer lifts active lockouts, and the cookie holds an HMAC of the view token instead of the token.
- Secrets are redacted from everything that leaves the runner (from 0.1.2, folded into this release).

### Changed
- The npm package is now **`xsignon-autoheal`** (`npx xsignon-autoheal`); `autoheal-ai` belongs to someone else.
- The cost limit fails closed: a model with no known price needs `price-in`/`price-out` (`0` for local models).
- Each failure gets an equal share of the remaining budget; the output allowance per AI call is 8,000 tokens.
- The rest-of-file rerun rejects a crash or a run with no tests, and a fix to a page object reruns every spec that imports it.
- A failure that does not reproduce is reported as an environment problem, never quarantined. Only a real FLAKY verdict quarantines.
- App-bug issues are opened only at 60% confidence or more (`issue-min-confidence`, `open-issues`).
- Fixed waits and `force: true` are always blocked; raised timeouts are a warning.
- `dist/` is prebuilt and committed; the action installs runtime packages only, with no install scripts, and checks for Node 22.13+.
- `playwright-e2e-mcp` is pinned to exactly 0.15.0.

## 0.1.2

Folded into 0.2.0: secret redaction, expectation variables followed to their declaration, dashboard row cap.

## 0.1.1 (2026-11-03)

Hardening after the first security review: token isolation, artifact path checks, anti-cheat obfuscation rules, per-fix memory files, budget worst-case checks, mock-check limits, dashboard view token and lockout.

## 0.1.0 (2026-11-03)

First release: triage, rule and AI fixes, anti-cheat guard, stability proof, flaky quarantine, app-bug issues, repo memory, budgets and the self-hosted dashboard.
