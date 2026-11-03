/**
 * OpenAI Chat Completions adapter over fetch. Also serves any
 * OpenAI-compatible endpoint (local models through Ollama, vLLM, LM Studio)
 * via AUTOHEAL_BASE_URL.
 */
import type { ChatRequest, ChatResponse, Provider } from './types.js';
export interface OpenAIOptions {
    apiKey?: string;
    model: string;
    baseURL: string;
    timeoutMs: number;
}
interface WireToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}
interface WireMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: WireToolCall[];
    tool_call_id?: string;
}
export declare function toWireMessages(request: ChatRequest): WireMessage[];
export declare class OpenAIProvider implements Provider {
    private readonly options;
    readonly name: string;
    readonly model: string;
    constructor(options: OpenAIOptions);
    chat(request: ChatRequest): Promise<ChatResponse>;
}
export {};
