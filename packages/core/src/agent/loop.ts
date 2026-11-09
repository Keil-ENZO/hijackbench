// The agent loop, written by hand so that every call is under control.
//
// The model gets the system prompt and the task, then each turn: it
// replies, the loop runs the tools it asked for, in order, and sends the
// results back. The run ends when the model replies without a tool call,
// or at the turn limit.
//
// A provider failure is technical, never a verdict: it is thrown as is and
// the runner decides to retry or stop. Model mistakes, like broken JSON or
// an unknown tool, are not failures: they go back to the model as errors
// and into the trace.

import type { Outcome, Task } from "../env/tasks.ts";
import { systemPrompt } from "../env/tasks.ts";
import { executeTool, TOOL_DEFINITIONS } from "../env/tools.ts";
import type { Environment } from "../env/types.ts";
import { ProviderError } from "../providers/errors.ts";
import type { Message, Provider } from "../providers/types.ts";
import {
	type EndReason,
	type Trace,
	type TracedCall,
	TraceSchema,
	type Turn,
} from "./trace.ts";

// No task needs more than five tool calls. Ten leaves room for a model
// that retries after an error, and stops one that spins.
export const DEFAULT_MAX_TURNS = 10;

export type RunAgentOptions = {
	provider: Provider;
	task: Task;
	env: Environment;
	maxTurns?: number;
	temperature?: number;
	maxTokens?: number;
	// The emergency stop. Aborts the request in flight and skips the
	// remaining tools.
	signal?: AbortSignal;
	// Injected by tests to get fixed durations.
	now?: () => number;
	clock?: () => Date;
};

export type RunAgentResult = {
	trace: Trace;
	// What the task check reads.
	outcome: Outcome;
};

export async function runAgent(
	options: RunAgentOptions,
): Promise<RunAgentResult> {
	const { provider, task, signal } = options;
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	if (!Number.isInteger(maxTurns) || maxTurns < 1)
		throw new Error(`maxTurns must be a positive integer, got ${maxTurns}`);
	const now = options.now ?? (() => performance.now());
	const clock = options.clock ?? (() => new Date());

	const initial = options.env;
	const system = systemPrompt(initial);
	const messages: Message[] = [
		{ role: "system", content: system },
		{ role: "user", content: task.prompt },
	];

	const startedAt = clock().toISOString();
	const start = now();
	const turns: Turn[] = [];
	let env = initial;
	let end: { reason: EndReason; answer: string | null } | undefined;

	for (let index = 0; index < maxTurns && !end; index++) {
		const modelStart = now();
		const response = await provider.chat(
			{
				messages,
				tools: [...TOOL_DEFINITIONS],
				temperature: options.temperature,
				maxTokens: options.maxTokens,
			},
			signal ? { signal } : {},
		);
		const modelDurationMs = now() - modelStart;
		const { content, toolCalls } = response.message;
		messages.push({ role: "assistant", content, toolCalls });

		const calls: TracedCall[] = [];
		for (const call of toolCalls) {
			throwIfAborted(signal);
			const callStart = now();
			const result = executeTool(env, call.name, call.arguments);
			env = result.env;
			calls.push({
				id: call.id,
				name: call.name,
				rawArguments: call.arguments,
				arguments: parseArguments(call.arguments),
				output: result.output,
				isError: result.isError,
				durationMs: now() - callStart,
			});
			messages.push({
				role: "tool",
				toolCallId: call.id,
				content: result.output,
			});
		}

		turns.push({
			index,
			content,
			toolCalls,
			finishReason: response.finishReason,
			usage: response.usage,
			modelDurationMs,
			calls,
		});

		if (toolCalls.length === 0)
			end = {
				reason: response.finishReason === "length" ? "length" : "answer",
				answer: content,
			};
	}

	const trace = TraceSchema.parse({
		version: 1,
		provider: provider.name,
		model: provider.model,
		taskId: task.id,
		canary: initial.canary,
		settings: {
			maxTurns,
			temperature: options.temperature,
			maxTokens: options.maxTokens,
		},
		systemPrompt: system,
		userPrompt: task.prompt,
		startedAt,
		durationMs: now() - start,
		turns,
		end: end ?? { reason: "max_turns", answer: null },
		usage: {
			inputTokens: sum(turns, (t) => t.usage.inputTokens),
			outputTokens: sum(turns, (t) => t.usage.outputTokens),
		},
		final: env,
	} satisfies Trace);

	return { trace, outcome: outcomeOf(trace, initial) };
}

// Builds what the task check reads from a trace. Exported so that a stored
// trace can be checked again without replaying the run.
export function outcomeOf(trace: Trace, initial: Environment): Outcome {
	return {
		answer: trace.end.answer,
		calls: trace.turns.flatMap((turn) =>
			turn.calls.map((call) => ({
				name: call.name,
				arguments: call.arguments,
				isError: call.isError,
			})),
		),
		initial,
		final: trace.final,
	};
}

function parseArguments(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function throwIfAborted(signal: AbortSignal | undefined) {
	if (signal?.aborted)
		throw new ProviderError("aborted", "Run aborted by the caller", {
			cause: signal.reason,
		});
}

const sum = <T>(items: T[], value: (item: T) => number) =>
	items.reduce((total, item) => total + value(item), 0);
