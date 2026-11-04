/**
 * Locators as Playwright sees them (internal selectors in traces) and as the
 * test source writes them (getByRole(...), get_by_role(...)), plus a strength
 * ranking that follows Playwright's own advice: role and accessible name
 * first, then label, placeholder, text, alt, title, test id, and CSS last.
 */
import { elements, labelOf, nameOf, roleOf, textOf } from './snapshot.js';
const RANK = { role: 1, label: 2, placeholder: 3, text: 4, alt: 5, title: 5, testid: 6, 'role-no-name': 7, id: 8, css: 9 };
function unquote(raw) {
    const m = /^("(?:[^"\\]|\\.)*")([is]?)$/.exec(raw.trim());
    if (!m)
        return null;
    try {
        return { value: JSON.parse(m[1]), exact: m[2] === 's' };
    }
    catch {
        return null;
    }
}
/** The last part of a Playwright selector (after the final >>), parsed. Null for chains it cannot express. */
export function parseSelector(selector) {
    const parts = selector.split(/\s>>\s/);
    const last = (parts[parts.length - 1] ?? '').trim();
    if (!last || /^(?:nth|visible|internal:has|internal:and|internal:or|internal:chain)/.test(last))
        return null;
    let m = /^internal:role=([a-z]+)(.*)$/.exec(last);
    if (m) {
        const out = { kind: 'role', value: m[1] };
        const name = /\[name=("(?:[^"\\]|\\.)*"[is]?)\]/.exec(m[2] ?? '');
        if (name) {
            const q = unquote(name[1]);
            if (!q)
                return null;
            out.name = q.value;
            if (q.exact)
                out.exact = true;
        }
        return out;
    }
    m = /^internal:(label|text)=(.+)$/.exec(last);
    if (m) {
        const q = unquote(m[2]);
        return q ? { kind: m[1], value: q.value, ...(q.exact ? { exact: true } : {}) } : null;
    }
    m = /^internal:testid=\[([\w-]+)=("(?:[^"\\]|\\.)*")s?\]$/.exec(last);
    if (m) {
        const q = unquote(m[2]);
        return q ? { kind: 'testid', value: q.value } : null;
    }
    m = /^internal:attr=\[(placeholder|alt|title)=("(?:[^"\\]|\\.)*"[is]?)\]$/.exec(last);
    if (m) {
        const q = unquote(m[2]);
        return q ? { kind: m[1], value: q.value, ...(q.exact ? { exact: true } : {}) } : null;
    }
    if (last.startsWith('internal:') || /^(?:xpath|text|id|data-testid)=/.test(last))
        return null;
    return { kind: 'css', value: last.replace(/^css=/, '') };
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A string literal with the given content in any quote style. */
const lit = (value, group = 1) => `(['"\`])${esc(value).replace(/'/g, "\\\\?'").replace(/"/g, '\\\\?"')}\\${group}`;
const JS_METHOD = { role: 'getByRole', label: 'getByLabel', placeholder: 'getByPlaceholder', text: 'getByText', alt: 'getByAltText', title: 'getByTitle', testid: 'getByTestId', css: 'locator' };
const PY_METHOD = { role: 'get_by_role', label: 'get_by_label', placeholder: 'get_by_placeholder', text: 'get_by_text', alt: 'get_by_alt_text', title: 'get_by_title', testid: 'get_by_test_id', css: 'locator' };
/** A regex that finds this locator call in source code (JS/TS or Python). */
export function sourcePattern(loc, python) {
    const method = (python ? PY_METHOD : JS_METHOD)[loc.kind];
    if (loc.kind === 'role') {
        if (loc.name === undefined)
            return new RegExp(`\\b${method}\\(\\s*${lit(loc.value)}\\s*\\)`, 'g');
        const name = python ? `name\\s*=\\s*${lit(loc.name, 2)}(?:\\s*,\\s*exact\\s*=\\s*(?:True|False))?` : `\\{\\s*name\\s*:\\s*${lit(loc.name, 2)}[^}]*\\}`;
        return new RegExp(`\\b${method}\\(\\s*${lit(loc.value)}\\s*,\\s*${name}\\s*\\)`, 'g');
    }
    const rest = python ? '(?:\\s*,\\s*exact\\s*=\\s*(?:True|False))?' : '(?:\\s*,\\s*\\{[^}]*\\})?';
    return new RegExp(`\\b${method}\\(\\s*${lit(loc.value)}${rest}\\s*\\)`, 'g');
}
const q = (s, quote) => `${quote}${s.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`)}${quote}`;
/** Source code for a locator, in the file's language and quote style. */
export function renderLocator(loc, python, quote = "'") {
    const method = (python ? PY_METHOD : JS_METHOD)[loc.kind];
    const quoteChar = python && quote === '`' ? "'" : quote;
    if (loc.kind === 'role') {
        if (loc.name === undefined)
            return `${method}(${q(loc.value, quoteChar)})`;
        if (python)
            return `${method}(${q(loc.value, quoteChar)}, name=${q(loc.name, quoteChar)}${loc.exact ? ', exact=True' : ''})`;
        return `${method}(${q(loc.value, quoteChar)}, { name: ${q(loc.name, quoteChar)}${loc.exact ? ', exact: true' : ''} })`;
    }
    if (loc.exact && loc.kind !== 'testid' && loc.kind !== 'css')
        return python ? `${method}(${q(loc.value, quoteChar)}, exact=True)` : `${method}(${q(loc.value, quoteChar)}, { exact: true })`;
    return `${method}(${q(loc.value, quoteChar)})`;
}
const cssIdent = (s) => /^[A-Za-z_][\w-]*$/.test(s);
/**
 * The strongest locator that picks exactly this element on the page, in
 * Playwright's order of preference. Null when nothing is unique.
 */
export function locatorFor(target, root, testIdAttr = 'data-testid') {
    const all = elements(root).filter((e) => e.tag !== 'HTML' && e.tag !== 'HEAD' && e.tag !== 'BODY');
    const role = roleOf(target);
    const name = nameOf(target, role);
    const unique = (pred) => all.filter(pred).length === 1;
    if (role && name && name.length <= 80) {
        const sameExact = (e) => roleOf(e) === role && nameOf(e) === name;
        const sameLoose = (e) => roleOf(e) === role && nameOf(e).toLowerCase().includes(name.toLowerCase());
        if (unique(sameLoose))
            return { kind: 'role', value: role, name };
        if (unique(sameExact))
            return { kind: 'role', value: role, name, exact: true };
    }
    const label = labelOf(target);
    if (label && unique((e) => labelOf(e) === label))
        return { kind: 'label', value: label, exact: true };
    const placeholder = target.attrs.placeholder;
    if (placeholder && unique((e) => e.attrs.placeholder === placeholder))
        return { kind: 'placeholder', value: placeholder, exact: true };
    const text = textOf(target, 100);
    // Text only for elements that hold the text themselves, not containers around it.
    const ownText = target.children.some((c) => typeof c === 'string' && c.trim() !== '');
    if (ownText && text && text.length <= 60 && !role.match(/^(?:textbox|combobox|listbox|list|table|navigation|main|region|form)$/)) {
        const owners = all.filter((e) => textOf(e, 100) === text);
        const innermost = owners.filter((e) => !owners.some((o) => o !== e && o.parent === e));
        if (innermost.length === 1 && innermost[0] === target)
            return { kind: 'text', value: text, exact: true };
    }
    const testId = target.attrs[testIdAttr];
    if (testId && unique((e) => e.attrs[testIdAttr] === testId))
        return { kind: 'testid', value: testId };
    const id = target.attrs.id;
    if (id && cssIdent(id) && unique((e) => e.attrs.id === id))
        return { kind: 'css', value: `#${id}` };
    return null;
}
/** Rank of a locator written in source (lower is stronger). */
export function rankOf(expr) {
    const m = /\b(getByRole|get_by_role|getByLabel|get_by_label|getByPlaceholder|get_by_placeholder|getByText|get_by_text|getByAltText|get_by_alt_text|getByTitle|get_by_title|getByTestId|get_by_test_id|locator)\(\s*(['"`])((?:\\.|(?!\2).)*)\2([^)]*)\)/.exec(expr);
    if (!m)
        return RANK.css;
    const method = m[1].toLowerCase().replace(/_/g, '');
    const rest = m[4] ?? '';
    if (method === 'getbyrole')
        return /name/.test(rest) ? RANK.role : RANK['role-no-name'];
    if (method === 'getbylabel')
        return RANK.label;
    if (method === 'getbyplaceholder')
        return RANK.placeholder;
    if (method === 'getbytext')
        return RANK.text;
    if (method === 'getbyalttext')
        return RANK.alt;
    if (method === 'getbytitle')
        return RANK.title;
    if (method === 'getbytestid')
        return RANK.testid;
    const css = m[3] ?? '';
    if (/^#[\w-]+$/.test(css))
        return RANK.id;
    return RANK.css;
}
export function strengthOf(expr) {
    const r = rankOf(expr);
    if (r <= 3)
        return 'strong';
    if (r <= 6)
        return 'good';
    if (r <= 8)
        return 'fair';
    return 'weak';
}
const CALL = /\b(?:getBy(?:Role|Label|Placeholder|Text|AltText|Title|TestId)|get_by_(?:role|label|placeholder|text|alt_text|title|test_id)|locator)\((?:[^()]|\([^()]*\))*\)/g;
/** Locator calls in a piece of source. */
export function locatorCalls(source) {
    return [...source.matchAll(CALL)].map((m) => m[0]);
}
/** Locators that a change replaced, by comparing removed and added lines. */
export function locatorChanges(before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    const removed = a.filter((l) => !b.includes(l)).flatMap(locatorCalls);
    const added = b.filter((l) => !a.includes(l)).flatMap(locatorCalls);
    const gone = removed.filter((x) => !added.includes(x));
    const fresh = added.filter((x) => !removed.includes(x));
    const out = [];
    for (let i = 0; i < Math.min(gone.length, fresh.length, 5); i++) {
        const x = gone[i];
        const y = fresh[i];
        const rx = rankOf(x);
        const ry = rankOf(y);
        out.push({ before: x, after: y, from: strengthOf(x), to: strengthOf(y), direction: ry < rx ? 1 : ry > rx ? -1 : 0 });
    }
    return out;
}
//# sourceMappingURL=locators.js.map