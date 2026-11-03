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

export type Verdict = 'PASS' | 'WARN' | 'BLOCK';

export interface CheatFinding {
  severity: 'BLOCK' | 'WARN';
  rule: string;
  message: string;
}

export interface CheatReport {
  verdict: Verdict;
  findings: CheatFinding[];
}

/** Strip comments so commented-out code neither counts nor hides. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:"'`\\/])\/\/[^\n]*/g, '$1')
    .replace(/^\s*#[^\n]*$/gm, '');
}

function count(source: string, pattern: RegExp): number {
  return (source.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)) ?? []).length;
}

function maxNumber(source: string, pattern: RegExp): number {
  let max = 0;
  for (const match of source.matchAll(new RegExp(pattern.source, 'g'))) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max;
}

function addedLines(before: string, after: string): string[] {
  const seen = new Map<string, number>();
  for (const line of before.split('\n')) seen.set(line.trim(), (seen.get(line.trim()) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split('\n')) {
    const key = line.trim();
    const left = seen.get(key) ?? 0;
    if (left > 0) seen.set(key, left - 1);
    else if (key !== '') added.push(key);
  }
  return added;
}

const ASSERTION = /\bexpect(?:\.soft|\.poll)?\s*\(|\bassert\b|\bexpect_that\b|\bto_have_|\bto_be_/;
const TEST_DECL = /\b(?:test|it)(?:\.describe)?\s*\(\s*['"`]|\bdef\s+test_\w+\s*\(/;
const SKIP = /\b(?:test|it|describe)\.(?:skip|fixme|only|fail)\s*\(|\btest\.describe\.(?:skip|only|fixme)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|\bpytest\.skip\s*\(/;
/** Things a test fix never needs, and an exfiltration attempt does. */
const ESCAPE: Array<[RegExp, string]> = [
  [/\bprocess\s*\.\s*(?:env|binding|dlopen)\b|\bos\.environ\b|\bos\.getenv\s*\(|\bgetenv\s*\(/, 'reads environment variables'],
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
const EXPECTATION = /\.(?:not\.)?(?:toHaveText|toContainText|toHaveValue|toHaveValues|toHaveURL|toHaveTitle|toHaveCount|toHaveAttribute|toHaveClass|toHaveCSS|toHaveId|toHaveJSProperty|toHaveAccessibleName|toHaveAccessibleDescription|toHaveRole|toEqual|toStrictEqual|toBe|toMatch|toContain|toHaveLength|toHaveProperty|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toBeCloseTo|to_have_text|to_contain_text|to_have_value|to_have_values|to_have_url|to_have_title|to_have_count|to_have_attribute|to_have_class|to_have_css|to_have_id|to_have_js_property|to_have_accessible_name|to_have_role)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)|^\s*assert\s+(.+)$/gm;

function declaration(source: string, name: string): string | undefined {
  const n = name.replace(/\$/g, '\\$');
  const js = new RegExp(`\\b(?:const|let|var)\\s+${n}\\s*(?::[^=\\n]+)?=\\s*([^;\\n]+)`).exec(source);
  if (js?.[1] !== undefined) return js[1].trim();
  const py = new RegExp(`^\\s*${n}\\s*(?::[^=\\n]+)?=\\s*(?!=)(.+)$`, 'm').exec(source);
  return py?.[1]?.trim();
}

export function expectations(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(EXPECTATION)) {
    let value = m[1] ?? m[2] ?? '';
    if (m[2] !== undefined) {
      // Python: keep only what is compared against, so a locator change on the left is fine.
      const parts = value.split(/\s(?:==|!=|>=|<=|>|<|not in|in|is not|is)\s/);
      value = parts.length > 1 ? (parts[parts.length - 1] ?? value) : value;
    }
    value = value.replace(/\s+/g, ' ').trim();
    out.push(value);
    // Follow a variable to where it is set in this file, so moving the
    // expected value into `const price = '$12'` changes the expectation too.
    for (const name of value.match(/\b[A-Za-z_$][\w$]*\b/g) ?? []) {
      if (/^(?:true|false|null|undefined|new|RegExp|String|Number|await|this|None|True|False)$/.test(name)) continue;
      const init = declaration(source, name);
      if (init !== undefined) out.push(`${name} = ${init}`);
    }
  }
  return out;
}

function missing(before: string[], after: string[]): string[] {
  const left = new Map<string, number>();
  for (const x of after) left.set(x, (left.get(x) ?? 0) + 1);
  const gone: string[] = [];
  for (const x of before) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else gone.push(x);
  }
  return gone;
}

const STRONG = /\.(?:toHaveText|toHaveValue|toHaveURL|toHaveTitle|toHaveCount|toHaveAttribute|toContainText|toEqual|toStrictEqual|toBe|toMatchAriaSnapshot|toHaveScreenshot)\s*\(/;
const WEAK = /\.(?:toBeTruthy|toBeDefined|toBeFalsy|not\.toBeNull|toBeAttached)\s*\(/;

export function scanChange(before: string, after: string): CheatReport {
  const a = stripComments(before);
  const b = stripComments(after);
  const findings: CheatFinding[] = [];
  const block = (rule: string, message: string) => findings.push({ severity: 'BLOCK', rule, message });
  const warn = (rule: string, message: string) => findings.push({ severity: 'WARN', rule, message });

  const assertionsBefore = count(a, ASSERTION);
  const assertionsAfter = count(b, ASSERTION);
  if (assertionsAfter < assertionsBefore) block('assertion-removed', `assertions went from ${assertionsBefore} to ${assertionsAfter}`);

  const testsBefore = count(a, TEST_DECL);
  const testsAfter = count(b, TEST_DECL);
  if (testsAfter < testsBefore) block('test-removed', `tests went from ${testsBefore} to ${testsAfter}`);

  if (count(b, SKIP) > count(a, SKIP)) block('skip-added', 'a skip, only, fixme, fail or xfail marker was added');

  const added = addedLines(a, b);
  if (added.some((line) => /^return\b\s*;?$|^if\s*\(.*\)\s*\{?\s*return\b|^if .*:\s*return\b/.test(line))) {
    block('early-return', 'an early return was added, so later steps or assertions may never run');
  }
  if (/catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/.test(b) && count(b, /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/) > count(a, /catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/)) {
    block('swallowed-error', 'an empty catch block was added');
  }
  if (count(b, /except\s*(\w+)?\s*:\s*pass\b/) > count(a, /except\s*(\w+)?\s*:\s*pass\b/)) block('swallowed-error', 'an except: pass was added');
  if (count(b, /\.catch\s*\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null|false)\s*\)/) > count(a, /\.catch\s*\(\s*\(\s*\)\s*=>\s*(\{\s*\}|undefined|null|false)\s*\)/)) {
    block('swallowed-error', 'a promise error is now swallowed with .catch(() => {})');
  }

  const changed = missing(expectations(a), expectations(b));
  if (changed.length) {
    block('expectation-changed', `what the test expects changed (${changed.slice(0, 3).map((x) => JSON.stringify(x.slice(0, 60))).join(', ')}); if the app now shows something else, that is for a person to decide`);
  }
  if (count(b, TRIVIAL) > count(a, TRIVIAL)) block('trivial-assertion', 'an assertion that cannot fail was added');
  if (count(b, TAMPER) > count(a, TAMPER)) block('app-tampered', 'the change fakes network answers, injects scripts or edits the page instead of testing it');

  for (const [pattern, what] of ESCAPE) {
    if (count(b, pattern) > count(a, pattern)) block('unsafe-code', `the change ${what}, which a test fix never needs`);
  }

  const timeoutPattern = /timeout\s*[:=]\s*(\d[\d_]*)/i;
  const timeoutBefore = maxNumber(a.replace(/_/g, ''), timeoutPattern);
  const timeoutAfter = maxNumber(b.replace(/_/g, ''), timeoutPattern);
  if (timeoutAfter > timeoutBefore) warn('timeout-raised', `a timeout was raised to ${timeoutAfter} ms`);
  if (count(b, /setTimeout\s*\(|\.slow\s*\(/) > count(a, /setTimeout\s*\(|\.slow\s*\(/)) warn('timeout-raised', 'test.setTimeout or test.slow was added');
  if (count(b, /waitForTimeout\s*\(|time\.sleep\s*\(|wait_for_timeout\s*\(/) > count(a, /waitForTimeout\s*\(|time\.sleep\s*\(|wait_for_timeout\s*\(/)) {
    warn('fixed-wait', 'a fixed wait (waitForTimeout / sleep) was added');
  }
  if (count(b, /force\s*[:=]\s*(true|True)/) > count(a, /force\s*[:=]\s*(true|True)/)) warn('force-action', 'force: true was added, which skips actionability checks');
  if (count(b, WEAK) > count(a, WEAK) && count(b, STRONG) < count(a, STRONG)) warn('weaker-matcher', 'a specific matcher was replaced by a weaker one');
  if (count(b, /\.not\./) !== count(a, /\.not\./)) warn('negation-changed', 'the number of .not assertions changed');
  if (count(b, /retries\s*[:=]\s*[1-9]/) > count(a, /retries\s*[:=]\s*[1-9]/)) warn('retries-added', 'retries were added');

  const verdict: Verdict = findings.some((f) => f.severity === 'BLOCK') ? 'BLOCK' : findings.length ? 'WARN' : 'PASS';
  return { verdict, findings };
}
