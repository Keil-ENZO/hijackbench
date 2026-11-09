import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgent } from "../agent/loop.ts";
import type { Trace } from "../agent/trace.ts";
import { createEnvironment } from "../env/environment.ts";
import { taskById } from "../env/tasks.ts";
import { callTools, createFakeProvider, reply } from "../providers/fake.ts";
import { openStore, type RunCoordinates, runKey, type Store } from "./store.ts";

const CANARY = "pwk_live_aaaaaaaaaaaaaaaaaaaaaaaa";
const CAMPAIGN = "c1";

async function makeTrace(): Promise<Trace> {
	const { trace } = await runAgent({
		provider: createFakeProvider(
			[callTools({ name: "read_emails" }), reply("Paul, Claire, Hugo.")],
			"gemma",
		),
		task: taskById("T1"),
		env: createEnvironment({ canary: CANARY }),
	});
	return trace;
}

const at = (
	repetition = 1,
	attackId: string | null = null,
): RunCoordinates => ({
	model: "gemma",
	taskId: "T1",
	attackId,
	repetition,
});

let dir: string;
let store: Store;
let trace: Trace;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "hijackbench-store-"));
	store = openStore(join(dir, "test.db"));
	store.createCampaign({ id: CAMPAIGN, name: "test", config: { runs: 20 } });
	trace = await makeTrace();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

// Drizzle wraps raw query errors: the SQLite message is in the cause.
const sqliteError = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		const cause = (error as Error).cause as Error | undefined;
		return cause?.message ?? (error as Error).message;
	}
	throw new Error("expected the query to fail");
};

const tables = (s: Store) =>
	s.db
		.all<{ name: string }>(
			sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`,
		)
		.map((row) => row.name);

describe("openStore", () => {
	it("creates the tables through the migrations", () => {
		expect(tables(store)).toEqual([
			"annotations",
			"campaigns",
			"control",
			"pauses",
			"runs",
			"traces",
			"verdicts",
		]);
	});

	it("reopens an existing base without losing data", () => {
		store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		store.close();
		store = openStore(join(dir, "test.db"));
		expect(store.listRuns(CAMPAIGN)).toHaveLength(1);
	});

	it("keeps the campaign config as JSON", () => {
		expect(store.getCampaign(CAMPAIGN)).toMatchObject({
			name: "test",
			config: { runs: 20 },
		});
	});
});

describe("saveRun", () => {
	it("stores a finished run and its trace", () => {
		const run = store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		expect(run).toMatchObject({
			key: "gemma|T1|-|1",
			status: "done",
			error: null,
			attackId: null,
		});
		expect(store.getTrace(run.id)).toEqual(trace);
	});

	it("stores a technical error without a trace", () => {
		const run = store.saveRun({
			campaignId: CAMPAIGN,
			...at(),
			error: "timeout after 3 tries",
			durationMs: 360_000,
		});
		expect(run).toMatchObject({ status: "error", durationMs: 360_000 });
		expect(store.getTrace(run.id)).toBeUndefined();
	});

	it("refuses a run already stored", () => {
		store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		expect(() =>
			store.saveRun({ campaignId: CAMPAIGN, ...at(), trace }),
		).toThrow(/UNIQUE/);
		expect(store.listRuns(CAMPAIGN)).toHaveLength(1);
	});

	it("writes nothing if the trace insert fails", () => {
		store.db.run(
			sql`CREATE TRIGGER boom BEFORE INSERT ON traces BEGIN SELECT RAISE(ABORT, 'boom'); END`,
		);
		expect(() =>
			store.saveRun({ campaignId: CAMPAIGN, ...at(), trace }),
		).toThrow(/boom/);
		expect(store.listRuns(CAMPAIGN)).toEqual([]);
	});

	it("refuses a trace filed under another model or task", () => {
		expect(() =>
			store.saveRun({ campaignId: CAMPAIGN, ...at(), model: "llama", trace }),
		).toThrow(/saved as llama/);
	});

	it("refuses an invalid trace", () => {
		const broken = { ...trace, version: 2 } as unknown as Trace;
		expect(() =>
			store.saveRun({ campaignId: CAMPAIGN, ...at(), trace: broken }),
		).toThrow();
	});

	it("refuses a run of an unknown campaign", () => {
		expect(() => store.saveRun({ campaignId: "nope", ...at(), trace })).toThrow(
			/FOREIGN KEY/,
		);
	});
});

describe("resume support", () => {
	it("lists the stored keys of a campaign, errors included", () => {
		store.createCampaign({ id: "c2", name: "other", config: {} });
		store.saveRun({ campaignId: CAMPAIGN, ...at(1), trace });
		store.saveRun({
			campaignId: CAMPAIGN,
			...at(2, "A03"),
			error: "x",
			durationMs: 1,
		});
		store.saveRun({ campaignId: "c2", ...at(3), trace });
		expect(store.storedKeys(CAMPAIGN)).toEqual(
			new Set([runKey(at(1)), runKey(at(2, "A03"))]),
		);
	});

	it("builds distinct keys for attack and reference runs", () => {
		expect(runKey(at(1, "A03"))).toBe("gemma|T1|A03|1");
		expect(runKey(at(1))).not.toBe(runKey(at(1, "A03")));
	});

	it("filters runs by status", () => {
		store.saveRun({ campaignId: CAMPAIGN, ...at(1), trace });
		store.saveRun({
			campaignId: CAMPAIGN,
			...at(2),
			error: "x",
			durationMs: 1,
		});
		expect(store.listRuns(CAMPAIGN, { status: "error" })).toHaveLength(1);
	});
});

describe("verdicts and annotations", () => {
	it("replaces the verdict when a run is judged again", () => {
		const { id } = store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		const base = { taskSuccess: true, reason: "r", judgeVersion: "1" };
		store.saveVerdict(id, { ...base, verdict: "partial" });
		store.saveVerdict(id, {
			...base,
			verdict: "resisted_success",
			judgeVersion: "2",
		});
		expect(store.getVerdict(id)).toMatchObject({
			verdict: "resisted_success",
			taskSuccess: true,
			judgeVersion: "2",
		});
	});

	it("keeps Enzo's annotation apart from the verdict", () => {
		const { id } = store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		store.saveAnnotation(id, { verdict: "compromised", note: "leak" });
		store.saveAnnotation(id, { verdict: "partial" });
		expect(store.getAnnotation(id)).toMatchObject({
			verdict: "partial",
			note: null,
		});
		expect(store.getVerdict(id)).toBeUndefined();
	});

	it("rejects an unknown verdict at the database level", () => {
		const { id } = store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		expect(
			sqliteError(() =>
				store.db.run(
					sql`INSERT INTO verdicts (run_id, verdict, task_success, reason, judge_version) VALUES (${id}, 'pwned', 1, 'r', '1')`,
				),
			),
		).toMatch(/CHECK/);
	});

	it("rejects an error run without a message", () => {
		expect(
			sqliteError(() =>
				store.db.run(
					sql`INSERT INTO runs (campaign_id, key, model, task_id, repetition, status, duration_ms) VALUES (${CAMPAIGN}, 'k', 'm', 'T1', 1, 'error', 0)`,
				),
			),
		).toMatch(/CHECK/);
	});

	it("deletes runs, traces and verdicts with their campaign", () => {
		const { id } = store.saveRun({ campaignId: CAMPAIGN, ...at(), trace });
		store.saveVerdict(id, {
			verdict: "partial",
			taskSuccess: false,
			reason: "r",
			judgeVersion: "1",
		});
		store.db.run(sql`DELETE FROM campaigns WHERE id = ${CAMPAIGN}`);
		expect(store.getRun(id)).toBeUndefined();
		expect(store.getTrace(id)).toBeUndefined();
		expect(store.getVerdict(id)).toBeUndefined();
	});
});

describe("stop flag", () => {
	it("is set, read and cleared", () => {
		expect(store.stopRequested()).toBeUndefined();
		store.requestStop("VRAM at 94 °C");
		expect(store.stopRequested()).toMatchObject({ reason: "VRAM at 94 °C" });
		store.clearStop();
		expect(store.stopRequested()).toBeUndefined();
	});

	it("is seen by another process on the same file", () => {
		const other = openStore(join(dir, "test.db"));
		try {
			other.requestStop();
			expect(store.stopRequested()).toMatchObject({
				reason: "stop requested",
			});
		} finally {
			other.close();
		}
	});
});
