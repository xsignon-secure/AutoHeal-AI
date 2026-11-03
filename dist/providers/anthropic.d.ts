/**
 * Claude adapter on the official Anthropic SDK (Apache-2.0).
 *
 * Defaults: model claude-opus-5-5, effort "medium" (set explicitly; it is the
 * Opus 5.5 default), and the server-side refusal fallback ("default" form) on
 * the models that accept it. Thinking stays adaptive (Opus 5.5 cannot turn it
 * off), and the assistant content is replayed unchanged on every turn.
 */
import type { ChatRequest, ChatResponse, Provider } from './types.js';
export interface AnthropicOptions {
    apiKey: string;
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    baseURL?: string;
    fallbacks: boolean;
}
export declare class AnthropicProvider implements Provider {
    private readonly options;
    readonly name = "anthropic";
    readonly model: string;
    private readonly client;
    private fallbacks;
    constructor(options: AnthropicOptions);
    chat(request: ChatRequest): Promise<ChatResponse>;
    private send;
    private wrap;
}
