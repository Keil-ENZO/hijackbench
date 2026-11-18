// An annotation session: the runs drawn from a campaign, minus the ones
// already annotated. Nothing about the session is stored but the
// annotations: the draw is deterministic, so running the command again
// with the same size and seed resumes where it stopped.

import type { Trace } from "../agent/trace.ts";
import type { Attack } from "../attacks/catalog.ts";
import { type Task, type TaskId, taskById } from "../env/tasks.ts";
import type { Environment } from "../env/types.ts";
import { startingWorld } from "../judge/campaign.ts";
import { JUDGE_VERSION } from "../judge/judge.ts";
import type { Verdict } from "../store/schema.ts";
import type { Run, Store, StoredVerdict } from "../store/store.ts";
import { type Candidate, DEFAULT_SAMPLE_SIZE, drawSample } from "./sample.ts";

// The verdicts a human can give. A technical error has no trace to read:
// it is never drawn, and never annotated.
export const HUMAN_VERDICTS = [
	"compromised",
	"partial",
	"resisted_success",
	"resisted_failure",
] as const satisfies readonly Verdict[];
export type HumanVerdict = (typeof HUMAN_VERDICTS)[number];

export class AnnotationError extends Error {
	override name = "AnnotationError";
}

export type AnnotationSession = {
	campaignId: string;
	seed: string;
	// Every run drawn, in the order to show them.
	sample: number[];
	// The runs of the sample still to annotate, same order.
	pending: number[];
	// How many runs each verdict of the judge gave to the sample.
	quotas: Partial<Record<Verdict, number>>;
};

export function openSession(
	store: Store,
	campaignId: string,
	options: { size?: number; seed?: string } = {},
): AnnotationSession {
	const size = options.size ?? DEFAULT_SAMPLE_SIZE;
	const seed = options.seed ?? campaignId;
	if (!Number.isInteger(size) || size < 1)
		throw new AnnotationError(
			"The sample size must be a whole number, 1 or more.",
		);
	if (!store.getCampaign(campaignId))
		throw new AnnotationError(`No campaign "${campaignId}" in the base.`);

	const results = store.listRunResults(campaignId);
	// Annotating against an old or missing verdict would calibrate a judge
	// that no longer exists.
	const stale = results.filter((r) => r.judgeVersion !== JUDGE_VERSION).length;
	if (stale > 0)
		throw new AnnotationError(
			`${stale} runs of "${campaignId}" are not judged by judge v${JUDGE_VERSION}. Run first: hijackbench judge ${campaignId}`,
		);

	const candidates: Candidate[] = results.flatMap((r) =>
		r.status === "done" && r.verdict && r.verdict !== "technical_error"
			? [{ runId: r.runId, verdict: r.verdict }]
			: [],
	);
	if (candidates.length === 0)
		throw new AnnotationError(
			`"${campaignId}" has no finished run to annotate.`,
		);

	const sample = drawSample(candidates, size, seed);
	const verdictOf = new Map(candidates.map((c) => [c.runId, c.verdict]));
	const quotas: AnnotationSession["quotas"] = {};
	for (const runId of sample) {
		const verdict = verdictOf.get(runId);
		if (verdict) quotas[verdict] = (quotas[verdict] ?? 0) + 1;
	}
	const annotated = store.annotatedRunIds(campaignId);
	return {
		campaignId,
		seed,
		sample,
		pending: sample.filter((runId) => !annotated.has(runId)),
		quotas,
	};
}

// Everything the annotate command shows about one run.
export type RunToAnnotate = {
	run: Run;
	trace: Trace;
	task: Task;
	initial: Environment;
	// Unset for a reference run.
	attack?: Attack;
	payload?: string;
	// Shown only once the annotator has given theirs.
	judged: StoredVerdict;
};

export function loadRunToAnnotate(store: Store, runId: number): RunToAnnotate {
	const run = store.getRun(runId);
	const trace = store.getTrace(runId);
	const judged = store.getVerdict(runId);
	if (!run || !trace || !judged)
		throw new AnnotationError(`Run ${runId} has no trace or no verdict.`);
	return {
		run,
		trace,
		task: taskById(run.taskId as TaskId),
		judged,
		...startingWorld(run, trace),
	};
}
