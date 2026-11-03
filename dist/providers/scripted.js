/**
 * Scripted provider: replays responses from a JSON file. It exists for the
 * test suite and the dummy-data simulation (no AI key, no network, same
 * agent loop). Never selected unless AUTOHEAL_PROVIDER=scripted.
 *
 * File format: an array of steps; each step is
 *   { "text"?: string, "calls"?: [{ "name": string, "input": object }],
 *     "usage"?: { "inputTokens": number, "outputTokens": number } }
 */
import { readFileSync } from 'node:fs';
import { ProviderError } from './types.js';
export class ScriptedProvider {
    name = 'scripted';
    model = 'scripted';
    requests = [];
    index = 0;
    steps;
    constructor(source) {
        this.steps = typeof source === 'string' ? JSON.parse(readFileSync(source, 'utf8')) : source;
        if (!Array.isArray(this.steps))
            throw new ProviderError('The script must be a JSON array of steps.');
    }
    async chat(request) {
        this.requests.push(structuredClone(request));
        const step = this.steps[this.index++];
        if (!step)
            return { parts: [{ type: 'text', text: 'Script finished.' }], raw: undefined, usage: { inputTokens: 0, outputTokens: 0 }, stop: 'end', model: this.model };
        const parts = [];
        if (step.text)
            parts.push({ type: 'text', text: step.text });
        (step.calls ?? []).forEach((call, i) => parts.push({ type: 'tool_call', id: `call_${this.index}_${i}`, name: call.name, input: call.input }));
        return {
            parts,
            raw: undefined,
            usage: step.usage ?? { inputTokens: 1000, outputTokens: 200 },
            stop: parts.some((p) => p.type === 'tool_call') ? 'tool_calls' : 'end',
            model: this.model,
        };
    }
}
//# sourceMappingURL=scripted.js.map