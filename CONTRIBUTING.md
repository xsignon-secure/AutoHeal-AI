# Contributing to AutoHeal AI

Thanks for helping. Issues and pull requests are welcome.

## Setup

Node 22.13 or newer (`.npmrc` enforces it).

```bash
npm ci
npm test            # build + unit tests
npm run simulate    # end-to-end runs against the dummy shop (needs Playwright's Chromium and python3 with PyYAML)
```

For the simulation, install the dummy shop once:

```bash
cd simulation/fixture && npm install && npx playwright install --with-deps chromium
```

## Before you open a PR

- `npm test` passes.
- `npm run simulate` passes if you touched `src/heal.ts`, `src/agent.ts`, `src/cheat.ts`, `src/allowlist.ts`, `action.yml`, `publish/` or `scripts/`.
- `dist/` is rebuilt and committed (`npm run build`). CI fails when it is out of date, because the action runs `dist/` directly.
- New behaviour has a test. Anti-cheat changes need both a "blocked" and a "still allowed" case.
- `CHANGELOG.md` has a line under the next version.

## Security rules for changes

- The heal job must never get a token that can write. Anything that pushes, comments or opens issues belongs in `scripts/publish.mjs`.
- `scripts/publish.mjs` and `scripts/package.mjs` have no dependencies, so they run on the runner's own Node without `npm install`.
- Everything the publish job reads from the heal result is untrusted. Validate it there.
- Report vulnerabilities privately (see [SECURITY.md](SECURITY.md)), not in issues.

## Releasing

1. Bump `package.json`, `src/version.ts`, the `@v` tags in `templates/autoheal.yml` and `README.md`, and add the `CHANGELOG.md` entry.
2. `npm run build`, commit `dist/`, merge the PR.
3. Push the tag `vX.Y.Z` from `main`, then create the GitHub release.
