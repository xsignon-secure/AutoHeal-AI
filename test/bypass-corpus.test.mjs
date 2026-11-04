// The guard's regression set: every bypass from every audit is blocked, real fixes pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanChange } from '../dist/index.js';
import { bypasses, legit, spec } from './bypasses/corpus.mjs';

for (const [audit, name, find, replace] of bypasses) {
  test(`bypass (${audit}): ${name} is blocked`, () => {
    assert.ok(spec.includes(find), `corpus entry does not apply: ${find}`);
    const r = scanChange(spec, spec.replace(find, replace), 'tests/checkout.spec.ts');
    assert.equal(r.verdict, 'BLOCK', JSON.stringify(r.findings));
  });
}

for (const [name, find, replace] of legit) {
  test(`real fix: ${name} passes`, () => {
    assert.ok(spec.includes(find), `corpus entry does not apply: ${find}`);
    const r = scanChange(spec, spec.replace(find, replace), 'tests/checkout.spec.ts');
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.findings));
  });
}
