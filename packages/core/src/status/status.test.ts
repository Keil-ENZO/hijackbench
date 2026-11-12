import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCampaign } from "../config/campaign.ts";
import { reply } from "../providers/fake.ts";
import type { Provider } from "../providers/types.ts";
import { runCampaign } from "../runner/runner.ts";
import { openStore, type Store } from "../store/store.ts";
import { campaignStatus, defaultCampaignId } from "./status.ts";

const config = parseCampaign(`id: test
name: Test
models: [gemma, llama]
tasks: [T1, T2]
runs: 2
thermal: { enabled: false }`);

const provider = (model: string): Provider => ({
	name: "scripted",
	model,
	chat: async () => reply("done"),
});

let store: Store;
beforeEach(() => {
	store = openStore(":memory:");
});
afterEach(() => store.close());

// Runs the campaign and stops it after `count` runs.
async function runSome(count: number) {
	const controller = new AbortController();
	let seen = 0;
	await runCampaign({
		config,
		store,
		providerFor: provider,
		signal: controller.signal,
		onEvent: (event) => {
			if (event.type === "run" && ++seen === count) controller.abort();
		},
	});
}

describe("campaignStatus", () => {
	it("knows nothing of a campaign that is not in the base", () => {
		expect(campaignStatus(store, "nope")).toBeUndefined();
	});

	it("counts stored runs against the plan, per model and per case", async () => {
		await runSome(5);
		const status = campaignStatus(store, "test");
		expect(status).toMatchObject({
			state: "stopped",
			planned: 8,
			stored: 5,
			judged: 5,
			errors: 0,
			cases: ["T1", "T2"],
			current: null,
		});
		expect(status?.models.map((m) => [m.model, m.planned, m.stored])).toEqual([
			["gemma", 4, 4],
			["llama", 4, 1],
		]);
		expect(status?.models[1]?.cases).toMatchObject({
			T1: { planned: 2, stored: 1 },
			T2: { planned: 2, stored: 0 },
		});
	});

	it("is done when every planned run is stored", async () => {
		await runSome(99);
		expect(campaignStatus(store, "test")).toMatchObject({
			state: "done",
			stored: 8,
			etaMs: 0,
		});
	});

	it("has no estimate before the first run", () => {
		store.createCampaign({ id: "test", name: "Test", config });
		expect(campaignStatus(store, "test")).toMatchObject({
			state: "stopped",
			stored: 0,
			etaMs: null,
		});
	});

	it("estimates each model from its own runs, pauses included", () => {
		store.createCampaign({ id: "test", name: "Test", config });
		const error = (model: string, taskId: string, durationMs: number) =>
			store.saveRun({
				campaignId: "test",
				model,
				taskId,
				attackId: null,
				repetition: 1,
				error: "x",
				durationMs,
			});
		error("gemma", "T1", 10_000);
		error("gemma", "T2", 20_000);
		error("llama", "T1", 1_000);
		store.savePause({
			campaignId: "test",
			kind: "pause",
			runKey: "gemma|T2|-|1",
			startedAt: new Date().toISOString(),
			durationMs: 30_000,
			fromC: 84,
			toC: 60,
		});
		const status = campaignStatus(store, "test");
		// gemma: 60 s for 2 runs, 2 left. llama: 1 s for 1 run, 3 left.
		expect(status?.etaMs).toBe(2 * 30_000 + 3 * 1_000);
		expect(status?.spentMs).toBe(61_000);
		expect(status?.pauses).toEqual({ pauses: 1, cuts: 0, durationMs: 30_000 });
		expect(status?.errors).toBe(3);
	});

	it("a model without runs borrows the average of the others", () => {
		store.createCampaign({ id: "test", name: "Test", config });
		store.saveRun({
			campaignId: "test",
			model: "gemma",
			taskId: "T1",
			attackId: null,
			repetition: 1,
			error: "x",
			durationMs: 4_000,
		});
		expect(campaignStatus(store, "test")?.etaMs).toBe(7 * 4_000);
	});

	it("is running while the heartbeat is fresh, with the run in flight", () => {
		store.createCampaign({ id: "test", name: "Test", config });
		const now = Date.now();
		store.beat({
			campaignId: "test",
			runKey: "llama|T2|-|2",
			runStartedAt: new Date(now - 7_000).toISOString(),
		});
		expect(campaignStatus(store, "test", now)).toMatchObject({
			state: "running",
			current: { model: "llama", taskId: "T2", repetition: 2, forMs: 7_000 },
		});
		// A runner that died without a word stops beating.
		expect(campaignStatus(store, "test", now + 60_000)).toMatchObject({
			state: "stopped",
			current: null,
		});
	});

	it("the heartbeat of another campaign does not count", () => {
		store.createCampaign({ id: "test", name: "Test", config });
		store.beat({ campaignId: "other", runKey: null, runStartedAt: null });
		expect(campaignStatus(store, "test")?.state).toBe("stopped");
	});
});

describe("the runner", () => {
	it("judges each run as it ends and clears its heartbeat", async () => {
		await runSome(99);
		expect(store.listTaskSuccess("test").size).toBe(8);
		expect(store.heartbeat()).toBeUndefined();
	});
});

describe("defaultCampaignId", () => {
	it("is the running campaign, or else the newest", () => {
		expect(defaultCampaignId(store)).toBeUndefined();
		store.createCampaign({ id: "old", name: "Old", config });
		store.createCampaign({ id: "new", name: "New", config });
		expect(defaultCampaignId(store)).toBe("new");
		store.beat({ campaignId: "old", runKey: null, runStartedAt: null });
		expect(defaultCampaignId(store)).toBe("old");
	});
});
