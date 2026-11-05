// A stand-in for the `cypress` package, for AutoHeal's tests (the real one
// needs a 500 MB binary). cypress.run() reads each spec, finds its it(...)
// blocks, and "runs" cy.get / cy.contains / .should('have.text') against the
// app described in fake-app.json: { "elements": { "<selector>": "<text>" } }.
const fs = require('node:fs');
const path = require('node:path');

function runTest(body, app) {
  let last = null;
  const steps = [...body.matchAll(/cy\.get\(\s*(['"])(.*?)\1\s*\)|cy\.contains\(\s*(['"])(.*?)\3\s*(?:,\s*(['"])(.*?)\5\s*)?\)|\.should\(\s*'have\.text'\s*,\s*(['"])(.*?)\7\s*\)/g)];
  for (const m of steps) {
    if (m[2] !== undefined) {
      if (!(m[2] in app.elements)) return `AssertionError: Timed out retrying after 4000ms: Expected to find element: \`${m[2]}\`, but never found it.`;
      last = m[2];
    } else if (m[4] !== undefined) {
      const text = m[6] ?? m[4];
      const tag = m[6] !== undefined ? m[4] : null;
      const hit = Object.entries(app.elements).find(([sel, t]) => t === text && (!tag || sel.startsWith(tag)));
      if (!hit) return `AssertionError: Timed out retrying after 4000ms: Expected to find content: '${text}'${tag ? ` within the selector: '${tag}'` : ''} but never did.`;
      last = hit[0];
    } else if (m[8] !== undefined) {
      const actual = app.elements[last];
      if (actual !== m[8]) return `AssertionError: Timed out retrying after 4000ms: expected '<${last}>' to have text '${m[8]}', but the text was '${actual}'`;
    }
  }
  return null;
}

module.exports.run = async ({ spec, project }) => {
  const root = project ?? process.cwd();
  const app = JSON.parse(fs.readFileSync(path.join(root, 'fake-app.json'), 'utf8'));
  const log = path.join(root, '.fake-cypress-runs');
  fs.appendFileSync(log, `${spec}\n`);
  const runs = String(spec)
    .split(',')
    .map((rel) => {
      const source = fs.readFileSync(path.join(root, rel), 'utf8');
      const describe = /describe\(\s*'([^']*)'/.exec(source)?.[1];
      const parts = source.split(/\bit\(\s*'/).slice(1);
      const tests = parts.map((part) => {
        const title = part.slice(0, part.indexOf("'"));
        const error = runTest(part, app);
        return { title: describe ? [describe, title] : [title], state: error ? 'failed' : 'passed', displayError: error ? `${error}\n    at Context.eval (webpack:///./${rel}:4:8)` : null };
      });
      return { spec: { relative: rel, absolute: path.join(root, rel) }, tests, screenshots: [] };
    });
  return { status: 'finished', runs };
};
