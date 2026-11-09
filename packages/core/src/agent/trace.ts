// The trace of one run: everything the agent and the model did, in order.
//
// The judge reads it, the report counts it, the annotate command shows it.
// It is validated before it leaves the loop, and again when it is read
// back from storage, so a bad trace never reaches a verdict.

import { z } from "zod";
import { EnvironmentSchema } from "../env/types.ts";
import { FinishReasonSchema, ToolCallSchema } from "../providers/types.ts";

const Duration = z.number().nonnegative();

const UsageSchema = z.object({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
});

export const TracedCallSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	// As the model wrote it, broken JSON included.
	rawArguments: z.string(),
	// Parsed JSON, or null if the model sent broken JSON.
	arguments: z.unknown(),
	output: z.string(),
	isError: z.boolean(),
	durationMs: Duration,
});
export type TracedCall = z.infer<typeof TracedCallSchema>;

export const TurnSchema = z.object({
	index: z.number().int().nonnegative(),
	// The model's reply for this turn.
	content: z.string().nullable(),
	toolCalls: z.array(ToolCallSchema),
	finishReason: FinishReasonSchema,
	usage: UsageSchema,
	modelDurationMs: Duration,
	// The tool calls run after the reply, in the order the model asked.
	calls: z.array(TracedCallSchema),
});
export type Turn = z.infer<typeof TurnSchema>;

// Why the loop stopped.
// - answer: the model replied without calling a tool.
// - length: same, but the reply hit the token limit and may be cut.
// - max_turns: the model was still calling tools at the turn limit.
export const EndReasonSchema = z.enum(["answer", "length", "max_turns"]);
export type EndReason = z.infer<typeof EndReasonSchema>;

export const TraceSchema = z.object({
	version: z.literal(1),
	provider: z.string().min(1),
	model: z.string().min(1),
	taskId: z.string().min(1),
	canary: z.string().min(1),
	settings: z.object({
		maxTurns: z.number().int().positive(),
		temperature: z.number().min(0).max(2).optional(),
		maxTokens: z.number().int().positive().optional(),
	}),
	systemPrompt: z.string(),
	userPrompt: z.string(),
	startedAt: z.iso.datetime(),
	durationMs: Duration,
	turns: z.array(TurnSchema),
	end: z.object({
		reason: EndReasonSchema,
		answer: z.string().nullable(),
	}),
	usage: UsageSchema,
	// The world after the run: sent mails, deleted files. The initial one
	// is rebuilt from the seed and the canary.
	final: EnvironmentSchema,
});
export type Trace = z.infer<typeof TraceSchema>;
