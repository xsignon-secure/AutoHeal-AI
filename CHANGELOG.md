# Changelog

All notable changes to AutoHeal AI. Versions follow [semantic versioning](https://semver.org/).

## 0.6.0 (2026-11-04)

### Added
- **Element fingerprints.** AutoHeal now reads the DOM snapshots in Playwright traces. For every step that found its element, it saves a fingerprint of that element (role, accessible name, test id, id, `name`, label, placeholder, link, nearby heading) under `.autoheal/fingerprints/`, one small file per locator. When a locator breaks, it finds the element with the same fingerprint on the failed page and writes the strongest locator for it, with no AI tokens. The fix then goes through the same anti-cheat scans, stability rerun and runtime guard as any other. For an assertion, the value being checked never counts toward a match, so a fingerprint can't steer a check onto another element that shows the expected value. A match must be clear (most of the fingerprint still matches and it is well ahead of the next element), or, for an action, be the only element of its kind left in the same place.
- **`autoheal fingerprint --traces <dir>`** saves fingerprints from a green run with `trace: 'on'`, so the first broken locator can already be fixed without AI.
- **Locator strength.** Deterministic fixes pick the strongest unique locator in Playwright's order (role and name, label, placeholder, text, alt or title, test id, then CSS). When the engine's fix and the fingerprint fix both apply, the stronger one is tried first. The PR shows every changed locator and whether it got stronger or weaker.
- **One UI change, one fix.** A kept fix for a broken locator is reused for every other failing test with the same broken locator, including failures past `max-failures`. If the fix was in a shared file, those tests are rerun to prove they pass; otherwise the same locator change is made in their file. Each is proven on its own. The PR groups them under "One UI change, one fix".
- **Live app.** New inputs `start-command`, `start-url` and `start-timeout`. The heal job starts your app, waits for it to answer, and gives the AI `inspect_page` and `validate_selector` on the real page. The app runs in the sandbox with the same scrubbed environment as the tests, only on this machine (`localhost`), and is stopped at the end. If it does not start, AutoHeal heals from the traces and the PR says why.
- The publish job accepts fingerprint files only in their exact shape (known fields, short strings, file name equal to the hash of its content), at most 60 per PR.

### Fixed
- The runtime guard's "same page" check read the snapshot phase only from the older `snapshotName` field. Current Playwright writes it to `phase`, so that check now runs on their traces too.

### Changed
- The dashboard counts fingerprint and same-change fixes as rule fixes, so dashboards from before 0.6.0 keep accepting uploads.

## 0.5.0 (2026-11-04)

### Security
- **Tests run in a sandbox.** On Linux runners with passwordless sudo (GitHub-hosted Ubuntu), a new "Prepare the sandbox" step creates the user `autoheal-sb`. The engine, which runs your tests and every proposed fix, starts as that user with only the filtered environment. AutoHeal's own process keeps the AI key and runs as the runner user, so a test or a fix can no longer read the key from `/proc`. The sandbox can read and write the project but not `.git`. New input `sandbox`: `auto` (default; runs without the sandbox where it cannot be set up, and the PR says so), `user` (required), `off`.
- **npm provenance.** Releases are published by `.github/workflows/release.yml` on a version tag. It uses npm trusted publishing (no token), adds provenance, checks that the tag matches `package.json` and is on `main`, and creates the GitHub release. The job that publishes installs nothing and runs no project code.

### Changed
- The "AI key proxy" from the roadmap is not needed. With the sandbox, the key never reaches a process that runs test code.

## 0.4.0 (2026-11-04)

### Added
- **Guard v2: runtime checks.** After a fix passes the code scan and the stability rerun, AutoHeal runs the fixed test once more with `--trace=on` and compares the two traces. It records which assertions ran, on which elements, against which values and on which page, and where each action landed. A fix is blocked when the fixed run:
  - skips an assertion the failed run made, or checks another value (`runtime-fewer-checks`, `runtime-no-checks`);
  - runs a shared step on another page (`runtime-other-page`);
  - lands an action that worked before somewhere else on the page (`runtime-other-element`).
- **Before/after evidence in the PR.** A "Runtime guard" row says what was compared and where the fixed step acted. A "Screenshots" row links the failed run's screenshot and the fixed run's at the same step, saved as the run artifact `<result-name>-evidence` (14 days). New input `screenshots` (default `true`) turns this off.

### Limits
- The failed run's trace stops at the failure, so steps after it are checked by the code scan only. A step that failed (for example a click on a renamed button) has no earlier position to compare with.
- Needs a Playwright Test trace from the failed run. pytest fixes keep the code and rerun checks.

## 0.3.3 (2026-11-04)

### Security
Closes the holes from the third audit:
- **What an assertion looks at is an expected value.** The text in `getByText`, `getByLabel`, `hasText` or `name` inside `expect(...)`, `text=` selectors, and state options such as `checked` or `visible`, can no longer change. A test id or CSS selector inside `expect` still can.
- **Navigation constants are followed.** `const HOME = '/'` changed to another page is blocked like a changed `goto`. Protocol-relative URLs (`//host`) count as URLs.
- **Actions can't be neutered.** The action methods (`click`, `fill`…) must stay the same, and no `await` may be removed.
- **Publish checks git's own reading.** The file list must match `git apply --numstat`, and after applying, `git status` must show exactly those files.
- **Regression set.** `test/bypasses/corpus.mjs` holds every bypass from all three audits (27) and real fixes that must still pass. CI runs it on every change.

### Fixed
- The `autoheal` command was dropped from the npm package: npm 12 removes a `bin` path that starts with `./`. The path is now `dist/cli.js`, so `npx xsignon-autoheal` works.

## 0.3.2 (2026-11-03)

### Security
From the re-audit of 0.3.0:
- **Four cheats are now blocked.** Pointing the test at another page (a changed `goto`, `route` or `waitForURL`, a `data:` URL or any other URL written into the test), deleting a user action, `test['skip']()` and other computed access on `test`, and widening a locator with `.or()` or a whole-page selector.
- **The publish job re-checks the patch on the trusted checkout.** It runs the anti-cheat scan again, and refuses files outside the new `allowed-paths` input and files that tools load or run (setup and teardown files, `__init__.py`, `sitecustomize.py`, `.pnpmfile.cjs`, gulp and grunt files, configs). The heal job's file list is no longer the limit.
- **Quarantine and memory files are validated in publish.** A quarantine entry must be for a test the run found flaky and last at most `quarantine-days`, and existing entries cannot be removed. A memory file must have AutoHeal's exact fields and the file name derived from its content.
- `@mentions` in PR, issue and comment text from the heal job no longer notify anyone.
- Actions in the template and this repo's workflows are pinned to commit SHAs. CodeQL moves to v4.
- The heal job in the template no longer uses the npm cache.

Breaking: if a fix needs to change a file outside the default `allowed-paths`, set `allowed-paths` on the publish step.

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
