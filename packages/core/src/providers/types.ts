// The provider interface: the only way the agent talks to a model.
//
// Messages and tools go in, a reply with optional tool calls comes out.
// Ollama implements it today; Claude and GPT will plug in the same way.

import { z } from "zod";

export const ToolCallSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	// Raw JSON as the model wrote it. It may be malformed: that is the
	// model's behavior, so the agent parses it and records the result.
	arguments: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessageSchema = z.discriminatedUnion("role", [
	z.object({ role: z.literal("system"), content: z.string() }),
	z.object({ role: z.literal("user"), content: z.string() }),
	z.object({
		role: z.literal("assistant"),
		content: z.string().nullable(),
		toolCalls: z.array(ToolCallSchema),
	}),
	z.object({
		role: z.literal("tool"),
		toolCallId: z.string().min(1),
		content: z.string(),
	}),
]);
export type Message = z.infer<typeof MessageSchema>;

export const ToolDefinitionSchema = z.object({
	name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
	description: z.string(),
	// JSON Schema of the arguments, passed to the model as is.
	parameters: z.record(z.string(), z.unknown()),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const ChatRequestSchema = z.object({
	messages: z.array(MessageSchema).min(1),
	tools: z.array(ToolDefinitionSchema),
	temperature: z.number().min(0).max(2).optional(),
	maxTokens: z.number().int().positive().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const FinishReasonSchema = z.enum([
	"stop",
	"tool_calls",
	"length",
	"other",
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const ChatResponseSchema = z.object({
	message: z.object({
		role: z.literal("assistant"),
		content: z.string().nullable(),
		toolCalls: z.array(ToolCallSchema),
	}),
	finishReason: FinishReasonSchema,
	usage: z.object({
		inputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
	}),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export type ChatOptions = {
	// Aborts the request in flight. Used by the emergency stop.
	signal?: AbortSignal;
};

export interface Provider {
	readonly name: string;
	readonly model: string;
	chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResponse>;
}
