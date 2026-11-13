# Changelog

All notable changes to AutoHeal AI. Versions follow [semantic versioning](https://semver.org/).

## 0.15.0 (2026-11-13)

### Added
- **The heal job signs in too.** With a live app (`start-command` or `app-url`), the Action's new `login-url`, `login-steps`, `login-check`, `login-totp-env` and `session` inputs (or the `--login-*` / `--session` flags of `autoheal heal`) sign in through the engine's `save-login` before the AI checks locators, so pages behind a login are inspected as the tests see them. Secrets stay `{{env:NAME}}` from the step's env. A failed sign-in is logged and healing goes on from the traces; the session file the job made is deleted at the end and never packed into a fix. The PR summary says when the AI worked signed in.
- playwright-e2e-mcp 0.16.2.

## 0.14.0 (2026-11-13)

### Added
- **`autoheal cover` for flows behind a login.** `--login-step` (repeatable), `--login-url`, `--login-check` and `--login-totp-env` sign in once through the engine's `save-login`, with secrets written as `{{env:E2E_PASSWORD}}` and two-factor codes as `{{totp}}`, so no secret reaches the AI, the logs or the test. Pages then open as the signed-in user and the new test loads the same session (`test.use({ storageState })`, or pytest's `browser_context_args`). `--session <file>` alone reuses a session your Playwright setup project already makes.
- The new-test guard refuses a test that loads any session file other than the configured one, and a login step that types a password as plain text.
- `autoheal_cover` (MCP) takes `session`.
- Library: `ensureSession`, `checkLogin`, `parseLoginStep`, `sessionPrompt`, `sessionFindings` (used by KeepGreen 0.3.0).

## 0.13.0 (2026-11-13)

Fixes from a cross-repo audit of AutoHeal, playwright-e2e-mcp, KeepGreen and the demo repo.

### Fixed
- **OpenRouter could not be used from the GitHub Action.** The heal action had `base-url` but no way to pass the endpoint's key, so OpenRouter and other hosted OpenAI-compatible endpoints only worked locally. New `api-key` input (`AUTOHEAL_API_KEY`).
- **OpenRouter models needed hand-set prices.** AutoHeal fails closed without a price, so every OpenRouter run stopped unless `price-in`/`price-out` were set. For an OpenRouter `base-url`, AutoHeal now looks the model up in OpenRouter's public model list (no key is sent). Hand-set prices still win.
- **`autoheal cover --url` refused a deployed app.** Only an app AutoHeal starts itself must be on this machine; an already running staging or preview app now works.
- **The metrics workflow template ran AutoHeal 0.9.0.** Every template, the README and the demo now pin this version, and a test keeps them in step.

### Changed
- playwright-e2e-mcp 0.15.0 to 0.16.1: Playwright 1.65, GitHub tokens kept out of test processes, capped CI downloads.

## 0.12.1 (2026-11-09)

Fixes found by running 0.12.0 for real: a real WebdriverIO project and a public GitHub demo repository ([xsignon-secure/autoheal-demo](https://github.com/xsignon-secure/autoheal-demo)) where AutoHeal healed real PRs and answered real `/autoheal` commands.

### Fixed
- **WebdriverIO results were never read.** `@wdio/junit-reporter` writes `wdio-<id>-junit-reporter.log` files by default, not `.xml`, so AutoHeal found no failures. Those files are read now, spec paths given as `file://` URLs are resolved, and quoted expected/actual values are unquoted, so a wrong price is reported as `$10` vs `$12`.
- **"One UI change, one fix" grouped different changes.** Two UI changes made in the same commit (a renamed label and a renamed test id) were shown as one change. Fixes are now grouped by the locator change itself.
- **`/autoheal apply` left the PR without test results.** A push made with the workflow token starts no workflows, so the applied fix was never tested on the PR. Apply now starts the test workflow on the PR branch (the `rerun-workflow` input, or the workflow of the failed run, found automatically) and says so in its reply.
- **An applied fix was learned as rejected.** `/autoheal apply` closes the fix PR after copying the fix, and the review learner read that as "closed without merging", so the same fix was refused on the next PR. The fix PR is now closed with an `autoheal-applied` marker and counts as accepted, and fix PRs applied by 0.12.0 are recognized from their "Applied to ..." comment.
- **`/autoheal explain` pasted the whole fix PR.** It now answers with a short table (test, locator change, how it was fixed) and the tests left alone on purpose, without the PR's hidden markers.
- **A run that fixed nothing stayed silent.** The failing PR now gets a comment with the reason for each test (for example "the same change was closed without merging in PR #2") and how to retry.
- A test skipped because reviewers closed the same change before no longer says "no AI key is set"; it says the change was declined and how to undo that.
- The report footer no longer says "with your own AI key" on runs without one.
- Spend shows `$0` when no tokens were used, instead of "not priced".

### Changed
- CI runs the WebdriverIO and heal-during-the-run scenarios of the simulation against real WebdriverIO and Playwright.

## 0.12.0 (2026-11-09)

Everything from the market review: AutoHeal now heals during the run, fixes inside the failing PR, triages visual changes, fixes flaky tests, supports WebdriverIO, writes new tests, and works as an MCP server.

### Added
- **Heal during the run (Playwright).** `import { test } from 'xsignon-autoheal/playwright'` (or `withAutoHeal(test)`) heals an action whose locator finds nothing from the element's saved fingerprint, so the run stays green. Modes `heal`, `report` and `off` (`AUTOHEAL_RUNTIME`). Each heal is logged, annotated and written to `autoheal-healed/`; the heal job turns it into a code fix proven with runtime healing off. The workflow template also heals green runs that uploaded an `autoheal-healed` artifact, and `autoheal fix` does the same locally.
- **Fix on the failing PR.** Publish input `fix-target: pr-branch` pushes the fix as one more commit onto the failing PR's own branch (never forced, never the default or a shared branch; falls back to a separate PR). The failing PR always gets a comment that links the fix. AutoHeal never heals a run of its own fix commit.
- **Chat commands.** `templates/autoheal-commands.yml` and the `command` action: `/autoheal apply`, `retry`, `explain`, `ignore` and `help` on the failing PR or the fix PR, for owners, members and collaborators.
- **Grouping by cause.** Failures with the same broken locator or the same wrong value are one group; `max-failures` counts groups, and repeats of one app bug are reported without tokens. The PR shows the number of distinct causes.
- **Flaky tests are fixed first.** The AI looks for the race and a deterministic fix, which must pass at least 10 runs in a row (input `fix-flaky`, default on); otherwise the test is quarantined. A new `autoheal-history` artifact keeps each test's failures across runs, and the PR shows them.
- **Visual snapshot triage.** A `toHaveScreenshot` failure updates the existing baseline only when app files changed since it was committed (named in the PR, old and new baseline side by side), proven by the stability rerun; otherwise it is an app bug. New fix kind `baseline` in `.autoheal.yml` `fixes.allow`. The publish job accepts these PNGs and nothing else binary.
- **WebdriverIO.** Projects with `wdio.conf.*` are healed through WebdriverIO: results from `@wdio/junit-reporter` (or `wdio-json-reporter`), single-test reruns through the Launcher in the sandbox, WebdriverIO locator advice for the AI, and anti-cheat rules for `browser.execute`, `browser.mock`, command overrides and `browser.pause`. `framework: webdriverio` (or `wdio`).
- **`autoheal cover`.** Writes one new test for a flow with no test (`--flow "..."`), exploring the running app; kept only if it passes a guard built for new tests and 5 runs in a row.
- **`autoheal mcp`.** AutoHeal as an MCP server (stdio) with `autoheal_fix`, `autoheal_cover`, `autoheal_doctor` and `autoheal_learn`, and an agent skill in `skills/autoheal/SKILL.md`.
- **Head-to-head benchmark.** `BENCH_FIXER="<command>" npm run bench -- --setups fingerprints,external` runs any other fixer on the same failed project and scores it the same way, with a new **cheats** column (a test that passes only because it was weakened, judged by the anti-cheat scan). Two new cases: an icon button whose title changed (fix) and a list that lost an item (trap).

### Changed
- The engine's environment always has `AUTOHEAL_RUNTIME=off`, so reruns prove the code itself.
- Triage knows WebdriverIO's "element wasn't found" errors as locator drift.
- The action's Marketplace description lists every framework.

## 0.11.0 (2026-11-08)

### Added
- **GitLab CI and CircleCI.** New templates `templates/gitlab-ci.yml` (jobs `autoheal-heal` in `.post` on failure, `autoheal-publish` in the `autoheal-publish` environment, and a scheduled `autoheal-learn`) and `templates/circleci-config.yml` (heal after `e2e: failed`, publish in the `autoheal-publish` context, daily learn). Fixes arrive as a draft merge request on GitLab (self-managed too) and as a PR or MR from CircleCI. New command `autoheal publish`, which the templates call. The heal job prepares the sandbox user itself outside GitHub Actions (`--setup-sandbox`, automatic on GitLab and CircleCI).
- **Runs on your machine.** `autoheal fix` runs your tests with the right reporter and traces, heals what failed with the same checks as CI, and leaves verified changes in the working tree. Nothing is committed or pushed.
- **`autoheal init` and `autoheal doctor`.** `init` detects your framework, CI and package manager, writes the workflow with your Node or Python version and install command filled in, adds AutoHeal's folders to `.gitignore`, checks your test config (report, traces, artifacts, `workflow_dispatch`, the Cypress plugin) and prints the steps left with direct links. `doctor` runs the same checks plus Node, git remote, AI key, fingerprints and sandbox.
- **CI runs on the fix PR.** The publish job starts your test workflow on the fix branch with `workflow_dispatch` (new publish input `rerun-workflow`; the template passes it and gives the publish job `actions: write`). No personal token or GitHub App needed.
- **Learned fingerprints.** `autoheal learn` runs the suite once with traces on and saves fingerprints. Each template has a daily learn job that saves them as an artifact or cache, and the heal job downloads the newest one, so fixes without AI work from the first broken locator. Set `AUTOHEAL_LEARNED=false` to skip them.
- **Cypress plugin.** `import 'xsignon-autoheal/cypress'` in the support file and `require('xsignon-autoheal/cypress/plugin')(on, config)` in the config record what each `cy.get`/`.find` found and the page when a query fails. Cypress now gets element-fingerprint fixes with no AI tokens (writing `data-cy`/`data-test`/`data-testid`, stable id, `name` or `aria-label` selectors), learned fingerprints, "one UI change, one fix" and quarantine of flaky tests.
- **Screenshots inside the PR.** The before/after screenshots of each kept fix are shown in the PR or MR description (GitHub: committed to the `autoheal-evidence` branch and linked by commit; GitLab: project uploads).
- **Demo project** in `examples/demo`: a small shop with Playwright tests and AutoHeal set up, plus a commit script that renames a button, to see a fix PR in a few minutes.
- The command is also installed as `xsignon-autoheal`, matching the package name.

### Changed
- The publish step uses the GitHub and GitLab REST APIs directly instead of the `gh` CLI.
- Commit links, run links and the PR footer follow the CI the run came from.
- Run ids may contain letters and dashes (CircleCI workflow ids).

## 0.10.0 (2026-11-05)

### Added
- **Cypress support.** A project with a `cypress.config.*` (and no Playwright config) is healed through Cypress: AutoHeal reads Cypress's JUnit XML (the built-in junit reporter), mochawesome JSON or `cypress.run()` results, triages each failure (a missing element or content is locator drift; `expected '<p>' to have text '$10', but the text was '$12'` and chai's `expected 'B' to equal 'A'` are app bugs; server, crash, config and compile errors are environment), shows the AI Cypress's failure screenshot, and reruns specs through Cypress's module API in the sandbox. A fix must pass 3 separate runs and leave the rest of the spec no worse. New input and option `framework` (`auto`, `playwright`, `pytest`, `cypress`). The sandbox setup copies the Cypress binary into the sandbox user's home. Fixes without AI, the runtime guard and quarantine still need Playwright traces; the README lists what works where.
- **Cypress anti-cheat rules.** `.should(...)`, `.and(...)` and chai assertions are counted and their expected values protected; the asserted text of `cy.contains(...)` may not change; `cy.visit` counts as navigation; `cy.intercept`, `cy.stub`, `cy.clock`, `cy.window`, `.invoke`, `cy.exec`, `cy.task`, `cy.request`, `Cypress.env`, `Cypress.config`, `uncaught:exception` and `fail` handlers, `xit`/`xdescribe`, `this.skip()`, `context.skip`, `cy.wait(<ms>)` and `{ force: true }` are blocked or warned. Cypress changes always get the strict local scan (WARN blocks).
- **Benchmark.** `npm run bench` builds a project with 13 cases (9 UI changes a heal should fix: renamed button, link, label, placeholder, aria-label, changed test id, id and class, and a renamed button next to a look-alike; 4 app changes it must leave alone: a changed price, a changed heading, a removed feature and a button that now does something else), records a green run, breaks it, and heals it with and without fingerprints (and with your AI key when `BENCH_AI=1`). It reports fixed, wrong fixes, false fixes on traps, tokens, cost and time. Results for this release are in [`bench/RESULTS.md`](bench/RESULTS.md).
- The simulation has a `cypress` scenario that runs the dummy shop with real Cypress in CI.

### Changed
- The publish job's default `allowed-paths` includes `**/*.cy.*`, and it never patches `cypress/support/`, `cypress/plugins/` or `cypress.env.json`.
- `summary.json` records the `framework`.

## 0.9.0 (2026-11-05)

### Added
- **`autoheal metrics`.** A Markdown report of how AutoHeal is doing in a repository, read from GitHub and the checkout with no server and no AI. It covers fix PRs opened, merged as written, merged after edits, closed and still open; the acceptance rate and median time to merge; fixes by kind and the share made without AI; AI spend and estimated time saved; the test files fixed most often; app-bug issues opened and closed; and quarantined tests (active, expiring within 7 days, expired). `--json` saves the numbers, and in GitHub Actions the report also goes to the job summary.
- **Weekly metrics workflow:** `templates/autoheal-metrics.yml`. Read-only permissions, no AI key.
- Fix PR descriptions now carry a hidden `autoheal-run` line with the run's spend, tokens, time saved and counts, so metrics can add them up.

## 0.8.0 (2026-11-04)

### Added
- **Policy file.** A `.autoheal.yml` at the repository root sets team rules: `protect` (paths a fix may never change), `skip` (tests left alone, by file or title), `fixes.allow` (rules, fingerprint, same-change, ai), `fixes.min-strength` (the weakest locator a fix may write), `fixes.max-per-pr`, `quarantine` (on or off, `max-days`), `limits` (`max-usd`, `max-failures`, `repeat-each`) and `issues` (on or off, `min-confidence`). A policy can only make AutoHeal stricter than the workflow. The heal job reads it before any project code runs; the publish job checks the patch against it again and refuses changes to the policy file itself. An invalid file stops the job with the line number. Example in `templates/autoheal-policy.yml`.
- The PR and the job summary say which policy applied, and skipped tests are listed with the rule that skipped them.

## 0.7.0 (2026-11-04)

### Added
- **Find the cause.** For each fixed locator and each app bug, AutoHeal searches the repository history (`git log -S`, test and AutoHeal files excluded) for the most recent app commit that removed the old text or added the new one, and checks the direction of the change. The PR shows a "Likely cause" row with the commit linked, the app-bug issue names it, and "One UI change, one fix" groups fixes by that commit. The workflow template now checks out 200 commits (`fetch-depth: 200`).
- **Learn from reviews.** AutoHeal PR bodies now start with a hidden list of their fixes. Before healing, the heal process reads the last 20 closed AutoHeal PRs from the same repository and sorts each fix into merged as written, edited by a reviewer (the reviewer's change to that file is read from the compare view) or closed. A rule or fingerprint fix equal to one that was closed is not proposed again, and the result says which PR closed it. The AI's repo memory includes what reviewers kept, edited and closed. The job summary counts them. New input `learn-from-reviews` (default `true`); the template's heal job now has `pull-requests: read`. If the PRs can't be read, healing goes on and the summary says why.

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
