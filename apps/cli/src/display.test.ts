import type { CampaignStatus } from "@hijackbench/core";
import { describe, expect, it } from "vitest";
import { formatDuration, percent, renderStatus } from "./display.ts";

const thresholds = { pauseAt: 84, resumeAt: 60, abortAt: 90 };

const tally = (planned: number, stored: number, success: number) => ({
	planned,
	stored,
	errors: 0,
	judged: stored,
	success,
});

const status = (over: Partial<CampaignStatus> = {}): CampaignStatus => ({
	id: "ref",
	name: "Reference",
	state: "stopped",
	...tally(8, 3, 2),
	spentMs: 30_000,
	etaMs: 50_000,
	current: null,
	pauses: { pauses: 1, cuts: 0, durationMs: 15_000 },
	cases: ["T1", "T2"],
	models: [
		{
			model: "gemma",
			...tally(4, 3, 2),
			cases: { T1: tally(2, 2, 2), T2: tally(2, 1, 0) },
		},
		{
			model: "llama",
			...tally(4, 0, 0),
			cases: { T1: tally(2, 0, 0), T2: tally(2, 0, 0) },
		},
	],
	...over,
});

describe("formatDuration", () => {
	it("picks the unit from the size", () => {
		expect(formatDuration(400)).toBe("0 s");
		expect(formatDuration(45_200)).toBe("45 s");
		expect(formatDuration(200_000)).toBe("3 min 20 s");
		expect(formatDuration(3_900_000)).toBe("1 h 05 min");
	});
});

describe("percent", () => {
	it("has no value without runs", () => {
		expect(percent(1, 3)).toBe("33 %");
		expect(percent(0, 0)).toBe("-");
	});
});

describe("renderStatus", () => {
	it("shows the progress, the time left and the rates per case", () => {
		const text = renderStatus(status(), 71, thresholds);
		expect(text).toContain("3/8 runs · 38 % · about 50 s left");
		expect(text).toContain("VRAM 71 °C (pause at 84, cut at 90)");
		expect(text).toContain("1 pauses, 0 cuts, 15 s cooling");
		expect(text).toMatch(/gemma\s+2\/2\s+0\/1\s+2\/3\s+67 %/);
		expect(text).toMatch(/llama\s+-\s+-\s+-\s+-/);
		expect(text).toContain("hijackbench resume ref");
	});

	it("shows the run in flight", () => {
		const text = renderStatus(
			status({
				state: "running",
				current: {
					model: "gemma",
					taskId: "T2",
					attackId: null,
					repetition: 2,
					forMs: 12_000,
				},
			}),
			71,
			thresholds,
		);
		expect(text).toContain("now: gemma T2 #2, for 12 s");
		expect(text).not.toContain("resume");
	});

	it("says what to do about runs without a verdict", () => {
		const text = renderStatus(status({ judged: 1 }), undefined, thresholds);
		expect(text).toContain("2 runs have no verdict yet: hijackbench judge ref");
		expect(text).toContain("VRAM: no reading on this machine");
	});

	it("drops the time left once done", () => {
		const text = renderStatus(
			status({ state: "done", etaMs: 0 }),
			40,
			thresholds,
		);
		expect(text).not.toContain("left");
	});
});
