/**
 * `autoheal init` and `autoheal doctor`: the first ten minutes.
 *
 * init finds your CI, test framework, package manager and test workflow,
 * writes the AutoHeal workflow for GitHub Actions, GitLab CI or CircleCI from
 * the bundled templates, adds AutoHeal's folders to .gitignore and prints the
 * few things only you can do (a secret, a repository setting), with links.
 *
 * doctor checks the same things any time, plus the local machine, and says
 * how to fix each one. Neither command runs your tests or changes your code.
 */
import { type Framework } from './cypress.js';
export type SetupCi = 'github' | 'gitlab' | 'circleci';
export interface Check {
    level: 'ok' | 'warn' | 'fail';
    what: string;
    /** How to fix it, when it is not ok. */
    fix?: string;
}
export interface Project {
    root: string;
    ci: SetupCi;
    framework: Framework;
    pm: 'npm' | 'pnpm' | 'yarn' | 'none';
    /** owner/name and host from the git remote, when there is one. */
    remote?: {
        host: string;
        repo: string;
    };
    /** GitHub: the test workflow's name and file. */
    workflow?: {
        name: string;
        file: string;
        text: string;
    };
    playwrightVersion?: string;
}
/** The GitHub workflow that runs the tests (not AutoHeal's own). */
export declare function findTestWorkflow(root: string, framework: Framework): Project['workflow'];
export declare function detect(root: string, ci?: SetupCi): Promise<Project>;
/** The bundled template, filled in for this project. */
export declare function renderTemplate(p: Project): {
    file: string;
    text: string;
};
/** What the project's own files say about the setup, as checks. */
export declare function projectChecks(p: Project): Check[];
/** The things only you can do: secrets and repository settings, with links. */
export declare function manualSteps(p: Project): string[];
export interface InitResult {
    project: Project;
    written: string[];
    skipped: string[];
    checks: Check[];
    steps: string[];
}
export declare function init(root: string, options?: {
    ci?: SetupCi;
    force?: boolean;
    dryRun?: boolean;
}): Promise<InitResult>;
/** Every check: the project's setup and this machine. */
export declare function doctor(root: string, env?: NodeJS.ProcessEnv, options?: {
    ci?: SetupCi;
}): Promise<Check[]>;
export declare function checksText(checks: Check[]): string;
