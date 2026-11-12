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
import { type Task, type TaskId, taskById } from "../env/tasks.ts";
import { judgeStoredRun } from "../judge/campaign.ts";
import { isProviderError, ProviderError } from "../providers/errors.ts";
import type { Provider } from "../providers/types.ts";
import { type RunCoordinates, runKey, type Store } from "../store/store.ts";
import { type ThermalGuard, ThermalReadError } from "../thermal/thermal.ts";

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
	| { type: "cut"; run: RunCoordinates; vram: number }
	| {
			type: "pause";
			run: RunCoordinates;
			kind: "pause" | "cut";
			durationMs: number;
			fromC: number;
			toC: number;
	  }
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
	// The GDDR6X guard. Absent when the config disables it.
	thermal?: ThermalGuard;
	// How often the VRAM is read during a run, to cut it at abortAt.
	thermalPollMs?: number;
};

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_STOP_POLL_MS = 1_000;
const DEFAULT_THERMAL_POLL_MS = 2_000;
// A run cut twice in a row means the card cannot hold this model.
const MAX_CUTS_PER_RUN = 2;

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

	const { thermal } = options;
	if (thermal) {
		try {
			thermal.read();
		} catch (error) {
			throw new Error(
				`Cannot read the VRAM temperature, so the card cannot be protected: ${(error as Error).message}. ` +
					"Fix the exporter, or set thermal.enabled: false on a machine without the 3090.",
			);
		}
	}

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
	// What `status` shows from another process: the run in flight, and a
	// beat renewed at each poll so a dead runner is not taken for a live one.
	const flight = {
		runKey: null as string | null,
		runStartedAt: null as string | null,
	};
	const beat = () => store.beat({ campaignId: config.id, ...flight });
	beat();
	const watch = setInterval(() => {
		beat();
		const flag = store.stopRequested();
		if (flag && !stopController.signal.aborted)
			stopController.abort(new Error(flag.reason));
	}, options.stopPollMs ?? DEFAULT_STOP_POLL_MS);

	const context = {
		config,
		store,
		retries,
		retryDelayMs,
		sleep,
		now,
		onRetry: (run: RunCoordinates, attempt: number, error: string) =>
			emit({ type: "retry", run, attempt, error }),
	};

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

			const task = taskById(run.taskId as TaskId);
			const position = {
				index: summary.skipped + index + 1,
				remaining: todo.length - index - 1,
			};
			// One pass per try of this run: a thermal cut sends it back here,
			// to cool down and run it again from scratch.
			for (let cuts = 0; ; ) {
				if (thermal) {
					const kind = cuts > 0 ? "cut" : "pause";
					const pause = await coolDown(thermal, signal, cuts > 0);
					if (pause) {
						store.savePause({
							campaignId: config.id,
							kind,
							runKey: runKey(run),
							...pause,
						});
						emit({ type: "pause", run, kind, ...pause });
					}
				}
				await options.beforeRun?.(run, signal);

				const heat = watchHeat(thermal, options.thermalPollMs);
				flight.runKey = runKey(run);
				flight.runStartedAt = new Date().toISOString();
				beat();
				try {
					const result = await attempt({
						...context,
						provider,
						run,
						task,
						signal: heat ? AbortSignal.any([signal, heat.signal]) : signal,
					});
					if (result.status === "done") summary.done++;
					else summary.errors++;
					emit({ type: "run", run, ...position, ...result });
					break;
				} catch (error) {
					// The run signal aborts on a stop or on heat: the cause
					// tells them apart.
					const cause = heat?.signal.reason;
					if (!heat?.signal.aborted || signal.aborted) throw error;
					if (cause instanceof ThermalReadError)
						throw new StopCampaign(`lost the VRAM reading: ${cause.message}`);
					if (!(cause instanceof ThermalCut)) throw error;
					cuts++;
					emit({ type: "cut", run, vram: cause.vram });
					if (cuts >= MAX_CUTS_PER_RUN)
						throw new StopCampaign(
							`VRAM reached ${cause.vram} °C twice on ${runKey(run)}: the card cannot hold this model as set up`,
						);
				} finally {
					heat?.stop();
					flight.runKey = null;
					flight.runStartedAt = null;
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
		store.clearBeat();
		// The model leaves the VRAM whatever happened: end, stop or crash.
		await provider?.unload?.().catch(() => {});
	}

	emit({ type: "end", summary });
	return summary;
}

type AttemptContext = {
	config: CampaignConfig;
	store: Store;
	retries: number;
	retryDelayMs: number;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	now: () => number;
	onRetry: (run: RunCoordinates, attempt: number, error: string) => void;
	provider: Provider;
	run: RunCoordinates;
	task: Task;
	signal: AbortSignal;
};

// Runs one planned run until it is saved, as done or as a technical error,
// retrying what can be retried. Throws to stop: an abort, or a failure that
// no retry can fix.
async function attempt(ctx: AttemptContext): Promise<{
	status: "done" | "error";
	durationMs: number;
	taskSuccess?: boolean;
}> {
	const { config, store, provider, run, task, signal } = ctx;
	const start = ctx.now();
	for (let tries = 0; ; tries++) {
		const env = createEnvironment({ canary: generateCanary() });
		try {
			const { trace, outcome } = await runAgent({
				provider,
				task,
				env,
				temperature: config.agent.temperature,
				maxTurns: config.agent.maxTurns,
				...(config.agent.maxTokens && { maxTokens: config.agent.maxTokens }),
				signal,
			});
			const saved = store.saveRun({ campaignId: config.id, ...run, trace });
			// Judged at once, so `status` shows success rates while the
			// campaign runs. `judge` gives every run its verdict again.
			store.saveVerdict(saved.id, judgeStoredRun(store, saved));
			return {
				status: "done",
				durationMs: trace.durationMs,
				taskSuccess: task.check(outcome).success,
			};
		} catch (error) {
			if (!isProviderError(error)) throw error;
			const blame = blameOf(error);
			if (blame === "abort") throw error;
			if (blame === "campaign") throw new StopCampaign(error);
			if (tries < ctx.retries) {
				ctx.onRetry(run, tries + 1, describe(error));
				await ctx.sleep(ctx.retryDelayMs * (tries + 1), signal);
				continue;
			}
			// Ollama still down after the retries: no run can succeed.
			if (blame === "service") throw new StopCampaign(error);
			const durationMs = ctx.now() - start;
			const saved = store.saveRun({
				campaignId: config.id,
				...run,
				error: describe(error),
				durationMs,
			});
			store.saveVerdict(saved.id, judgeStoredRun(store, saved));
			return { status: "error", durationMs };
		}
	}
}

// Reads the VRAM during a run and aborts at abortAt, or when the reading
// is lost. Undefined when there is no thermal guard.
function watchHeat(thermal: ThermalGuard | undefined, pollMs?: number) {
	if (!thermal) return undefined;
	const controller = new AbortController();
	const timer = setInterval(() => {
		try {
			const vram = thermal.read();
			if (vram >= thermal.thresholds.abortAt)
				controller.abort(new ThermalCut(vram));
		} catch (error) {
			controller.abort(error);
		}
	}, pollMs ?? DEFAULT_THERMAL_POLL_MS);
	return {
		signal: controller.signal,
		stop: () => clearInterval(timer),
	};
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
	constructor(cause: ProviderError | string) {
		super(typeof cause === "string" ? cause : describe(cause), { cause });
	}
}

// The reason of a heat abort, with the temperature that triggered it.
class ThermalCut extends Error {
	readonly vram: number;
	constructor(vram: number) {
		super(`VRAM at ${vram} °C`);
		this.vram = vram;
	}
}

// Waits for the card to cool down. A stop during the wait is an abort,
// a lost reading stops the campaign.
async function coolDown(
	thermal: ThermalGuard,
	signal: AbortSignal,
	force: boolean,
) {
	try {
		return await thermal.coolDown(signal, { force });
	} catch (error) {
		if (signal.aborted) throw abortError(signal);
		if (error instanceof ThermalReadError)
			throw new StopCampaign(`lost the VRAM reading: ${error.message}`);
		throw error;
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
