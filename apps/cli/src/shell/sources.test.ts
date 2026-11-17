import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEnvironment,
	createFakeProvider,
	JUDGE_VERSION,
	loadCampaign,
	openStore,
	reply,
	runAgent,
	type Store,
	taskById,
} from "@hijackbench/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { argumentSource, campaignFiles, campaignIds } from "./sources.ts";

const yaml = (id: string, runs = 2) => `id: ${id}
name: ${id} name
models: [m]
tasks: [T7]
runs: ${runs}
`;

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hijackbench-sources-"));
	store = openStore(":memory:");
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

// Stores the campaign of a file with `done` of its runs.
async function store_(file: string, done: number) {
	const config = loadCampaign(file);
	store.createCampaign({ id: config.id, name: config.name, config });
	const { trace } = await runAgent({
		provider: createFakeProvider([reply("3 emails")], "m"),
		task: taskById("T7"),
		env: createEnvironment({ canary: `pwk_live_${"a".repeat(24)}` }),
	});
	for (let repetition = 1; repetition <= done; repetition++) {
		const run = store.saveRun({
			campaignId: config.id,
			model: "m",
			taskId: "T7",
			attackId: null,
			repetition,
			trace,
		});
		store.saveVerdict(run.id, {
			verdict: "resisted_success",
			taskSuccess: true,
			reason: "ok",
			judgeVersion: JUDGE_VERSION,
		});
	}
}

describe("campaignFiles", () => {
	it("lists the files with their state: new, stopped, complete, invalid", async () => {
		const file = (name: string, text: string) => {
			writeFileSync(join(dir, name), text);
			return join(dir, name);
		};
		file("a-new.yaml", yaml("fresh"));
		await store_(file("b-half.yaml", yaml("half")), 1);
		await store_(file("c-done.yaml", yaml("done")), 2);
		file("d-bad.yaml", "id: Bad Id\n");
		file("notes.txt", "not a campaign");

		expect(campaignFiles(store, dir).map((f) => [f.value, f.detail])).toEqual([
			[join(dir, "a-new.yaml"), "new · fresh · fresh name"],
			[join(dir, "b-half.yaml"), "stopped at 1/2 runs · half · half name"],
			[
				join(dir, "c-done.yaml"),
				"complete, 2 runs: nothing to run · done · done name",
			],
			[join(dir, "d-bad.yaml"), expect.stringMatching(/^invalid: /)],
		]);
	});

	it("flags a file whose id is in the base with another config", async () => {
		const path = join(dir, "x.yaml");
		writeFileSync(path, yaml("same", 2));
		await store_(path, 2);
		writeFileSync(path, yaml("same", 5));
		expect(campaignFiles(store, dir)[0]?.detail).toContain(
			"another config, give it a new one",
		);
	});

	it("returns nothing for a missing directory", () => {
		expect(campaignFiles(store, join(dir, "absent"))).toEqual([]);
	});
});

describe("argumentSource", () => {
	it("gives files to run, ids to the commands that take one", async () => {
		const path = join(dir, "c.yaml");
		writeFileSync(path, yaml("c", 1));
		await store_(path, 1);
		const source = argumentSource(store, dir);
		expect(source("run").map((a) => a.value)).toEqual([path]);
		expect(source("status")).toEqual(campaignIds(store));
		expect(source("status")[0]).toEqual({
			value: "c",
			detail: "complete, 1 runs: nothing to run · c name",
		});
		expect(source("stop")).toEqual([]);
	});
});
