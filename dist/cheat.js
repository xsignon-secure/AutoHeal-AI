/**
 * Local anti-cheat scan. It runs next to the engine's heal guard
 * (check-test-change) as a second, independent line: a fix is only kept when
 * both agree it does not make the test pass by checking less.
 *
 * BLOCK: fewer assertions, fewer tests, new skip/only/fixme/xfail, an early
 * return, an empty catch that swallows failures.
 *        New code that reaches outside the browser test (environment
 *        variables, child processes, the file system, raw network calls,
 *        eval): a fix runs on the CI runner, so this is how a prompt-injected
 *        AI could leak secrets.
 *        A changed expected value, an assertion that cannot fail, faked
 *        network answers, injected scripts or DOM edits, and dynamic or
 *        obfuscated access that could hide any of the above.
 * WARN:  raised timeouts, waitForTimeout, force: true, weaker matchers,
 * flipped .not, retries. AutoHeal treats WARN as blocking unless
 * AUTOHEAL_ALLOW_WARN=1.
 */
import { checkAllowlist } from './allowlist.js';
/** Strip comments so commented-out code neither counts nor hides. */
export function stripComments(source) {
    return stripBlockComments(source)
        .replace(/(^|[^:"'`\\/])\/\/[^\n]*/g, '$1')
        .replace(/^\s*#[^\n]*$/gm, '');
}
/** Removes block comments in one linear pass (a lazy regex is quadratic on an unclosed "/*"). */
function stripBlockComments(source) {
    let out = '';
    let i = 0;
    for (;;) {
        const start = source.indexOf('/*', i);
        if (start === -1)
            return out + source.slice(i);
        const end = source.indexOf('*/', start + 2);
        if (end === -1)
            return out + source.slice(i); // unclosed: left as is, like the old regex
        out += source.slice(i, start);
        i = end + 2;
    }
}
function count(source, pattern) {
    return (source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}
function maxNumber(source, pattern) {
    let max = 0;
    for (const match of source.matchAll(new RegExp(pattern.source, 'g'))) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value > max)
            max = value;
    }
    return max;
}
function addedLines(before, after) {
    const seen = new Map();
    for (const line of before.split('\n'))
        seen.set(line.trim(), (seen.get(line.trim()) ?? 0) + 1);
    const added = [];
    for (const line of after.split('\n')) {
        const key = line.trim();
        const left = seen.get(key) ?? 0;
        if (left > 0)
            seen.set(key, left - 1);
        else if (key !== '')
            added.push(key);
    }
    return added;
}
const ASSERTION = /\bexpect(?:\.soft|\.poll)?\s*\(|\bassert\b|\bexpect_that\b|\bto_have_|\bto_be_/;
const TEST_DECL = /\b(?:test|it|specify)(?:\.describe)?\s*\(\s*['"`]|\bdef\s+test_\w+\s*\(/;
const SKIP = /\b(?:test|it|describe|context|specify)\.(?:skip|fixme|only|fail)\s*\(|\btest\.describe\.(?:skip|only|fixme)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|\bpytest\.skip\s*\(|\bx(?:it|describe|context|specify)\s*\(|\bthis\s*\.\s*skip\s*\(/;
/** Cypress: a spec that drives the app through cy.* commands. */
const CYPRESS = /\bcy\s*\.\s*(?:get|contains|visit|find|request|intercept)\s*\(/;
/** Cypress assertions: .should(...) and .and(...). */
const CY_ASSERTION = /\.\s*(?:should|and)\s*\(/;
/** Cypress commands that fake the app or its time, or change the page instead of testing it. */
const CY_TAMPER = /\bcy\s*\.\s*(?:intercept|stub|clock|tick|window|document|server|route)\s*\(|\.\s*invoke\s*\(/;
/** WebdriverIO commands that run code in the page, fake the network or rewrite commands. */
const WDIO_TAMPER = /\bbrowser\s*\.\s*(?:execute|executeAsync|executeScript|mock|mockClearAll|mockRestoreAll|overwriteCommand|addCommand|throttle|throttleNetwork|emulate)\s*\(/;
/** Hiding failures: an uncaught-exception or fail handler that swallows errors. */
const CY_SWALLOW = /\b(?:cy|Cypress)\s*\.\s*on\s*\(\s*['"`](?:uncaught:exception|fail)['"`]/;
/** Things a test fix never needs, and an exfiltration attempt does. */
const ESCAPE = [
    [/\bprocess\s*\.\s*(?:env|binding|dlopen)\b|\bos\.environ\b|\bos\.getenv\s*\(|\bgetenv\s*\(|\bCypress\s*\.\s*env\s*\(/, 'reads environment variables'],
    [/\bcy\s*\.\s*(?:exec|task|readFile|writeFile)\s*\(/, 'runs a command or touches files through Cypress'],
    [/\bcy\s*\.\s*request\s*\(/, 'makes a raw network call (cy.request)'],
    [/\bchild_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bsubprocess\b|\bos\.system\s*\(|\bos\.popen\s*\(/, 'starts a process'],
    [/\brequire\s*\(|\bimport\s*\(|^\s*import\s[^\n]*\bfrom\s*['"](?:node:)?(?:fs|os|net|http|https|dgram|dns|tls|child_process|worker_threads|vm)(?:\/promises)?['"]|^\s*import\s+['"]/m, 'loads a new module'],
    [/^\s*(?:import|from)\s+(?:os|sys|subprocess|socket|requests|urllib|httpx|shutil|pathlib)\b/m, 'imports a system or network module'],
    [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\s*\(|\bnavigator\.sendBeacon\b/, 'makes a raw network call'],
    [/\beval\s*\(|\bnew\s+Function\s*\(|\bexec\s*\(\s*(?:compile|open|['"])/, 'evaluates code from a string'],
    [/\.git\/|\.env\b|\/proc\/|~\/\.ssh|GITHUB_TOKEN|GH_TOKEN|ACTIONS_RUNTIME_TOKEN|ACTIONS_ID_TOKEN/, 'touches secrets or repo internals'],
    [
        /\bglobalThis\b|\b(?:window|self|global)\s*\[|\bReflect\s*\.|\.constructor\b|\b__proto__\b|\bString\.fromCharCode\b|\batob\s*\(|\bBuffer\.from\s*\(|\[\s*(?:['"`][^\]]*['"`]\s*\+|[^\]]*\+\s*['"`])|\bgetattr\s*\(|\b__import__\b|\bimportlib\b|\b__builtins__\b|\bglobals\s*\(\s*\)/,
        'uses dynamic or obfuscated access (built names, globals, decoding)',
    ],
];
/** A computed property on test/it/describe, e.g. test['skip'](): a way to write skip without the word after a dot. */
const COMPUTED_TEST = /\b(?:test|it|describe)(?:\s*\.\s*describe)?\s*\[/;
/**
 * Where the test goes: a fix may find an element differently, never point the
 * test at another page (a data: URL that just shows the expected text, or an
 * attacker's site). The arguments of these calls must stay exactly the same.
 */
const NAVIGATION = /\.(?:goto|visit|origin|waitForURL|wait_for_url|route|routeFromHAR|route_from_har|newPage|new_page|setContent|set_content|expect_navigation|waitForNavigation)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
/** A URL written into the test. Locators never need one. */
const URL_LITERAL = /['"`]\s*(?:(?:data|javascript|blob|file|about|https?|wss?|ftp):|\/\/|\\\\)[^'"`]*['"`]/gi;
/** User actions. Deleting one removes a step of what the test checks. */
const ACTION = /\.(?:click|dblclick|fill|press|pressSequentially|press_sequentially|type|check|uncheck|setChecked|set_checked|hover|tap|selectOption|select_option|setInputFiles|set_input_files|dragTo|drag_to|dispatchEvent|dispatch_event|focus|blur|clear|goto|selectText|select_text|down|up|insertText|insert_text|select|rightclick|trigger|selectFile|submit|scrollTo)\s*\(/;
/** Ways to make a locator match more than it did: .or(), or a whole-page selector. */
const WIDENING = /\.or_?\s*\(|\b(?:locator|\$\$?|querySelector(?:All)?|query_selector(?:_all)?)\s*\(\s*['"`]\s*(?:body|html|\*|:root|:scope|div|span)\s*['"`]/;
/**
 * Ways to make a test pass by changing what the app shows instead of the
 * test: faking network answers, injecting scripts, or editing the DOM.
 */
const TAMPER = /\.(?:route|routeFromHAR|route_from_har|unroute|addInitScript|add_init_script|evaluate|evaluateHandle|evaluate_handle|\$eval|\$\$eval|eval_on_selector|eval_on_selector_all|exposeFunction|expose_function|exposeBinding|expose_binding|setContent|set_content)\s*\(|\.fulfill\s*\(/;
/** An assertion that cannot fail, e.g. expect(true).toBe(true). */
const TRIVIAL = /\bexpect(?:\.soft)?\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`)\s*\)|^\s*assert\s+(?:True|1|not\s+False|"[^"]*"|'[^']*')\s*$/m;
/**
 * What each assertion expects: the arguments of value matchers and the body
 * of Python asserts. A fix may change how an element is found, never what the
 * test expects to see; a changed expectation is how an app bug gets hidden.
 */
const EXPECTATION = /\.(?:not\.)?(?:to[A-Z]\w*|to_[a-z_]+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)|^\s*assert\s+(.+)$/gm;
/** Cypress and chai: .should('have.text', 'A'), .and(...), expect(x).to.equal('A'). */
const CY_EXPECTATION = /\.\s*(?:should|and|to(?:\s*\.\s*\w+)+)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
/** What an assertion looks at: the argument of expect(...). Changing it retargets the check. */
const EXPECT_SUBJECT = /\bexpect(?:\.soft|\.poll)?\s*\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g;
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`|\b(?:true|false|True|False)\b|-?\b\d+(?:\.\d+)?\b/g;
function declaration(source, name) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const js = new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(source);
    if (js?.[1] !== undefined)
        return js[1].trim();
    const py = new RegExp(`^\\s*${n}\\s*(?::[^=\\n]+)?=\\s*(?!=)(.+)$`, 'm').exec(source);
    return py?.[1]?.trim();
}
export function expectations(source) {
    const out = [];
    const cypress = CYPRESS.test(source);
    const found = [...source.matchAll(EXPECTATION)];
    // chai chains count everywhere; .should/.and only in Cypress specs (Playwright has its own .and()).
    for (const m of source.matchAll(CY_EXPECTATION)) {
        if (cypress || /^\.\s*to\b/.test(m[0]))
            found.push(m);
    }
    for (const m of found) {
        let value = m[1] ?? m[2] ?? '';
        if (m[2] !== undefined) {
            // Python: keep only what is compared against, so a locator change on the left is fine.
            const parts = value.split(/\s(?:==|!=|>=|<=|>|<|not in|in|is not|is)\s/);
            value = parts.length > 1 ? (parts[parts.length - 1] ?? value) : value;
        }
        // A raised timeout is a warning of its own, not a changed expectation.
        value = value.replace(/\btimeout\s*[:=]\s*[\d_]+\s*,?/g, '').replace(/\s+/g, ' ').trim();
        out.push(value);
        // Follow a variable to where it is set in this file, so moving the
        // expected value into `const price = '$12'` changes the expectation too.
        for (const name of value.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
            if (/^(?:true|false|null|undefined|new|RegExp|String|Number|await|this|None|True|False)$/.test(name))
                continue;
            const init = declaration(source, name);
            if (init !== undefined)
                out.push(`${name} = ${init}`);
        }
    }
    return out;
}
/**
 * The content an assertion is about: the text in getByText / getByLabel /
 * hasText / name inside expect(...), 'text=' selectors, and state options
 * such as checked or visible. Changing one changes what is checked, so it is
 * an expected value. A test id or CSS selector is identity, not content, and
 * may change.
 */
const SUBJECT_CONTENT = /\b(?:getBy(?:Text|Label|Placeholder|AltText|Title)|get_by_(?:text|label|placeholder|alt_text|title))\s*\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`|\/(?:[^/\\\n]|\\.)+\/[a-z]*|[A-Za-z_$][\w$]*)|\b(?:hasText|has_text|hasNotText|has_not_text|name)\s*[:=]\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`|\/(?:[^/\\\n]|\\.)+\/[a-z]*|[A-Za-z_$][\w$]*)|\b(checked|pressed|selected|expanded|disabled|visible|includeHidden|include_hidden|exact)\s*[:=]\s*(true|false|True|False)|(['"`]\s*text\s*=[^'"`]*['"`])/g;
/** Cypress: the text in cy.contains(...) when the same command chain asserts something. */
function cypressSubjects(source) {
    if (!CYPRESS.test(source))
        return [];
    const out = [];
    // One chain runs from a cy. to the next statement that starts with cy. (or a semicolon).
    for (const chain of source.split(/;|\n(?=\s*cy\s*\.)/)) {
        if (!CY_ASSERTION.test(chain))
            continue;
        for (const m of chain.matchAll(/\bcontains\s*\(([^()]*)\)/g))
            out.push(`contains(${(m[1] ?? '').replace(/\s+/g, ' ').trim()})`);
    }
    return out;
}
export function assertionSubjects(source) {
    const out = cypressSubjects(source);
    for (const m of source.matchAll(EXPECT_SUBJECT)) {
        for (const c of (m[1] ?? '').matchAll(SUBJECT_CONTENT)) {
            const value = c[1] ?? c[2] ?? (c[3] ? `${c[3]}=${c[4]}` : c[5]) ?? '';
            out.push(value);
            if (/^[A-Za-z_$][\w$]*$/.test(value) && !/^(?:true|false|True|False)$/.test(value)) {
                const init = declaration(source, value);
                if (init !== undefined)
                    out.push(`${value} = ${init}`);
            }
        }
    }
    return out;
}
/** Where each navigation call goes, following a constant back to its value. */
function navigationTargets(source) {
    const out = [];
    for (const m of source.matchAll(NAVIGATION)) {
        const arg = (m[1] ?? '').replace(/\s+/g, ' ').trim();
        out.push(arg);
        for (const name of arg.replace(LITERAL, '').match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
            if (/^(?:await|this|page|self|timeout|waitUntil|wait_until)$/.test(name))
                continue;
            const init = declaration(source, name);
            if (init !== undefined)
                out.push(`${name} = ${init}`);
        }
    }
    return out;
}
function actionNames(source) {
    return [...source.matchAll(new RegExp(ACTION.source, 'g'))].map((m) => m[0].replace(/[\s(.]/g, '')).sort();
}
function missing(before, after) {
    const left = new Map();
    for (const x of after)
        left.set(x, (left.get(x) ?? 0) + 1);
    const gone = [];
    for (const x of before) {
        const n = left.get(x) ?? 0;
        if (n > 0)
            left.set(x, n - 1);
        else
            gone.push(x);
    }
    return gone;
}
const STRONG = /\.(?:toHaveText|toHaveValue|toHaveURL|toHaveTitle|toHaveCount|toHaveAttribute|toContainText|toEqual|toStrictEqual|toBe|toMatchAriaSnapshot|toHaveScreenshot)\s*\(/;
const WEAK = /\.(?:toBeTruthy|toBeDefined|toBeFalsy|not\.toBeNull|toBeAttached)\s*\(/;
export function scanChange(before, after, file) {
    const a = stripComments(before);
    const b = stripComments(after);
    const findings = [];
    const block = (rule, message) => findings.push({ severity: 'BLOCK', rule, message });
    const warn = (rule, message) => findings.push({ severity: 'WARN', rule, message });
    const cypress = CYPRESS.test(a) || CYPRESS.test(b);
    const assertionsBefore = count(a, ASSERTION) + (cypress ? count(a, CY_ASSERTION) : 0);
    const assertionsAfter = count(b, ASSERTION) + (cypress ? count(b, CY_ASSERTION) : 0);
    if (assertionsAfter < assertionsBefore)
        block('assertion-removed', `assertions went from ${assertionsBefore} to ${assertionsAfter}`);
    const testsBefore = count(a, TEST_DECL);
    const testsAfter = count(b, TEST_DECL);
    if (testsAfter < testsBefore)
        block('test-removed', `tests went from ${testsBefore} to ${testsAfter}`);
    if (count(b, SKIP) > count(a, SKIP))
        block('skip-added', 'a skip, only, fixme, fail or xfail marker was added');
    if (count(b, COMPUTED_TEST) > count(a, COMPUTED_TEST))
        block('skip-added', "test[...] was added, which can call skip, only or fixme without naming them");
    const navBefore = navigationTargets(a);
    const navAfter = navigationTargets(b);
    const navChanged = missing(navBefore, navAfter).concat(missing(navAfter, navBefore));
    if (navChanged.length) {
        block('navigation-changed', `where the test navigates changed (${navChanged.slice(0, 2).map((x) => JSON.stringify(x.slice(0, 60))).join(', ')}); a fix may change how an element is found, never which page is tested`);
    }
    const urls = missing((b.match(URL_LITERAL) ?? []).map((u) => u.toLowerCase()), (a.match(URL_LITERAL) ?? []).map((u) => u.toLowerCase()));
    if (urls.length)
        block('url-added', `a URL was written into the test (${urls[0]?.slice(0, 60)}); locators never need one`);
    const actionsBefore = actionNames(a);
    const actionsAfter = actionNames(b);
    if (actionsAfter.length < actionsBefore.length)
        block('step-removed', `user actions went from ${actionsBefore.length} to ${actionsAfter.length}; a fix may retarget a step, not delete it`);
    else if (actionsAfter.join() !== actionsBefore.join()) {
        block('action-changed', `the actions changed (${missing(actionsBefore, actionsAfter).join(', ')} → ${missing(actionsAfter, actionsBefore).join(', ')}); a fix may change which element is used, not what is done to it`);
    }
    if (count(b, /\bawait\b/) < count(a, /\bawait\b/))
        block('await-removed', 'an await was removed, so a step or check may no longer be waited for');
    const subjectsGone = missing(assertionSubjects(a), assertionSubjects(b));
    if (subjectsGone.length) {
        block('assertion-retargeted', `what an assertion looks at changed (${subjectsGone.slice(0, 2).map((x) => JSON.stringify(x.slice(0, 60))).join(', ')}); a check must stay on the same text, test id or state`);
    }
    if (count(b, WIDENING) > count(a, WIDENING))
        block('locator-widened', 'a locator was widened with .or() or a whole-page selector, so it can match something other than the intended element');
    const added = addedLines(a, b);
    if (added.some((line) => /^return\b\s*;?$|^if\s*\(.*\)\s*\{?\s*return\b|^if .*:\s*return\b/.test(line))) {
        block('early-return', 'an early return was added, so later steps or assertions may never run');
    }
    if (/catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/.test(b) && count(b, /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/) > count(a, /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/)) {
        block('swallowed-error', 'an empty catch block was added');
    }
    if (count(b, /except\s*(\w+)?\s*:\s*pass\b/) > count(a, /except\s*(\w+)?\s*:\s*pass\b/))
        block('swallowed-error', 'an except: pass was added');
    if (count(b, /\.catch\s*\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null|false)\s*\)/) > count(a, /\.catch\s*\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null|false)\s*\)/)) {
        block('swallowed-error', 'a promise error is now swallowed with .catch(() => {})');
    }
    // The structural allowlist: locators, waits and literals only.
    const allow = checkAllowlist(before, after, file);
    for (const problem of allow.problems)
        block('outside-allowlist', `a fix may only change locators and waits; this change ${problem}`);
    const changed = missing(expectations(a), expectations(b));
    if (changed.length) {
        block('expectation-changed', `what the test expects changed (${changed.slice(0, 3).map((x) => JSON.stringify(x.slice(0, 60))).join(', ')}); if the app now shows something else, that is for a person to decide`);
    }
    if (count(b, TRIVIAL) > count(a, TRIVIAL))
        block('trivial-assertion', 'an assertion that cannot fail was added');
    if (count(b, TAMPER) > count(a, TAMPER) || count(after, TAMPER) > count(before, TAMPER))
        block('app-tampered', 'the change fakes network answers, injects scripts or edits the page instead of testing it');
    if (count(b, CY_TAMPER) > count(a, CY_TAMPER) || count(after, CY_TAMPER) > count(before, CY_TAMPER)) {
        block('app-tampered', 'the change adds cy.intercept, cy.stub, cy.clock, cy.window or .invoke, which fake or edit the app instead of testing it');
    }
    if (count(b, WDIO_TAMPER) > count(a, WDIO_TAMPER) || count(after, WDIO_TAMPER) > count(before, WDIO_TAMPER)) {
        block('app-tampered', 'the change adds browser.execute, browser.mock or a command override, which fake or edit the app instead of testing it');
    }
    if (count(b, CY_SWALLOW) > count(a, CY_SWALLOW) || count(after, CY_SWALLOW) > count(before, CY_SWALLOW))
        block('swallowed-error', "an uncaught:exception or fail handler was added, which hides the app's errors");
    if (count(b, /\bCypress\s*\.\s*config\s*\(/) > count(a, /\bCypress\s*\.\s*config\s*\(/))
        block('config-changed', 'Cypress.config(...) was added, which changes timeouts or settings for the run');
    for (const [pattern, what] of ESCAPE) {
        if (count(b, pattern) > count(a, pattern) || count(after, pattern) > count(before, pattern))
            block('unsafe-code', `the change ${what}, which a test fix never needs`);
    }
    const timeoutPattern = /timeout\s*[:=]\s*(\d[\d_]*)/i;
    const timeoutBefore = maxNumber(a.replace(/_/g, ''), timeoutPattern);
    const timeoutAfter = maxNumber(b.replace(/_/g, ''), timeoutPattern);
    if (timeoutAfter > timeoutBefore)
        warn('timeout-raised', `a timeout was raised to ${timeoutAfter} ms`);
    if (count(b, /setTimeout\s*\(|\.slow\s*\(/) > count(a, /setTimeout\s*\(|\.slow\s*\(/))
        warn('timeout-raised', 'test.setTimeout or test.slow was added');
    const FIXED_WAIT = /waitForTimeout\s*\(|time\.sleep\s*\(|wait_for_timeout\s*\(|\bcy\s*\.\s*wait\s*\(\s*[\d_]|\bbrowser\s*\.\s*pause\s*\(/;
    if (count(b, FIXED_WAIT) > count(a, FIXED_WAIT)) {
        warn('fixed-wait', 'a fixed wait (waitForTimeout / sleep / cy.wait(ms)) was added');
    }
    if (count(b, /force\s*[:=]\s*(true|True)/) > count(a, /force\s*[:=]\s*(true|True)/))
        warn('force-action', 'force: true was added, which skips actionability checks');
    if (count(b, WEAK) > count(a, WEAK) && count(b, STRONG) < count(a, STRONG))
        warn('weaker-matcher', 'a specific matcher was replaced by a weaker one');
    if (count(b, /\.not\./) !== count(a, /\.not\./))
        warn('negation-changed', 'the number of .not assertions changed');
    if (count(b, /retries\s*[:=]\s*[1-9]/) > count(a, /retries\s*[:=]\s*[1-9]/))
        warn('retries-added', 'retries were added');
    const verdict = findings.some((f) => f.severity === 'BLOCK') ? 'BLOCK' : findings.length ? 'WARN' : 'PASS';
    return { verdict, findings };
}
//# sourceMappingURL=cheat.js.map