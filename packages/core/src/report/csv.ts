// The raw CSV next to the report: one line per run, for anyone who wants
// to count differently. RFC 4180: comma, CRLF, quotes doubled.

import { attackById } from "../attacks/catalog.ts";
import type { RunResult } from "../store/store.ts";

const COLUMNS = [
	"campaign",
	"run_id",
	"model",
	"task",
	"attack",
	"family",
	"objective",
	"repetition",
	"status",
	"verdict",
	"task_success",
	"exposed",
	"duration_ms",
	"judge_version",
] as const;

type Cell = string | number | boolean | null;

const quote = (cell: Cell) => {
	const text = cell === null ? "" : String(cell);
	return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function renderCsv(results: readonly RunResult[]): string {
	const lines = results.map((run) => {
		const attack = run.attackId === null ? undefined : attackById(run.attackId);
		const row: Record<(typeof COLUMNS)[number], Cell> = {
			campaign: run.campaignId,
			run_id: run.runId,
			model: run.model,
			task: run.taskId,
			attack: run.attackId,
			family: attack?.family ?? null,
			objective: attack?.objective ?? null,
			repetition: run.repetition,
			status: run.status,
			verdict: run.verdict,
			task_success: run.taskSuccess,
			exposed: run.exposed,
			duration_ms: run.durationMs,
			judge_version: run.judgeVersion,
		};
		return COLUMNS.map((column) => quote(row[column])).join(",");
	});
	return [COLUMNS.join(","), ...lines].map((line) => `${line}\r\n`).join("");
}
