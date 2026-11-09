import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CampaignConfig, parseCampaign } from "../config/campaign.ts";
import { ProviderError } from "../providers/errors.ts";
import { reply } from "../providers/fake.ts";
import type { ChatResponse, Provider } from "../providers/types.ts";
import { openStore, runKey, type Store } from "../store/store.ts";
import { createThermalGuard, ThermalReadError } from "../thermal/thermal.ts";
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

	it("cuts the request in flight when stop is called from another process", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hijackbench-stop-"));
		const file = join(dir, "test.db");
		const runner = openStore(file);
		const other = openStore(file);
		try {
			let requests = 0;
			// The second request hangs, like a model stuck on a long reply,
			// until the runner aborts it.
			const hanging: Provider = {
				name: "hanging",
				model: "gemma",
				chat: (_, { signal } = {}) =>
					++requests === 1
						? Promise.resolve(reply("done"))
						: new Promise((_, reject) => {
								setTimeout(() => other.requestStop("VRAM alert"), 20);
								signal?.addEventListener("abort", () =>
									reject(new ProviderError("aborted", "aborted")),
								);
							}),
				unload: async () => {
					log.push("unload gemma");
				},
			};
			const started = performance.now();
			const summary = await runCampaign({
				config: config(),
				store: runner,
				providerFor: () => hanging,
				stopPollMs: 10,
			});
			expect(performance.now() - started).toBeLessThan(1000);
			expect(summary).toMatchObject({ done: 1, stopped: "VRAM alert" });
			// The cut run is not saved, and the model left the VRAM.
			expect(runner.listRuns("test")).toHaveLength(1);
			expect(log).toEqual(["unload gemma"]);
		} finally {
			runner.close();
			other.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives the stop signal to the hook before each run", async () => {
		const summary = await run(config(), undefined, {
			stopPollMs: 5,
			// A thermal pause that waits until stopped.
			beforeRun: (_, signal) =>
				new Promise((_, reject) => {
					setTimeout(() => store.requestStop("stop during pause"), 10);
					signal.addEventListener("abort", () =>
						reject(new ProviderError("aborted", "aborted")),
					);
				}),
		});
		expect(summary).toMatchObject({ done: 0, stopped: "stop during pause" });
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

describe("thermal guard", () => {
	// A card whose temperature the test sets; reads during a pause drop it
	// by 10 °C each time.
	function card(initial: number) {
		const state = { vram: initial, cooling: false };
		const thermal = createThermalGuard({
			thresholds: { pauseAt: 84, resumeAt: 60, abortAt: 90 },
			read: () => {
				if (state.vram === -1) throw new ThermalReadError("exporter down");
				return state.vram;
			},
			sleep: async () => {
				state.vram -= 10;
			},
		});
		return { state, thermal };
	}

	// A provider that heats the card while it answers: the n-th call sets
	// the temperature from `heat`, then waits for the abort or answers.
	function heating(state: { vram: number }, heat: (n: number) => number) {
		let calls = 0;
		return (): Provider => ({
			name: "heating",
			model: "gemma",
			chat: (_, { signal } = {}) => {
				state.vram = heat(++calls);
				if (state.vram < 90) return Promise.resolve(reply("done"));
				return new Promise((_, reject) =>
					signal?.addEventListener("abort", () =>
						reject(new ProviderError("aborted", "aborted")),
					),
				);
			},
		});
	}

	const one = () =>
		parseCampaign(`id: test
name: Test
models: [gemma]
tasks: [T1]
runs: 2
`);

	it("pauses before a run and records the pause", async () => {
		const { state, thermal } = card(86);
		const summary = await run(one(), undefined, { thermal });
		expect(summary.done).toBe(2);
		expect(store.listPauses("test")).toMatchObject([
			{ kind: "pause", runKey: "gemma|T1|-|1", fromC: 86, toC: 56 },
		]);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "pause", kind: "pause", fromC: 86 }),
		);
		expect(state.vram).toBe(56);
	});

	it("cuts a run at abortAt, cools down, and runs it again", async () => {
		const { state, thermal } = card(50);
		const summary = await runCampaign({
			config: one(),
			store,
			thermal,
			thermalPollMs: 5,
			// First call overheats, the others stay cool.
			providerFor: heating(state, (n) => (n === 1 ? 91 : 70)),
			onEvent: (e) => events.push(e),
		});
		expect(summary).toMatchObject({ done: 2, errors: 0 });
		expect(summary.stopped).toBeUndefined();
		expect(events).toContainEqual({
			type: "cut",
			run: expect.objectContaining({ repetition: 1 }),
			vram: 91,
		});
		expect(store.listPauses("test")).toMatchObject([
			{ kind: "cut", runKey: "gemma|T1|-|1", fromC: 91, toC: 51 },
		]);
		// The cut run was saved once, from its second try.
		expect(store.listRuns("test").map((r) => r.key)).toEqual([
			"gemma|T1|-|1",
			"gemma|T1|-|2",
		]);
	});

	it("stops the campaign when the same run is cut twice", async () => {
		const { state, thermal } = card(50);
		const summary = await runCampaign({
			config: one(),
			store,
			thermal,
			thermalPollMs: 5,
			providerFor: heating(state, () => 92),
		});
		expect(summary.stopped).toMatch(
			/VRAM reached 92 °C twice on gemma\|T1\|-\|1/,
		);
		expect(store.listRuns("test")).toEqual([]);
	});

	it("stops when the reading is lost in the middle of a run", async () => {
		const { state, thermal } = card(50);
		const summary = await runCampaign({
			config: one(),
			store,
			thermal,
			thermalPollMs: 5,
			providerFor: heating(state, () => {
				// The exporter dies; the hanging reply waits for the abort.
				setTimeout(() => {
					state.vram = -1;
				}, 10);
				return 95;
			}),
		});
		expect(summary.stopped).toBe("lost the VRAM reading: exporter down");
		expect(store.listRuns("test")).toEqual([]);
	});

	it("refuses to start without a reading", async () => {
		const { thermal } = card(-1);
		await expect(run(one(), undefined, { thermal })).rejects.toThrow(
			/Cannot read the VRAM temperature.*thermal.enabled: false/,
		);
		expect(store.getCampaign("test")).toBeUndefined();
	});

	it("lets stop end a pause", async () => {
		const controller = new AbortController();
		const thermal = createThermalGuard({
			thresholds: { pauseAt: 84, resumeAt: 60, abortAt: 90 },
			read: () => 88,
			pollMs: 60_000,
		});
		setTimeout(() => controller.abort(new Error("stop during pause")), 10);
		const summary = await run(one(), undefined, {
			thermal,
			signal: controller.signal,
		});
		expect(summary).toMatchObject({ done: 0, stopped: "stop during pause" });
	});
});
