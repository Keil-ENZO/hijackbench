// What the CLI prints about a campaign: plain text builders, kept apart
// from the commands so they can be tested without a terminal.

import type { CampaignStatus, Tally, Thresholds } from "@hijackbench/core";
import pc from "picocolors";

// 45 s, 3 min 20 s, 1 h 05 min: no false precision on long waits.
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export const percent = (part: number, whole: number) =>
	whole > 0 ? `${Math.round((100 * part) / whole)} %` : "-";

// "18/20": tasks succeeded out of the runs judged.
const rate = (tally: Tally) =>
	tally.judged > 0 ? `${tally.success}/${tally.judged}` : "-";

export function vramLine(
	vram: number | undefined,
	thresholds: Thresholds,
): string {
	if (vram === undefined) return "VRAM: no reading on this machine";
	const text = `VRAM ${vram} °C`;
	const colored =
		vram >= thresholds.abortAt
			? pc.red(text)
			: vram >= thresholds.pauseAt
				? pc.yellow(text)
				: text;
	return `${colored} (pause at ${thresholds.pauseAt}, cut at ${thresholds.abortAt})`;
}

const STATE = {
	running: pc.green("running"),
	stopped: pc.yellow("stopped"),
	done: pc.green("done"),
} as const;

function table(rows: string[][]): string {
	const widths = rows[0]?.map((_, column) =>
		Math.max(...rows.map((row) => row[column]?.length ?? 0)),
	);
	return rows
		.map((row) =>
			row
				.map((cell, column) =>
					column === 0
						? cell.padEnd(widths?.[column] ?? 0)
						: cell.padStart(widths?.[column] ?? 0),
				)
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

export function renderStatus(
	status: CampaignStatus,
	vram: number | undefined,
	thresholds: Thresholds,
): string {
	const lines = [`${pc.bold(status.id)}  ${status.name}`];

	const progress = [
		STATE[status.state],
		`${status.stored}/${status.planned} runs`,
		percent(status.stored, status.planned),
	];
	if (status.state !== "done" && status.etaMs !== null)
		progress.push(`about ${formatDuration(status.etaMs)} left`);
	lines.push(progress.join(" · "));

	if (status.current)
		lines.push(
			`now: ${status.current.model} ${status.current.taskId}${status.current.attackId ? `+${status.current.attackId}` : ""} #${status.current.repetition}, for ${formatDuration(status.current.forMs)}`,
		);

	const { pauses, cuts, durationMs } = status.pauses;
	lines.push(
		`${vramLine(vram, thresholds)} · ${pauses} pauses, ${cuts} cuts, ${formatDuration(durationMs)} cooling`,
	);

	lines.push(
		"",
		"Tasks succeeded, out of the runs judged:",
		table([
			["", ...status.cases, "all", ""],
			...status.models.map((model) => [
				model.model,
				...status.cases.map((name) => {
					const tally = model.cases[name];
					return tally ? rate(tally) : "-";
				}),
				rate(model),
				percent(model.success, model.judged),
			]),
		]),
	);

	if (status.errors > 0)
		lines.push("", pc.red(`${status.errors} runs ended in a technical error.`));
	const unjudged = status.stored - status.judged;
	if (unjudged > 0)
		lines.push(
			"",
			`${unjudged} runs have no verdict yet: hijackbench judge ${status.id}`,
		);
	if (status.state === "stopped")
		lines.push("", `Resume with: hijackbench resume ${status.id}`);
	return lines.join("\n");
}
