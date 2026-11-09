---
name: autoheal
description: Fix failing end-to-end tests (Playwright, pytest-playwright, Cypress, WebdriverIO) without weakening them, or write a new proven test for an uncovered user flow, with AutoHeal AI.
---

# AutoHeal AI

Use this skill when end-to-end tests fail and the user wants them fixed, when a
flow has no test yet, or when setting up AutoHeal in CI.

AutoHeal fixes only **test bugs** (moved locators, stale waits, outdated
screenshot baselines after an intended UI change). App bugs are reported,
never hidden. Every fix passes an anti-cheat guard (no deleted or weakened
assertions, no skips, no faked network, no fixed waits) and a stability rerun
before it is kept.

## Fix failing tests on this machine

```bash
npx -y xsignon-autoheal fix            # runs the tests, fixes what broke, leaves changes uncommitted
git diff                               # review every change
```

Needs a clean git tree (or `--allow-dirty`) and, for fixes beyond the
deterministic ones, an AI key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`AUTOHEAL_BASE_URL` for a local model. `--max-usd` caps the spend.

## Write a test for a flow with no test

```bash
npx -y xsignon-autoheal cover --flow "a shopper adds two items and checks out" --url http://localhost:3000
```

The new test is kept only if it makes real assertions, drives the app, uses
no fakes or fixed waits, and passes 5 runs in a row.

## Heal during the run (Playwright Test)

```ts
// tests/fixtures.ts
export { test, expect } from 'xsignon-autoheal/playwright';
```

A broken locator is found again from its saved fingerprint while the test
runs, so the run stays green; each heal is recorded in `autoheal-healed/` and
the next AutoHeal job turns it into a proven code fix.

## In CI

```bash
npx -y xsignon-autoheal init           # writes the GitHub Actions, GitLab CI or CircleCI workflow
npx -y xsignon-autoheal doctor         # checks the setup, with a fix for each problem
```

Comment `/autoheal apply`, `/autoheal retry`, `/autoheal explain` or
`/autoheal ignore` on a pull request (with the autoheal-commands workflow).

## As an MCP server

```json
{ "mcpServers": { "autoheal": { "command": "npx", "args": ["-y", "xsignon-autoheal", "mcp"] } } }
```

Tools: `autoheal_fix`, `autoheal_cover`, `autoheal_doctor`, `autoheal_learn`.

## Rules for the agent

- Never edit a test to make it pass by changing what it expects; if the app is
  wrong, say so.
- Review AutoHeal's diff before committing; it never commits on its own locally.
