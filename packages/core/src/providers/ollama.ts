// Ollama adapter, over its OpenAI-compatible API (/v1/chat/completions).

import { z } from "zod";
import { ProviderError } from "./errors.ts";
import {
	type ChatOptions,
	type ChatRequest,
	ChatRequestSchema,
	type ChatResponse,
	type FinishReason,
	type Message,
	type Provider,
} from "./types.ts";

export type OllamaOptions = {
	model: string;
	baseUrl?: string;
	// Per request, body included. A long tool-using turn on a 26B model
	// stays well under a minute in the J0 measure.
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
};

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 120_000;

const OpenAIResponseSchema = z.object({
	choices: z
		.array(
			z.object({
				message: z.object({
					content: z.string().nullish(),
					tool_calls: z
						.array(
							z.object({
								id: z.string().nullish(),
								function: z.object({
									name: z.string(),
									arguments: z.union([
										z.string(),
										z.record(z.string(), z.unknown()),
									]),
								}),
							}),
						)
						.nullish(),
				}),
				finish_reason: z.string().nullish(),
			}),
		)
		.min(1),
	usage: z
		.object({
			prompt_tokens: z.number().int().nonnegative(),
			completion_tokens: z.number().int().nonnegative(),
		})
		.nullish(),
});

export function createOllamaProvider(options: OllamaOptions): Provider {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const url = `${baseUrl}/v1/chat/completions`;

	return {
		name: "ollama",
		model: options.model,

		async chat(request: ChatRequest, { signal }: ChatOptions = {}) {
			const req = ChatRequestSchema.parse(request);
			if (signal?.aborted) throw aborted(signal.reason);

			const timeout = AbortSignal.timeout(timeoutMs);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

			let status: number;
			let text: string;
			try {
				const res = await fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(toOpenAIRequest(options.model, req)),
					signal: combined,
				});
				status = res.status;
				text = await res.text();
			} catch (error) {
				if (signal?.aborted) throw aborted(error);
				if (timeout.aborted)
					throw new ProviderError(
						"timeout",
						`Ollama gave no complete reply within ${timeoutMs} ms`,
						{ cause: error },
					);
				throw new ProviderError(
					"network",
					`Cannot reach Ollama at ${baseUrl}. Is it running?`,
					{ cause: error },
				);
			}

			if (status < 200 || status >= 300)
				throw new ProviderError(
					"http",
					`Ollama returned ${status}: ${text.slice(0, 500)}`,
					{ status },
				);

			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch (error) {
				throw new ProviderError(
					"invalid_response",
					"Ollama returned a body that is not JSON",
					{ cause: error },
				);
			}
			const parsed = OpenAIResponseSchema.safeParse(json);
			if (!parsed.success)
				throw new ProviderError(
					"invalid_response",
					`Unexpected reply from Ollama: ${z.prettifyError(parsed.error)}`,
					{ cause: parsed.error },
				);
			return fromOpenAIResponse(parsed.data);
		},
	};
}

function aborted(cause: unknown) {
	return new ProviderError("aborted", "Request aborted by the caller", {
		cause,
	});
}

function toOpenAIRequest(model: string, req: ChatRequest) {
	return {
		model,
		messages: req.messages.map(toOpenAIMessage),
		...(req.tools.length > 0 && {
			tools: req.tools.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				},
			})),
		}),
		...(req.temperature !== undefined && { temperature: req.temperature }),
		...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
		stream: false,
	};
}

function toOpenAIMessage(message: Message) {
	switch (message.role) {
		case "system":
		case "user":
			return { role: message.role, content: message.content };
		case "assistant":
			return {
				role: "assistant",
				content: message.content,
				...(message.toolCalls.length > 0 && {
					tool_calls: message.toolCalls.map((call) => ({
						id: call.id,
						type: "function",
						function: { name: call.name, arguments: call.arguments },
					})),
				}),
			};
		case "tool":
			return {
				role: "tool",
				tool_call_id: message.toolCallId,
				content: message.content,
			};
	}
}

function fromOpenAIResponse(
	body: z.infer<typeof OpenAIResponseSchema>,
): ChatResponse {
	// min(1) above guarantees the first choice.
	const choice = body.choices[0] as (typeof body.choices)[number];
	return {
		message: {
			role: "assistant",
			content: choice.message.content ?? null,
			toolCalls: (choice.message.tool_calls ?? []).map((call, index) => ({
				id: call.id || `call_${index}`,
				name: call.function.name,
				arguments:
					typeof call.function.arguments === "string"
						? call.function.arguments
						: JSON.stringify(call.function.arguments),
			})),
		},
		finishReason: toFinishReason(choice.finish_reason),
		usage: {
			// Ollama counts only the prompt tokens it evaluated: a prefix
			// reused from its cache is left out, so later turns look smaller.
			inputTokens: body.usage?.prompt_tokens ?? 0,
			outputTokens: body.usage?.completion_tokens ?? 0,
		},
	};
}

function toFinishReason(reason: string | null | undefined): FinishReason {
	switch (reason) {
		case "stop":
		case "tool_calls":
		case "length":
			return reason;
		default:
			return "other";
	}
}
