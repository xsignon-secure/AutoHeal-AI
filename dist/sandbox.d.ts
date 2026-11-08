/**
 * The test sandbox: your tests, and every fix the AI proposes, run as a
 * separate Linux user. AutoHeal's own process (which holds the AI key) runs as
 * the runner user. Linux does not let one user read another user's process
 * memory or environment (/proc/<pid>/environ, /proc/<pid>/mem), so code in a
 * test cannot read the key, the runner's tokens or its files.
 *
 * The action's "Prepare the sandbox" step (scripts/sandbox-setup.sh) creates
 * the user and grants it the project folder; this module only decides whether
 * to use it and wraps the engine's command line.
 */
import { execFileSync } from 'node:child_process';
export type SandboxMode = 'auto' | 'user' | 'off';
export interface Sandbox {
    user: string;
    home: string;
}
export interface SandboxChoice {
    sandbox: Sandbox | null;
    /** Shown in the PR and the job summary. */
    note: string;
}
export declare function sandboxMode(value: string | undefined): SandboxMode;
/**
 * Picks the sandbox. `user` fails closed when it cannot be used; `auto` uses it
 * when the setup step prepared it (Linux runners) and says so when it could not.
 */
export declare function chooseSandbox(mode: SandboxMode, env?: NodeJS.ProcessEnv, run?: typeof execFileSync): SandboxChoice;
/**
 * The command that starts `command args` as the sandbox user with exactly
 * `env` (nothing inherited). The values end up on the command line, so `env`
 * must hold no secrets; engineEnv() already removed them.
 */
export declare function wrapCommand(sandbox: Sandbox, command: string, args: string[], env: Record<string, string>): {
    command: string;
    args: string[];
};
/**
 * Runs scripts/sandbox-setup.sh, the step GitHub Actions runs before AutoHeal,
 * for CIs that have no such step (GitLab, CircleCI). Returns the variables
 * chooseSandbox() reads; empty when the sandbox could not be prepared (the
 * script says why, and `user` mode fails instead).
 */
export declare function prepareSandbox(projectRoot: string, mode: SandboxMode, log?: (line: string) => void, run?: typeof execFileSync): Record<string, string>;
