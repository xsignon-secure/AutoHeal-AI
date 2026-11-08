/**
 * Where AutoHeal runs: GitHub Actions, GitLab CI, CircleCI or your own
 * machine. Each CI names the same things (the run, the commit, the branch,
 * the repository and its host) with its own variables; this module reads them
 * once so the rest of AutoHeal never has to know which CI it is in.
 *
 * Only plain, checked values come out: a value that does not look like what
 * it should be (a branch with spaces, a commit that is not hex) is dropped.
 */
const BRANCH = /^[\w./-]{1,200}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const RUN = /^[A-Za-z0-9-]{1,64}$/;
const REPO = /^[\w.-]+(?:\/[\w.-]+){1,5}$/;
const NUMBER = /^\d{1,10}$/;
const LOGIN = /^[\w.-]{1,100}$/;
const ok = (v, re) => (v && re.test(v) && !v.includes('..') && !v.startsWith('-') ? v : undefined);
function httpsOrigin(v) {
    if (!v)
        return undefined;
    try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')))
            return undefined;
        if (u.username || u.password)
            return undefined;
        return u.origin;
    }
    catch {
        return undefined;
    }
}
/** Host and path of a CircleCI repository URL (git@github.com:a/b.git or https://github.com/a/b). */
export function parseRepoUrl(url) {
    if (!url)
        return undefined;
    const ssh = /^(?:ssh:\/\/)?git@([\w.-]+)[:/](.+?)(?:\.git)?\/?$/.exec(url);
    if (ssh?.[1] && ssh[2])
        return REPO.test(ssh[2]) ? { host: ssh[1], repo: ssh[2] } : undefined;
    try {
        const u = new URL(url);
        const repo = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
        return REPO.test(repo) ? { host: u.hostname, repo } : undefined;
    }
    catch {
        return undefined;
    }
}
function forgeForHost(host, env) {
    const forced = (env.AUTOHEAL_FORGE ?? '').toLowerCase();
    if (forced === 'github' || forced === 'gitlab')
        return forced;
    if (host === 'github.com' || host.endsWith('.ghe.com'))
        return 'github';
    if (host === 'gitlab.com' || host.startsWith('gitlab.'))
        return 'gitlab';
    return 'none';
}
function compact(info) {
    return Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined && v !== ''));
}
/** Reads the CI's own variables. AUTOHEAL_* values (set by a template) win. */
export function ciInfo(env = process.env) {
    let info;
    if (env.GITHUB_ACTIONS === 'true') {
        const server = httpsOrigin(env.GITHUB_SERVER_URL) ?? 'https://github.com';
        const repo = ok(env.GITHUB_REPOSITORY, REPO);
        info = {
            ci: 'github',
            forge: 'github',
            server,
            api: httpsOrigin(env.GITHUB_API_URL) ?? (server === 'https://github.com' ? 'https://api.github.com' : `${server}/api/v3`),
            ...(repo ? { repo } : {}),
            ...(ok(env.GITHUB_RUN_ID, RUN) ? { runId: env.GITHUB_RUN_ID } : {}),
            ...(repo && ok(env.GITHUB_RUN_ID, RUN) ? { runUrl: `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` } : {}),
            ...(ok(env.GITHUB_SHA, COMMIT) ? { commit: env.GITHUB_SHA } : {}),
            ...(ok(env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME, BRANCH) ? { branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME } : {}),
            ...(ok(env.GITHUB_ACTOR, LOGIN) ? { owner: `@${env.GITHUB_ACTOR}` } : {}),
        };
    }
    else if (env.GITLAB_CI === 'true') {
        const server = httpsOrigin(env.CI_SERVER_URL) ?? 'https://gitlab.com';
        const branch = env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_BRANCH || env.CI_COMMIT_REF_NAME;
        info = {
            ci: 'gitlab',
            forge: 'gitlab',
            server,
            api: httpsOrigin(env.CI_API_V4_URL) && /\/api\/v4\/?$/.test(env.CI_API_V4_URL ?? '') ? (env.CI_API_V4_URL ?? '').replace(/\/+$/, '') : `${server}/api/v4`,
            ...(ok(env.CI_PROJECT_PATH, REPO) ? { repo: env.CI_PROJECT_PATH } : {}),
            ...(ok(env.CI_PROJECT_ID, NUMBER) ? { projectId: env.CI_PROJECT_ID } : {}),
            ...(ok(env.CI_PIPELINE_ID, RUN) ? { runId: env.CI_PIPELINE_ID } : {}),
            ...(httpsOrigin(env.CI_PIPELINE_URL) ? { runUrl: env.CI_PIPELINE_URL } : {}),
            ...(ok(env.CI_COMMIT_SHA, COMMIT) ? { commit: env.CI_COMMIT_SHA } : {}),
            ...(ok(branch, BRANCH) ? { branch } : {}),
            ...(ok(env.CI_MERGE_REQUEST_IID, NUMBER) ? { pr: env.CI_MERGE_REQUEST_IID } : {}),
            ...(ok(env.GITLAB_USER_LOGIN, LOGIN) ? { owner: `@${env.GITLAB_USER_LOGIN}` } : {}),
            ...(ok(env.CI_DEFAULT_BRANCH, BRANCH) ? { defaultBranch: env.CI_DEFAULT_BRANCH } : {}),
        };
    }
    else if (env.CIRCLECI === 'true') {
        const parsed = parseRepoUrl(env.CIRCLE_REPOSITORY_URL);
        const forge = parsed ? forgeForHost(parsed.host, env) : 'none';
        const server = parsed ? `https://${parsed.host}` : undefined;
        // The workflow id is the same in every job of the run, so heal and publish agree on it.
        const runId = ok(env.CIRCLE_WORKFLOW_ID, RUN);
        const pr = /\/(?:pull|merge_requests)\/(\d{1,10})$/.exec(env.CIRCLE_PULL_REQUEST ?? '')?.[1];
        info = {
            ci: 'circleci',
            forge,
            ...(server ? { server } : {}),
            ...(forge === 'github' && server ? { api: server === 'https://github.com' ? 'https://api.github.com' : `${server}/api/v3` } : {}),
            ...(forge === 'gitlab' && server ? { api: `${server}/api/v4` } : {}),
            ...(parsed ? { repo: parsed.repo } : {}),
            ...(runId ? { runId } : {}),
            ...(httpsOrigin(env.CIRCLE_BUILD_URL) ? { runUrl: env.CIRCLE_BUILD_URL } : {}),
            ...(ok(env.CIRCLE_SHA1, COMMIT) ? { commit: env.CIRCLE_SHA1 } : {}),
            ...(ok(env.CIRCLE_BRANCH, BRANCH) ? { branch: env.CIRCLE_BRANCH } : {}),
            ...(pr ? { pr } : {}),
            ...(ok(env.CIRCLE_USERNAME, LOGIN) ? { owner: `@${env.CIRCLE_USERNAME}` } : {}),
        };
    }
    else {
        info = { ci: 'local', forge: 'none' };
    }
    if (info.runUrl)
        info.selfUrl = info.runUrl;
    if (info.ci === 'gitlab' && httpsOrigin(env.CI_JOB_URL))
        info.selfUrl = env.CI_JOB_URL;
    // A template (or you) can set these explicitly; they are checked the same way.
    if (ok(env.AUTOHEAL_RUN_ID, RUN))
        info.runId = env.AUTOHEAL_RUN_ID;
    if (httpsOrigin(env.AUTOHEAL_RUN_URL))
        info.runUrl = env.AUTOHEAL_RUN_URL;
    if (ok(env.AUTOHEAL_COMMIT, COMMIT))
        info.commit = env.AUTOHEAL_COMMIT;
    if (ok(env.AUTOHEAL_BRANCH, BRANCH))
        info.branch = env.AUTOHEAL_BRANCH;
    if (ok(env.AUTOHEAL_PR, NUMBER))
        info.pr = env.AUTOHEAL_PR;
    if (env.AUTOHEAL_OWNER && /^@?[\w.-]{1,100}$/.test(env.AUTOHEAL_OWNER))
        info.owner = env.AUTOHEAL_OWNER.startsWith('@') ? env.AUTOHEAL_OWNER : `@${env.AUTOHEAL_OWNER}`;
    if (ok(env.AUTOHEAL_REPO, REPO))
        info.repo = env.AUTOHEAL_REPO;
    const forced = (env.AUTOHEAL_FORGE ?? '').toLowerCase();
    if (forced === 'github' || forced === 'gitlab')
        info.forge = forced;
    if (httpsOrigin(env.AUTOHEAL_SERVER_URL))
        info.server = httpsOrigin(env.AUTOHEAL_SERVER_URL);
    if (httpsOrigin(env.AUTOHEAL_API_URL))
        info.api = (env.AUTOHEAL_API_URL ?? '').replace(/\/+$/, '');
    if (info.forge === 'github' && !info.server)
        info.server = 'https://github.com';
    if (info.forge === 'github' && !info.api)
        info.api = info.server === 'https://github.com' ? 'https://api.github.com' : `${info.server}/api/v3`;
    if (info.forge === 'gitlab' && !info.server)
        info.server = 'https://gitlab.com';
    if (info.forge === 'gitlab' && !info.api)
        info.api = `${info.server}/api/v4`;
    return compact(info);
}
/** Web link of the repository, for commit links in the PR. */
export function repoWebUrl(info) {
    return info.server && info.repo ? `${info.server}/${info.repo}` : undefined;
}
/** Commit link on the host (GitHub: /commit/sha, GitLab: /-/commit/sha). */
export function commitUrl(info, sha) {
    const web = repoWebUrl(info);
    if (!web || !COMMIT.test(sha))
        return undefined;
    return info.forge === 'gitlab' ? `${web}/-/commit/${sha}` : `${web}/commit/${sha}`;
}
/** Human name of the CI, for messages. */
export function ciLabel(ci) {
    return { github: 'GitHub Actions', gitlab: 'GitLab CI', circleci: 'CircleCI', local: 'your machine' }[ci];
}
/** True for a branch AutoHeal itself pushed: never heal it (no loops). */
export function isAutohealBranch(branch) {
    return !!branch && branch.startsWith('autoheal/');
}
//# sourceMappingURL=ci.js.map