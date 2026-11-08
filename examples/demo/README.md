# AutoHeal AI demo shop

A tiny shop (plain Node, no dependencies) with three Playwright tests and [AutoHeal AI](https://github.com/xsignon-secure/AutoHeal-AI) already set up. Use it to watch AutoHeal fix a broken test in about five minutes, before you add it to your own project.

## On your machine (no account, no AI key needed)

```bash
npm install
npx playwright install chromium
npx playwright test                 # 3 passed
npx xsignon-autoheal learn          # records what each locator points at
./break-the-ui.sh                   # renames a button, changes a test id and the Pro price
npx xsignon-autoheal fix
git diff
```

`fix` reruns the tests and finds:

| Test | What changed | What AutoHeal does |
|---|---|---|
| `user can log in` | the "Log in" button is now "Sign in" | fixes the locator, proves it passes 5 times |
| `add a mug to the cart` | the button's test id changed | finds the same button by its fingerprint and writes a role locator |
| `pro plan price` | the price is now $12 | leaves the test alone and reports a likely app bug |

All three without an AI key. The fixes stay in your working tree; nothing is committed.

## On GitHub

1. Create a new repository and copy this folder's contents to its root (the `.github/` folder too).
2. Add a repository secret `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`). It is optional for this demo if you do step 4.
3. **Settings → Actions → General → Workflow permissions:** tick **Allow GitHub Actions to create and approve pull requests**.
4. Save fingerprints so fixes need no AI: `npx playwright test --trace on && npx xsignon-autoheal fingerprint --traces test-results`, then commit `.autoheal/fingerprints/`. (In a real project the daily learn job in `autoheal.yml` does this for you.)
5. Push to `main`. The "Playwright Tests" workflow passes.
6. Run `./break-the-ui.sh` and `git push`.

The tests fail, AutoHeal runs, and a few minutes later you have a draft PR that fixes the two tests (with before and after screenshots) and an issue about the price. The publish job starts the tests on the fix PR, so it gets its check.

## Files

- `app/server.mjs`: the shop.
- `tests/`: the Playwright tests.
- `.github/workflows/e2e.yml`: runs the tests and keeps the report and traces when they fail.
- `.github/workflows/autoheal.yml`: AutoHeal, the same file `npx xsignon-autoheal init` writes.
- `break-the-ui.sh`: the UI change.
