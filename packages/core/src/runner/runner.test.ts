import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CampaignConfig, parseCampaign } from "../config/campaign.ts";
import { ProviderError } from "../providers/errors.ts";
import { reply } from "../providers/fake.ts";
import type { ChatResponse, Provider } from "../providers/types.ts";
import { openStore, runKey, type Store } from "../store/store.ts";
import {
	CampaignMismatchError,
	planCampaign,
	type RunnerEvent,
	runCampaign,
} from "./runner.ts";

const config = (yaml = ""): CampaignConfig =>
	parseCampaign(`id: test
name: Test
models: [gemma, llama]
tasks: [T1, T2]
runs: 3
${yaml}`);

// A provider that answers every call with `answer(call number)`, and logs
// loads and unloads so the tests can check what sits in VRAM.
type Log = string[];
function provider(
	model: string,
	log: Log,
	answer: (n: number) => ChatResponse,
) {
	let calls = 0;
	log.push(`load ${model}`);
	return {
		name: "scripted",
		model,
		async chat() {
			calls++;
			log.push(`chat ${model}`);
			return answer(calls);
		},
		async unload() {
			log.push(`unload ${model}`);
		},
	} satisfies Provider;
}

let store: Store;
let log: Log;
let events: RunnerEvent[];

beforeEach(() => {
	store = openStore(":memory:");
	log = [];
	events = [];
});
afterEach(() => store.close());

const run = (
	c: CampaignConfig,
	answer: (model: string, n: number) => ChatResponse = () => reply("done"),
	extra: Partial<Parameters<typeof runCampaign>[0]> = {},
) =>
	runCampaign({
		config: c,
		store,
		providerFor: (model) => provider(model, log, (n) => answer(model, n)),
		onEvent: (event) => events.push(event),
		sleep: async () => {},
		...extra,
	});

describe("planCampaign", () => {
	it("goes model by model, then repetition by repetition", () => {
		const plan = planCampaign(config());
		expect(plan).toHaveLength(2 * 3 * 2);
		expect(plan.slice(0, 4).map(runKey)).toEqual([
			"gemma|T1|-|1",
			"gemma|T2|-|1",
			"gemma|T1|-|2",
			"gemma|T2|-|2",
		]);
		expect(plan[6]?.model).toBe("llama");
		expect(new Set(plan.map(runKey)).size).toBe(plan.length);
	});
});

describe("runCampaign", () => {
	it("runs and stores every planned run", async () => {
		const summary = await run(config());
		expect(summary).toEqual({ planned: 12, skipped: 0, done: 12, errors: 0 });
		expect(store.listRuns("test")).toHaveLength(12);
		expect(store.storedKeys("test")).toEqual(
			new Set(planCampaign(config()).map(runKey)),
		);
	});

	it("keeps one model in VRAM at a time", async () => {
		await run(config());
		const lifecycle = log.filter((line) => !line.startsWith("chat"));
		expect(lifecycle).toEqual([
			"load gemma",
			"unload gemma",
			"load llama",
			"unload llama",
		]);
		const firstLlama = log.indexOf("load llama");
		expect(log.slice(firstLlama).some((l) => l === "chat gemma")).toBe(false);
	});

	it("applies the agent settings of the config", async () => {
		await run(config("agent:\n  temperature: 0\n  maxTurns: 3\n"));
		const [first] = store.listRuns("test");
		const trace = store.getTrace(first?.id ?? 0);
		expect(trace?.settings).toEqual({ maxTurns: 3, temperature: 0 });
	});

	it("reports each run with its task check", async () => {
		await run(config());
		const runs = events.filter((e) => e.type === "run");
		expect(runs).toHaveLength(12);
		expect(runs[0]).toMatchObject({
			index: 1,
			remaining: 11,
			status: "done",
			taskSuccess: false,
		});
		expect(events.at(-1)).toMatchObject({ type: "end" });
	});

	it("refuses attacked runs until the attack catalog exists", async () => {
		await expect(run(config("attacks: [A01]\n"))).rejects.toThrow(/US-20/);
	});
});

describe("resume", () => {
	it("picks up after a crash in the middle, without loss or duplicate", async () => {
		// The fifth model call crashes the process.
		let calls = 0;
		const crashing = () => {
			if (++calls === 5) throw new Error("power cut");
			return reply("done");
		};
		await expect(run(config(), crashing)).rejects.toThrow("power cut");
		expect(store.listRuns("test")).toHaveLength(4);

		events = [];
		const summary = await run(config());
		expect(summary).toEqual({ planned: 12, skipped: 4, done: 8, errors: 0 });
		expect(events[0]).toMatchObject({ type: "start", skipped: 4 });

		const keys = store.listRuns("test").map((r) => r.key);
		expect(keys).toHaveLength(12);
		expect(new Set(keys).size).toBe(12);
	});

	it("drops the run in flight when aborted, and reruns it on resume", async () => {
		const controller = new AbortController();
		const aborting = (_: string, n: number) => {
			if (n === 3) {
				controller.abort(new Error("emergency stop"));
				throw new ProviderError("aborted", "aborted");
			}
			return reply("done");
		};
		const summary = await run(config(), aborting, {
			signal: controller.signal,
		});
		expect(summary).toMatchObject({ done: 2, stopped: "emergency stop" });
		expect(store.listRuns("test")).toHaveLength(2);
		expect(log.at(-1)).toBe("unload gemma");

		const resumed = await run(config());
		expect(resumed).toMatchObject({ skipped: 2, done: 10 });
	});

	it("does nothing for a finished campaign", async () => {
		await run(config());
		log = [];
		const summary = await run(config());
		expect(summary).toEqual({ planned: 12, skipped: 12, done: 0, errors: 0 });
		expect(log).toEqual([]);
	});

	it("refuses a changed config under the same id", async () => {
		await run(config());
		await expect(run({ ...config(), runs: 20 })).rejects.toThrow(
			CampaignMismatchError,
		);
	});
});

describe("stop flag", () => {
	it("stops between runs when the flag is set", async () => {
		let seen = 0;
		const summary = await run(config(), undefined, {
			beforeRun: async () => {
				if (++seen === 3) store.requestStop("VRAM at 94 °C");
			},
		});
		expect(summary).toMatchObject({ done: 3, stopped: "VRAM at 94 °C" });
		expect(events).toContainEqual({ type: "stop", reason: "VRAM at 94 °C" });
	});

	it("clears a stale flag when a campaign starts", async () => {
		store.requestStop("old stop");
		const summary = await run(config());
		expect(summary.stopped).toBeUndefined();
		expect(summary.done).toBe(12);
	});
});

describe("technical failures", () => {
	const timeout = () => {
		throw new ProviderError("timeout", "no reply within 120000 ms");
	};

	it("retries, then succeeds", async () => {
		let calls = 0;
		const flaky = () => {
			if (++calls === 1) timeout();
			return reply("done");
		};
		const summary = await run(config(), flaky);
		expect(summary.errors).toBe(0);
		expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
	});

	it("saves the run as an error after the last try, and goes on", async () => {
		const sleeps: number[] = [];
		const summary = await run(
			config(),
			(model, n) => (model === "gemma" && n <= 3 ? timeout() : reply("ok")),
			{
				retryDelayMs: 1000,
				sleep: async (ms) => {
					sleeps.push(ms);
				},
			},
		);
		expect(sleeps).toEqual([1000, 2000]);
		expect(summary).toMatchObject({ done: 11, errors: 1 });
		const [error] = store.listRuns("test", { status: "error" });
		expect(error).toMatchObject({
			key: "gemma|T1|-|1",
			error: "timeout: no reply within 120000 ms",
		});
	});

	it("stops at once on a refused request, and saves nothing", async () => {
		let calls = 0;
		const summary = await run(config(), () => {
			calls++;
			throw new ProviderError(
				"http",
				"Ollama returned 404: model not found\n",
				{
					status: 404,
				},
			);
		});
		expect(calls).toBe(1);
		expect(summary).toMatchObject({
			done: 0,
			errors: 0,
			stopped: "http: Ollama returned 404: model not found",
		});
		expect(store.listRuns("test")).toEqual([]);
	});

	it("retries a server error, then saves it as a run error", async () => {
		const summary = await run(config(), (model, n) =>
			model === "gemma" && n <= 3
				? (() => {
						throw new ProviderError("http", "Ollama returned 500", {
							status: 500,
						});
					})()
				: reply("ok"),
		);
		expect(summary).toMatchObject({ errors: 1, done: 11 });
	});

	it("stops the campaign when Ollama stays out of reach, saving nothing", async () => {
		let calls = 0;
		const summary = await run(config(), () => {
			calls++;
			throw new ProviderError("network", "Cannot reach Ollama");
		});
		expect(calls).toBe(3);
		expect(summary.stopped).toBe("network: Cannot reach Ollama");
		expect(store.listRuns("test")).toEqual([]);

		// Back up: resume runs everything.
		const resumed = await run(config());
		expect(resumed).toMatchObject({ skipped: 0, done: 12 });
	});

	it("lets a bug through: it is not a technical failure", async () => {
		await expect(
			run(config(), () => {
				throw new TypeError("undefined is not a function");
			}),
		).rejects.toThrow(TypeError);
		expect(store.listRuns("test")).toEqual([]);
	});
});
