// The log of the shell, as blocks like in Claude Code: a command with its
// state, its output indented under it, a blank line between blocks.

import pc from "picocolors";
import wrapAnsi from "wrap-ansi";

export type BlockState = "running" | "ok" | "failed";

export type Block = {
	id: number;
	// A note has no command: the welcome line, an unknown command, /help.
	kind: "note" | "command";
	title: string;
	lines: string[];
	state: BlockState;
	code?: number | null;
};

const BULLET = "●";
const RESULT = "⎿";

function header(block: Block): string {
	const title = pc.bold(block.title);
	if (block.state === "running")
		return `${pc.yellow(BULLET)} ${title}  ${pc.dim("running…")}`;
	if (block.state === "failed")
		return `${pc.red(BULLET)} ${title}  ${pc.red(`exit ${block.code ?? "?"}`)}`;
	return `${pc.green(BULLET)} ${title}`;
}

// Blank lines at the edges of an output say nothing: the block has its own.
function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && !lines[start]?.trim()) start++;
	while (end > start && !lines[end - 1]?.trim()) end--;
	return lines.slice(start, end);
}

// Every block as screen lines, wrapped to the width: what the log shows.
export function layoutLog(blocks: readonly Block[], width: number): string[] {
	const wrap = (text: string, room: number) =>
		wrapAnsi(text, Math.max(room, 10), { hard: true, trim: false }).split("\n");
	const out: string[] = [];
	for (const block of blocks) {
		if (block.kind === "note") {
			for (const line of block.lines) out.push(...wrap(line, width));
		} else {
			out.push(...wrap(header(block), width));
			for (const [i, line] of trimBlank(block.lines).entries()) {
				const [first, ...rest] = wrap(line, width - 4);
				out.push(`${i === 0 ? pc.dim(`  ${RESULT} `) : "    "}${first ?? ""}`);
				for (const more of rest) out.push(`    ${more}`);
			}
		}
		out.push("");
	}
	return out;
}
