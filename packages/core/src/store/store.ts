// The store: every finished run goes to SQLite as soon as it ends, so a
// crash or a stop loses at most the run in flight.
//
// better-sqlite3 is synchronous: a run and its trace are written in one
// transaction that either lands whole or not at all. WAL mode lets the
// `stop` command write its flag while a campaign is running.

import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { type Trace, TraceSchema } from "../agent/trace.ts";
import * as schema from "./schema.ts";
import {
	annotations,
	campaigns,
	control,
	type PauseKind,
	pauses,
	runs,
	traces,
	type Verdict,
	verdicts,
} from "./schema.ts";

const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const STOP = "stop";

// Where a run sits in the campaign plan.
export type RunCoordinates = {
	model: string;
	taskId: string;
	// Null for a reference run, without attack.
	attackId: string | null;
	repetition: number;
};

export const runKey = (run: RunCoordinates) =>
	[run.model, run.taskId, run.attackId ?? "-", run.repetition].join("|");

export type NewRun = RunCoordinates & { campaignId: string } & (
		| { trace: Trace }
		// A technical failure after retries. A stopped run is not saved.
		| { error: string; durationMs: number }
	);

export type Campaign = typeof campaigns.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type StoredVerdict = typeof verdicts.$inferSelect;
export type Annotation = typeof annotations.$inferSelect;
export type StoredPause = typeof pauses.$inferSelect;

export type Store = ReturnType<typeof openStore>;

// ":memory:" for tests. Applies pending migrations on open.
export function openStore(path: string) {
	const sqlite = new Database(path);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	// The stop command and the runner may write at the same time.
	sqlite.pragma("busy_timeout = 5000");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: MIGRATIONS });

	return {
		db,

		createCampaign(campaign: { id: string; name: string; config: unknown }) {
			return db.insert(campaigns).values(campaign).returning().get();
		},

		getCampaign(id: string): Campaign | undefined {
			return db.select().from(campaigns).where(eq(campaigns.id, id)).get();
		},

		// Writes the run and its trace in one transaction. Throws if the run
		// is already stored: the runner must skip it.
		saveRun(run: NewRun): Run {
			const { campaignId, model, taskId, attackId, repetition } = run;
			const trace = "trace" in run ? TraceSchema.parse(run.trace) : undefined;
			if (trace && (trace.model !== model || trace.taskId !== taskId))
				throw new Error(
					`Trace of ${trace.model}/${trace.taskId} saved as ${model}/${taskId}`,
				);
			return db.transaction((tx) => {
				const saved = tx
					.insert(runs)
					.values({
						campaignId,
						key: runKey(run),
						model,
						taskId,
						attackId,
						repetition,
						status: trace ? "done" : "error",
						error: "error" in run ? run.error : null,
						durationMs: Math.round(
							trace
								? trace.durationMs
								: "durationMs" in run
									? run.durationMs
									: 0,
						),
					})
					.returning()
					.get();
				if (trace) tx.insert(traces).values({ runId: saved.id, trace }).run();
				return saved;
			});
		},

		// The keys of the runs already stored, errors included.
		storedKeys(campaignId: string): Set<string> {
			const rows = db
				.select({ key: runs.key })
				.from(runs)
				.where(eq(runs.campaignId, campaignId))
				.all();
			return new Set(rows.map((row) => row.key));
		},

		getRun(id: number): Run | undefined {
			return db.select().from(runs).where(eq(runs.id, id)).get();
		},

		listRuns(campaignId: string, filter: { status?: Run["status"] } = {}) {
			return db
				.select()
				.from(runs)
				.where(
					and(
						eq(runs.campaignId, campaignId),
						filter.status ? eq(runs.status, filter.status) : undefined,
					),
				)
				.orderBy(runs.id)
				.all();
		},

		// Validated on the way out too: a trace that no longer matches the
		// schema fails loudly instead of reaching the judge.
		getTrace(runId: number): Trace | undefined {
			const row = db
				.select({ trace: traces.trace })
				.from(traces)
				.where(eq(traces.runId, runId))
				.get();
			return row && TraceSchema.parse(row.trace);
		},

		// Judging again replaces the previous verdict.
		saveVerdict(
			runId: number,
			verdict: {
				verdict: Verdict;
				taskSuccess: boolean;
				reason: string;
				judgeVersion: string;
			},
		) {
			const values = { runId, ...verdict };
			db.insert(verdicts)
				.values(values)
				.onConflictDoUpdate({ target: verdicts.runId, set: verdict })
				.run();
		},

		getVerdict(runId: number): StoredVerdict | undefined {
			return db.select().from(verdicts).where(eq(verdicts.runId, runId)).get();
		},

		saveAnnotation(
			runId: number,
			annotation: { verdict: Verdict; note?: string | null },
		) {
			const values = {
				runId,
				verdict: annotation.verdict,
				note: annotation.note ?? null,
			};
			db.insert(annotations)
				.values(values)
				.onConflictDoUpdate({
					target: annotations.runId,
					set: { verdict: values.verdict, note: values.note },
				})
				.run();
		},

		getAnnotation(runId: number): Annotation | undefined {
			return db
				.select()
				.from(annotations)
				.where(eq(annotations.runId, runId))
				.get();
		},

		savePause(pause: {
			campaignId: string;
			kind: PauseKind;
			runKey: string;
			startedAt: string;
			durationMs: number;
			fromC: number;
			toC: number;
		}) {
			db.insert(pauses)
				.values({ ...pause, durationMs: Math.round(pause.durationMs) })
				.run();
		},

		listPauses(campaignId: string): StoredPause[] {
			return db
				.select()
				.from(pauses)
				.where(eq(pauses.campaignId, campaignId))
				.orderBy(pauses.id)
				.all();
		},

		// The emergency stop flag. Global: it stops whatever campaign runs.
		requestStop(reason = "stop requested") {
			const at = new Date().toISOString();
			db.insert(control)
				.values({ key: STOP, value: reason, updatedAt: at })
				.onConflictDoUpdate({
					target: control.key,
					set: { value: reason, updatedAt: at },
				})
				.run();
		},

		stopRequested(): { reason: string; at: string } | undefined {
			const row = db.select().from(control).where(eq(control.key, STOP)).get();
			return row && { reason: row.value, at: row.updatedAt };
		},

		clearStop() {
			db.delete(control).where(eq(control.key, STOP)).run();
		},

		close() {
			sqlite.close();
		},
	};
}
