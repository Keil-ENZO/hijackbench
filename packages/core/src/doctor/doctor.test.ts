import { describe, expect, it } from "vitest";
import { CampaignConfigSchema } from "../config/campaign.ts";
import { type Check, type DoctorInput, runDoctor } from "./doctor.ts";
import {
	createOllamaClient,
	type InstalledModel,
	type LoadedModel,
	type OllamaClient,
	OllamaUnreachableError,
	sameModel,
} from "./models.ts";

const NOW = 1_794_238_955_000;
const PROM = (vram: number, ageS = 2) => `gputemps_vram_celsius{gpu="0"} ${vram}
gputemps_junction_celsius{gpu="0"} 53
gputemps_last_success_timestamp_seconds ${NOW / 1000 - ageS}
`;
const THRESHOLDS = { pauseAt: 84, resumeAt: 60, abortAt: 90 };

const model = (name: string, tools: boolean | null): InstalledModel => ({
	name,
	size: 17e9,
	parameterSize: "25.2B",
	quantization: "Q4_K_M",
	tools,
});

function fakeOllama(
	installed: InstalledModel[] | "down",
	loaded: LoadedModel[] = [],
): OllamaClient {
	const down = async (): Promise<never> => {
		throw new OllamaUnreachableError("cannot reach Ollama at http://x");
	};
	if (installed === "down")
		return {
			baseUrl: "http://x",
			version: down,
			installed: down,
			loaded: down,
		};
	return {
		baseUrl: "http://x",
		version: async () => "0.35.1",
		installed: async () => installed,
		loaded: async () => loaded,
	};
}

const input = (over: Partial<DoctorInput> = {}): DoctorInput => ({
	version: "0.0.0",
	base: { path: "/data/hijackbench.db", campaigns: 2 },
	ollama: fakeOllama([model("gemma4:26b", true)]),
	vramFile: "/prom",
	thresholds: THRESHOLDS,
	read: () => PROM(54),
	now: NOW,
	...over,
});

const byName = (checks: Check[], name: string) =>
	checks.filter((c) => c.name === name);

const campaign = (models: string[], thermal = true) => ({
	source: "c.yaml",
	config: CampaignConfigSchema.parse({
		id: "c",
		name: "c",
		models,
		tasks: ["T1"],
		runs: 1,
		thermal: { enabled: thermal },
	}),
});

describe("runDoctor", () => {
	it("passes on a healthy machine", async () => {
		const checks = await runDoctor(input());
		expect(checks.map((c) => [c.name, c.status])).toEqual([
			["hijackbench", "ok"],
			["Ollama", "ok"],
			["Models", "ok"],
			["Thermal probe", "ok"],
			["GPU", "ok"],
		]);
		expect(byName(checks, "GPU")[0]?.detail).toContain("junction 53 °C");
	});

	it("says what to do on every failure", async () => {
		const checks = await runDoctor(
			input({
				base: { path: "/data/hijackbench.db", error: "SQLITE_READONLY" },
				ollama: fakeOllama("down"),
				read: () => {
					throw new Error("ENOENT");
				},
			}),
		);
		const failed = checks.filter((c) => c.status === "fail");
		expect(failed.map((c) => c.name)).toEqual([
			"hijackbench",
			"Ollama",
			"Thermal probe",
			"GPU",
		]);
		for (const check of failed) expect(check.fix).toBeTruthy();
		expect(byName(checks, "Ollama")[0]?.fix).toMatch(/Start Ollama/);
	});

	it("warns on an empty base: maybe the wrong Docker setup", async () => {
		const [check] = await runDoctor(
			input({ base: { path: "/data/hijackbench.db", campaigns: 0 } }),
		);
		expect(check).toMatchObject({ status: "warn" });
		expect(check?.fix).toMatch(/data volume/);
	});

	it("refuses a stale probe: a dead exporter is not a cold card", async () => {
		const checks = await runDoctor(input({ read: () => PROM(40, 45) }));
		expect(byName(checks, "Thermal probe")[0]).toMatchObject({
			status: "fail",
		});
	});

	it("warns on a hot card", async () => {
		const checks = await runDoctor(input({ read: () => PROM(86) }));
		expect(byName(checks, "Thermal probe")[0]?.fix).toMatch(/60 °C/);
	});

	it("prefers nvidia-smi's name, and flags a model split with the CPU", async () => {
		const checks = await runDoctor(
			input({
				gpuName: "NVIDIA GeForce RTX 3090",
				ollama: fakeOllama(
					[model("gemma4:26b", true)],
					[{ name: "gemma4:26b", size: 20e9, sizeVram: 15e9 }],
				),
			}),
		);
		const [gpu] = byName(checks, "GPU");
		expect(gpu?.detail).toContain("RTX 3090");
		expect(gpu?.detail).toContain("75 % in VRAM");
		expect(gpu).toMatchObject({ status: "warn" });
	});

	it("fails when no model has tool support", async () => {
		const checks = await runDoctor(
			input({ ollama: fakeOllama([model("llama2:7b", false)]) }),
		);
		expect(byName(checks, "Models")[0]).toMatchObject({ status: "fail" });
	});

	it("checks a campaign file's models: missing, without tools, unknown", async () => {
		const checks = await runDoctor(
			input({
				ollama: fakeOllama([
					model("gemma4:26b", true),
					model("old:7b", false),
					model("odd:latest", null),
				]),
				campaign: campaign(["gemma4:26b", "old:7b", "odd", "absent:1b"]),
			}),
		);
		const models = byName(checks, "Campaign models");
		expect(models.map((c) => [c.status, c.detail])).toEqual([
			["fail", "not installed: absent:1b"],
			["fail", "no tool support: old:7b"],
			["warn", "tool support unknown: odd"],
		]);
		expect(models[0]?.fix).toBe("ollama pull absent:1b");
	});

	it("passes a good campaign file, and warns when its guard is off", async () => {
		const good = await runDoctor(input({ campaign: campaign(["gemma4:26b"]) }));
		expect(byName(good, "Campaign models")[0]).toMatchObject({ status: "ok" });
		const off = await runDoctor(
			input({
				campaign: campaign(["gemma4:26b"], false),
				read: () => {
					throw new Error("ENOENT");
				},
			}),
		);
		expect(byName(off, "Campaign file")[0]).toMatchObject({ status: "warn" });
		expect(byName(off, "Thermal probe")[0]).toMatchObject({ status: "warn" });
	});

	it("reports an invalid campaign file", async () => {
		const checks = await runDoctor(
			input({
				campaign: { source: "c.yaml", error: "runs: must be a number" },
			}),
		);
		expect(byName(checks, "Campaign file")[0]).toMatchObject({
			status: "fail",
			detail: "runs: must be a number",
		});
	});
});

describe("createOllamaClient", () => {
	const responses: Record<string, unknown> = {
		"/api/version": { version: "0.35.1" },
		"/api/tags": {
			models: [
				{
					name: "qwen3:8b",
					size: 5e9,
					details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" },
				},
				{ name: "broken:1b", size: 1e9 },
			],
		},
		"/api/ps": { models: [{ name: "qwen3:8b", size: 6e9, size_vram: 6e9 }] },
	};
	const fetch = (async (url: string, init?: RequestInit) => {
		const path = new URL(url).pathname;
		if (path === "/api/show") {
			const { model } = JSON.parse(String(init?.body));
			if (model === "broken:1b") return new Response("no", { status: 500 });
			return Response.json({ capabilities: ["completion", "tools"] });
		}
		return Response.json(responses[path]);
	}) as typeof globalThis.fetch;

	it("lists the models, sorted, with their tool support", async () => {
		const client = createOllamaClient("http://h:11434/", fetch);
		expect(await client.version()).toBe("0.35.1");
		expect(await client.installed()).toEqual([
			{
				name: "broken:1b",
				size: 1e9,
				parameterSize: null,
				quantization: null,
				tools: null,
			},
			{
				name: "qwen3:8b",
				size: 5e9,
				parameterSize: "8.2B",
				quantization: "Q4_K_M",
				tools: true,
			},
		]);
		expect(await client.loaded()).toEqual([
			{ name: "qwen3:8b", size: 6e9, sizeVram: 6e9 },
		]);
	});

	it("names an unreachable Ollama", async () => {
		const client = createOllamaClient("http://h:11434", (async () => {
			throw new TypeError("fetch failed");
		}) as typeof globalThis.fetch);
		await expect(client.version()).rejects.toBeInstanceOf(
			OllamaUnreachableError,
		);
	});

	it("matches a bare name with its :latest tag", () => {
		expect(sameModel("odd", "odd:latest")).toBe(true);
		expect(sameModel("odd:7b", "odd:latest")).toBe(false);
	});
});
