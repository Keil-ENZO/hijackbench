// Judges the stored runs of a campaign and saves their verdicts.
//
// The only part of the judge that touches the base. The rules stay in
// judge.ts, pure.

import { createEnvironment } from "../env/environment.ts";
import { VERDICTS, type Verdict } from "../store/schema.ts";
import type { Run, Store } from "../store/store.ts";
import { JUDGE_VERSION, judge } from "./judge.ts";

export type StoredJudgment = {
	verdict: Verdict;
	taskSuccess: boolean;
	reason: string;
	judgeVersion: string;
};

export function judgeStoredRun(store: Store, run: Run): StoredJudgment {
	if (run.status === "error")
		return {
			verdict: "technical_error",
			taskSuccess: false,
			reason: `technical error: ${run.error}`,
			judgeVersion: JUDGE_VERSION,
		};
	const trace = store.getTrace(run.id);
	if (!trace) throw new Error(`Run ${run.id} is done but has no trace`);
	// The attack catalog of US-20 will graft its payload here.
	if (run.attackId !== null)
		throw new Error(
			`Run ${run.id} is attacked: judging attacked runs needs the attack catalog (US-20)`,
		);
	const { verdict, taskSuccess, reason } = judge({
		trace,
		initial: createEnvironment({ canary: trace.canary }),
	});
	return { verdict, taskSuccess, reason, judgeVersion: JUDGE_VERSION };
}

export type CampaignJudgment = {
	judged: number;
	// Per model, then per verdict.
	counts: Record<string, Record<Verdict, number>>;
};

const emptyCounts = (): Record<Verdict, number> =>
	Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0])) as Record<
		Verdict,
		number
	>;

// Judges every run again: the rules are cheap, and a new judge version
// must replace every old verdict. One transaction for the whole campaign.
export function judgeCampaign(
	store: Store,
	campaignId: string,
): CampaignJudgment {
	const runs = store.listRuns(campaignId);
	const counts: CampaignJudgment["counts"] = {};
	store.db.transaction(() => {
		for (const run of runs) {
			const judgment = judgeStoredRun(store, run);
			store.saveVerdict(run.id, judgment);
			const byVerdict = counts[run.model] ?? emptyCounts();
			byVerdict[judgment.verdict]++;
			counts[run.model] = byVerdict;
		}
	});
	return { judged: runs.length, counts };
}
