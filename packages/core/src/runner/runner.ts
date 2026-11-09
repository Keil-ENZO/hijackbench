// The runner: turns a campaign config into runs, one at a time, and
// writes each one as soon as it ends.
//
// Resuming is the same as running: the plan is computed again from the
// config, and the runs already in the base are skipped. A campaign can
// stop anywhere, by a crash, a stop or a cut cable, and lose at most the
// run in flight.

import { isDeepStrictEqual } from "node:util";
import { runAgent } from "../agent/loop.ts";
import type { CampaignConfig } from "../config/campaign.ts";
import { generateCanary } from "../env/canary.ts";
import { createEnvironment } from "../env/environment.ts";
import { type TaskId, taskById } from "../env/tasks.ts";
import { isProviderError, ProviderError } from "../providers/errors.ts";
import type { Provider } from "../providers/types.ts";
import { type RunCoordinates, runKey, type Store } from "../store/store.ts";

// The order matters when a campaign is cut: model by model, so that each
// model loads once, then repetition by repetition, so that every case has
// the same number of runs at any point.
export function planCampaign(config: CampaignConfig): RunCoordinates[] {
	const cases = [
		...config.tasks.map((taskId) => ({ taskId, attackId: null })),
		// The attack catalog of US-20 will give each attack its task.
		...config.attacks.map((attackId) => ({ taskId: "?", attackId })),
	];
	const plan: RunCoordinates[] = [];
	for (const model of config.models)
		for (let repetition = 1; repetition <= config.runs; repetition++)
			for (const c of cases) plan.push({ model, repetition, ...c });
	return plan;
}

export type RunnerEvent =
	| { type: "start"; campaignId: string; planned: number; skipped: number }
	| { type: "model"; model: string }
	| {
			type: "run";
			run: RunCoordinates;
			index: number;
			remaining: number;
			status: "done" | "error";
			taskSuccess?: boolean;
			durationMs: number;
	  }
	| { type: "retry"; run: RunCoordinates; attempt: number; error: string }
	| { type: "stop"; reason: string }
	| { type: "end"; summary: RunnerSummary };

export type RunnerSummary = {
	planned: number;
	skipped: number;
	done: number;
	errors: number;
	// Set when the campaign stopped before the end.
	stopped?: string;
};

export type RunCampaignOptions = {
	config: CampaignConfig;
	store: Store;
	// Builds the provider of a model. Called once per model.
	providerFor: (model: string) => Provider;
	// Aborts the run in flight. The run is not saved.
	signal?: AbortSignal;
	// Called before each run. The thermal pause of US-16 waits here, and
	// gives up when the signal aborts.
	beforeRun?: (run: RunCoordinates, signal: AbortSignal) => Promise<void>;
	onEvent?: (event: RunnerEvent) => void;
	// New tries after a technical failure, before the run is saved as an
	// error. A model that is down fails fast, a slow reply gets a second go.
	retries?: number;
	retryDelayMs?: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
	// How often the stop flag is read, in the middle of a run too.
	stopPollMs?: number;
};

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_STOP_POLL_MS = 1_000;

export class CampaignMismatchError extends Error {
	override readonly name = "CampaignMismatchError";
}

// Stores the campaign on the first run. Later runs must bring the same
// config: changing it under a running campaign would mix two protocols.
export function ensureCampaign(store: Store, config: CampaignConfig) {
	const existing = store.getCampaign(config.id);
	if (!existing) {
		store.createCampaign({ id: config.id, name: config.name, config });
		return;
	}
	if (!isDeepStrictEqual(existing.config, config))
		throw new CampaignMismatchError(
			`Campaign "${config.id}" is already in the base with another config. ` +
				"Resume it as it is, or give the new file another id.",
		);
}

export async function runCampaign(
	options: RunCampaignOptions,
): Promise<RunnerSummary> {
	const { config, store } = options;
	const emit = options.onEvent ?? (() => {});
	const retries = options.retries ?? DEFAULT_RETRIES;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	const sleep = options.sleep ?? abortableSleep;
	const now = options.now ?? (() => performance.now());

	if (config.attacks.length > 0)
		throw new Error(
			"Attacked runs need the attack catalog (US-20). Run reference tasks only for now.",
		);

	ensureCampaign(store, config);
	// A stop left over from the last campaign must not stop this one.
	store.clearStop();

	const plan = planCampaign(config);
	const stored = store.storedKeys(config.id);
	const todo = plan.filter((run) => !stored.has(runKey(run)));
	const summary: RunnerSummary = {
		planned: plan.length,
		skipped: plan.length - todo.length,
		done: 0,
		errors: 0,
	};
	emit({
		type: "start",
		campaignId: config.id,
		planned: summary.planned,
		skipped: summary.skipped,
	});

	// The emergency stop: `hijackbench stop` sets the flag from another
	// process, the watch turns it into an abort within a poll interval,
	// even while a request is in flight.
	const stopController = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, stopController.signal])
		: stopController.signal;
	const watch = setInterval(() => {
		const flag = store.stopRequested();
		if (flag && !stopController.signal.aborted)
			stopController.abort(new Error(flag.reason));
	}, options.stopPollMs ?? DEFAULT_STOP_POLL_MS);

	let provider: Provider | undefined;
	try {
		for (const [index, run] of todo.entries()) {
			const stop = stopReason(store, signal);
			if (stop) {
				summary.stopped = stop;
				emit({ type: "stop", reason: stop });
				break;
			}

			if (provider?.model !== run.model) {
				await provider?.unload?.();
				provider = options.providerFor(run.model);
				emit({ type: "model", model: run.model });
			}

			await options.beforeRun?.(run, signal);

			const task = taskById(run.taskId as TaskId);
			const start = now();
			let attempt = 0;
			for (;;) {
				const env = createEnvironment({ canary: generateCanary() });
				try {
					const { trace, outcome } = await runAgent({
						provider,
						task,
						env,
						temperature: config.agent.temperature,
						maxTurns: config.agent.maxTurns,
						...(config.agent.maxTokens && {
							maxTokens: config.agent.maxTokens,
						}),
						signal,
					});
					store.saveRun({ campaignId: config.id, ...run, trace });
					summary.done++;
					emit({
						type: "run",
						run,
						index: summary.skipped + index + 1,
						remaining: todo.length - index - 1,
						status: "done",
						taskSuccess: task.check(outcome).success,
						durationMs: trace.durationMs,
					});
					break;
				} catch (error) {
					if (!isProviderError(error)) throw error;
					const blame = blameOf(error);
					if (blame === "abort") throw error;
					if (blame === "campaign") throw new StopCampaign(error);
					if (attempt < retries) {
						attempt++;
						emit({
							type: "retry",
							run,
							attempt,
							error: describe(error),
						});
						await sleep(retryDelayMs * attempt, signal);
						continue;
					}
					// Ollama still down after the retries: no run can succeed.
					if (blame === "service") throw new StopCampaign(error);
					const durationMs = now() - start;
					store.saveRun({
						campaignId: config.id,
						...run,
						error: describe(error),
						durationMs,
					});
					summary.errors++;
					emit({
						type: "run",
						run,
						index: summary.skipped + index + 1,
						remaining: todo.length - index - 1,
						status: "error",
						durationMs,
					});
					break;
				}
			}
		}
	} catch (error) {
		// A clean stop: the run in flight is dropped, the rest waits for
		// resume.
		if (error instanceof StopCampaign) summary.stopped = error.message;
		else if (isProviderError(error) && error.kind === "aborted")
			summary.stopped = stopReason(store, signal) ?? "aborted";
		else throw error;
		emit({ type: "stop", reason: summary.stopped });
	} finally {
		clearInterval(watch);
		// The model leaves the VRAM whatever happened: end, stop or crash.
		await provider?.unload?.().catch(() => {});
	}

	emit({ type: "end", summary });
	return summary;
}

function stopReason(store: Store, signal: AbortSignal | undefined) {
	if (signal?.aborted)
		return signal.reason instanceof Error
			? signal.reason.message
			: String(signal.reason ?? "aborted");
	return store.stopRequested()?.reason;
}

const describe = (error: ProviderError) =>
	`${error.kind}: ${error.message.trim()}`;

// Who a provider failure is about, which decides what the runner does.
// - run: this run went wrong (slow reply, garbled answer, server error).
//   Retry, then save it as a technical error: it counts in the error rate.
// - service: Ollama cannot be reached. Retry, then stop the campaign:
//   saving errors would make resume skip runs that never had a chance.
// - campaign: the request itself is refused, e.g. a model that does not
//   exist. Retrying cannot help: stop now.
// - abort: the emergency stop.
type Blame = "run" | "service" | "campaign" | "abort";

function blameOf(error: ProviderError): Blame {
	switch (error.kind) {
		case "aborted":
			return "abort";
		case "network":
			return "service";
		case "http":
			return error.status !== undefined && error.status < 500
				? "campaign"
				: "run";
		default:
			return "run";
	}
}

class StopCampaign extends Error {
	constructor(cause: ProviderError) {
		super(describe(cause), { cause });
	}
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError(signal));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// Same shape as a provider abort, so the runner handles both the same way.
const abortError = (signal?: AbortSignal) =>
	new ProviderError("aborted", "Run aborted by the caller", {
		cause: signal?.reason,
	});
