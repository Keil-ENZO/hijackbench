// The CLI as a user meets it: a process, its output, its exit code. See
// docs/cli-checklist.md.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "hijackbench-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Nothing on the machine is reached: no Ollama, no probe, a fresh base.
const ISOLATED = {
	HIJACKBENCH_DATA: join(dir, "data"),
	HIJACKBENCH_VRAM_FILE: join(dir, "absent.prom"),
	OLLAMA_URL: "http://127.0.0.1:9",
};

function cli(args: string[], env: Record<string, string> = {}) {
	const clean = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!["NO_COLOR", "FORCE_COLOR", "HIJACKBENCH_DEBUG"].includes(key),
		),
	);
	const result = spawnSync(process.execPath, [CLI, ...args], {
		env: { ...clean, ...ISOLATED, ...env },
		encoding: "utf8",
		timeout: 20_000,
	});
	return {
		status: result.status,
		out: result.stdout,
		err: result.stderr,
		all: result.stdout + result.stderr,
	};
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colors
const ANSI = /\x1b\[/;
const STACK = /^\s+at /m;

const COMMANDS = [
	"doctor",
	"models",
	"run",
	"resume",
	"stop",
	"status",
	"judge",
	"annotate",
	"report",
];

describe("help", () => {
	it.each(COMMANDS)("%s shows an example", (command) => {
		const { status, out } = cli([command, "--help"]);
		expect(status).toBe(0);
		expect(out).toMatch(/Examples?:\n {2}\$ hijackbench /);
	});

	it("documents the exit codes", () => {
		const { out } = cli(["--help"]);
		expect(out).toContain("Exit codes:");
		for (const code of ["0", "1", "2", "130"])
			expect(out).toMatch(new RegExp(`^ {2}${code} +\\S`, "m"));
	});
});

describe("exit codes", () => {
	it("exits 2 on a usage error", () => {
		expect(cli(["nope"]).status).toBe(2);
		expect(cli(["run"]).status).toBe(2);
		expect(cli(["status", "--nope"]).status).toBe(2);
	});

	it("exits 0 on --version", () => {
		expect(cli(["--version"]).status).toBe(0);
	});

	it("exits 1 when something must be fixed", () => {
		expect(cli(["doctor"]).status).toBe(1);
		expect(cli(["models"]).status).toBe(1);
		expect(cli(["status", "absent"]).status).toBe(1);
		expect(cli(["resume", "absent"]).status).toBe(1);
		expect(cli(["judge", "absent"]).status).toBe(1);
	});

	it("exits 0 when all is well", () => {
		expect(cli(["stop", "test"]).status).toBe(0);
	});
});

describe("errors", () => {
	it("shows a message, never a stack trace", () => {
		const bad = join(dir, "bad.yaml");
		writeFileSync(bad, "id: Bad Id\nruns: lots\n");
		const config = cli(["run", bad]);
		expect(config.status).toBe(1);
		expect(config.err).toContain("is not a valid campaign");
		expect(config.all).not.toMatch(STACK);

		// A bug, here a base that cannot be created: the message and a hint.
		const file = join(dir, "a-file");
		writeFileSync(file, "");
		const bug = cli(["judge", "x"], { HIJACKBENCH_DATA: file });
		expect(bug.status).toBe(1);
		expect(bug.err).toContain("HIJACKBENCH_DEBUG=1");
		expect(bug.all).not.toMatch(STACK);
	});

	it("shows the stack with HIJACKBENCH_DEBUG", () => {
		const file = join(dir, "a-file");
		writeFileSync(file, "");
		const { err } = cli(["judge", "x"], {
			HIJACKBENCH_DATA: file,
			HIJACKBENCH_DEBUG: "1",
		});
		expect(err).toMatch(STACK);
	});
});

describe("json", () => {
	it.each([
		["doctor", ["doctor", "--json"]],
		["models", ["models", "--json"]],
		["status", ["status", "--json"]],
	])("%s --json prints JSON only on stdout, or nothing", (_, args) => {
		const { out } = cli(args);
		if (out.trim()) expect(() => JSON.parse(out)).not.toThrow();
	});

	it("doctor --json says whether the machine is ready", () => {
		const report = JSON.parse(cli(["doctor", "--json"]).out);
		expect(report.ready).toBe(false);
		expect(report.checks.length).toBeGreaterThan(3);
	});
});

describe("colors", () => {
	it("none in a pipe", () => {
		expect(cli(["doctor"]).all).not.toMatch(ANSI);
	});

	it("none with NO_COLOR, even when forced", () => {
		expect(
			cli(["doctor"], { FORCE_COLOR: "1", NO_COLOR: "1" }).all,
		).not.toMatch(ANSI);
	});

	it("some when forced: the two tests above prove something", () => {
		expect(cli(["doctor"], { FORCE_COLOR: "1" }).all).toMatch(ANSI);
	});
});
