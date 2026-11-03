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

import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { ScriptedProvider } from './scripted.js';
import type { Provider } from './types.js';

export * from './types.js';
export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider, toWireMessages } from './openai.js';
export { ScriptedProvider } from './scripted.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): Provider | null {
  const explicit = env.AUTOHEAL_PROVIDER?.trim().toLowerCase();
  const kind =
    explicit ||
    (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : env.AUTOHEAL_BASE_URL ? 'openai-compatible' : 'none');
  const model = env.AUTOHEAL_MODEL?.trim();

  switch (kind) {
    case 'none':
      return null;
    case 'anthropic': {
      if (!env.ANTHROPIC_API_KEY) throw new ConfigError('AUTOHEAL_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');
      const effort = (env.AUTOHEAL_EFFORT?.trim() || 'medium') as (typeof EFFORTS)[number];
      if (!EFFORTS.includes(effort)) throw new ConfigError(`AUTOHEAL_EFFORT must be one of ${EFFORTS.join(', ')}.`);
      return new AnthropicProvider({
        apiKey: env.ANTHROPIC_API_KEY,
        model: model || DEFAULT_ANTHROPIC_MODEL,
        effort,
        fallbacks: env.AUTOHEAL_NO_FALLBACK !== '1',
        ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      });
    }
    case 'openai': {
      if (!env.OPENAI_API_KEY) throw new ConfigError('AUTOHEAL_PROVIDER=openai needs OPENAI_API_KEY.');
      if (!model) throw new ConfigError('Set AUTOHEAL_MODEL to the OpenAI model to use.');
      return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, model, baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', timeoutMs: 300_000 });
    }
    case 'openai-compatible': {
      if (!env.AUTOHEAL_BASE_URL) throw new ConfigError('AUTOHEAL_PROVIDER=openai-compatible needs AUTOHEAL_BASE_URL.');
      if (!model) throw new ConfigError('Set AUTOHEAL_MODEL to the model your endpoint serves.');
      return new OpenAIProvider({
        model,
        baseURL: env.AUTOHEAL_BASE_URL,
        timeoutMs: 600_000,
        ...(env.AUTOHEAL_API_KEY ? { apiKey: env.AUTOHEAL_API_KEY } : {}),
      });
    }
    case 'scripted': {
      if (!env.AUTOHEAL_SCRIPT) throw new ConfigError('AUTOHEAL_PROVIDER=scripted needs AUTOHEAL_SCRIPT.');
      return new ScriptedProvider(env.AUTOHEAL_SCRIPT);
    }
    default:
      throw new ConfigError(`Unknown AUTOHEAL_PROVIDER "${kind}".`);
  }
}
