/**
 * OpenAI Chat Completions adapter over fetch. Also serves any
 * OpenAI-compatible endpoint (local models through Ollama, vLLM, LM Studio)
 * via AUTOHEAL_BASE_URL.
 */

import type { ChatRequest, ChatResponse, Part, Provider, StopReason } from './types.js';
import { ProviderError } from './types.js';

export interface OpenAIOptions {
  apiKey?: string;
  model: string;
  baseURL: string;
  timeoutMs: number;
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | WireContentPart[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

export type WireContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function toWireMessages(request: ChatRequest): WireMessage[] {
  const out: WireMessage[] = [{ role: 'system', content: request.system }];
  for (const turn of request.turns) {
    if (turn.role === 'assistant') {
      const text = turn.parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text).join('\n');
      const calls = turn.parts.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      out.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      });
      continue;
    }
    const texts: string[] = [];
    const images: WireContentPart[] = [];
    for (const part of turn.parts) {
      if (part.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: part.id, content: part.isError ? `ERROR: ${part.content}` : part.content });
      } else if (part.type === 'text') {
        texts.push(part.text);
      } else if (part.type === 'image') {
        images.push({ type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } });
      }
    }
    if (images.length) out.push({ role: 'user', content: [...(texts.length ? [{ type: 'text' as const, text: texts.join('\n\n') }] : []), ...images] });
    else if (texts.length) out.push({ role: 'user', content: texts.join('\n\n') });
  }
  return out;
}

export class OpenAIProvider implements Provider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly options: OpenAIOptions) {
    this.model = options.model;
    this.name = /api\.openai\.com/.test(options.baseURL) ? 'openai' : 'openai-compatible';
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const official = this.name === 'openai';
    const body = {
      model: this.model,
      messages: toWireMessages(request),
      tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      ...(official ? { max_completion_tokens: request.maxTokens } : { max_tokens: request.maxTokens }),
    };
    const url = `${this.options.baseURL.replace(/\/+$/, '')}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new ProviderError(`${this.name} returned HTTP ${res.status}: ${text.slice(0, 300)}`, retryable);
    }
    let json: {
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: WireToolCall[] } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError(`${this.name} returned a response that is not JSON.`);
    }
    const choice = json.choices?.[0];
    const parts: Part[] = [];
    if (choice?.message?.content) parts.push({ type: 'text', text: choice.message.content });
    for (const call of choice?.message?.tool_calls ?? []) {
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        input = { __invalid_json: call.function.arguments };
      }
      parts.push({ type: 'tool_call', id: call.id, name: call.function.name, input });
    }
    const finish = choice?.finish_reason;
    const stop: StopReason =
      parts.some((p) => p.type === 'tool_call') ? 'tool_calls' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end';
    return {
      parts,
      raw: undefined,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      stop,
      model: json.model ?? this.model,
    };
  }
}
