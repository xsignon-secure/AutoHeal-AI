/**
 * Spend limits for one heal job: steps, tokens and dollars. The dollar figure
 * is an estimate from list prices (USD per million tokens); set
 * AUTOHEAL_PRICE_IN / AUTOHEAL_PRICE_OUT for models not listed here.
 */
import type { Usage } from './providers/types.js';
/** [input, output] USD per 1M tokens, Anthropic first-party list prices. */
export declare const PRICES: Record<string, [number, number]>;
export interface BudgetLimits {
    maxSteps: number;
    maxTokens: number;
    maxUsd: number;
}
export interface BudgetSnapshot {
    steps: number;
    inputTokens: number;
    outputTokens: number;
    usd: number;
    priced: boolean;
}
export declare function priceFor(model: string, env?: NodeJS.ProcessEnv): [number, number] | null;
/**
 * OpenRouter publishes the price of every model it serves. For an OpenRouter
 * base URL, look the model up so the dollar limit works without hand-set
 * prices. A plain GET of the public model list: no key goes with it.
 */
export declare function lookupOpenRouterPrice(model: string, baseUrl: string | undefined, fetchFn?: typeof fetch): Promise<[number, number] | null>;
/**
 * When the model has no known price, try OpenRouter's list and, if found, set
 * AUTOHEAL_PRICE_IN / AUTOHEAL_PRICE_OUT in env so every later priceFor() call
 * (heal, cover, the dashboard upload) agrees. Returns the price in use.
 */
export declare function ensurePrice(model: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void, fetchFn?: typeof fetch): Promise<[number, number] | null>;
export declare class Budget {
    readonly limits: BudgetLimits;
    private readonly price;
    private steps;
    private inputTokens;
    private outputTokens;
    /** The current failure's share of what is left (see share()). */
    private shareUsd;
    private shareTokens;
    constructor(limits: BudgetLimits, price: [number, number] | null);
    record(usage: Usage): void;
    get usd(): number;
    /**
     * Gives the next failure an equal share of what is left, so the first hard
     * failure cannot spend the whole job budget. Unspent money rolls over.
     */
    share(failuresLeft: number): void;
    /**
     * The limit that the next call could break, judged by its worst case
     * (estimated input plus the full output allowance), so a single call can
     * never push the job past max-usd or max-tokens.
     */
    wouldExceed(estimatedInputTokens: number, maxOutputTokens: number): string | null;
    /** The limit that was reached, or null while there is room left. */
    exceeded(): string | null;
    snapshot(): BudgetSnapshot;
}
/** Adds snapshots together (for the job total across failures). */
export declare function addSnapshots(a: BudgetSnapshot, b: BudgetSnapshot): BudgetSnapshot;
export declare const EMPTY_SNAPSHOT: BudgetSnapshot;
