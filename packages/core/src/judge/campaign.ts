// Judges the stored runs of a campaign and saves their verdicts.
//
// The only part of the judge that touches the base. The rules stay in
// judge.ts, pure.

import type { Trace } from "../agent/trace.ts";
import {
	type Attack,
	attackById,
	graftAttack,
	payloadOf,
} from "../attacks/catalog.ts";
import { createEnvironment } from "../env/environment.ts";
import type { Environment } from "../env/types.ts";
import { VERDICTS, type Verdict } from "../store/schema.ts";
import type { Run, Store } from "../store/store.ts";
import { JUDGE_VERSION, judge } from "./judge.ts";

export type StoredJudgment = {
	verdict: Verdict;
	taskSuccess: boolean;
	exposed: boolean | null;
	reason: string;
	judgeVersion: string;
};

export type StartingWorld = {
	initial: Environment;
	// Unset for a reference run.
	attack?: Attack;
	payload?: string;
};

// The world a stored run started from: the seed, the run's canary, and
// the payload of its attack. The judge and the annotate command read it.
export function startingWorld(
	run: Pick<Run, "attackId">,
	trace: Pick<Trace, "canary">,
): StartingWorld {
	const clean = createEnvironment({ canary: trace.canary });
	if (run.attackId === null) return { initial: clean };
	const attack = attackById(run.attackId);
	return {
		initial: graftAttack(clean, attack),
		attack,
		payload: payloadOf(attack, clean),
	};
}

export function judgeStoredRun(store: Store, run: Run): StoredJudgment {
	if (run.status === "error")
		return {
			verdict: "technical_error",
			taskSuccess: false,
			exposed: null,
			reason: `technical error: ${run.error}`,
			judgeVersion: JUDGE_VERSION,
		};
	const trace = store.getTrace(run.id);
	if (!trace) throw new Error(`Run ${run.id} is done but has no trace`);
	const { initial, attack, payload } = startingWorld(run, trace);
	const { verdict, taskSuccess, exposed, reason } = judge({
		trace,
		initial,
		...(attack &&
			payload !== undefined && {
				attack: { recipients: attack.recipients, payload },
			}),
	});
	return { verdict, taskSuccess, exposed, reason, judgeVersion: JUDGE_VERSION };
}

export type CampaignJudgment = {
	judged: number;
	// Per model, then per verdict.
	counts: Record<string, Record<Verdict, number>>;
	// Per model: the attacked runs that never saw the payload.
	unexposed: Record<string, number>;
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
	const unexposed: CampaignJudgment["unexposed"] = {};
	store.db.transaction(() => {
		for (const run of runs) {
			const judgment = judgeStoredRun(store, run);
			store.saveVerdict(run.id, judgment);
			const byVerdict = counts[run.model] ?? emptyCounts();
			byVerdict[judgment.verdict]++;
			counts[run.model] = byVerdict;
			unexposed[run.model] =
				(unexposed[run.model] ?? 0) + (judgment.exposed === false ? 1 : 0);
		}
	});
	return { judged: runs.length, counts, unexposed };
}
