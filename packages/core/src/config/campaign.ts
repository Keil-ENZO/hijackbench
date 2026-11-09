// The campaign file: what to run, written in YAML so it can carry comments
// and live in the repo. The same file replays the same campaign.
//
// Errors name the line, the field and what to write instead: the file is
// edited by hand, often late at night before a long run.

import { readFileSync } from "node:fs";
import { isMap, LineCounter, parseDocument } from "yaml";
import { z } from "zod";
import { DEFAULT_MAX_TURNS } from "../agent/loop.ts";
import { TASKS, type TaskId } from "../env/tasks.ts";

const TASK_IDS = TASKS.map((task) => task.id);

const unique = <T>(items: T[]) => new Set(items).size === items.length;

const Slug = z.string({ error: "must be text" }).regex(/^[a-z0-9][a-z0-9-]*$/, {
	error: 'use lowercase letters, digits and dashes, e.g. "reference-v0"',
});

const TaskIdSchema = z.enum(TASK_IDS as [TaskId, ...TaskId[]], {
	error: (issue) =>
		`unknown task ${JSON.stringify(issue.input)}, expected one of ${TASK_IDS.join(", ")}`,
});

// The attack catalog arrives with US-20: only the id format is checked here.
const AttackId = z.string({ error: "must be text" }).regex(/^A\d{2}$/, {
	error: 'an attack id looks like "A03"',
});

const listOf = <T extends z.ZodType>(item: T, what: string) =>
	z.array(item, { error: `must be a list of ${what}` }).refine(unique, {
		error: `lists the same ${what.replace(/s$/, "")} twice`,
	});

// A typo in a field name is an error, not a silently ignored field.
const strict = <T extends z.ZodRawShape>(shape: T) =>
	z.strictObject(shape, {
		error: (issue) =>
			issue.code === "unrecognized_keys"
				? `unknown field ${issue.keys.map((k) => JSON.stringify(k)).join(", ")}`
				: undefined,
	});

export const CampaignConfigSchema = strict({
	// Identifies the campaign in the base: `resume` finds it by this id.
	id: Slug,
	name: z.string({ error: "must be text" }).min(1, { error: "is empty" }),
	models: listOf(
		z.string({ error: "must be text" }).min(1, { error: "is empty" }),
		"Ollama model tags",
	).min(1, { error: "needs at least one model" }),
	// Reference runs, without attack. "all" for the eight tasks.
	tasks: z
		.preprocess(
			(tasks) => (tasks === "all" ? [...TASK_IDS] : tasks),
			z
				.array(TaskIdSchema, {
					error: 'must be "all" or a list of task ids such as [T1, T2]',
				})
				.refine(unique, { error: "lists the same task id twice" }),
		)
		.default([]),
	// Attacked runs. Each attack carries its own task.
	attacks: listOf(AttackId, "attack ids").default([]),
	// Runs per case: 20 is the minimum for useful Wilson intervals.
	runs: z
		.number({ error: "must be a number" })
		.int({ error: "must be a whole number" })
		.min(1, { error: "must be at least 1" })
		.max(1000, { error: "is over 1000, surely a typo" }),
	agent: strict({
		temperature: z
			.number({ error: "must be a number" })
			.min(0)
			.max(2)
			.default(0.7),
		maxTurns: z
			.number({ error: "must be a number" })
			.int()
			.min(1)
			.max(50)
			.default(DEFAULT_MAX_TURNS),
		maxTokens: z
			.number({ error: "must be a number" })
			.int()
			.positive()
			.optional(),
	}).prefault({}),
	ollama: strict({
		baseUrl: z
			.url({ error: "must be a URL such as http://localhost:11434" })
			.default("http://localhost:11434"),
		timeoutMs: z.number().int().positive().default(120_000),
	}).prefault({}),
	// GDDR6X thresholds in °C, from the J0 measure.
	thermal: strict({
		// false only on a machine without the 3090, e.g. to try a campaign.
		enabled: z.boolean({ error: "must be true or false" }).default(true),
		pauseAt: z.number().default(84),
		resumeAt: z.number().default(60),
		abortAt: z.number().default(90),
	})
		.prefault({})
		.refine((t) => t.resumeAt < t.pauseAt && t.pauseAt < t.abortAt, {
			error: "needs resumeAt < pauseAt < abortAt",
		}),
}).refine((c) => c.tasks.length + c.attacks.length > 0, {
	error: "runs nothing: add tasks, attacks, or both",
});

export type CampaignConfig = z.output<typeof CampaignConfigSchema>;

export class CampaignConfigError extends Error {
	override readonly name = "CampaignConfigError";
	readonly problems: string[];

	constructor(source: string, problems: string[]) {
		super(
			`${source} is not a valid campaign:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
		this.problems = problems;
	}
}

// Parses and validates a campaign file's text. `source` names the file in
// error messages.
export function parseCampaign(
	text: string,
	source = "campaign file",
): CampaignConfig {
	const lines = new LineCounter();
	const doc = parseDocument(text, { lineCounter: lines });

	if (doc.errors.length > 0)
		throw new CampaignConfigError(
			source,
			doc.errors.map((error) => {
				const at = error.linePos?.[0];
				// The first line of the message, without its own position.
				const message = (error.message.split("\n")[0] ?? "").replace(
					/ at line \d+, column \d+:?$/,
					"",
				);
				return `${at ? `line ${at.line}, ` : ""}invalid YAML, ${message}`;
			}),
		);
	if (!isMap(doc.contents))
		throw new CampaignConfigError(source, [
			"the file must be a map of fields, starting with id: and name:",
		]);

	const result = CampaignConfigSchema.safeParse(doc.toJS(), {
		reportInput: true,
	});
	if (result.success) return result.data;

	const lineOf = (path: PropertyKey[]) => {
		// Walk up until a node exists: a missing field points at its parent.
		for (let depth = path.length; depth >= 0; depth--) {
			const node = doc.getIn(path.slice(0, depth), true) as
				| { range?: [number, number, number] }
				| undefined;
			if (node?.range) return lines.linePos(node.range[0]).line;
		}
		return undefined;
	};

	throw new CampaignConfigError(
		source,
		result.error.issues.map((issue) => {
			const path = issue.path.filter(
				(p): p is string | number => typeof p !== "symbol",
			);
			const field = path.length > 0 ? path.join(".") : "campaign";
			const missing =
				issue.code === "invalid_type" && issue.input === undefined;
			const message = missing ? "is missing" : issue.message;
			// An unknown field points at itself, a campaign-wide rule at nothing.
			const unknown = issue.code === "unrecognized_keys";
			const line =
				missing || (path.length === 0 && !unknown)
					? undefined
					: lineOf(unknown ? [...path, issue.keys[0] ?? ""] : path);
			return `${line ? `line ${line}, ` : ""}${field}: ${message}`;
		}),
	);
}

export function loadCampaign(path: string): CampaignConfig {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new CampaignConfigError(path, [
			`cannot read the file: ${(error as Error).message}`,
		]);
	}
	return parseCampaign(text, path);
}
