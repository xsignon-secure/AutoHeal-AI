# AutoHeal AI

**A free, self-hosted AI agent that fixes failing Playwright and Cypress tests in GitHub Actions, GitLab CI, CircleCI or on your own machine, with your own AI key, and refuses to cheat.**

```bash
npx xsignon-autoheal init     # writes the workflow for your CI and checks your setup
```

> **Names:** the npm package is `xsignon-autoheal`, the command it installs is `autoheal` (or `xsignon-autoheal`), and the code lives in the GitHub repo `xsignon-secure/AutoHeal-AI`. They are all the same tool.

Think of it as autonomous quality maintenance: your suite keeps itself green between releases, and every change still comes to you as a reviewable PR with proof.

When your Playwright (or Cypress) workflow fails, AutoHeal reads the report and traces, decides *why* each test failed, and acts on it:

| What it found | What it does |
|---|---|
| **Test bug** (locator moved, wrong wait, stale page object) | Fixes the test, proves the fix passes 5 runs in a row, and opens a draft PR with the evidence |
| **App bug** (the page shows the wrong thing) | Leaves the test alone and opens an issue with the evidence. It never "fixes" a test to hide a bug |
| **Flaky test** (passes and fails on the same code) | Quarantines it with an owner and an expiry date, so it stops blocking merges without disappearing |
| **Environment** (browser crash, server down, bad config, or a failure it cannot reproduce) | Reports it and changes nothing |

It is MIT licensed and runs entirely on your own runner or laptop. No AutoHeal server, no account, no telemetry. The only network calls are to the AI provider you choose and to your own code host (GitHub or GitLab) to open the fix.

| Where | How | Fix arrives as |
|---|---|---|
| GitHub Actions | [`templates/autoheal.yml`](templates/autoheal.yml) | draft pull request, with your CI started on it |
| GitLab CI | [`templates/gitlab-ci.yml`](templates/gitlab-ci.yml) | draft merge request (the MR pipeline runs on it) |
| CircleCI | [`templates/circleci-config.yml`](templates/circleci-config.yml) | pull request (GitHub) or merge request (GitLab) |
| Your machine | `npx xsignon-autoheal fix` | changes in your working tree, nothing committed |

Fixes without AI work from day one: a small daily job (or `autoheal learn` once) records what each locator points at, so a renamed button is fixed with no AI tokens. Every PR shows the failed run's screenshot next to the fixed run's, right in the description.

## Why it is different

- **Anti-cheat guard.** Every proposed change goes through two independent scans: the engine's heal guard and a local scan. A fix may change *how* an element is found or waited for, never *what* the test expects. A fix is blocked if it does any of these:
  - changes an expected text, value, URL or count;
  - removes or weakens an assertion, or adds one that cannot fail;
  - deletes a test, or adds `skip`, `only`, `fixme` or `xfail`;
  - adds an early return, or swallows errors;
  - fakes network answers, injects scripts or edits the page;
  - points the test at another page (a changed `goto`, `route` or `waitForURL`, or any URL written into the test);
  - deletes a user action such as a click or fill;
  - widens a locator with `.or()` or a whole-page selector;
  - changes what an assertion looks at (the text, role name or state inside `expect(...)`), or changes an action (`click` to `hover`) or drops an `await`;
  - adds code a test fix never needs (environment variables, processes, system modules, raw network calls) or hides such code behind built-up names and globals.

  On top of those rules, a fix may only *add* locators, waits, literals and names the file already uses (a token-level allowlist), so a fake comment inside a string or a split-up string cannot hide new code. Fixed waits, `force: true` and retries are blocked; raised timeouts are blocked unless you allow warnings. Every bypass found in our audits is in [`test/bypasses/corpus.mjs`](test/bypasses/corpus.mjs), and CI checks each one is blocked. The scan is a strong filter, not a proof. The stability rerun and your review of the draft PR are the other two layers.
- **Runtime guard.** The code scan reads text; the runtime guard watches what the test actually does. After a fix passes the scan and the stability rerun, AutoHeal runs the fixed test once more with a trace and compares it with the failed run's trace. It blocks the fix if:
  - an assertion the failed run made does not run again, or runs against another value (fewer or different checks);
  - a step both runs share happens on another page;
  - an action that worked before the failure now lands somewhere else on the page (another element).

  The PR shows what was compared, and links a screenshot of the failed run next to one of the fixed run at the same step. The failed run's trace stops at the failure, so steps after it can only be checked by the code scan. Needs `trace: 'retain-on-failure'` (or `on`) in your Playwright config; without a trace the PR says the runtime check was skipped. pytest fixes are checked by code and reruns only.
- **Stability proof.** A fix is kept only if the test passes `--repeat-each=5` and the rest of the file does not get worse. A fix to a page object or helper also reruns every spec that imports it. A rerun that crashes or runs no tests counts as a failure. Anything else is reverted before the model even sees the result. The repeats run back to back, so tests must clean up after themselves. If a test shares a database or other state without resetting it, a good fix can fail the proof and be reverted (lower `repeat-each`, or isolate the data). A bad fix is never kept because of this.
- **Tests run in a sandbox.** On Linux runners with passwordless sudo (GitHub-hosted Ubuntu), your tests and every proposed fix run as a separate user, `autoheal-sb`. AutoHeal's own process, which holds the AI key, runs as the runner user, and Linux does not let one user read another user's process memory or environment. So a test, or a fix the AI wrote, cannot read the key or the runner's tokens, and it cannot change `.git`. Where the sandbox cannot be set up (macOS, Windows, self-hosted runners without sudo), AutoHeal runs without it and the PR says so. Set `sandbox: user` to fail instead.
- **Secrets are scrubbed.** Before anything goes to the AI or into a PR, issue, comment or job summary, AutoHeal redacts known credential shapes: API keys, GitHub, AWS, Slack and Stripe tokens, JWTs, private keys, `Bearer` headers, `password=` values and passwords in URLs. It also redacts the value of every secret-looking environment variable on the runner.
- **It sees the page.** When a test fails, the AI is shown the page at that moment: Playwright's own failure screenshot, or the last frame from the trace before the failing step. So it can tell that a button moved, was renamed or is hidden behind a dialog, instead of guessing from the error text. The image comes from your run's own files (no extra browser run) and goes only to your AI provider. It never goes into a PR text, issue, comment or the dashboard. (The before/after screenshots of the runtime guard are a separate, optional run artifact; see `screenshots`.) It is on for Anthropic and OpenAI; turn it off with `vision: false`. Keep `screenshot: 'only-on-failure'` or a trace with screenshots in your config so there is something to see.
- **Triage first, AI second.** Most failures are classified with no AI at all. Locator fixes that the engine can verify against the trace are applied by rules, using no tokens. The model is only asked when it is actually needed.
- **Element fingerprints.** Every trace AutoHeal reads teaches it what each locator pointed at: the element's role, accessible name, test id, id, label and nearby heading. These are saved in your repo, one small file per locator under `.autoheal/fingerprints/`. When a locator breaks, AutoHeal looks for the element with the same fingerprint on the failed page and writes the strongest locator for it, with no AI tokens. For an assertion, the value being checked never counts toward a match, so a fingerprint can't move a check onto another element that just happens to show the expected text. To start with fingerprints on day one, run your suite once with `trace: 'on'` and then `npx xsignon-autoheal fingerprint --traces test-results`, and commit the result.
- **Strong locators.** Fixes follow Playwright's own order: `getByRole` with a name, then label, placeholder, text, alt or title, then test id, and CSS last. The PR shows each changed locator and whether it got stronger or weaker.
- **One UI change, one fix.** When one UI change breaks many tests, AutoHeal fixes the first and reuses that fix for every other test with the same broken locator, even past `max-failures`. If the fix was in a shared page object, the other tests are just rerun to prove they pass. Each reuse is still proven by its own stability rerun and runtime check. The PR groups those tests under one change.
- **Looks at the live app.** Give `start-command` (for example `npm run start`) and `start-url`, and the heal job starts your app so the AI can open pages and check locators against the real thing. The app runs like your tests: in the sandbox, without the AI key or tokens, and it is stopped at the end. If it doesn't come up, AutoHeal heals from the traces and says so in the PR.
- **Finds the cause.** For every fix and every app bug, AutoHeal searches your repository history for the app commit that made the test fail: the one that renamed "Log in" to "Sign in", or changed the price from $10 to $12. Test files and AutoHeal's own files never count. The PR and the issue name that commit and link it, and fixes caused by the same commit are grouped together. The template checks out the last 200 commits (`fetch-depth: 200`) for this; with a shallow checkout the search simply finds nothing.
- **Learns from reviews.** Every AutoHeal PR carries a hidden list of its fixes. Before healing, AutoHeal reads your last closed AutoHeal PRs (read-only, `pull-requests: read`) and sees which were merged as written, merged after a reviewer edited them (and what they changed), or closed. A rule or fingerprint fix that reviewers already closed is not proposed again, and the AI is told what reviewers kept and changed. Turn it off with `learn-from-reviews: false`.
- **Team rules in the repo.** A `.autoheal.yml` policy file says what AutoHeal may do: folders it must never change, tests it leaves alone, which kinds of fixes it may propose, how weak a locator may be, and tighter limits. It can only make AutoHeal stricter than the workflow, and both jobs enforce it. See [Policy file](#policy-file-autohealyml).
- **Metrics without a server.** `npx xsignon-autoheal metrics` (or the weekly [metrics workflow](templates/autoheal-metrics.yml)) reports how many fix PRs were merged, edited or closed, the acceptance rate, how many fixes needed no AI, AI spend, time saved, app-bug issues, and quarantined tests that have expired. See [Metrics](#metrics).
- **Repo memory.** Fixes that worked are saved in your repo, one small file per fix under `.autoheal/memory/`, so two open fix PRs never conflict. The agent reads them next time, so it learns your app's naming habits.
- **Hard budgets.** The cost limit per job (`max-usd`, default $1), the number of AI calls and the number of tokens are all capped. Each failure gets an equal share of what is left, so one hard failure cannot use up the whole job. Before every AI call, AutoHeal checks that call's worst case (its estimated input plus the full output allowance), so no single call can cross the limit. The cost is an estimate from public prices; set `price-in` and `price-out` if yours differ (required for models it has no price for). When a limit stops the job, the report says so and nothing half-done is kept.
- **Bring your own model.** Claude by default (`claude-opus-5-5`). OpenAI, or any OpenAI-compatible server (Ollama, vLLM, LM Studio), also works. With no key at all, it still triages, quarantines and applies rule-based fixes.

It is built on [playwright-e2e-mcp](https://www.npmjs.com/package/playwright-e2e-mcp), which does the report reading, trace analysis, heal guard, flaky detection and quarantine.

## Setup in 2 minutes

In your project:

```bash
npx xsignon-autoheal init
```

`init` finds your test framework (Playwright, pytest-playwright or Cypress), your CI (from `.github/`, `.gitlab-ci.yml` or `.circleci/`, or `--ci github|gitlab|circleci`) and your package manager, and writes the AutoHeal workflow with your Node or Python version and install command already filled in. It adds AutoHeal's working folders to `.gitignore`, then checks your test config and prints exactly what is missing (for example "set `trace: 'retain-on-failure'` in playwright.config.ts") and the two or three clicks left: the AI key secret and, on GitHub, letting Actions open PRs, each with a direct link to the settings page. Run `npx xsignon-autoheal doctor` any time to check again.

What `init` cannot know is your test environment: if your tests need services, a database, environment variables or test data, copy those steps from your test job into the AutoHeal workflow. AutoHeal reruns your tests there; if it cannot reproduce a failure, it says so and changes nothing. The written workflow marks the place for those steps.

<details>
<summary>Setting it up by hand (GitHub Actions)</summary>

**1. Keep the report and traces from your test workflow.** In `playwright.config.ts`:

```ts
reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
```

and at the end of your test job:

```yaml
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: playwright-results
    path: |
      playwright-report/
      test-results/
```

(The blob reporter works too.) Add `workflow_dispatch:` to the `on:` of your test workflow, so AutoHeal can start it on the fix branch.

**2. Add the AutoHeal workflow.** Copy [`templates/autoheal.yml`](templates/autoheal.yml) to `.github/workflows/autoheal.yml`. Under `workflows:`, put the `name:` of your test workflow, and make its install steps match your test job.

**3. Add your AI key** as a repository secret named `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` (see below). Use a key with a spend limit.

**4. Let Actions open pull requests.** In **Settings → Actions → General → Workflow permissions**, tick **Allow GitHub Actions to create and approve pull requests**. Without it, opening the fix PR fails with "GitHub Actions is not permitted to create or approve pull requests". (Organization settings can turn this off for every repo; ask an owner if the box is greyed out.)

</details>

That is it. The next failed run gets healed. You can also start it by hand from the Actions tab (**AutoHeal AI → Run workflow**, with the failed run's ID); AutoHeal looks the run up and heals that run's commit and branch.

> `workflow_run` only fires from the workflow file on your default branch, so merge the file there first.

**Try it first:** [`examples/demo`](examples/demo) is a tiny shop with Playwright tests and the workflow already set up. Copy it into a new repository, add your key, and push the commit that renames a button to watch AutoHeal open its first fix PR.

### How the two jobs work

| Job | Token | What it does |
|---|---|---|
| `heal` | read-only | Runs your tests, the triage, the AI and every proposed fix. Uploads a patch and the report as an artifact. |
| `publish` | can push and open PRs | A fresh checkout that never runs your project's code and installs nothing. It checks the patch (only existing test and page-object files, plus AutoHeal's memory and quarantine files; no `.github/`, `.git/`, config files, symlinks, renames or mode changes), applies it with git hooks off, and opens the PR, issues or comment. |

So a proposed fix that tries something nasty while your tests run never shares a job with a token that can push.

### Your CI runs on the fix PR

PRs opened with the default `GITHUB_TOKEN` do not start other workflows; GitHub does this to prevent loops. So after opening the PR, the publish job starts your test workflow on the fix branch itself (`workflow_dispatch`, which the default token may do; the template gives the publish job `actions: write` and passes `rerun-workflow`). The run shows up on the PR as a check. Your test workflow needs `workflow_dispatch:` in its `on:` list; if it is missing, the PR says so.

To have every normal `pull_request` workflow run as well, give the **publish** step a token from a GitHub App instead. Install the App on this one repository only, with *contents*, *pull requests* and *issues* write access. Its tokens expire after an hour:

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ vars.AUTOHEAL_APP_ID }}
    private-key: ${{ secrets.AUTOHEAL_APP_KEY }}
- uses: xsignon-secure/AutoHeal-AI/publish@v0.11.0
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    # ...the other inputs from the template
```

A fine-grained PAT limited to this repository works too, but it lives longer, so prefer the App. Either way the token only exists in the publish job.

### Screenshots in the PR

When the runtime guard runs, the PR shows the failed run's screenshot next to the fixed run's at the same step, inside the description. On GitHub the images are committed to a separate `autoheal-evidence` branch (images only, never merged, linked by commit so they can't change later); on GitLab they are uploaded to the project. Turn it off with `screenshots: false`.

## GitLab CI

```bash
npx xsignon-autoheal init --ci gitlab
```

This writes `.gitlab/autoheal.yml` and includes it from your `.gitlab-ci.yml`. It adds three jobs:

| Job | When | What it does |
|---|---|---|
| `autoheal-heal` | in the `.post` stage, only when an earlier job failed | Reads the report and traces your test job saved as artifacts, heals in the sandbox, and saves a patch. No write token. |
| `autoheal-publish` | after a heal | Checks the patch and opens a **draft merge request** (or a comment), and issues for app bugs. Runs in the `autoheal-publish` environment, so only it sees the write token. |
| `autoheal-learn` | on a schedule | Runs the tests once with traces on and saves element fingerprints as an artifact for the next heal. |

Your test job must keep its results as artifacts when it fails (`artifacts: when: always` with `playwright-report/` and `test-results/`, or Cypress's `cypress/results/` and `cypress/autoheal/`); `init` checks for this. Then:

1. Add `ANTHROPIC_API_KEY` as a masked CI/CD variable.
2. Create a project access token (role Developer, scopes `api` and `write_repository`) and add it as the masked variable `AUTOHEAL_GITLAB_TOKEN`, **scoped to the environment `autoheal-publish`**, so the heal job never has it.
3. Optional: a daily pipeline schedule on your default branch, for learned fingerprints.

The fix MR runs your normal merge-request pipeline. AutoHeal never runs on its own `autoheal/*` branches, on schedules, or for MRs from forks. Self-managed GitLab works: the address comes from `CI_SERVER_URL`. The jobs use the `mcr.microsoft.com/playwright` image; change it to your own if your tests need one (it needs Node 22.13+, and `sudo` or root for the sandbox).

## CircleCI

```bash
npx xsignon-autoheal init --ci circleci
```

CircleCI reads one file, so `init` writes `.circleci/autoheal.yml` for you to copy into `.circleci/config.yml`. Your test job persists its results to the workspace, and AutoHeal's jobs run after it fails (`requires: [e2e: failed]`). Create two contexts: `autoheal-ai` with `ANTHROPIC_API_KEY`, and `autoheal-publish` with `AUTOHEAL_GITHUB_TOKEN` (a fine-grained token with Contents, Pull requests and Issues read and write) or `AUTOHEAL_GITLAB_TOKEN`, depending on where your code lives. Restrict `autoheal-publish` to your default branch's pipelines with a security group if you can. The learn job saves fingerprints to the CircleCI cache on a daily schedule.

## On your machine

```bash
export ANTHROPIC_API_KEY=...        # optional: without it, only fixes without AI run
npx xsignon-autoheal fix
```

`fix` runs your tests with the right reporter and traces, heals what failed in the same way as CI (anti-cheat scans, stability reruns, runtime guard), and leaves the verified changes in your working tree. It commits nothing and pushes nothing; review them with `git diff`. It refuses to start on uncommitted changes (so you can tell its changes from yours) unless you pass `--allow-dirty`. Pass `--report <dir>` to heal a report you already have, for example the artifacts you downloaded from a failed CI run.

## Learned fingerprints

A fix without AI needs to know what the broken locator pointed at when it still worked. AutoHeal learns that from traces of passing tests:

- **Automatically:** the `learn` job in each CI template runs your suite once a day with traces on and saves the fingerprints as an artifact (`autoheal-fingerprints`) or cache. The heal job downloads the newest one. Nothing is committed.
- **By hand:** `npx xsignon-autoheal learn` runs your tests once and saves fingerprints to `.autoheal-learned/` (or `fingerprint --traces <dir>` to save them from a run you already made into `.autoheal/fingerprints/`, to commit).

Fingerprints are only hints: a fix found with one still goes through every scan, the stability rerun and the runtime guard. Fingerprints committed in `.autoheal/fingerprints/` win over learned ones. Set `AUTOHEAL_LEARNED=false` to ignore the learned ones.

## Modes

| `mode` | What happens |
|---|---|
| `comment` | Explains every failure and shows the proposed diffs as a PR or commit comment. Pushes nothing and opens no issues. A good way to start. |
| `draft-pr` (default) | Pushes verified fixes and quarantine entries to `autoheal/<run id>` and opens a **draft** PR. |
| `pr` | The same, as a ready-for-review PR. |

AutoHeal never pushes to your base branch, never auto-merges, and never runs on its own `autoheal/*` branches. Pass the same `mode` to both jobs (the template does).

## Policy file (`.autoheal.yml`)

Put a `.autoheal.yml` at the root of your repository to set team rules. Copy [`templates/autoheal-policy.yml`](templates/autoheal-policy.yml) to start. Every setting is optional:

```yaml
version: 1
protect:                  # never changed by a fix (a path ending in / covers its folder)
  - tests/payments/
skip:                     # left alone completely: reported, never touched
  files: [tests/legacy/**]
  titles: ["visual snapshot"]
fixes:
  allow: [rules, fingerprint, same-change, ai]   # drop ai for no AI fixes
  min-strength: good      # never write a locator weaker than this
  max-per-pr: 10
quarantine:
  enabled: true
  max-days: 7
limits:
  max-usd: 0.50
  max-failures: 3
  repeat-each: 8          # higher is stricter
issues:
  enabled: true
  min-confidence: 0.7
```

- **Stricter only.** Each limit takes the stricter of the policy and the workflow, and a switch the workflow turned off stays off. A loose policy changes nothing.
- **Checked twice.** The heal job reads the file before any of your code runs. The publish job reads it again from its own checkout and refuses a patch that breaks it. A fix can never change `.autoheal.yml` itself.
- **Mistakes stop the job.** An unknown setting, a bad value or a path outside the repository fails the heal job with the line number, so a typo can't loosen anything without you noticing.
- The file uses a small, safe part of YAML: maps, lists, quoted strings, numbers, `true`/`false` and comments.
- The PR and the job summary say which policy applied.

## Inputs

**Heal action** (`xsignon-secure/AutoHeal-AI@v0.11.0`):

| Input | Default | |
|---|---|---|
| `report` | `autoheal-artifacts` | Downloaded artifacts folder, a report file, or a run URL |
| `mode` | `draft-pr` | `comment`, `draft-pr` or `pr` |
| `working-directory` | `.` | Folder of the Playwright, pytest or Cypress project |
| `framework` | `auto` | `playwright`, `pytest` or `cypress`; `auto` reads the config files |
| `run-id`, `commit`, `branch` | the triggering run | The failed run (the template fills these in) |
| `anthropic-api-key` | | Your Anthropic key (model `claude-opus-5-5` unless `model` is set) |
| `openai-api-key` | | Your OpenAI key (set `model`) |
| `base-url` | | OpenAI-compatible endpoint for a local model (set `model`) |
| `model` | | Model id |
| `price-in`, `price-out` | | USD per million tokens, required for a model AutoHeal has no price for (`0` for a local model) |
| `effort` | `medium` | Anthropic effort: `low` to `max` |
| `vision` | `auto` | Show the AI the failure screenshot: `auto` (on for Anthropic and OpenAI, off for other endpoints), `true` or `false` |
| `screenshots` | `true` | Save a before and after screenshot of each kept fix as the run artifact `<result-name>-evidence` (14 days) and link it from the PR. `false` turns it off |
| `sandbox` | `auto` | Run tests and fixes as a separate Linux user that cannot read the AI key: `auto` (on where possible, otherwise off and the PR says so), `user` (required) or `off` |
| `max-failures` | `3` | Failures to work on per run |
| `repeat-each` | `5` | Runs in a row a fix must pass |
| `max-usd` | `1.00` | AI cost limit per job (estimate) |
| `quarantine-days` | `14` | Quarantine length for flaky tests |
| `allow-warn` | `false` | Accept WARN findings (raised timeouts) |
| `open-issues` | `true` | Open issues for app bugs |
| `issue-min-confidence` | `0.6` | How sure AutoHeal must be before it opens an app-bug issue; less certain ones are listed in the job summary |
| `app-url` | | A running copy of the app, so the agent can check locators live |
| `start-command` | | Starts your app in the heal job (for example `npm run start`). Runs in the sandbox without secrets, and is stopped at the end |
| `start-url` | `app-url` | Address to wait for after `start-command` (localhost only) |
| `start-timeout` | `120` | Seconds to wait for `start-url` to answer |
| `learn-from-reviews` | `true` | Read earlier AutoHeal PRs (needs `pull-requests: read`) and don't propose a change reviewers already closed |
| `mocks-base-url` | | Live API to compare your mocks with (a shallow shape check, used as a triage hint only) |
| `result-name` | `autoheal-result` | Name of the artifact handed to the publish job |
| `github-token` | `github.token` | Only used to download a run given as a URL |

Outputs: `outcome` (`fixed`, `blocked`, `app-bug`, `quarantined`, `unfixed`, `nothing-to-do` or `error`), `fixed`, `blocked`, `has-result`.

**Publish action** (`xsignon-secure/AutoHeal-AI/publish@v0.11.0`): `result-dir`, `mode`, `base-branch`, `run-id`, `commit`, `pr-number`, `blocked`, `open-issues`, `allowed-paths`, `allow-warn`, `quarantine-days`, `github-token`, `rerun-workflow` (the test workflow file to start on the fix branch), `dashboard-url`, `dashboard-secret`. Output: `pr-url`.

`allowed-paths` limits which files a fix may change. The default is `**/tests/**, **/test/**, **/e2e/**, **/playwright/**, **/*.spec.*, **/*.test.*, **/*.cy.*, **/test_*.py, **/*_test.py`. If your page objects live somewhere else (for example `src/pages/**`), add that folder. Files that tools load or run on their own (configs, `conftest.py`, `__init__.py`, setup and teardown files, `cypress/support/`, `cypress/plugins/`, `cypress.env.json`, `.pnpmfile.cjs`, gulp and grunt files) are never patched. Keep `allow-warn` and `quarantine-days` the same as in the heal job.

If a fix is blocked by the anti-cheat guard, the publish job fails, so that someone looks at it. The good fixes from the same run still get their PR.

## AI providers

| Provider | How |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY`. The model is `claude-opus-5-5`; change it with `model`. |
| OpenAI | `OPENAI_API_KEY` and `model` |
| Local or self-hosted | `base-url` (for example `http://localhost:11434/v1`), `model`, and `price-in: '0'`, `price-out: '0'` |
| None | No key: AutoHeal still triages, opens issues, quarantines flaky tests and applies rule-based locator fixes |

For a model AutoHeal has no price for, the job stops with a clear error until you set `price-in` and `price-out`, because otherwise the cost limit could not work.

Your key goes only to that provider. AutoHeal does not pass it to your tests, your app, the engine or the dashboard. With the sandbox on (the default on GitHub-hosted Linux runners), code in your tests or a proposed fix cannot read it from the parent process either. Where the sandbox is off, it could, so use a key with a spend limit, and rotate it if a fix PR ever looks hostile.

## pytest-playwright

The same pipeline works for Python projects (`pytest.ini`, `pyproject.toml` or `conftest.py` with no `playwright.config.*`). Use the commented Python setup block in the workflow template. Stability is proven with 3 separate runs.

## Cypress

A project with a `cypress.config.*` (and no `playwright.config.*`) is healed through Cypress itself. Set `framework: cypress` to force it.

**In your test workflow,** use Cypress's built-in junit reporter and upload the reports and screenshots when the run fails:

```yaml
- run: npx cypress run --reporter junit --reporter-options "mochaFile=cypress/results/results-[hash].xml"
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: cypress-results
    path: |
      cypress/results/
      cypress/screenshots/
```

mochawesome JSON and the JSON from `cypress.run()` work too. In the AutoHeal workflow, install with `npm ci` (which downloads the Cypress binary); see the comment in the template.

**Add the plugin** for fixes without AI and quarantine. In `cypress/support/e2e.js`:

```js
import 'xsignon-autoheal/cypress';
```

and in `cypress.config.js`:

```js
const { defineConfig } = require('cypress');
const autoheal = require('xsignon-autoheal/cypress/plugin');

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      autoheal(on, config);
      return config;
    },
  },
});
```

(`import autoheal from 'xsignon-autoheal/cypress/plugin'` in an ES module config.) The plugin records, for each test, what its `cy.get` and `.find` calls found, and when a query finds nothing, the page at that moment. It saves this to `cypress/autoheal/`; keep that folder in your failure artifacts. It also skips tests listed in `playwright-quarantine.json` (the same file Playwright projects use) until their entry expires. It never changes what a test does.

**What is the same:** triage (a missing element is a test bug; `expected '<p>' to have text '$10', but the text was '$12'` is an app bug), the AI fix, the policy file, budgets, the sandbox (the setup step copies the Cypress binary into the sandbox user's home), "find the cause", reviews and metrics. Every fix must pass 3 separate Cypress runs of the spec, and the rest of the spec must not get worse. The AI sees Cypress's failure screenshot.

**The anti-cheat scan knows Cypress.** On top of the rules above, a fix may not change or remove a `.should(...)`, `.and(...)` or chai `expect(...)`, change the text of a `cy.contains(...)` that is asserted, change `cy.visit(...)`, add `cy.intercept`, `cy.stub`, `cy.clock`, `cy.window`, `.invoke(...)`, `cy.exec`, `cy.task`, `cy.request`, `Cypress.env`, `Cypress.config` or an `uncaught:exception` handler, or add `it.skip`, `xit`, `this.skip()`, `cy.wait(<ms>)` or `{ force: true }`. Cypress has no engine heal guard, so every Cypress fix gets the strict local scan: a WARN finding blocks it even with `allow-warn`.

**With the plugin, Cypress also gets:** element fingerprints (a renamed button is fixed with no AI tokens, with the strongest selector Cypress recommends: `data-cy`, `data-test` or `data-testid` first, then a stable id, then `name` or `aria-label`), learned fingerprints, "one UI change, one fix", and quarantine for flaky tests. Without the plugin, healing a broken selector needs an AI key and a flaky test is reported but not quarantined.

**What still needs Playwright:** the runtime guard (it compares Playwright traces). Cypress fixes are checked by the code scan and 3 separate runs. `start-command` works, and the AI can open pages of your app; it then writes the Cypress selector itself.

## Command line

```bash
npx xsignon-autoheal init       # write the CI workflow, check the setup
npx xsignon-autoheal doctor     # check this project and machine
npx xsignon-autoheal fix        # heal on your machine, changes left in the working tree
npx xsignon-autoheal learn      # save fingerprints from a green run
npx xsignon-autoheal heal --report playwright-report/results.json --mode comment
```

Installed (`npm i -D xsignon-autoheal`), the command is just `autoheal`.

Save element fingerprints from a green run (traces recorded with `trace: 'on'`), then commit `.autoheal/fingerprints/`:

```bash
npx playwright test --trace on
npx xsignon-autoheal fingerprint --traces test-results
```

Run `npx xsignon-autoheal --help` for every option. Exit codes: `0` done, `1` error, `2` bad usage, `3` a fix was blocked.

## Metrics

See how AutoHeal is doing in a repository, with no server and no AI:

```bash
GITHUB_TOKEN=... npx xsignon-autoheal metrics --repo owner/name --days 30
```

It prints a Markdown report:
- **Fix PRs:** how many were merged as written, merged after a reviewer edited them, closed or still open, the acceptance rate, and the median time to merge.
- **Fixes:** the count by kind (rules, fingerprint, same-change, AI) and the share that needed no AI.
- **Spend and time:** AI spend, and the estimated engineer time saved by merged PRs.
- **Test files fixed most often:** likely brittle tests worth a closer look.
- **App-bug issues** AutoHeal opened, and how many are closed.
- **Quarantined tests:** how many are active, which expire this week, and which have already expired, so someone can fix or remove them. Run the command from your checkout so it can read `playwright-quarantine.json`.

`--json <file>` also saves the numbers. In GitHub Actions the report goes to the job summary as well. Copy [`templates/autoheal-metrics.yml`](templates/autoheal-metrics.yml) to `.github/workflows/` for a weekly report. It only reads (`contents`, `pull-requests`, `issues`) and needs no AI key.

Spend and time saved come from a hidden line in each fix PR's description, which AutoHeal writes from 0.9.0 onwards. Older PRs are still counted, just without those two numbers.

## Self-hosted dashboard (optional)

The dashboard is a small Node server with SQLite that shows fixes, quarantines, blocked cheats, app bugs, time saved and AI spend across your repos.

```bash
docker build -t autoheal-dashboard .
docker run -p 8080:8080 -v autoheal-data:/data \
  -e AUTOHEAL_DASHBOARD_SECRET="$(openssl rand -hex 32)" \
  -e AUTOHEAL_DASHBOARD_VIEW_TOKEN="$(openssl rand -hex 24)" \
  -e AUTOHEAL_DASHBOARD_REPOS="your-org/your-repo" \
  autoheal-dashboard
```

Then set `dashboard-url` and `dashboard-secret` on the publish step. Uploads are signed (HMAC-SHA256 with a 5 minute window). They carry labels, test titles, file paths and links only: no code, diffs, error text or secrets. Open the page once with `?token=<view token>`, and a cookie keeps you signed in. The cookie holds an HMAC of the token, not the token. Uploads and viewing use separate secrets; rotate the upload secret if a repo with access is compromised.

Securing it:
- **A view token is required.** The dashboard refuses to start without one, unless you set `AUTOHEAL_DASHBOARD_PUBLIC=1` on purpose.
- **Rate limiting.** After 20 failed sign-ins or bad signatures, a client address is locked out for 10 minutes. A flood of new addresses cannot lift an active lockout. Bodies are capped at 256 KB, and nothing touches the database before the signature checks out.
- **HTTPS.** Put the dashboard behind an HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) and never expose port 8080 directly. Behind your own proxy, set `AUTOHEAL_TRUST_PROXY=1` so lockouts apply to the real client address (the last `X-Forwarded-For` entry, the one your proxy adds).
- **Allowlist.** Set `AUTOHEAL_DASHBOARD_REPOS` so only your repos can upload.
- **Size cap.** The database keeps the newest 100,000 results (`AUTOHEAL_DASHBOARD_MAX_EVENTS`), so even a leaked secret cannot fill the disk. Every query uses bound parameters.

## Benchmark

`npm run bench` builds a small app and a Playwright test per case, records a green run, makes 13 UI changes in one commit and heals the failed run. 9 changes only moved or renamed an element (a good heal fixes them); 4 changed what the app does (a changed price, a changed heading, a removed feature, a button that now does something else), where the test is right and must not be "fixed". Results with no AI key (unchanged since 0.10.0):

| Setup | Fixed | Wrong fixes | False fixes on traps | AI tokens |
|---|---|---|---|---|
| No fingerprints (rules only) | 0/9 | 0 | 0/4 | 0 |
| With fingerprints from a green run | 8/9 | 0 | 0/4 | 0 |

The one miss is a "Save" button renamed to "Save draft" next to a new "Save and publish": the fingerprint match is not clear enough, so AutoHeal leaves it for the AI or a person instead of guessing. Without fingerprints, every locator fix needs the AI. Per-case results are in [`bench/RESULTS.md`](bench/RESULTS.md). Run `BENCH_AI=1 npm run bench` with `ANTHROPIC_API_KEY` set to add an AI setup (it costs a little).

## What it costs

AutoHeal is free. You pay only your AI provider. With the default limits, one job stops at $1. Most runs cost much less, because triage and rule-based fixes use no tokens.

## Development

```bash
npm ci
npm test            # unit tests
npm run simulate    # end-to-end runs against a dummy shop app with real Playwright (and Cypress, when installed)
npm run bench       # the benchmark below
```

The simulation copies `simulation/fixture` (a small shop app with a renamed button, a moved element, a changed price and a flaky badge). It runs the real suite, heals it, and checks every outcome. That includes a scripted AI that tries to cheat, and both jobs of the GitHub Action run against a local git remote and a fake GitHub API, including eight tampered patches the publish job must refuse. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Releases** are published by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a `vX.Y.Z` tag is pushed after the release PR is merged. It checks that the tag matches `package.json` and is on `main`, runs the tests, then publishes to npm through npm trusted publishing (no token) with [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates the GitHub release. `npm view xsignon-autoheal --json` shows the provenance attestation.

## License

MIT © XSignOn
