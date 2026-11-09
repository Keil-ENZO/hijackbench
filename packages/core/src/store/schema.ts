// The database schema. One SQLite file per machine, no server.
//
// Change it here, then run `pnpm db:generate`: drizzle-kit writes the
// migration next to this file, and openStore() applies it.

import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

// The five verdicts of the taxonomy.
export const VERDICTS = [
	"compromised",
	"partial",
	"resisted_success",
	"resisted_failure",
	"technical_error",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const RUN_STATUSES = ["done", "error"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const oneOf = (column: string, values: readonly string[]) =>
	sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

const createdAt = () =>
	text("created_at")
		.notNull()
		.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`);

export const campaigns = sqliteTable("campaigns", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	// The campaign config as validated, so a campaign can be replayed.
	config: text("config", { mode: "json" }).notNull(),
	createdAt: createdAt(),
});

export const runs = sqliteTable(
	"runs",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => campaigns.id, { onDelete: "cascade" }),
		// Identifies the run in the campaign plan. The runner skips the keys
		// already stored: that is how a campaign resumes.
		key: text("key").notNull(),
		model: text("model").notNull(),
		taskId: text("task_id").notNull(),
		// Null for a reference run, without attack.
		attackId: text("attack_id"),
		repetition: integer("repetition").notNull(),
		status: text("status", { enum: RUN_STATUSES }).notNull(),
		// Set when status is "error": a technical failure, never a verdict.
		error: text("error"),
		durationMs: integer("duration_ms").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("runs_campaign_key").on(t.campaignId, t.key),
		index("runs_campaign_model_task").on(t.campaignId, t.model, t.taskId),
		check("runs_status", oneOf("status", RUN_STATUSES)),
		// An error has its message, a finished run has none.
		check(
			"runs_error",
			sql`(${t.status} = 'error') = (${t.error} IS NOT NULL)`,
		),
		check("runs_repetition", sql`${t.repetition} >= 1`),
	],
);

// Kept apart from runs: traces are large, most queries do not need them.
export const traces = sqliteTable("traces", {
	runId: integer("run_id")
		.primaryKey()
		.references(() => runs.id, { onDelete: "cascade" }),
	// The full trace, validated by TraceSchema on the way in and out.
	trace: text("trace", { mode: "json" }).notNull(),
});

// One verdict per run. Judging again replaces it.
export const verdicts = sqliteTable(
	"verdicts",
	{
		runId: integer("run_id")
			.primaryKey()
			.references(() => runs.id, { onDelete: "cascade" }),
		verdict: text("verdict", { enum: VERDICTS }).notNull(),
		taskSuccess: integer("task_success", { mode: "boolean" }).notNull(),
		reason: text("reason").notNull(),
		// The judge rules version, to know which runs to judge again.
		judgeVersion: text("judge_version").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		index("verdicts_verdict").on(t.verdict),
		check("verdicts_verdict", oneOf("verdict", VERDICTS)),
	],
);

// Enzo's verdict on a run, for the judge calibration of J7.
export const annotations = sqliteTable(
	"annotations",
	{
		runId: integer("run_id")
			.primaryKey()
			.references(() => runs.id, { onDelete: "cascade" }),
		verdict: text("verdict", { enum: VERDICTS }).notNull(),
		note: text("note"),
		createdAt: createdAt(),
	},
	() => [check("annotations_verdict", oneOf("verdict", VERDICTS))],
);

// Flags shared between processes. `hijackbench stop` sets "stop", the
// runner polls it.
export const control = sqliteTable("control", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updatedAt: text("updated_at").notNull(),
});

// Thermal pauses and cuts, with their temperatures: the report shows how
// much of a campaign the card spent cooling down.
export const PAUSE_KINDS = ["pause", "cut"] as const;
export type PauseKind = (typeof PAUSE_KINDS)[number];

export const pauses = sqliteTable(
	"pauses",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		campaignId: text("campaign_id")
			.notNull()
			.references(() => campaigns.id, { onDelete: "cascade" }),
		// pause: before a run, the card was at pauseAt or more.
		// cut: a run was aborted at abortAt, then the card cooled down.
		kind: text("kind", { enum: PAUSE_KINDS }).notNull(),
		// The run waiting, as its key in the plan.
		runKey: text("run_key").notNull(),
		startedAt: text("started_at").notNull(),
		durationMs: integer("duration_ms").notNull(),
		fromC: integer("from_c").notNull(),
		toC: integer("to_c").notNull(),
	},
	(t) => [
		index("pauses_campaign").on(t.campaignId),
		check("pauses_kind", oneOf("kind", PAUSE_KINDS)),
	],
);
