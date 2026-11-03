/**
 * Provider-neutral chat types. Each provider adapter maps these to its own
 * wire format, so the agent loop never depends on one AI vendor.
 */
export interface ToolSpec {
    name: string;
    description: string;
    /** JSON Schema for the tool input (type: object). */
    inputSchema: Record<string, unknown>;
}
export type Part = {
    type: 'text';
    text: string;
} | {
    type: 'tool_call';
    id: string;
    name: string;
    input: Record<string, unknown>;
} | {
    type: 'tool_result';
    id: string;
    content: string;
    isError?: boolean;
}
/** A screenshot (base64). Only ever sent in user turns. */
 | {
    type: 'image';
    mediaType: 'image/png' | 'image/jpeg';
    data: string;
    width?: number;
    height?: number;
};
export interface Turn {
    role: 'user' | 'assistant';
    parts: Part[];
    /**
     * The provider's own assistant content, replayed unchanged on the next
     * request (Anthropic thinking and fallback blocks must be passed back as
     * they came).
     */
    raw?: unknown;
}
export interface ChatRequest {
    system: string;
    turns: Turn[];
    tools: ToolSpec[];
    maxTokens: number;
}
export type StopReason = 'tool_calls' | 'end' | 'max_tokens' | 'refusal';
export interface Usage {
    inputTokens: number;
    outputTokens: number;
}
export interface ChatResponse {
    parts: Part[];
    raw: unknown;
    usage: Usage;
    stop: StopReason;
    /** The model that actually served the request. */
    model: string;
}
export interface Provider {
    readonly name: string;
    readonly model: string;
    chat(request: ChatRequest): Promise<ChatResponse>;
}
export declare class ProviderError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable?: boolean);
}
