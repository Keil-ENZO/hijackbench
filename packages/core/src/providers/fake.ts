// A scripted provider for tests: no network, no model.
//
// Each call to chat() consumes the next step of the script. A step is a
// reply, an error to throw, or a function of the request.

import { ProviderError } from "./errors.ts";
import type {
	ChatOptions,
	ChatRequest,
	ChatResponse,
	Provider,
	ToolCall,
} from "./types.ts";

export type FakeStep =
	| ChatResponse
	| Error
	| ((request: ChatRequest) => ChatResponse | Promise<ChatResponse>);

export type FakeProvider = Provider & {
	// Every request received, in order.
	readonly requests: ChatRequest[];
};

export function createFakeProvider(
	steps: FakeStep[],
	model = "fake-model",
): FakeProvider {
	const queue = [...steps];
	const requests: ChatRequest[] = [];

	return {
		name: "fake",
		model,
		requests,
		async chat(request: ChatRequest, { signal }: ChatOptions = {}) {
			if (signal?.aborted)
				throw new ProviderError("aborted", "Request aborted by the caller");
			requests.push(structuredClone(request));
			const step = queue.shift();
			if (step === undefined)
				throw new Error(
					`Fake provider ran out of steps after ${requests.length - 1} calls`,
				);
			if (step instanceof Error) throw step;
			return typeof step === "function" ? step(request) : step;
		},
	};
}

// Shorthands to write scripts.

export const reply = (content: string): ChatResponse => ({
	message: { role: "assistant", content, toolCalls: [] },
	finishReason: "stop",
	usage: { inputTokens: 0, outputTokens: 0 },
});

export const callTools = (
	...calls: Array<{ name: string; args?: unknown; id?: string }>
): ChatResponse => ({
	message: {
		role: "assistant",
		content: null,
		toolCalls: calls.map(
			(call, index): ToolCall => ({
				id: call.id ?? `call_${index}`,
				name: call.name,
				arguments: JSON.stringify(call.args ?? {}),
			}),
		),
	},
	finishReason: "tool_calls",
	usage: { inputTokens: 0, outputTokens: 0 },
});
