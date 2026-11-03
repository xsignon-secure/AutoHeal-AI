/**
 * Picks the AI provider from the environment. The customer's own key is the
 * only credential; nothing here talks to an XSignOn server.
 *
 *   AUTOHEAL_PROVIDER  anthropic | openai | openai-compatible | scripted | none
 *                      (default: anthropic when ANTHROPIC_API_KEY is set, else
 *                      openai when OPENAI_API_KEY is set, else
 *                      openai-compatible when AUTOHEAL_BASE_URL is set, else none)
 *   AUTOHEAL_MODEL     model id (default for anthropic: claude-opus-5-5;
 *                      required for the others)
 *   AUTOHEAL_EFFORT    anthropic effort: low | medium | high | xhigh | max (default medium)
 *   AUTOHEAL_BASE_URL  OpenAI-compatible base URL, e.g. http://localhost:11434/v1
 *   AUTOHEAL_SCRIPT    scripted provider: path to the JSON script
 */
import type { Provider } from './types.js';
export * from './types.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider, toWireMessages } from './openai.js';
export { ScriptedProvider } from './scripted.js';
export declare const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
export declare class ConfigError extends Error {
    constructor(message: string);
}
export declare function providerFromEnv(env?: NodeJS.ProcessEnv): Provider | null;
