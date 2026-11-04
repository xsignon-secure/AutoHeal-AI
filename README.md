# AutoHeal AI

**A free, self-hosted AI agent that fixes failing Playwright tests in your own CI, with your own AI key, and refuses to cheat.**

Think of it as autonomous quality maintenance: your suite keeps itself green between releases, and every change still comes to you as a reviewable PR with proof.

When your Playwright workflow fails, AutoHeal reads the report and traces, decides *why* each test failed, and acts on it:

| What it found | What it does |
|---|---|
| **Test bug** (locator moved, wrong wait, stale page object) | Fixes the test, proves the fix passes 5 runs in a row, and opens a draft PR with the evidence |
| **App bug** (the page shows the wrong thing) | Leaves the test alone and opens an issue with the evidence. It never "fixes" a test to hide a bug |
| **Flaky test** (passes and fails on the same code) | Quarantines it with an owner and an expiry date, so it stops blocking merges without disappearing |
| **Environment** (browser crash, server down, bad config, or a failure it cannot reproduce) | Reports it and changes nothing |

It is MIT licensed and runs entirely on your GitHub runner. No AutoHeal server, no account, no telemetry. The only network calls are to the AI provider you choose.

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
- **Repo memory.** Fixes that worked are saved in your repo, one small file per fix under `.autoheal/memory/`, so two open fix PRs never conflict. The agent reads them next time, so it learns your app's naming habits.
- **Hard budgets.** The cost limit per job (`max-usd`, default $1), the number of AI calls and the number of tokens are all capped. Each failure gets an equal share of what is left, so one hard failure cannot use up the whole job. Before every AI call, AutoHeal checks that call's worst case (its estimated input plus the full output allowance), so no single call can cross the limit. The cost is an estimate from public prices; set `price-in` and `price-out` if yours differ (required for models it has no price for). When a limit stops the job, the report says so and nothing half-done is kept.
- **Bring your own model.** Claude by default (`claude-opus-5-5`). OpenAI, or any OpenAI-compatible server (Ollama, vLLM, LM Studio), also works. With no key at all, it still triages, quarantines and applies rule-based fixes.

It is built on [playwright-e2e-mcp](https://www.npmjs.com/package/playwright-e2e-mcp), which does the report reading, trace analysis, heal guard, flaky detection and quarantine.

## Setup in 5 minutes

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

(The blob reporter works too.)

**2. Add the AutoHeal workflow.** Copy [`templates/autoheal.yml`](templates/autoheal.yml) to `.github/workflows/autoheal.yml`. Under `workflows:`, put the `name:` of your test workflow. Then make its install steps match your test job: the same Node or Python version, browsers, environment variables, secrets, services and test data. AutoHeal reruns your tests there; if it cannot reproduce a failure, it says so and changes nothing.

**3. Add your AI key** as a repository secret named `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` (see below). Use a key with a spend limit.

**4. Let Actions open pull requests.** In **Settings → Actions → General → Workflow permissions**, tick **Allow GitHub Actions to create and approve pull requests**. Without it, opening the fix PR fails with "GitHub Actions is not permitted to create or approve pull requests". (Organization settings can turn this off for every repo; ask an owner if the box is greyed out.)

That is it. The next failed run gets healed. You can also start it by hand from the Actions tab (**AutoHeal AI → Run workflow**, with the failed run's ID); AutoHeal looks the run up and heals that run's commit and branch.

> `workflow_run` only fires from the workflow file on your default branch, so merge the file there first.

### How the two jobs work

| Job | Token | What it does |
|---|---|---|
| `heal` | read-only | Runs your tests, the triage, the AI and every proposed fix. Uploads a patch and the report as an artifact. |
| `publish` | can push and open PRs | A fresh checkout that never runs your project's code and installs nothing. It checks the patch (only existing test and page-object files, plus AutoHeal's memory and quarantine files; no `.github/`, `.git/`, config files, symlinks, renames or mode changes), applies it with git hooks off, and opens the PR, issues or comment. |

So a proposed fix that tries something nasty while your tests run never shares a job with a token that can push.

### Let your CI run on the fix PR

PRs opened with the default `GITHUB_TOKEN` do not start other workflows; GitHub does this to prevent loops. If you want your tests to run on AutoHeal's PR, give the **publish** step a token from a GitHub App. Install the App on this one repository only, with *contents* and *pull requests* write access. Its tokens expire after an hour:

```yaml
- uses: actions/create-github-app-token@v1
  id: app-token
  with:
    app-id: ${{ vars.AUTOHEAL_APP_ID }}
    private-key: ${{ secrets.AUTOHEAL_APP_KEY }}
- uses: xsignon-secure/AutoHeal-AI/publish@v0.5.0
  with:
    github-token: ${{ steps.app-token.outputs.token }}
    # ...the other inputs from the template
```

A fine-grained PAT limited to this repository works too, but it lives longer, so prefer the App. Either way the token only exists in the publish job.

## Modes

| `mode` | What happens |
|---|---|
| `comment` | Explains every failure and shows the proposed diffs as a PR or commit comment. Pushes nothing and opens no issues. A good way to start. |
| `draft-pr` (default) | Pushes verified fixes and quarantine entries to `autoheal/<run id>` and opens a **draft** PR. |
| `pr` | The same, as a ready-for-review PR. |

AutoHeal never pushes to your base branch, never auto-merges, and never runs on its own `autoheal/*` branches. Pass the same `mode` to both jobs (the template does).

## Inputs

**Heal action** (`xsignon-secure/AutoHeal-AI@v0.5.0`):

| Input | Default | |
|---|---|---|
| `report` | `autoheal-artifacts` | Downloaded artifacts folder, a report file, or a run URL |
| `mode` | `draft-pr` | `comment`, `draft-pr` or `pr` |
| `working-directory` | `.` | Folder of the Playwright project |
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
| `mocks-base-url` | | Live API to compare your mocks with (a shallow shape check, used as a triage hint only) |
| `result-name` | `autoheal-result` | Name of the artifact handed to the publish job |
| `github-token` | `github.token` | Only used to download a run given as a URL |

Outputs: `outcome` (`fixed`, `blocked`, `app-bug`, `quarantined`, `unfixed`, `nothing-to-do` or `error`), `fixed`, `blocked`, `has-result`.

**Publish action** (`xsignon-secure/AutoHeal-AI/publish@v0.5.0`): `result-dir`, `mode`, `base-branch`, `run-id`, `commit`, `pr-number`, `blocked`, `open-issues`, `allowed-paths`, `allow-warn`, `quarantine-days`, `github-token`, `dashboard-url`, `dashboard-secret`. Output: `pr-url`.

`allowed-paths` limits which files a fix may change. The default is `**/tests/**, **/test/**, **/e2e/**, **/playwright/**, **/*.spec.*, **/*.test.*, **/test_*.py, **/*_test.py`. If your page objects live somewhere else (for example `src/pages/**`), add that folder. Files that tools load or run on their own (configs, `conftest.py`, `__init__.py`, setup and teardown files, `.pnpmfile.cjs`, gulp and grunt files) are never patched. Keep `allow-warn` and `quarantine-days` the same as in the heal job.

If a fix is blocked by the anti-cheat guard, the publish job fails, so that someone looks at it. The good fixes from the same run still get their PR.

## AI providers

| Provider | How |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY`. The model is `claude-opus-5-5`; change it with `model`. |
| OpenAI | `OPENAI_API_KEY` and `model` |
| Local or self-hosted | `base-url` (for example `http://localhost:11434/v1`), `model`, and `price-in: '0'`, `price-out: '0'` |
| None | No key: AutoHeal still triages, opens issues, quarantines flaky tests and applies rule-based locator fixes |

For a model AutoHeal has no price for, the job stops with a clear error until you set `price-in` and `price-out`, because otherwise the cost limit could not work.

Your key goes only to that provider. AutoHeal does not pass it to your tests, the engine or the dashboard. It is still in the heal job, though, and code running there as the same user (your tests, or a proposed fix during its rerun) could in principle read it from the parent process. So use a key with a spend limit, and rotate it if a fix PR ever looks hostile.

## pytest-playwright

The same pipeline works for Python projects (`pytest.ini`, `pyproject.toml` or `conftest.py` with no `playwright.config.*`). Use the commented Python setup block in the workflow template. Stability is proven with 3 separate runs.

## Command line

```bash
npx xsignon-autoheal heal --report playwright-report/results.json --mode comment
```

Run `npx xsignon-autoheal --help` for every option. Exit codes: `0` done, `1` error, `2` bad usage, `3` a fix was blocked.

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

## What it costs

AutoHeal is free. You pay only your AI provider. With the default limits, one job stops at $1. Most runs cost much less, because triage and rule-based fixes use no tokens.

## Development

```bash
npm ci
npm test            # unit tests
npm run simulate    # end-to-end runs against a dummy shop app with real Playwright
```

The simulation copies `simulation/fixture` (a small shop app with a renamed button, a moved element, a changed price and a flaky badge). It runs the real suite, heals it, and checks every outcome. That includes a scripted AI that tries to cheat, and both jobs of the GitHub Action run against a local git remote and a fake `gh`, including eight tampered patches the publish job must refuse. See [CONTRIBUTING.md](CONTRIBUTING.md).

**Releases** are published by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a `vX.Y.Z` tag is pushed after the release PR is merged. It checks that the tag matches `package.json` and is on `main`, runs the tests, then publishes to npm through npm trusted publishing (no token) with [provenance](https://docs.npmjs.com/generating-provenance-statements), and creates the GitHub release. `npm view xsignon-autoheal --json` shows the provenance attestation.

## License

MIT © XSignOn
