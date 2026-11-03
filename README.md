# AutoHeal AI

**A free, self-hosted AI agent that fixes failing Playwright tests in your own CI, with your own AI key, and refuses to cheat.**

When your Playwright workflow fails, AutoHeal reads the report and traces, decides *why* each test failed, and acts on it:

| What it found | What it does |
|---|---|
| **Test bug** (locator moved, wrong wait, stale page object) | Fixes the test, proves the fix passes 5 runs in a row, and opens a draft PR with the evidence |
| **App bug** (the page shows the wrong thing) | Leaves the test alone and opens an issue with the evidence. It never "fixes" a test to hide a bug |
| **Flaky test** (passes and fails on the same code) | Quarantines it with an owner and an expiry date, so it stops blocking merges without disappearing |
| **Environment** (browser crash, server down, bad config) | Reports it and changes nothing |

It is MIT licensed and runs entirely on your GitHub runner. No AutoHeal server, no account, no telemetry. The only network calls are to the AI provider you choose.

## Why it is different

- **Anti-cheat guard.** Every proposed change goes through two independent scans: the engine's heal guard and a local scan. A fix is blocked if it removes or weakens an assertion, deletes a test, adds `skip`, `only`, `fixme` or `xfail`, adds an early return, or swallows errors. It is also blocked if it adds code a test fix never needs, such as reading environment variables, starting processes, loading system modules or making raw network calls. Raised timeouts, fixed waits, `force: true` and retries are blocked too, unless you allow warnings.
- **Stability proof.** A fix is kept only if the test passes `--repeat-each=5` and the rest of the file does not get worse. Anything else is reverted before the model even sees the result.
- **Triage first, AI second.** Most failures are classified with no AI at all. Locator fixes that the engine can verify against the trace are applied by rules, using no tokens. The model is only asked when it is actually needed.
- **Repo memory.** Fixes that worked are saved in `.autoheal/memory.json` in your repo. The agent reads them next time, so it learns your app's naming habits.
- **Hard budgets.** The cost limit per job (`max-usd`, default $1), the number of AI calls and the number of tokens are all capped.
- **Bring your own model.** Claude by default (`claude-opus-5-5`). OpenAI, or any OpenAI-compatible server (Ollama, vLLM, LM Studio), also works. With no key at all, it still triages, quarantines and applies rule-based fixes.

It is built on [playwright-e2e-mcp](https://www.npmjs.com/package/playwright-e2e-mcp), which does the report reading, trace analysis, heal guard, flaky detection and quarantine.

## Setup in 5 minutes

**1. Keep the report and traces from your test workflow.** In `playwright.config.ts`:

```ts
reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
use: { trace: 'retain-on-failure' },
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

**2. Add the AutoHeal workflow.** Copy [`templates/autoheal.yml`](templates/autoheal.yml) to `.github/workflows/autoheal.yml`. Under `workflows:`, put the `name:` of your test workflow.

**3. Add your AI key** as a repository secret named `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` (see below).

That is it. The next failed run gets healed. You can also start it by hand from the Actions tab (**AutoHeal AI → Run workflow**, with the failed run's ID).

> `workflow_run` only fires from the workflow file on your default branch, so merge the file there first.

### Let your CI run on the fix PR

PRs opened with the default `GITHUB_TOKEN` do not start other workflows; GitHub does this to prevent loops. If you want your tests to run on AutoHeal's PR, create a fine-grained PAT or a GitHub App token with *contents* and *pull requests* write access. Pass it as `github-token`:

```yaml
- uses: xsignon-secure/AutoHeal-AI@v0.1.0
  with:
    github-token: ${{ secrets.AUTOHEAL_TOKEN }}
```

## Modes

| `mode` | What happens |
|---|---|
| `comment` | Explains every failure and shows the proposed diffs as a PR or commit comment. Changes nothing. A good way to start. |
| `draft-pr` (default) | Pushes verified fixes and quarantine entries to `autoheal/<run id>` and opens a **draft** PR. |
| `pr` | The same, as a ready-for-review PR. |

AutoHeal never pushes to your base branch, never auto-merges, and never runs on its own `autoheal/*` branches.

## Inputs

| Input | Default | |
|---|---|---|
| `report` | `autoheal-artifacts` | Downloaded artifacts folder, a report file, or a run URL |
| `mode` | `draft-pr` | `comment`, `draft-pr` or `pr` |
| `working-directory` | `.` | Folder of the Playwright project |
| `anthropic-api-key` | | Your Anthropic key (model `claude-opus-5-5` unless `model` is set) |
| `openai-api-key` | | Your OpenAI key (set `model`) |
| `base-url` | | OpenAI-compatible endpoint for a local model (set `model`) |
| `model` | | Model id |
| `effort` | `medium` | Anthropic effort: `low` to `max` |
| `max-failures` | `3` | Failures to work on per run |
| `repeat-each` | `5` | Runs in a row a fix must pass |
| `max-usd` | `1.00` | AI cost limit per job (estimate) |
| `quarantine-days` | `14` | Quarantine length for flaky tests |
| `allow-warn` | `false` | Accept WARN findings (raised timeouts, fixed waits, `force`) |
| `app-url` | | A running copy of the app, so the agent can check locators live |
| `mocks-base-url` | | Live API to compare your mocks with |
| `base-branch` | failed branch | Branch the fix PR targets |
| `github-token` | `github.token` | Token for the fix branch, PRs and issues |
| `dashboard-url`, `dashboard-secret` | | Your optional self-hosted dashboard |

Outputs: `outcome` (`fixed`, `blocked`, `app-bug`, `quarantined`, `unfixed`, `nothing-to-do` or `error`), `fixed`, `blocked`, `pr-url`.

If a fix is blocked by the anti-cheat guard, the job fails, so that someone looks at it. The good fixes from the same run still get their PR.

## AI providers

| Provider | How |
|---|---|
| Anthropic (default) | `ANTHROPIC_API_KEY`. The model is `claude-opus-5-5`; change it with `model`. |
| OpenAI | `OPENAI_API_KEY` and `model` |
| Local or self-hosted | `base-url` (for example `http://localhost:11434/v1`) and `model` |
| None | No key: AutoHeal still triages, opens issues, quarantines flaky tests and applies rule-based locator fixes |

Your key goes only to that provider. It is never passed to your tests, the engine or the dashboard.

## pytest-playwright

The same pipeline works for Python projects (`pytest.ini`, `pyproject.toml` or `conftest.py` with no `playwright.config.*`). Use the commented Python setup block in the workflow template. Stability is proven with 3 separate runs.

## Command line

```bash
npx autoheal-ai heal --report playwright-report/results.json --mode comment
```

Run `npx autoheal-ai --help` for every option. Exit codes: `0` done, `1` error, `2` bad usage, `3` a fix was blocked.

## Self-hosted dashboard (optional)

The dashboard is a small Node server with SQLite that shows fixes, quarantines, blocked cheats, app bugs, time saved and AI spend across your repos.

```bash
docker build -t autoheal-dashboard .
docker run -p 8080:8080 -v autoheal-data:/data \
  -e AUTOHEAL_DASHBOARD_SECRET="$(openssl rand -hex 32)" \
  -e AUTOHEAL_DASHBOARD_VIEW_TOKEN="choose-a-view-token" \
  -e AUTOHEAL_DASHBOARD_REPOS="your-org/your-repo" \
  autoheal-dashboard
```

Then set `dashboard-url` and `dashboard-secret` in the workflow. Uploads are signed (HMAC-SHA256 with a 5 minute window). They carry labels, test titles, file paths and links only: no code, diffs, error text or secrets. Open the page once with `?token=<view token>`, and a cookie keeps you signed in.

## What it costs

AutoHeal is free. You pay only your AI provider. With the default limits, one job stops at $1. Most runs cost much less, because triage and rule-based fixes use no tokens.

## Development

```bash
npm ci
npm test            # unit tests
npm run simulate    # end-to-end runs against a dummy shop app with real Playwright
```

The simulation copies `simulation/fixture` (a small shop app with a renamed button, a moved element, a changed price and a flaky badge). It runs the real suite, heals it, and checks every outcome. That includes a scripted AI that tries to cheat, and every step of the GitHub Action run against a local git remote and a fake `gh`.

## License

MIT © XSignOn
