/**
 * Spend limits for one heal job: steps, tokens and dollars. The dollar figure
 * is an estimate from list prices (USD per million tokens); set
 * AUTOHEAL_PRICE_IN / AUTOHEAL_PRICE_OUT for models not listed here.
 */
/** [input, output] USD per 1M tokens, Anthropic first-party list prices. */
export const PRICES = {
    'claude-fable-5-1': [10, 50],
    'claude-opus-5-5': [4, 20],
    'claude-opus-5': [5, 25],
    'claude-sonnet-5-5': [2, 10],
    'claude-sonnet-5': [2, 10],
    'claude-haiku-5-5': [0.1, 0.5],
};
export function priceFor(model, env = process.env) {
    const inEnv = Number(env.AUTOHEAL_PRICE_IN);
    const outEnv = Number(env.AUTOHEAL_PRICE_OUT);
    if (env.AUTOHEAL_PRICE_IN && env.AUTOHEAL_PRICE_OUT && Number.isFinite(inEnv) && Number.isFinite(outEnv) && inEnv >= 0 && outEnv >= 0)
        return [inEnv, outEnv];
    return PRICES[model] ?? null;
}
export class Budget {
    limits;
    price;
    steps = 0;
    inputTokens = 0;
    outputTokens = 0;
    /** The current failure's share of what is left (see share()). */
    shareUsd = Infinity;
    shareTokens = Infinity;
    constructor(limits, price) {
        this.limits = limits;
        this.price = price;
    }
    record(usage) {
        this.steps += 1;
        this.inputTokens += usage.inputTokens;
        this.outputTokens += usage.outputTokens;
    }
    get usd() {
        if (!this.price)
            return 0;
        return (this.inputTokens * this.price[0] + this.outputTokens * this.price[1]) / 1_000_000;
    }
    /**
     * Gives the next failure an equal share of what is left, so the first hard
     * failure cannot spend the whole job budget. Unspent money rolls over.
     */
    share(failuresLeft) {
        const n = Math.max(1, Math.floor(failuresLeft));
        this.shareUsd = this.usd + Math.max(0, this.limits.maxUsd - this.usd) / n;
        const used = this.inputTokens + this.outputTokens;
        this.shareTokens = used + Math.max(0, this.limits.maxTokens - used) / n;
    }
    /**
     * The limit that the next call could break, judged by its worst case
     * (estimated input plus the full output allowance), so a single call can
     * never push the job past max-usd or max-tokens.
     */
    wouldExceed(estimatedInputTokens, maxOutputTokens) {
        const now = this.exceeded();
        if (now)
            return now;
        const tokens = this.inputTokens + this.outputTokens + estimatedInputTokens + maxOutputTokens;
        if (tokens > this.limits.maxTokens)
            return `token limit (${this.limits.maxTokens}; the next call could need ${estimatedInputTokens + maxOutputTokens})`;
        if (tokens > this.shareTokens)
            return `token share for this failure (${Math.floor(this.shareTokens)} of ${this.limits.maxTokens})`;
        if (this.price) {
            const next = (estimatedInputTokens * this.price[0] + maxOutputTokens * this.price[1]) / 1_000_000;
            if (this.usd + next > this.limits.maxUsd)
                return `cost limit ($${this.limits.maxUsd.toFixed(2)}; the next call could cost up to $${next.toFixed(2)})`;
            if (this.usd + next > this.shareUsd)
                return `cost share for this failure ($${this.shareUsd.toFixed(2)} of $${this.limits.maxUsd.toFixed(2)})`;
        }
        return null;
    }
    /** The limit that was reached, or null while there is room left. */
    exceeded() {
        if (this.steps >= this.limits.maxSteps)
            return `step limit (${this.limits.maxSteps})`;
        if (this.inputTokens + this.outputTokens >= this.limits.maxTokens)
            return `token limit (${this.limits.maxTokens})`;
        if (this.price && this.usd >= this.limits.maxUsd)
            return `cost limit ($${this.limits.maxUsd.toFixed(2)})`;
        return null;
    }
    snapshot() {
        return {
            steps: this.steps,
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            usd: Math.round(this.usd * 10_000) / 10_000,
            priced: this.price !== null,
        };
    }
}
/** Adds snapshots together (for the job total across failures). */
export function addSnapshots(a, b) {
    return {
        steps: a.steps + b.steps,
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        usd: Math.round((a.usd + b.usd) * 10_000) / 10_000,
        priced: a.priced && b.priced,
    };
}
export const EMPTY_SNAPSHOT = { steps: 0, inputTokens: 0, outputTokens: 0, usd: 0, priced: true };
//# sourceMappingURL=budget.js.map