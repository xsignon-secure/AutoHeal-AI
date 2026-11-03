/**
 * Scripted provider: replays responses from a JSON file. It exists for the
 * test suite and the dummy-data simulation (no AI key, no network, same
 * agent loop). Never selected unless AUTOHEAL_PROVIDER=scripted.
 *
 * File format: an array of steps; each step is
 *   { "text"?: string, "calls"?: [{ "name": string, "input": object }],
 *     "usage"?: { "inputTokens": number, "outputTokens": number } }
 */
import type { ChatRequest, ChatResponse, Provider } from './types.js';
interface Step {
    text?: string;
    calls?: Array<{
        name: string;
        input: Record<string, unknown>;
    }>;
    usage?: {
        inputTokens: number;
        outputTokens: number;
    };
}
export declare class ScriptedProvider implements Provider {
    readonly name = "scripted";
    readonly model = "scripted";
    readonly requests: ChatRequest[];
    private index;
    private readonly steps;
    constructor(source: string | Step[]);
    chat(request: ChatRequest): Promise<ChatResponse>;
}
export {};
