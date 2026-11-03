/**
 * Strict validation of uploaded heal events. Unknown fields are rejected, so
 * a misconfigured client cannot start sending code, diffs or error text.
 */
import type { HealEvent } from '../upload.js';
export declare const MAX_EVENTS = 200;
export declare function validateEvent(raw: unknown, index: number): HealEvent;
export declare function validateBatch(raw: unknown): HealEvent[];
