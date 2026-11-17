import { describe, expect, it } from "vitest";
import { type Block, layoutLog } from "./log.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colors
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (lines: string[]) => lines.map((l) => l.replace(ANSI, ""));

const block = (over: Partial<Block>): Block => ({
	id: 0,
	kind: "command",
	title: "/status",
	lines: [],
	state: "ok",
	...over,
});

describe("layoutLog", () => {
	it("draws a block: its header, its output indented, a blank line after", () => {
		expect(
			plain(
				layoutLog(
					[
						block({ lines: ["", "attacks-trial", "done · 15/15", ""] }),
						block({ id: 1, title: "/doctor", state: "running", lines: [] }),
					],
					80,
				),
			),
		).toEqual([
			"● /status",
			"  ⎿ attacks-trial",
			"    done · 15/15",
			"",
			"● /doctor  running…",
			"",
		]);
	});

	it("says how a command failed", () => {
		expect(plain(layoutLog([block({ state: "failed", code: 1 })], 80))[0]).toBe(
			"● /status  exit 1",
		);
	});

	it("wraps a long line under its indent", () => {
		const lines = plain(layoutLog([block({ lines: ["x".repeat(30)] })], 24));
		expect(lines.slice(1, 3)).toEqual([
			`  ⎿ ${"x".repeat(20)}`,
			`    ${"x".repeat(10)}`,
		]);
	});

	it("prints a note as it is", () => {
		expect(
			plain(
				layoutLog([block({ kind: "note", title: "", lines: ["hello"] })], 80),
			),
		).toEqual(["hello", ""]);
	});
});
