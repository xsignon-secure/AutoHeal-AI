# Security

## How AutoHeal protects your repository

AutoHeal runs an AI model against your code inside CI, so it is designed on the assumption that the model can be wrong or manipulated. Text in a page, a trace, a test file or the repo memory could try to instruct it; the prompt marks all of these as data.

- **Two jobs.** The heal job, where your tests and every proposed fix run, has a read-only token. It uploads a patch. The publish job never runs project code: in a fresh checkout it accepts only plain edits to existing source files plus AutoHeal's memory and quarantine files (no `.github/`, `.git/`, config files, new code files, symlinks, renames, deletes, mode changes or binary data), applies the patch with git hooks and fsmonitor off, and only then uses the write token.
- **Publish re-checks everything.** Nothing the heal job sends is trusted. On its own fresh checkout, the publish job:
  - runs the anti-cheat scan again on every changed file;
  - refuses files outside `allowed-paths` and files that tools load or run;
  - accepts a quarantine entry only for a test the run found flaky, for at most `quarantine-days`, and never removes one;
  - accepts a memory file only with AutoHeal's exact fields and the file name AutoHeal derives from its content.

  `@mentions` in PR, issue and comment text from the heal job are neutralized so they notify no one.
- **No forks.** The workflow template skips runs from forks, and manual runs look the run up and refuse forks too, so untrusted code never runs with your AI key.
- **No loops.** Runs on `autoheal/*` branches are skipped, and a fix PR is never opened against one.
- **Limited writes.** The model can only replace the failing test file or files it imports through relative paths. It cannot touch `.git`, `node_modules`, `.env*` or AutoHeal's own memory. It cannot create files.
- **Two anti-cheat scans** on every change, and a final one over all changes. Blocked:
  - a changed expected value, a weakened or removed assertion, or one that cannot fail;
  - faked network answers (`page.route`), injected scripts or page edits;
  - code a test fix never needs: environment variables, processes, system modules, raw network calls, `eval`, paths such as `.git/` and `/proc/`, or any of these hidden behind built-up names, globals or decoding.

  The scans are pattern based, so a determined obfuscation could still slip through. That is why every fix also runs without any token, must pass the stability rerun, and arrives as a draft PR for a person to review.
- **Short-lived push token.** Use a GitHub App token, installed on the one repository and expiring after an hour, rather than a PAT. See the README.
- **Secrets stay out of test runs.** Your tests, and every proposed fix, run in a child process without the AI key, the dashboard secret, `GITHUB_TOKEN`/`GH_TOKEN`, the Actions runtime tokens or `GITHUB_ENV`/`GITHUB_PATH`/`GITHUB_OUTPUT` (so they cannot change later steps). A run given as a URL is downloaded by a separate engine process that runs no tests. The workflow checks out with `persist-credentials: false`.
- **Screenshots go only to your AI provider.** With vision on (the default for Anthropic and OpenAI), the failure screenshot from your run's own artifacts is sent to the provider with the prompt. Text in an image cannot be scrubbed, so if your test pages show real customer data or secrets, set `vision: false`. Screenshots are never written to a PR, issue, comment, `summary.json` or the dashboard, and text in the image is treated as data like everything else.
- **Live page checks stay on your app.** With `app-url` set, the model can only open pages on that origin.
- **The model cannot quarantine.** Only real reruns that pass and fail on the same code can mark a test flaky.
- **Nothing is merged.** Fixes arrive as a (draft) PR for a human to review.
- **Dashboard.** Uploads are HMAC-signed with a 5 minute window and strictly validated before anything touches the database. They carry no code, diffs or error text.
  - A view token is required unless you make it public on purpose.
  - After 20 failed attempts, a client is locked out for 10 minutes.
  - Bodies are capped at 256 KB, and the database keeps at most 100,000 results.
  - Every query uses bound parameters.
  - The page sends a strict Content-Security-Policy and runs no scripts.
  - Run it behind HTTPS.
- **Secrets are scrubbed** from everything that leaves the runner: the AI prompt, PRs, issues, comments, the job summary and `summary.json`. The scrubber knows common credential shapes and the values of every secret-looking environment variable. It is pattern based, so keep secrets out of test output in the first place.
- **Known limits.** The AI key is in the heal job's main process. Code running in that job as the same user (a test, or a proposed fix during its rerun) could read it from `/proc`, so use a key with a spend limit. The write token is never in that job. Reruns assume tests are isolated; shared state can make a good fix fail its proof, but it cannot make a bad fix pass. The mock check compares shapes only, so it is a triage hint, not proof. The cost limit is an estimate from public prices, and the job refuses to start with a model that has no price unless you set one. Third-party actions in the template and in this repo's workflows are pinned to commit SHAs (Dependabot keeps them current). They run on Node 24, so self-hosted runners need version 2.327.1 or newer. The template refers to AutoHeal itself by tag; pin that to a commit SHA too if your policy requires it. The heal job uses no dependency cache, so nothing it saves can reach your other workflows.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Do not open a public issue. We aim to reply within 3 working days.
