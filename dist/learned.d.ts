/**
 * Fingerprints learned from green runs (`autoheal learn`), kept outside the
 * repository: as the newest `autoheal-fingerprints` artifact on GitHub, the
 * newest `autoheal-learn` job's artifacts on GitLab, or a CircleCI cache. The
 * heal job reads them before it starts, so a locator that breaks for the first
 * time can already be fixed without AI tokens.
 *
 * They are hints, never trusted on their own: a fix found from one still has
 * to pass the anti-cheat guard and the stability reruns like any other.
 */
import type { CiInfo } from './ci.js';
import type { FingerprintEntry } from './fingerprints.js';
export declare const LEARNED_DIR = ".autoheal-learned";
export declare const LEARNED_ARTIFACT = "autoheal-fingerprints";
export declare const LEARN_JOB = "autoheal-learn";
/** Fingerprints in a folder of <id>.json files (the learned folder). */
export declare function loadLearned(dir: string): Promise<FingerprintEntry[]>;
/** Writes the <id>.json entries of a downloaded zip into `dir`. Returns how many. */
export declare function unpackLearned(zip: Buffer, dir: string): Promise<number>;
/**
 * Downloads the newest learned fingerprints into `dir`. Never fails the heal:
 * returns a short note of what happened instead.
 */
export declare function fetchLearned(ci: CiInfo, env: NodeJS.ProcessEnv, dir: string): Promise<string>;
