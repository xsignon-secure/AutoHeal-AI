/**
 * Claude adapter on the official Anthropic SDK (Apache-2.0).
 *
 * Defaults: model claude-opus-5-5, effort "medium" (set explicitly; it is the
 * Opus 5.5 default), and the server-side refusal fallback ("default" form) on
 * the models that accept it. Thinking stays adaptive (Opus 5.5 cannot turn it
 * off), and the assistant content is replayed unchanged on every turn.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from './types.js';
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
function toBlocks(parts) {
    return parts.map((part) => {
        if (part.type === 'text')
            return { type: 'text', text: part.text };
        if (part.type === 'tool_call')
            return { type: 'tool_use', id: part.id, name: part.name, input: part.input };
        return { type: 'tool_result', tool_use_id: part.id, content: part.content, ...(part.isError ? { is_error: true } : {}) };
    });
}
export class AnthropicProvider {
    options;
    name = 'anthropic';
    model;
    client;
    fallbacks;
    constructor(options) {
        this.options = options;
        this.model = options.model;
        this.fallbacks = options.fallbacks && FALLBACK_MODELS.has(options.model);
        this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 3, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
    }
    async chat(request) {
        const messages = request.turns.map((turn) => turn.role === 'assistant' && turn.raw !== undefined
            ? { role: 'assistant', content: turn.raw }
            : { role: turn.role, content: toBlocks(turn.parts) });
        const params = {
            model: this.model,
            max_tokens: request.maxTokens,
            system: request.system,
            messages,
            tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
            output_config: { effort: this.options.effort },
        };
        let response;
        try {
            response = await this.send(params);
        }
        catch (error) {
            throw this.wrap(error);
        }
        const content = response.content ?? [];
        const parts = [];
        for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string')
                parts.push({ type: 'text', text: block.text });
            if (block.type === 'tool_use') {
                parts.push({
                    type: 'tool_call',
                    id: String(block.id),
                    name: String(block.name),
                    input: block.input ?? {},
                });
            }
        }
        const usage = response.usage ?? {};
        const reason = response.stop_reason;
        const stop = reason === 'tool_use' ? 'tool_calls' : reason === 'max_tokens' ? 'max_tokens' : reason === 'refusal' ? 'refusal' : 'end';
        return {
            parts,
            raw: content,
            usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
            stop,
            model: typeof response.model === 'string' ? response.model : this.model,
        };
    }
    async send(params) {
        if (this.fallbacks) {
            try {
                const beta = this.client.beta.messages;
                return (await beta.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }));
            }
            catch (error) {
                // An account or model that does not take the fallback parameter: go on without it.
                if (error instanceof Anthropic.BadRequestError && /fallback/i.test(error.message)) {
                    this.fallbacks = false;
                }
                else {
                    throw error;
                }
            }
        }
        const messages = this.client.messages;
        return (await messages.create(params));
    }
    wrap(error) {
        if (error instanceof Anthropic.AuthenticationError)
            return new ProviderError('Anthropic rejected the API key (check ANTHROPIC_API_KEY).');
        if (error instanceof Anthropic.NotFoundError)
            return new ProviderError(`Model not found: ${this.model} (check AUTOHEAL_MODEL).`);
        if (error instanceof Anthropic.RateLimitError)
            return new ProviderError('Anthropic rate limit reached; try again later.', true);
        if (error instanceof Anthropic.BadRequestError)
            return new ProviderError(`Anthropic refused the request: ${error.message}`);
        if (error instanceof Anthropic.APIConnectionError)
            return new ProviderError('Could not reach the Anthropic API.', true);
        if (error instanceof Anthropic.APIError)
            return new ProviderError(`Anthropic API error: ${error.message}`, true);
        return new ProviderError(error instanceof Error ? error.message : String(error));
    }
}
//# sourceMappingURL=anthropic.js.map