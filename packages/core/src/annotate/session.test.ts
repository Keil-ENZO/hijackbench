import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCampaign } from "../config/campaign.ts";
import { judgeCampaign } from "../judge/campaign.ts";
import { JUDGE_VERSION } from "../judge/judge.ts";
import { reply } from "../providers/fake.ts";
import { runCampaign } from "../runner/runner.ts";
import { openStore, type Store } from "../store/store.ts";
import { AnnotationError, loadRunToAnnotate, openSession } from "./session.ts";

// 3 attacks, 4 runs each: 12 runs, the agent answers at once.
const config = parseCampaign(`id: att
name: Attacked
models: [m]
attacks: [A01, A02, A03]
runs: 4
thermal: { enabled: false }`);

let store: Store;
beforeEach(async () => {
	store = openStore(":memory:");
	await runCampaign({
		config,
		store,
		providerFor: (model) => ({
			name: "scripted",
			model,
			chat: async () => reply("done"),
		}),
	});
	judgeCampaign(store, "att");
	// Give the first 4 runs another verdict, so the draw has two strata.
	for (const run of store.listRuns("att").slice(0, 4))
		store.saveVerdict(run.id, {
			verdict: "compromised",
			taskSuccess: false,
			exposed: true,
			reason: "test",
			judgeVersion: JUDGE_VERSION,
		});
});
afterEach(() => store.close());

describe("openSession", () => {
	it("draws the same quota from each verdict", () => {
		const session = openSession(store, "att", { size: 6 });
		expect(session.sample).toHaveLength(6);
		expect(session.pending).toEqual(session.sample);
		expect(session.quotas).toEqual({ compromised: 3, resisted_failure: 3 });
		expect(session.seed).toBe("att");
	});

	it("resumes: the runs annotated are left out, the rest keeps its order", () => {
		const first = openSession(store, "att", { size: 6 });
		const [a, b, ...rest] = first.sample;
		store.saveAnnotation(a as number, { verdict: "compromised" });
		store.saveAnnotation(b as number, { verdict: "partial", note: "unsure" });
		const again = openSession(store, "att", { size: 6 });
		expect(again.sample).toEqual(first.sample);
		expect(again.pending).toEqual(rest);
	});

	it("never draws a technical error", () => {
		const [run] = store.listRuns("att");
		store.saveVerdict(run?.id as number, {
			verdict: "technical_error",
			taskSuccess: false,
			reason: "test",
			judgeVersion: JUDGE_VERSION,
		});
		const session = openSession(store, "att", { size: 100 });
		expect(session.sample).toHaveLength(11);
		expect(session.sample).not.toContain(run?.id);
	});

	it("refuses a campaign judged by an older judge", () => {
		const [run] = store.listRuns("att");
		store.saveVerdict(run?.id as number, {
			verdict: "compromised",
			taskSuccess: false,
			reason: "old",
			judgeVersion: "0",
		});
		expect(() => openSession(store, "att")).toThrow(
			/1 runs of "att" are not judged by judge v.*hijackbench judge att/,
		);
	});

	it("refuses an unknown campaign and a bad size", () => {
		expect(() => openSession(store, "nope")).toThrow(AnnotationError);
		expect(() => openSession(store, "att", { size: 0 })).toThrow(
			/whole number/,
		);
		expect(() => openSession(store, "att", { size: Number.NaN })).toThrow(
			AnnotationError,
		);
	});
});

describe("loadRunToAnnotate", () => {
	it("rebuilds the world the run started from, attack included", () => {
		const [run] = store.listRuns("att");
		const item = loadRunToAnnotate(store, run?.id as number);
		expect(item.attack?.id).toBe("A01");
		expect(item.payload).toBeTruthy();
		expect(item.task.id).toBe(item.attack?.taskId);
		expect(item.initial.canary).toBe(item.trace.canary);
		expect(item.judged.verdict).toBe("compromised");
	});
});
