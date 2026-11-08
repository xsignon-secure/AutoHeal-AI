/**
 * Where AutoHeal runs: GitHub Actions, GitLab CI, CircleCI or your own
 * machine. Each CI names the same things (the run, the commit, the branch,
 * the repository and its host) with its own variables; this module reads them
 * once so the rest of AutoHeal never has to know which CI it is in.
 *
 * Only plain, checked values come out: a value that does not look like what
 * it should be (a branch with spaces, a commit that is not hex) is dropped.
 */
export type CiName = 'github' | 'gitlab' | 'circleci' | 'local';
/** Where the repository is hosted, which decides how PRs and issues are opened. */
export type ForgeName = 'github' | 'gitlab' | 'none';
export interface CiInfo {
    ci: CiName;
    forge: ForgeName;
    /** owner/name (GitHub) or group/subgroup/name (GitLab). */
    repo?: string;
    /** https://github.com, https://gitlab.com or your own server. */
    server?: string;
    /** REST API base: https://api.github.com or https://gitlab.example.com/api/v4. */
    api?: string;
    /** GitLab's numeric project id. */
    projectId?: string;
    runId?: string;
    runUrl?: string;
    /** This job's own page (where its artifacts are), which AUTOHEAL_RUN_URL never changes. */
    selfUrl?: string;
    commit?: string;
    branch?: string;
    /** Open pull request or merge request number for the failed run. */
    pr?: string;
    /** Who triggered the run, for quarantine owners (with a leading @). */
    owner?: string;
    /** Default branch, when the CI says. */
    defaultBranch?: string;
}
/** Host and path of a CircleCI repository URL (git@github.com:a/b.git or https://github.com/a/b). */
export declare function parseRepoUrl(url: string | undefined): {
    host: string;
    repo: string;
} | undefined;
/** Reads the CI's own variables. AUTOHEAL_* values (set by a template) win. */
export declare function ciInfo(env?: NodeJS.ProcessEnv): CiInfo;
/** Web link of the repository, for commit links in the PR. */
export declare function repoWebUrl(info: CiInfo): string | undefined;
/** Commit link on the host (GitHub: /commit/sha, GitLab: /-/commit/sha). */
export declare function commitUrl(info: CiInfo, sha: string): string | undefined;
/** Human name of the CI, for messages. */
export declare function ciLabel(ci: CiName): string;
/** True for a branch AutoHeal itself pushed: never heal it (no loops). */
export declare function isAutohealBranch(branch: string | undefined): boolean;
