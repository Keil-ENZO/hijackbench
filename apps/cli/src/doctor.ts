// What `doctor` and `models` print.

import type { Check, InstalledModel, LoadedModel } from "@hijackbench/core";
import pc from "picocolors";

const MARK = {
	ok: pc.green("✓"),
	warn: pc.yellow("!"),
	fail: pc.red("✗"),
} as const;

// One line per check, its fix under it, then a verdict line.
export function renderChecks(checks: readonly Check[]): string {
	const width = Math.max(...checks.map((c) => c.name.length));
	// A long detail, like a campaign file's problems, stays in its column.
	const pad = " ".repeat(width + 4);
	const lines = checks.flatMap((check) => [
		`${MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail.replaceAll("\n", `\n${pad}`)}`,
		...(check.fix ? [`${pad}${pc.dim(`→ ${check.fix}`)}`] : []),
	]);
	const failed = checks.filter((c) => c.status === "fail").length;
	const warned = checks.filter((c) => c.status === "warn").length;
	lines.push(
		"",
		failed > 0
			? pc.red(
					`${failed} problem${failed === 1 ? "" : "s"} to fix before a campaign.`,
				)
			: warned > 0
				? pc.yellow(`Ready, with ${warned} warning${warned === 1 ? "" : "s"}.`)
				: pc.green("Ready for a campaign."),
	);
	return lines.join("\n");
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

// A table of the installed models: size, tools, and whether loaded.
export function renderModels(
	installed: readonly InstalledModel[],
	loaded: readonly LoadedModel[],
): string {
	if (installed.length === 0)
		return "No model installed. Pull one with: ollama pull <model>";
	const rows = installed.map((m) => {
		const live = loaded.find((l) => l.name === m.name);
		return [
			m.name,
			m.parameterSize ?? "?",
			m.quantization ?? "?",
			gb(m.size),
			m.tools === null ? "?" : m.tools ? "yes" : "no",
			live ? `${Math.round((live.sizeVram / live.size) * 100)} % in VRAM` : "",
		];
	});
	const header = ["MODEL", "PARAMS", "QUANT", "SIZE", "TOOLS", "LOADED"];
	const widths = header.map((h, i) =>
		Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
	);
	const line = (cells: string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	const withTools = installed.filter((m) => m.tools).length;
	return [
		pc.bold(line(header)),
		...rows.map(line),
		"",
		`${installed.length} models, ${withTools} with tool support. A campaign needs tool support.`,
	].join("\n");
}
