#!/usr/bin/env node
/**
 * Runs Cypress specs for AutoHeal through Cypress's module API and writes a
 * small results file. AutoHeal starts this as the sandbox user, in the project
 * folder, with the AI key and runner tokens removed from the environment.
 *
 *   node cypress-run.mjs <results.json> <spec> [spec...]
 *
 * Cypress is loaded from the project's own node_modules, so the project's
 * Cypress version and config are used. Retries are off: AutoHeal decides how
 * many times a test runs.
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [out, ...specs] = process.argv.slice(2);
if (!out || !specs.length) {
  console.error('usage: cypress-run.mjs <results.json> <spec> [spec...]');
  process.exit(2);
}

const write = (data) => writeFileSync(out, JSON.stringify(data), { mode: 0o644 });

let cypress;
try {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  cypress = require('cypress');
} catch (error) {
  write({ runs: [], failed: `Cypress is not installed in this project (${error instanceof Error ? error.message : error}). Run npm ci before AutoHeal.` });
  process.exit(1);
}

const results = await cypress.run({
  project: process.cwd(),
  spec: specs.join(','),
  quiet: true,
  config: { retries: { runMode: 0, openMode: 0 }, video: false },
});

const runs = (results?.runs ?? []).map((run) => ({
  spec: run.spec?.relative ?? run.spec?.absolute ?? '',
  tests: (run.tests ?? []).map((t) => ({
    title: Array.isArray(t.title) ? t.title : [String(t.title ?? '')],
    state: t.state,
    displayError: t.displayError ?? null,
  })),
  screenshots: (run.screenshots ?? []).map((s) => ({ path: s.path ? path.relative(process.cwd(), s.path) : '' })),
}));
write({ runs, ...(results?.status === 'failed' ? { failed: String(results.message ?? 'Cypress could not run') } : {}) });
