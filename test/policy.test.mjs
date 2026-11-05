// 0.8.0: the .autoheal.yml policy file.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultPolicy, isProtected, loadPolicy, parsePolicyYaml, policyText, readPolicy, skipRule, tighten, tooWeak } from '../dist/policy.js';
import { checkPolicy } from '../scripts/publish.mjs';

const FULL = `# AutoHeal policy
version: 1
protect:
  - tests/payments/**
  - "e2e/legal/"   # a folder covers everything in it
skip:
  files: [tests/legacy/**]
  titles:
    - visual snapshot
fixes:
  allow: [rules, fingerprint, same-change]
  min-strength: good
  max-per-pr: 5
quarantine:
  enabled: false
  max-days: 7
limits:
  max-usd: 0.25
  max-failures: 2
  repeat-each: 8
issues:
  enabled: true
  min-confidence: 0.8
`;

test('policy: a full file is read with every setting', () => {
  const p = readPolicy(parsePolicyYaml(FULL));
  assert.deepEqual(p.protect, ['tests/payments/**', 'e2e/legal/']);
  assert.deepEqual(p.skip, { files: ['tests/legacy/**'], titles: ['visual snapshot'] });
  assert.deepEqual(p.fixes, { allow: ['rules', 'fingerprint', 'same-change'], minStrength: 'good', maxPerPr: 5 });
  assert.deepEqual(p.quarantine, { enabled: false, maxDays: 7 });
  assert.deepEqual(p.limits, { maxUsd: 0.25, maxFailures: 2, repeatEach: 8 });
  assert.deepEqual(p.issues, { enabled: true, minConfidence: 0.8 });
  assert.match(policyText(p), /2 protected paths; 2 skip rules; fixes allowed: rules, fingerprint, same-change; locators at least good; at most 5 fixes per PR; no quarantine/);
});

test('policy: an empty file means the defaults', () => {
  assert.deepEqual(readPolicy(parsePolicyYaml('# nothing yet\n')), defaultPolicy());
});

test('policy: mistakes stop the job instead of being ignored', () => {
  const bad = {
    'fixes:\n  alow: [ai]\n': /unknown setting "alow"/,
    'protect: ../secrets/**\n': /inside the repository/,
    'protect:\n  - /etc/**\n': /inside the repository/,
    'fixes:\n  allow: [magic]\n': /"magic" is not one of/,
    'limits:\n  max-usd: lots\n': /max-usd must be/,
    'limits:\n  max-failures: 2.5\n': /whole number/,
    'quarantine:\n  enabled: maybe\n': /true or false/,
    'version: 2\n': /version must be 1/,
    'protect: &x tests/**\n': /not supported/,
    'protect:\n\t- tests/**\n': /tabs/,
    'skip:\n  - files: a\n': /lists of maps/,
    'a: 1\na: 2\n': /appears twice/,
    'fixes:\n  min-strength: great\n': /min-strength must be one of/,
    'notes: |\n  text\n': /not supported/,
  };
  for (const [text, err] of Object.entries(bad)) assert.throws(() => readPolicy(parsePolicyYaml(text)), err, text);
  assert.throws(() => parsePolicyYaml('x'.repeat(30_000)), /larger than/);
});

test('policy: protect and skip match repo paths and titles', () => {
  const p = readPolicy(parsePolicyYaml(FULL));
  assert.ok(isProtected(p, 'tests/payments/card.spec.ts'));
  assert.ok(isProtected(p, 'e2e/legal/terms.spec.ts'), 'a folder entry covers its files');
  assert.ok(!isProtected(p, 'tests/cart.spec.ts'));
  assert.ok(!isProtected(null, 'tests/payments/card.spec.ts'));
  assert.equal(skipRule(p, 'tests/legacy/old.spec.ts', 'anything'), 'skip.files "tests/legacy/**"');
  assert.equal(skipRule(p, 'tests/home.spec.ts', 'Home › Visual Snapshot of hero'), 'skip.titles "visual snapshot"');
  assert.equal(skipRule(p, 'tests/home.spec.ts', 'Home › loads'), undefined);
  assert.ok(tooWeak(p, 'fair') && tooWeak(p, 'weak') && !tooWeak(p, 'good') && !tooWeak(p, 'strong'));
});

test('policy: limits can only get stricter than the workflow', () => {
  const p = readPolicy(parsePolicyYaml(FULL));
  const t = tighten({ maxFailures: 3, repeatEach: 5, quarantineDays: 14, maxUsd: 1 }, p);
  assert.deepEqual({ ...t, changed: undefined }, { maxFailures: 2, repeatEach: 8, quarantineDays: 7, maxUsd: 0.25, changed: undefined });
  const loose = readPolicy(parsePolicyYaml('limits:\n  max-usd: 50\n  max-failures: 20\n  repeat-each: 2\nquarantine:\n  max-days: 90\n'));
  const u = tighten({ maxFailures: 3, repeatEach: 5, quarantineDays: 14, maxUsd: 1 }, loose);
  assert.deepEqual([u.maxFailures, u.repeatEach, u.quarantineDays, u.maxUsd, u.changed.length], [3, 5, 14, 1, 0], 'a looser policy changes nothing');
});

test('policy: loaded from the repo root; a symlink is refused', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ah-policy-'));
  assert.equal(loadPolicy(dir), null);
  writeFileSync(path.join(dir, '.autoheal.yml'), 'protect: [tests/a/**]\n');
  assert.deepEqual(loadPolicy(dir).protect, ['tests/a/**']);
  const other = mkdtempSync(path.join(os.tmpdir(), 'ah-policy-'));
  mkdirSync(path.join(other, 'x'));
  writeFileSync(path.join(other, 'x', 'real.yml'), 'protect: []\n');
  symlinkSync(path.join(other, 'x', 'real.yml'), path.join(other, '.autoheal.yml'));
  assert.throws(() => loadPolicy(other), /regular file/);
});

test('policy: the publish job enforces it again', () => {
  const p = readPolicy(parsePolicyYaml(FULL));
  const f = (x) => ({ path: x, isNew: false });
  assert.throws(() => checkPolicy(null, [f('.autoheal.yml')], 1), /never change the policy file/);
  assert.throws(() => checkPolicy(p, [f('tests/payments/card.spec.ts')], 1), /protected/);
  assert.throws(() => checkPolicy(p, [f('playwright-quarantine.json')], 1), /quarantine off/);
  assert.throws(() => checkPolicy(p, [f('tests/a.spec.ts')], 6), /at most 5/);
  checkPolicy(p, [f('tests/a.spec.ts')], 5);
  checkPolicy(null, [f('tests/a.spec.ts')], 50);
});

test('policy: the example template is a valid policy', async () => {
  const { readFileSync } = await import('node:fs');
  const p = readPolicy(parsePolicyYaml(readFileSync(new URL('../templates/autoheal-policy.yml', import.meta.url), 'utf8')));
  assert.deepEqual(p.protect, ['tests/payments/']);
  assert.equal(p.fixes.allow.length, 4);
});
