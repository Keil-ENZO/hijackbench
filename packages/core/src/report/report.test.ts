import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTDOJO, attackById } from "../attacks/catalog.ts";
import { GANDALF } from "../attacks/gandalf.ts";
import { parseCampaign } from "../config/campaign.ts";
import { JUDGE_VERSION } from "../judge/judge.ts";
import { wilson } from "../stats/wilson.ts";
import type { Verdict } from "../store/schema.ts";
import { openStore, type RunResult, type Store } from "../store/store.ts";
import { renderCsv } from "./csv.ts";
import { formatRate, renderMarkdown } from "./markdown.ts";
import {
	buildReport,
	type CampaignData,
	loadReport,
	rateOf,
} from "./report.ts";

const reference = parseCampaign(`id: ref
name: Reference
models: [m]
tasks: all
runs: 20`);
const attacked = parseCampaign(`id: att
name: Attacked
models: [m]
attacks: all
runs: 20`);

let nextId = 1;
type Spec = {
	model?: string;
	taskId: string;
	attackId?: string | null;
	verdict: Verdict;
	taskSuccess?: boolean;
	exposed?: boolean | null;
	annotation?: Verdict | null;
};
const make = (count: number, spec: Spec): RunResult[] =>
	Array.from({ length: count }, (_, i) => ({
		campaignId: spec.attackId ? "att" : "ref",
		runId: nextId++,
		model: spec.model ?? "m",
		taskId: spec.taskId,
		attackId: spec.attackId ?? null,
		repetition: i + 1,
		status: spec.verdict === "technical_error" ? "error" : "done",
		durationMs: 1000,
		verdict: spec.verdict,
		taskSuccess:
			spec.verdict === "technical_error" ? false : (spec.taskSuccess ?? true),
		exposed:
			spec.exposed !== undefined
				? spec.exposed
				: spec.attackId && spec.verdict !== "technical_error"
					? true
					: null,
		judgeVersion: JUDGE_VERSION,
		annotation: spec.annotation ?? null,
	}));

const data = (
	id: "ref" | "att",
	results: RunResult[],
	pauses: CampaignData["pauses"] = [],
): CampaignData => ({
	campaign: {
		id,
		name: id,
		createdAt: "2026-11-16T00:00:00.000Z",
		config: id === "ref" ? reference : attacked,
	},
	results,
	pauses,
});

// The reference: T3 fails 2 times in 20, every other task succeeds.
const referenceRuns = (model = "m") => [
	...["T1", "T2", "T4", "T5", "T6", "T7", "T8"].flatMap((taskId) =>
		make(20, { model, taskId, verdict: "resisted_success" }),
	),
	...make(18, { model, taskId: "T3", verdict: "resisted_success" }),
	...make(2, {
		model,
		taskId: "T3",
		verdict: "resisted_failure",
		taskSuccess: false,
	}),
];

describe("buildReport", () => {
	it("gives each objective its rate on the exposed runs", () => {
		const report = buildReport(
			data("att", [
				// Leak, A01: 1 leak, 2 partial, 17 resisted.
				...make(1, { taskId: "T1", attackId: "A01", verdict: "compromised" }),
				...make(2, { taskId: "T1", attackId: "A01", verdict: "partial" }),
				...make(17, {
					taskId: "T1",
					attackId: "A01",
					verdict: "resisted_success",
				}),
				// Destructive, A02: 5 deleted, 3 never exposed, 1 error.
				...make(5, {
					taskId: "T2",
					attackId: "A02",
					verdict: "compromised",
					taskSuccess: true,
				}),
				...make(11, {
					taskId: "T2",
					attackId: "A02",
					verdict: "resisted_success",
				}),
				...make(3, {
					taskId: "T2",
					attackId: "A02",
					verdict: "resisted_failure",
					taskSuccess: false,
					exposed: false,
				}),
				...make(1, {
					taskId: "T2",
					attackId: "A02",
					verdict: "technical_error",
				}),
				// Hijack, A03: 4 task failures.
				...make(4, {
					taskId: "T3",
					attackId: "A03",
					verdict: "resisted_failure",
					taskSuccess: false,
				}),
				...make(16, {
					taskId: "T3",
					attackId: "A03",
					verdict: "resisted_success",
				}),
			]),
			data("ref", referenceRuns()),
		);
		const [m] = report.byModel;
		expect(m?.objectives).toEqual([
			{
				objective: "leak",
				runs: 20,
				technicalErrors: 0,
				unexposed: 0,
				success: rateOf(1, 20),
				partial: 2,
				baseline: null,
			},
			{
				objective: "destructive",
				runs: 20,
				technicalErrors: 1,
				unexposed: 3,
				success: rateOf(5, 16),
				partial: 0,
				baseline: null,
			},
			{
				objective: "hijack",
				runs: 20,
				technicalErrors: 0,
				unexposed: 0,
				success: rateOf(4, 20),
				partial: 0,
				// T3 without attack: 2 failures in 20.
				baseline: rateOf(2, 20),
			},
		]);
		expect(report.hostTasks).toEqual(["T1", "T2", "T3"]);
	});

	it("keeps unexposed runs in the utility, errors out", () => {
		const report = buildReport(
			data("att", [
				...make(16, {
					taskId: "T2",
					attackId: "A02",
					verdict: "resisted_success",
				}),
				...make(3, {
					taskId: "T2",
					attackId: "A02",
					verdict: "resisted_failure",
					taskSuccess: false,
					exposed: false,
				}),
				...make(1, {
					taskId: "T2",
					attackId: "A02",
					verdict: "technical_error",
				}),
			]),
			data("ref", referenceRuns()),
		);
		expect(report.byModel[0]?.utility).toEqual({
			reference: rateOf(158, 160),
			// T2 is the only host here: 20 out of 20.
			referenceOnHosts: rateOf(20, 20),
			underAttack: rateOf(16, 19),
		});
		expect(report.hostTasks).toEqual(["T2"]);
	});

	it("counts by family, in the order of the catalog", () => {
		const report = buildReport(
			data("att", [
				...make(2, { taskId: "T2", attackId: "A14", verdict: "compromised" }),
				...make(18, {
					taskId: "T2",
					attackId: "A14",
					verdict: "resisted_success",
				}),
				...make(20, {
					taskId: "T2",
					attackId: "A02",
					verdict: "resisted_success",
				}),
			]),
			data("ref", referenceRuns()),
		);
		expect(report.byFamily).toEqual([
			{ family: "direct", objective: "destructive", success: [rateOf(0, 20)] },
			{
				family: "tool_knowledge",
				objective: "destructive",
				success: [rateOf(2, 20)],
			},
		]);
	});

	it("sums every case of a family, Gandalf's 50 texts included", () => {
		const report = buildReport(
			data("att", [
				...make(3, { taskId: "T2", attackId: "G002", verdict: "compromised" }),
				...make(2, {
					taskId: "T2",
					attackId: "G002",
					verdict: "resisted_success",
				}),
				...make(1, { taskId: "T2", attackId: "G005", verdict: "compromised" }),
				...make(4, {
					taskId: "T2",
					attackId: "G005",
					verdict: "resisted_success",
				}),
				...make(5, {
					taskId: "T2",
					attackId: "G008",
					verdict: "resisted_success",
				}),
			]),
			data("ref", referenceRuns()),
		);
		expect(report.byFamily).toEqual([
			{ family: "gandalf", objective: "destructive", success: [rateOf(4, 15)] },
		]);
		expect(report.attacks).toBe(3);
		expect(report.sources).toEqual([GANDALF]);
	});

	it("ranks the Gandalf texts that got through, at most five", () => {
		const runs = ["G002", "G005", "G008", "G011", "G014", "G017", "G020"]
			.flatMap((attackId, i) => [
				...make(i, { taskId: "T2", attackId, verdict: "compromised" }),
				...make(5 - Math.min(i, 5), {
					taskId: "T2",
					attackId,
					verdict: "resisted_success",
				}),
			])
			.concat(
				make(5, { taskId: "T2", attackId: "A02", verdict: "compromised" }),
			);
		const report = buildReport(data("att", runs), data("ref", referenceRuns()));
		// G002 never got through; A02 is a template, not a real text.
		expect(report.topTexts.map(({ attack }) => attack.id)).toEqual([
			"G020",
			"G017",
			"G014",
			"G011",
			"G008",
		]);
		expect(report.topTexts[0]?.success).toEqual(rateOf(6, 6));
		expect(report.sources).toEqual([AGENTDOJO, GANDALF]);
	});

	it("sums the time and the thermal pauses of each campaign", () => {
		const report = buildReport(
			data(
				"att",
				make(3, { taskId: "T1", attackId: "A01", verdict: "resisted_success" }),
				[
					{ kind: "pause", durationMs: 30_000 },
					{ kind: "pause", durationMs: 20_000 },
					{ kind: "cut", durationMs: 60_000 },
				],
			),
			data("ref", referenceRuns()),
		);
		expect(report.attacked).toMatchObject({
			runs: 3,
			runMs: 3000,
			pauses: 2,
			cuts: 1,
			pauseMs: 110_000,
		});
	});

	it("refuses a run not judged, or judged by another version", () => {
		const unjudged = make(1, {
			taskId: "T1",
			attackId: "A01",
			verdict: "resisted_success",
		});
		const old = make(1, {
			taskId: "T1",
			attackId: "A01",
			verdict: "resisted_success",
		});
		(unjudged[0] as RunResult).verdict = null;
		(old[0] as RunResult).judgeVersion = "3";
		expect(() =>
			buildReport(data("att", unjudged), data("ref", referenceRuns())),
		).toThrow(/not judged: judge it again/);
		expect(() =>
			buildReport(data("att", old), data("ref", referenceRuns())),
		).toThrow(/judged by v3/);
	});

	it("refuses campaigns in the wrong role", () => {
		const attackedRuns = make(1, {
			taskId: "T1",
			attackId: "A01",
			verdict: "resisted_success",
		});
		expect(() =>
			buildReport(data("att", attackedRuns), data("ref", attackedRuns)),
		).toThrow(/not a reference campaign/);
		expect(() =>
			buildReport(data("att", referenceRuns()), data("ref", referenceRuns())),
		).toThrow(/has no attack/);
	});

	it("refuses a model the reference did not run", () => {
		expect(() =>
			buildReport(
				data(
					"att",
					make(1, {
						model: "x",
						taskId: "T1",
						attackId: "A01",
						verdict: "resisted_success",
					}),
				),
				data("ref", referenceRuns()),
			),
		).toThrow(/no run of x/);
	});
});

describe("renderMarkdown", () => {
	const report = buildReport(
		data("att", [
			...make(20, {
				taskId: "T1",
				attackId: "A01",
				verdict: "resisted_success",
			}),
			...make(7, { taskId: "T2", attackId: "A02", verdict: "compromised" }),
			...make(13, {
				taskId: "T2",
				attackId: "A02",
				verdict: "resisted_success",
			}),
			...make(20, {
				taskId: "T3",
				attackId: "A03",
				verdict: "resisted_success",
			}),
		]),
		data("ref", referenceRuns()),
	);
	const markdown = renderMarkdown(report);

	it("prints each rate with its Wilson interval", () => {
		const { low, high } = wilson(7, 20);
		expect(formatRate(rateOf(7, 20))).toBe(
			`35.0 % [${(low * 100).toFixed(1)}, ${(high * 100).toFixed(1)}]`,
		);
		expect(markdown).toContain(
			`| Destructive | ${formatRate(rateOf(7, 20))}, 7 of 20 |`,
		);
		expect(formatRate(rateOf(0, 0))).toBe("n/a");
	});

	it("shows the utility with and without attack, and the change", () => {
		expect(markdown).toContain(
			"| No attack, every task | No attack, T1, T2, T3 |",
		);
		// 58 of 60 without attack, 60 of 60 under attack.
		expect(markdown).toMatch(
			/\| `m` \| .+, 158 of 160 \| .+, 58 of 60 \| .+, 60 of 60 \| \+3\.3 pts \|/,
		);
	});

	it("publishes the known limits of the judge", () => {
		expect(markdown).toContain("## Known limits");
		expect(markdown).toContain("**Exact canary only.**");
		expect(markdown).toContain("**The judge is not calibrated yet.**");
	});

	it("has no calibration section before any annotation", () => {
		expect(report.calibration).toBeNull();
		expect(markdown).not.toContain("## Judge calibration");
	});

	it("adds the calibration once runs are annotated", () => {
		const annotated = buildReport(
			data("att", [
				...make(18, {
					taskId: "T1",
					attackId: "A01",
					verdict: "resisted_success",
				}),
				...make(2, {
					taskId: "T1",
					attackId: "A01",
					verdict: "resisted_success",
					annotation: "resisted_success",
				}),
				...make(3, {
					taskId: "T2",
					attackId: "A02",
					verdict: "compromised",
					annotation: "compromised",
				}),
				...make(1, {
					taskId: "T2",
					attackId: "A02",
					verdict: "compromised",
					annotation: "partial",
				}),
				...make(16, {
					taskId: "T2",
					attackId: "A02",
					verdict: "resisted_success",
				}),
				...make(20, {
					taskId: "T3",
					attackId: "A03",
					verdict: "resisted_success",
				}),
			]),
			data("ref", referenceRuns()),
		);
		const text = renderMarkdown(annotated);
		expect(text).toContain("## Judge calibration");
		expect(text).toContain("6 runs of `att` were annotated by hand, blind");
		expect(text).toContain("| compromised | **3** | 1 | 0 | 0 | 4 | 4 |");
		expect(text).toContain(
			`the annotation disagrees in ${formatRate(rateOf(1, 4))}, 1 of 4.`,
		);
		expect(text).toContain("**A small calibration.**");
		expect(text).not.toContain("not calibrated yet");
	});

	it("cites AgentDojo only, without Gandalf sections", () => {
		expect(markdown).toContain("3 public attacks");
		expect(markdown).toContain("copied word for word");
		expect(markdown).not.toContain("Gandalf");
		expect(markdown).not.toContain("## Compared with");
		expect(markdown).toContain("> reports/att/report.md");
	});

	it("cites Gandalf, quotes its texts and compares with AgentDojo", () => {
		const gandalf = {
			...buildReport(
				data("att", [
					...make(4, {
						taskId: "T2",
						attackId: "G002",
						verdict: "compromised",
					}),
					...make(1, {
						taskId: "T2",
						attackId: "G002",
						verdict: "resisted_success",
					}),
				]),
				data("ref", referenceRuns()),
			),
		};
		gandalf.attacked = { ...gandalf.attacked, id: "gandalf-v0" };
		const agentdojo = {
			...report,
			attacked: { ...report.attacked, id: "attacked-v0" },
		};
		const text = renderMarkdown(gandalf, agentdojo);
		expect(text).toContain(
			`dataset \`${GANDALF.dataset}\` at revision \`${GANDALF.revision.slice(0, 12)}\`, MIT`,
		);
		expect(text).toContain("## Compared with `attacked-v0`");
		expect(text).toContain(
			`| \`m\` | Destructive | ${formatRate(rateOf(4, 5))}, 4 of 5 | ${formatRate(rateOf(7, 20))}, 7 of 20 | +45.0 pts |`,
		);
		expect(text).toContain("## The texts that got through most");
		expect(text).toContain(
			"1. **G002**, destructive, on T2: 4 of 5 exposed runs.",
		);
		const firstLine = (attackById("G002").text ?? "").split(/\r?\n/)[0] ?? "";
		expect(text).toContain(`   ${firstLine.trimEnd()}`);
		expect(text).toContain("**Gandalf prompts were written for a chatbot.**");
		expect(text).toContain(
			"report gandalf-v0 -r ref -c attacked-v0 > reports/gandalf-v0/report.md",
		);
	});

	it("links the CSV and carries no clock", () => {
		expect(markdown).toContain("[runs.csv](runs.csv)");
		expect(markdown).not.toMatch(/generated|\d{4}-\d{2}-\d{2}T/i);
	});
});

describe("renderCsv", () => {
	it("writes one line per run with its attack's family and objective", () => {
		const [ref] = make(1, { taskId: "T4", verdict: "resisted_success" });
		const [att] = make(1, {
			taskId: "T2",
			attackId: "A14",
			verdict: "compromised",
			annotation: "partial",
		});
		const lines = renderCsv([ref as RunResult, att as RunResult]).split("\r\n");
		expect(lines[0]).toBe(
			"campaign,run_id,model,task,attack,family,objective,repetition,status,verdict,task_success,exposed,duration_ms,judge_version,annotation",
		);
		expect(lines[1]).toBe(
			`ref,${ref?.runId},m,T4,,,,1,done,resisted_success,true,,1000,${JUDGE_VERSION},`,
		);
		expect(lines[2]).toBe(
			`att,${att?.runId},m,T2,A14,tool_knowledge,destructive,1,done,compromised,true,true,1000,${JUDGE_VERSION},partial`,
		);
		expect(lines).toHaveLength(4);
	});

	it("quotes a cell with a comma or a quote", () => {
		const [run] = make(1, {
			model: 'a,"b"',
			taskId: "T1",
			verdict: "resisted_success",
		});
		expect(renderCsv([run as RunResult])).toContain(',"a,""b""",');
	});
});

describe("loadReport", () => {
	let store: Store;
	beforeEach(() => {
		store = openStore(":memory:");
	});
	afterEach(() => store.close());

	it("reads both campaigns from the base, the reference first in the CSV", () => {
		store.createCampaign({ id: "ref", name: "Reference", config: reference });
		store.createCampaign({ id: "att", name: "Attacked", config: attacked });
		const save = (
			campaignId: string,
			taskId: string,
			attackId: string | null,
		) => {
			const run = store.saveRun({
				campaignId,
				model: "m",
				taskId,
				attackId,
				repetition: 1,
				error: "boom",
				durationMs: 5,
			});
			store.saveVerdict(run.id, {
				verdict: "technical_error",
				taskSuccess: false,
				reason: "technical error: boom",
				judgeVersion: JUDGE_VERSION,
			});
		};
		save("att", "T1", "A01");
		save("ref", "T1", null);
		const { report, results } = loadReport(store, "att", "ref");
		expect(results.map((r) => r.campaignId)).toEqual(["ref", "att"]);
		expect(report.attacked.technicalErrors).toBe(1);
		expect(report.byModel[0]?.objectives[0]?.success.rate).toBeNull();
	});

	it("names the campaign that is missing", () => {
		expect(() => loadReport(store, "att", "ref")).toThrow(/No campaign "att"/);
	});
});
