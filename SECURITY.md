# Security

## How AutoHeal protects your repository

AutoHeal runs an AI model against your code inside CI with write access, so it is designed on the assumption that the model can be wrong or manipulated. Text in a page, a trace or a test file could try to instruct it.

- **No forks.** The workflow template skips runs from forks, so untrusted code never runs with your tokens or your AI key.
- **No loops.** Runs on `autoheal/*` branches are skipped, and a fix PR is never opened against one.
- **Limited writes.** The model can only replace the failing test file or files it imports through relative paths. It cannot touch `.git`, `node_modules`, `.env*` or AutoHeal's own memory. It cannot create files.
- **Two anti-cheat scans** on every change, and a final one over all changes. Blocked:
  - a changed expected value, a weakened or removed assertion, or one that cannot fail;
  - faked network answers (`page.route`), injected scripts or page edits;
  - code a test fix never needs: environment variables, processes, system modules, raw network calls, `eval`, paths such as `.git/` and `/proc/`, or any of these hidden behind built-up names, globals or decoding.

  The scans are pattern based, so a determined obfuscation could still slip through. That is why every fix also runs without any token, must pass the stability rerun, and arrives as a draft PR for a person to review.
- **Short-lived push token.** Use a GitHub App token, installed on the one repository and expiring after an hour, rather than a PAT. See the README.
- **Secrets stay out of test runs.** Your tests, and every proposed fix, run in a child process without the AI key, the dashboard secret, `GITHUB_TOKEN`/`GH_TOKEN` or the Actions runtime tokens. The workflow checks out with `persist-credentials: false`, so no token sits in `.git/config` while tests run. The fix branch is pushed afterwards with the action's token.
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
- **Known limits.** Reruns assume tests are isolated; shared state can make a good fix fail its proof, but it cannot make a bad fix pass. The mock check compares shapes only, so it is a triage hint, not proof. The cost limit is an estimate from public prices.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Do not open a public issue. We aim to reply within 3 working days.
