/**
 * AutoHeal AI for Cypress: add one line to cypress/support/e2e.js
 *
 *   import 'xsignon-autoheal/cypress';
 *
 * and register the plugin in cypress.config (see plugin.cjs). Then, on every
 * run:
 *   - each cy.get / .find that finds its element records a short fingerprint
 *     of that element (role, accessible name, test id, id, label, nearby
 *     heading; never page content beyond the element's own label);
 *   - when a cy.get or .find finds nothing and the test fails, the page at
 *     that moment is kept, so AutoHeal can find the element again without AI;
 *   - tests AutoHeal quarantined (playwright-quarantine.json) still run, but
 *     their failures do not fail the build until the entry expires.
 * Everything is written to cypress/autoheal/ by the plugin; nothing leaves the
 * machine.
 */

import { fingerprintOf } from '../dist/snapshot.js';

const MAX_NODES = 20000;
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg']);

let calls = [];
let pending = null;
let failed = null;
let quarantine = [];
const recorded = new Set();

function reset() {
  calls = [];
  pending = null;
  failed = null;
  recorded.clear();
}

/** The page under test (the app's iframe). */
function appDocument() {
  try {
    const win = cy.state('window');
    if (win && win.document) return win.document;
  } catch {
    // older Cypress
  }
  try {
    const frame = window.top.document.querySelector('iframe.aut-iframe');
    return frame ? frame.contentDocument : null;
  } catch {
    return null;
  }
}

/** The DOM as AutoHeal's element tree: { tag, attrs, children }, parents not enumerable. */
function snapshot(doc) {
  const map = new Map();
  let count = 0;
  const visit = (node, parent, depth) => {
    if (count > MAX_NODES || depth > 200) return null;
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      return t && t.trim() ? t.slice(0, 300) : null;
    }
    if (node.nodeType !== 1) return null;
    count++;
    const tag = String(node.tagName || '').toUpperCase();
    const attrs = {};
    for (const a of Array.from(node.attributes || []).slice(0, 40)) attrs[a.name] = String(a.value).slice(0, 300);
    const el = { tag, attrs, children: [] };
    Object.defineProperty(el, 'parent', { value: parent, enumerable: false, writable: true });
    map.set(node, el);
    if (!SKIP.has(tag)) {
      for (const child of Array.from(node.childNodes)) {
        const c = visit(child, el, depth + 1);
        if (c !== null) el.children.push(c);
      }
    }
    return el;
  };
  const root = visit(doc.documentElement, undefined, 0);
  return { root, map };
}

function pagePath(doc) {
  try {
    return doc.location.pathname;
  } catch {
    return undefined;
  }
}

function record(selector, $el) {
  if (typeof selector !== 'string' || !selector || selector.startsWith('@') || selector.length > 1000) return;
  if (!$el || $el.length === 0) {
    pending = selector;
    return;
  }
  if (pending === selector) pending = null;
  if (recorded.has(selector)) return;
  recorded.add(selector);
  try {
    const doc = appDocument();
    if (!doc) return;
    const { map } = snapshot(doc);
    const target = map.get($el[0]);
    if (!target) return;
    const page = pagePath(doc);
    calls.push({ callId: String(calls.length), method: 'get', selector, failed: false, target: fingerprintOf(target), ...(page ? { page } : {}) });
  } catch {
    // Recording is a help; never break the test.
  }
}

function wrapQuery(name) {
  Cypress.Commands.overwriteQuery(name, function (originalFn, ...args) {
    const inner = originalFn.apply(this, args);
    const selector = args[0];
    return function (subject) {
      const $el = inner.call(this, subject);
      record(selector, $el);
      return $el;
    };
  });
}

if (Cypress.Commands.overwriteQuery) {
  wrapQuery('get');
  wrapQuery('find');
}

const today = () => new Date().toISOString().slice(0, 10);

function quarantined(runnable) {
  const spec = Cypress.spec.relative || '';
  const title = runnable && runnable.title;
  return quarantine.find((e) => e && e.title === title && (spec === e.file || spec.endsWith(`/${e.file}`) || e.file.endsWith(`/${spec}`)) && typeof e.until === 'string' && e.until >= today());
}

Cypress.on('fail', (err, runnable) => {
  try {
    const text = String((err && err.message) || '');
    if (pending && /Expected to find|Timed out retrying|never found/.test(text)) {
      const doc = appDocument();
      if (doc) {
        const { root } = snapshot(doc);
        const page = pagePath(doc);
        const call = { callId: String(calls.length), method: 'get', selector: pending, failed: true, ...(page ? { page } : {}) };
        calls.push(call);
        failed = { call, page: { callId: call.callId, phase: 'before', frameUrl: doc.location.href, root } };
      }
    }
  } catch {
    // never hide the real failure
  }
  const q = quarantined(runnable);
  if (q) {
    Cypress.log({ name: 'autoheal', message: `quarantined until ${q.until}: this failure does not fail the build (${firstLine(err)})` });
    return false;
  }
  throw err;
});

function firstLine(err) {
  return String((err && err.message) || 'failed').split('\n')[0].slice(0, 200);
}

before(() => {
  cy.task('autoheal:quarantine', null, { log: false }).then((list) => {
    quarantine = Array.isArray(list) ? list : [];
  });
});

beforeEach(() => reset());

afterEach(function () {
  const test = Cypress.currentTest || {};
  const titlePath = Array.isArray(test.titlePath) ? test.titlePath : [test.title];
  const data = {
    version: 1,
    spec: Cypress.spec.relative,
    title: titlePath.join(' '),
    state: this.currentTest && this.currentTest.state,
    calls,
    ...(failed ? { failedCall: failed.call, failedPage: failed.page } : {}),
  };
  if (!calls.length) return;
  cy.task('autoheal:save', data, { log: false });
});
