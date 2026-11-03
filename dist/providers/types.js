/**
 * Provider-neutral chat types. Each provider adapter maps these to its own
 * wire format, so the agent loop never depends on one AI vendor.
 */
export class ProviderError extends Error {
    retryable;
    constructor(message, retryable = false) {
        super(message);
        this.retryable = retryable;
        this.name = 'ProviderError';
    }
}
//# sourceMappingURL=types.js.map