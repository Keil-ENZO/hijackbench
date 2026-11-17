// The live panel at the top of the shell: the campaign running, or else
// the newest, in two lines.

import type { CampaignStatus, Thresholds } from "@hijackbench/core";
import pc from "picocolors";
import { formatDuration, percent } from "../display.ts";

const WIDTH = 20;

export function bar(done: number, total: number, width = WIDTH): string {
	const full = total > 0 ? Math.round((done / total) * width) : 0;
	return (
		"█".repeat(Math.min(full, width)) +
		"░".repeat(width - Math.min(full, width))
	);
}

export function panelLines(
	status: CampaignStatus | undefined,
	vram: number | undefined,
	thresholds: Thresholds,
): string[] {
	if (!status)
		return [
			"No campaign in the base yet.",
			pc.dim("Check the machine with /doctor, then /run <file>."),
		];

	const state =
		status.state === "running"
			? pc.green("running")
			: status.state === "stopped"
				? pc.yellow("stopped")
				: pc.green("done");
	const left =
		status.state === "running" && status.etaMs != null
			? ` · about ${formatDuration(status.etaMs)} left`
			: "";
	const first = `${pc.bold(status.id)} ${state} ${bar(status.stored, status.planned)} ${status.stored}/${status.planned} ${percent(status.stored, status.planned)}${left}`;

	const parts: string[] = [];
	if (vram === undefined) parts.push(pc.dim("VRAM ?"));
	else {
		const text = `VRAM ${vram} °C`;
		parts.push(
			vram >= thresholds.abortAt
				? pc.red(text)
				: vram >= thresholds.pauseAt
					? pc.yellow(text)
					: text,
		);
	}
	const run = status.current;
	if (run)
		parts.push(
			`${run.model} ${run.taskId}${run.attackId ? `+${run.attackId}` : ""} #${run.repetition} for ${formatDuration(run.forMs)}`,
		);
	parts.push(
		`task ok ${status.success}/${status.judged}`,
		`errors ${status.errors}`,
	);
	return [first, parts.join(" · ")];
}
