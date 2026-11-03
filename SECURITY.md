# Security

## How AutoHeal protects your repository

AutoHeal runs an AI model against your code inside CI with write access, so it is designed on the assumption that the model can be wrong or manipulated. Text in a page, a trace or a test file could try to instruct it.

- **No forks.** The workflow template skips runs from forks, so untrusted code never runs with your tokens or your AI key.
- **No loops.** Runs on `autoheal/*` branches are skipped, and a fix PR is never opened against one.
- **Limited writes.** The model can only replace the failing test file or files it imports through relative paths. It cannot touch `.git`, `node_modules`, `.env*` or AutoHeal's own memory. It cannot create files.
- **Two anti-cheat scans** on every change, and a final one over all changes. Changes that weaken tests are blocked. So are changes that add code a test fix never needs: environment variables, processes, system modules, raw network calls, `eval`, or paths such as `.git/` and `/proc/`.
- **Secrets stay out of test runs.** Your tests, and every proposed fix, run in a child process without the AI key, the dashboard secret, `GITHUB_TOKEN`/`GH_TOKEN` or the Actions runtime tokens. The workflow checks out with `persist-credentials: false`, so no token sits in `.git/config` while tests run. The fix branch is pushed afterwards with the action's token.
- **Live page checks stay on your app.** With `app-url` set, the model can only open pages on that origin.
- **The model cannot quarantine.** Only real reruns that pass and fail on the same code can mark a test flaky.
- **Nothing is merged.** Fixes arrive as a (draft) PR for a human to review.
- **Dashboard.** Uploads are HMAC-signed with a 5 minute window and strictly validated. They carry no code, diffs or error text. Reading can require a view token. The page sends a strict Content-Security-Policy and runs no scripts.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security → Report a vulnerability). Do not open a public issue. We aim to reply within 3 working days.
