import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CampaignConfig,
	CampaignConfigError,
	loadCampaign,
	parseCampaign,
} from "./campaign.ts";

const CAMPAIGNS = join(import.meta.dirname, "../../../../campaigns");

const MINIMAL = `id: test
name: Test
models: [gemma]
tasks: [T1]
runs: 20
`;

// The problems listed by a failed parse.
function problems(text: string): string[] {
	try {
		parseCampaign(text);
	} catch (error) {
		if (error instanceof CampaignConfigError) return error.problems;
		throw error;
	}
	throw new Error("expected the campaign to be rejected");
}

describe("parseCampaign", () => {
	it("fills the defaults", () => {
		expect(parseCampaign(MINIMAL)).toEqual({
			id: "test",
			name: "Test",
			models: ["gemma"],
			tasks: ["T1"],
			attacks: [],
			runs: 20,
			agent: { temperature: 0.7, maxTurns: 10 },
			ollama: { baseUrl: "http://localhost:11434", timeoutMs: 120_000 },
			thermal: { enabled: true, pauseAt: 84, resumeAt: 60, abortAt: 90 },
		} satisfies CampaignConfig);
	});

	it('expands tasks: "all" to the eight tasks', () => {
		const config = parseCampaign(MINIMAL.replace("[T1]", "all"));
		expect(config.tasks).toEqual([
			"T1",
			"T2",
			"T3",
			"T4",
			"T5",
			"T6",
			"T7",
			"T8",
		]);
	});

	it("accepts attacks without reference tasks", () => {
		const config = parseCampaign(
			MINIMAL.replace("tasks: [T1]", "attacks: [A01, A15]"),
		);
		expect(config).toMatchObject({ tasks: [], attacks: ["A01", "A15"] });
	});

	it("keeps overridden settings and defaults the others", () => {
		const config = parseCampaign(
			`${MINIMAL}agent:\n  temperature: 0\n  maxTokens: 512\n`,
		);
		expect(config.agent).toEqual({
			temperature: 0,
			maxTurns: 10,
			maxTokens: 512,
		});
	});
});

describe("errors", () => {
	it("names every missing field", () => {
		expect(problems("id: test\n")).toEqual([
			"name: is missing",
			"models: is missing",
			"runs: is missing",
		]);
	});

	it("points a typo in a field name at its line", () => {
		expect(problems(`${MINIMAL}temprature: 0.5\n`)).toEqual([
			'line 6, campaign: unknown field "temprature"',
		]);
	});

	it("points an unknown nested field at its line", () => {
		expect(problems(`${MINIMAL}agent:\n  max_turns: 5\n`)).toEqual([
			'line 7, agent: unknown field "max_turns"',
		]);
	});

	it("lists the known tasks", () => {
		expect(problems(MINIMAL.replace("[T1]", "[T1, T9]"))).toEqual([
			'line 4, tasks.1: unknown task "T9", expected one of T1, T2, T3, T4, T5, T6, T7, T8',
		]);
	});

	it("explains the attack id format", () => {
		expect(problems(MINIMAL.replace("tasks: [T1]", "attacks: [3]"))).toEqual([
			"line 4, attacks.0: must be text",
		]);
		expect(
			problems(MINIMAL.replace("tasks: [T1]", "attacks: [attack-3]")),
		).toEqual(['line 4, attacks.0: an attack id looks like "A03"']);
	});

	it("rejects duplicates", () => {
		expect(problems(MINIMAL.replace("[gemma]", "[gemma, gemma]"))).toEqual([
			"line 3, models: lists the same Ollama model tag twice",
		]);
	});

	it("rejects a campaign that runs nothing", () => {
		expect(problems(MINIMAL.replace("tasks: [T1]\n", ""))).toEqual([
			"campaign: runs nothing: add tasks, attacks, or both",
		]);
	});

	it("checks the run count", () => {
		expect(problems(MINIMAL.replace("runs: 20", "runs: 2.5"))).toEqual([
			"line 5, runs: must be a whole number",
		]);
		expect(problems(MINIMAL.replace("runs: 20", 'runs: "20"'))).toEqual([
			"line 5, runs: must be a number",
		]);
	});

	it("checks the order of the thermal thresholds", () => {
		expect(problems(`${MINIMAL}thermal:\n  pauseAt: 95\n`)).toEqual([
			"line 7, thermal: needs resumeAt < pauseAt < abortAt",
		]);
	});

	it("explains the id format", () => {
		expect(problems(MINIMAL.replace("id: test", "id: My Campaign"))).toEqual([
			'line 1, id: use lowercase letters, digits and dashes, e.g. "reference-v0"',
		]);
	});

	it("reports broken YAML with its line", () => {
		const [problem] = problems("id: test\nmodels: [gemma\n");
		expect(problem).toMatch(/^line \d+, invalid YAML/);
	});

	it("rejects a file that is not a map", () => {
		expect(problems("- gemma\n")).toEqual([
			"the file must be a map of fields, starting with id: and name:",
		]);
	});

	it("names the file in the message", () => {
		expect(() => parseCampaign("id: x\n", "campaigns/x.yaml")).toThrow(
			/^campaigns\/x\.yaml is not a valid campaign:\n {2}- name: is missing/,
		);
	});
});

describe("loadCampaign", () => {
	it("loads the commented example", () => {
		const config = loadCampaign(join(CAMPAIGNS, "example.yaml"));
		expect(config).toMatchObject({
			id: "example",
			tasks: ["T2", "T5"],
			attacks: ["A01"],
			runs: 20,
		});
		expect(config.models).toHaveLength(2);
	});

	it("loads the V0 reference campaign: 8 tasks, 3 models", () => {
		const config = loadCampaign(join(CAMPAIGNS, "reference-v0.yaml"));
		expect(config.tasks).toHaveLength(8);
		expect(config.models).toHaveLength(3);
		expect(config.attacks).toEqual([]);
	});

	it("reports a missing file", () => {
		expect(() => loadCampaign("nope.yaml")).toThrow(
			/nope\.yaml is not a valid campaign:\n {2}- cannot read the file/,
		);
	});
});
