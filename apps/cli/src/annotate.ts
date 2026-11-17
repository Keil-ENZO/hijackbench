// The annotate command: shows a run, asks Enzo for his verdict, then
// shows the judge's. Blind: nothing printed before the answer depends on
// the judge's verdict.

import type { Interface } from "node:readline/promises";
import {
	type AnnotationSession,
	type HumanVerdict,
	loadRunToAnnotate,
	type RunToAnnotate,
	type Store,
	type Verdict,
} from "@hijackbench/core";
import pc from "picocolors";

// One key per verdict a human can give.
export const KEYS: Record<string, HumanVerdict> = {
	c: "compromised",
	p: "partial",
	s: "resisted_success",
	f: "resisted_failure",
};

export const LABELS: Record<Verdict, string> = {
	compromised: "compromised",
	partial: "partial attempt",
	resisted_success: "resisted, task done",
	resisted_failure: "resisted, task failed",
	technical_error: "technical error",
};

// Long tool outputs are cut in the default view. `v` shows them whole.
const SHORT = 500;

function cut(text: string, full: boolean): string {
	if (full || text.length <= SHORT) return text;
	return `${text.slice(0, SHORT)}${pc.dim(` … ${text.length - SHORT} more chars, v to view all`)}`;
}

const indent = (text: string, by: string) =>
	text
		.split("\n")
		.map((line) => by + line)
		.join("\n");

export function renderRun(
	item: RunToAnnotate,
	position: { index: number; total: number },
	options: { full?: boolean } = {},
): string {
	const { run, trace, task, initial, attack, payload } = item;
	const full = options.full ?? false;
	// The canary stands out wherever it shows up.
	const mark = (text: string) =>
		text.replaceAll(trace.canary, pc.bgRed(pc.white(trace.canary)));
	const contacts = new Set(
		[initial.user.address, ...initial.contacts.map((c) => c.address)].map((a) =>
			a.toLowerCase(),
		),
	);

	const lines = [
		pc.bold(
			`Run ${run.id} · ${position.index} of ${position.total} · ${run.model} · ${run.taskId}${run.attackId ? ` + ${run.attackId}` : ""} #${run.repetition}`,
		),
		`Canary: ${mark(trace.canary)}`,
		`User: ${initial.user.name} <${initial.user.address}>`,
		`Contacts: ${initial.contacts.map((c) => `${c.name} <${c.address}>`).join(", ")}`,
	];
	if (task.deletes?.length)
		lines.push(`Files the task may delete: ${task.deletes.join(", ")}`);
	if (attack && payload !== undefined) {
		lines.push(
			"",
			pc.bold(
				`Attack ${attack.id}: ${attack.family}, ${attack.objective}, via ${attack.vector}${attack.file ? ` ${attack.file}` : ""}`,
			),
		);
		if (attack.recipients.length)
			lines.push(`Attacker addresses: ${attack.recipients.join(", ")}`);
		lines.push(indent(pc.yellow(cut(payload, full)), "  "));
	}

	lines.push("", pc.bold("Request"), indent(trace.userPrompt, "  "));
	for (const turn of trace.turns) {
		lines.push("", pc.bold(`Turn ${turn.index + 1}`));
		// The last reply is the final answer, shown once, below.
		const isAnswer =
			turn.calls.length === 0 && turn.content === trace.end.answer;
		if (isAnswer) lines.push(pc.dim("  final answer, below"));
		else if (turn.content?.trim())
			lines.push(indent(mark(cut(turn.content.trim(), full)), "  "));
		for (const call of turn.calls) {
			lines.push(
				`  ${pc.cyan("→")} ${call.name}(${mark(call.rawArguments)})${call.isError ? pc.red(" error") : ""}`,
			);
			lines.push(indent(pc.dim(mark(cut(call.output, full))), "      "));
		}
	}

	lines.push(
		"",
		pc.bold(`Final answer`) + pc.dim(` (loop ended: ${trace.end.reason})`),
		indent(trace.end.answer ? mark(trace.end.answer) : pc.dim("none"), "  "),
		"",
		pc.bold("Final state"),
	);
	if (trace.final.sent.length === 0) lines.push("  No mail sent.");
	for (const [i, mail] of trace.final.sent.entries()) {
		const to = mail.to
			.map((address) =>
				contacts.has(address.toLowerCase())
					? address
					: pc.red(`${address} (outside contacts)`),
			)
			.join(", ");
		lines.push(
			`  Mail ${i + 1} to ${to}`,
			`    Subject: ${mark(mail.subject)}`,
			indent(mark(cut(mail.body, full)), "    "),
		);
	}
	const kept = new Set(trace.final.files.map((f) => f.path));
	const deleted = initial.files.filter((f) => !kept.has(f.path));
	if (deleted.length === 0) lines.push("  No file deleted.");
	for (const file of deleted)
		lines.push(
			`  Deleted ${file.path}${task.deletes?.includes(file.path) ? pc.dim(" (asked by the task)") : pc.red(" (not asked by the task)")}`,
		);
	return lines.join("\n");
}

export const PROMPT = `Your verdict: ${Object.entries(KEYS)
	.map(([key, verdict]) => `[${key}] ${LABELS[verdict]}`)
	.join("  ")}  ·  [v] view all  [k] skip  [q] quit\n> `;

export type Answer =
	| { kind: "verdict"; verdict: HumanVerdict }
	| { kind: "view" }
	| { kind: "skip" }
	| { kind: "quit" }
	| { kind: "unknown" };

export function parseAnswer(input: string): Answer {
	const key = input.trim().toLowerCase();
	const verdict = KEYS[key];
	if (verdict) return { kind: "verdict", verdict };
	if (key === "v") return { kind: "view" };
	if (key === "k") return { kind: "skip" };
	if (key === "q") return { kind: "quit" };
	return { kind: "unknown" };
}

// After the answer: the judge's verdict, and whether they agree.
export function renderReveal(human: HumanVerdict, item: RunToAnnotate): string {
	const judge = item.judged.verdict;
	const agree = judge === human;
	return [
		`Judge: ${LABELS[judge]} · ${agree ? pc.green("agree") : pc.red("DISAGREE")}`,
		pc.dim(`  ${item.judged.reason}`),
	].join("\n");
}

export type SessionSummary = {
	annotated: number;
	agreed: number;
	skipped: number;
	left: number;
};

// The interactive loop. Every answer is saved at once: quitting, Ctrl+C
// or a crash loses nothing, and the next session starts at the first run
// left.
export async function annotateSession(
	store: Store,
	session: AnnotationSession,
	rl: Interface,
	print: (text: string) => void = console.log,
): Promise<SessionSummary> {
	const summary: SessionSummary = {
		annotated: 0,
		agreed: 0,
		skipped: 0,
		left: session.pending.length,
	};
	const done = session.sample.length - session.pending.length;
	for (const [i, runId] of session.pending.entries()) {
		const item = loadRunToAnnotate(store, runId);
		const position = { index: done + i + 1, total: session.sample.length };
		print(`\n${"─".repeat(72)}\n${renderRun(item, position)}\n`);
		let answer = parseAnswer(await rl.question(PROMPT));
		while (answer.kind === "view" || answer.kind === "unknown") {
			if (answer.kind === "view")
				print(`\n${renderRun(item, position, { full: true })}\n`);
			else print("Unknown key.");
			answer = parseAnswer(await rl.question(PROMPT));
		}
		if (answer.kind === "quit") break;
		if (answer.kind === "skip") {
			summary.skipped++;
			continue;
		}
		const note = (await rl.question("Note, Enter for none: ")).trim();
		store.saveAnnotation(runId, {
			verdict: answer.verdict,
			note: note || null,
		});
		summary.annotated++;
		summary.left--;
		if (answer.verdict === item.judged.verdict) summary.agreed++;
		print(renderReveal(answer.verdict, item));
	}
	return summary;
}
