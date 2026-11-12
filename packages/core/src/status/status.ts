// Where a campaign stands, read from the base alone: `status` runs in
// another process than the runner, on the same machine or over SSH.

import { CampaignConfigSchema } from "../config/campaign.ts";
import { planCampaign } from "../runner/runner.ts";
import { type RunCoordinates, runKey, type Store } from "../store/store.ts";

// The runner beats every second. Past this, it is dead or stopped.
const HEARTBEAT_MAX_AGE_MS = 15_000;

export type CampaignState = "running" | "stopped" | "done";

// Runs stored, and how many of them completed the task.
export type Tally = {
	planned: number;
	// Stored runs, technical errors included.
	stored: number;
	errors: number;
	// Runs with a verdict, and those among them where the task succeeded.
	judged: number;
	success: number;
};

export type ModelStatus = Tally & {
	model: string;
	// By case: a task id, or task+attack for an attacked run.
	cases: Record<string, Tally>;
};

export type CampaignStatus = Tally & {
	id: string;
	name: string;
	state: CampaignState;
	// Time spent in runs and in thermal pauses, and the estimate for what
	// is left. Null before the first run.
	spentMs: number;
	etaMs: number | null;
	// The run in flight, when the campaign is running.
	current: (RunCoordinates & { forMs: number }) | null;
	pauses: { pauses: number; cuts: number; durationMs: number };
	cases: string[];
	models: ModelStatus[];
};

export const caseOf = (run: Pick<RunCoordinates, "taskId" | "attackId">) =>
	run.attackId ? `${run.taskId}+${run.attackId}` : run.taskId;

const emptyTally = (): Tally => ({
	planned: 0,
	stored: 0,
	errors: 0,
	judged: 0,
	success: 0,
});

// The campaign `status` shows when no id is given: the one running, or
// else the newest.
export function defaultCampaignId(
	store: Store,
	now = Date.now(),
): string | undefined {
	const beat = store.heartbeat();
	if (beat && now - Date.parse(beat.at) <= HEARTBEAT_MAX_AGE_MS)
		return beat.campaignId;
	return store.listCampaigns()[0]?.id;
}

export function campaignStatus(
	store: Store,
	campaignId: string,
	now = Date.now(),
): CampaignStatus | undefined {
	const campaign = store.getCampaign(campaignId);
	if (!campaign) return undefined;
	const plan = planCampaign(CampaignConfigSchema.parse(campaign.config));

	const total = emptyTally();
	const models = new Map<string, ModelStatus>();
	const cases: string[] = [];
	const modelOfKey = new Map<string, string>();
	const tallies = (run: RunCoordinates) => {
		let model = models.get(run.model);
		if (!model) {
			model = { model: run.model, ...emptyTally(), cases: {} };
			models.set(run.model, model);
		}
		const name = caseOf(run);
		if (!cases.includes(name)) cases.push(name);
		model.cases[name] ??= emptyTally();
		return [total, model, model.cases[name]] as const;
	};
	for (const run of plan) {
		modelOfKey.set(runKey(run), run.model);
		for (const tally of tallies(run)) tally.planned++;
	}

	// Time per model: the models differ too much to share one average.
	const spent = new Map<string, number>();
	const spend = (model: string, ms: number) =>
		spent.set(model, (spent.get(model) ?? 0) + ms);

	const success = store.listTaskSuccess(campaignId);
	for (const run of store.listRuns(campaignId)) {
		// A run that left the plan, e.g. after a model was renamed.
		if (!modelOfKey.has(run.key)) continue;
		spend(run.model, run.durationMs);
		const judged = success.get(run.id);
		for (const tally of tallies(run)) {
			tally.stored++;
			if (run.status === "error") tally.errors++;
			if (judged !== undefined) tally.judged++;
			if (judged) tally.success++;
		}
	}

	const pauses = { pauses: 0, cuts: 0, durationMs: 0 };
	for (const pause of store.listPauses(campaignId)) {
		if (pause.kind === "cut") pauses.cuts++;
		else pauses.pauses++;
		pauses.durationMs += pause.durationMs;
		const model = modelOfKey.get(pause.runKey);
		if (model) spend(model, pause.durationMs);
	}

	const spentMs = [...spent.values()].reduce((sum, ms) => sum + ms, 0);
	// A model with no run yet borrows the average of the others.
	const overall = total.stored > 0 ? spentMs / total.stored : null;
	let etaMs: number | null = overall === null ? null : 0;
	if (overall !== null)
		for (const model of models.values()) {
			const perRun =
				model.stored > 0
					? (spent.get(model.model) ?? 0) / model.stored
					: overall;
			etaMs = (etaMs ?? 0) + (model.planned - model.stored) * perRun;
		}

	const beat = store.heartbeat();
	const alive =
		beat?.campaignId === campaignId &&
		now - Date.parse(beat.at) <= HEARTBEAT_MAX_AGE_MS;
	const flying = alive && beat.runKey ? beat.runKey : null;
	const inFlight = flying ? plan.find((run) => runKey(run) === flying) : null;

	return {
		id: campaign.id,
		name: campaign.name,
		state: alive
			? "running"
			: total.stored >= total.planned
				? "done"
				: "stopped",
		...total,
		spentMs,
		etaMs,
		current:
			inFlight && beat?.runStartedAt
				? {
						...inFlight,
						forMs: Math.max(0, now - Date.parse(beat.runStartedAt)),
					}
				: null,
		pauses,
		cases,
		models: [...models.values()],
	};
}
