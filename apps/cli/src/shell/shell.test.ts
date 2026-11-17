import { EventEmitter } from "node:events";
import type { CampaignStatus } from "@hijackbench/core";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Launch } from "./app.ts";
import { App, type ShellAction, ShellState } from "./app.ts";
import {
	complete,
	parseLine,
	type SlashCommand,
	slashCommands,
	tokenize,
} from "./commands.ts";
import type { Job } from "./jobs.ts";
import { bar, panelLines } from "./panel.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colors
const plain = (text = "") => text.replace(/\x1b\[[0-9;]*m/g, "");

const fakeCommand = (name: string, usage = "", description = name) => ({
	name: () => name,
	usage: () => usage,
	description: () => description,
});

const COMMANDS = slashCommands([
	fakeCommand("doctor", "[options] [file]", "Check the install"),
	fakeCommand("run", "<file>", "Run a campaign"),
	fakeCommand("status", "[options] [id]", "Show a campaign"),
	fakeCommand("stop", "[reason]", "Emergency stop"),
	fakeCommand("annotate", "[options] <id>", "Annotate runs"),
	fakeCommand("help", "[command]"),
]);

describe("slash commands", () => {
	it("mirror the CLI commands, with the shell's own", () => {
		expect(COMMANDS.map((c) => [c.name, c.usage, c.mode])).toEqual([
			["doctor", "[file]", "capture"],
			["run", "<file>", "campaign"],
			["status", "[id]", "capture"],
			["stop", "[reason]", "capture"],
			["annotate", "<id>", "terminal"],
			["help", "", undefined],
			["quit", "", undefined],
		]);
	});

	it("split a line like a shell, quotes kept together", () => {
		expect(tokenize(`/stop "VRAM at 94 °C"  now`)).toEqual([
			"/stop",
			"VRAM at 94 °C",
			"now",
		]);
		expect(tokenize("/x 'a b'")).toEqual(["/x", "a b"]);
	});

	it("parse with or without the slash", () => {
		expect(parseLine("/status ref", COMMANDS)).toMatchObject({
			kind: "command",
			command: { name: "status" },
			args: ["ref"],
		});
		expect(parseLine("status", COMMANDS)).toMatchObject({ kind: "command" });
		expect(parseLine("/nope", COMMANDS)).toEqual({
			kind: "unknown",
			name: "nope",
		});
		expect(parseLine("   ", COMMANDS)).toEqual({ kind: "empty" });
	});

	it("complete the first word only", () => {
		expect(complete("/st", COMMANDS).map((c) => c.name)).toEqual([
			"status",
			"stop",
		]);
		expect(complete("/", COMMANDS)).toHaveLength(COMMANDS.length);
		expect(complete("/status ", COMMANDS)).toEqual([]);
		expect(complete("status", COMMANDS)).toEqual([]);
	});
});

const THRESHOLDS = { pauseAt: 84, resumeAt: 60, abortAt: 90 };

const status = (over: Partial<CampaignStatus> = {}): CampaignStatus => ({
	id: "attacked-v0",
	name: "attacked",
	state: "running",
	planned: 900,
	stored: 450,
	errors: 2,
	judged: 400,
	success: 300,
	spentMs: 0,
	etaMs: 2 * 3600_000,
	current: {
		model: "gemma4:26b",
		taskId: "T1",
		attackId: "A01",
		repetition: 3,
		forMs: 12_000,
	},
	pauses: { pauses: 0, cuts: 0, durationMs: 0 },
	cases: [],
	models: [],
	...over,
});

describe("panel", () => {
	it("draws the progress bar", () => {
		expect(bar(450, 900, 10)).toBe("█████░░░░░");
		expect(bar(0, 0, 4)).toBe("░░░░");
		expect(bar(12, 10, 4)).toBe("████");
	});

	it("shows the campaign running, the time left and the run in flight", () => {
		const [first, second] = panelLines(status(), 71, THRESHOLDS).map(plain);
		expect(first).toBe(
			"attacked-v0 running ██████████░░░░░░░░░░ 450/900 50 % · about 2 h 00 min left",
		);
		expect(second).toBe(
			"VRAM 71 °C · gemma4:26b T1+A01 #3 for 12 s · task ok 300/400 · errors 2",
		);
	});

	it("drops the time left once the campaign is over", () => {
		const [first] = panelLines(
			status({ state: "done", stored: 900, current: null }),
			undefined,
			THRESHOLDS,
		).map(plain);
		expect(first).not.toContain("left");
	});

	it("says what to do with an empty base", () => {
		expect(plain(panelLines(undefined, 50, THRESHOLDS).join("\n"))).toContain(
			"/doctor",
		);
	});
});

// A child process that never runs: the test ends it with finish().
function fakeLaunch() {
	const started: {
		line: string;
		args: string[];
		finish: (code: number) => void;
	}[] = [];
	const launch: Launch = (line, args, options) => {
		let finish: (code: number) => void = () => {};
		const done = new Promise<number | null>((resolve) => {
			finish = (code) => resolve(code);
		});
		const child = Object.assign(new EventEmitter(), {
			kill: vi.fn((signal?: string) => {
				if (signal === "SIGINT") finish(130);
				return true;
			}),
		});
		started.push({ line, args: [...args], finish });
		options.onLine(`started ${args.join(" ")}`);
		return {
			id: started.length,
			line,
			campaign: options.campaign,
			child,
			done,
		} as unknown as Job;
	};
	return { launch, started };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function mount() {
	const state = new ShellState();
	const actions: ShellAction[] = [];
	const { launch, started } = fakeLaunch();
	const app = render(
		h(App, {
			commands: COMMANDS as SlashCommand[],
			state,
			panel: () => ["PANEL"],
			color: false,
			onAction: (action) => actions.push(action),
			launch,
		}),
	);
	const type = async (...keys: string[]) => {
		for (const key of keys) {
			app.stdin.write(key);
			await tick();
		}
	};
	const screen = () => plain(app.frames.join("\n"));
	return { app, state, actions, started, type, screen };
}

describe("App", () => {
	let current: ReturnType<typeof mount> | undefined;
	afterEach(() => current?.app.unmount());

	it("shows the panel and opens the menu on a slash", async () => {
		current = mount();
		const { type, app } = current;
		expect(plain(app.lastFrame())).toContain("PANEL");
		await type("/", "s", "t");
		const frame = plain(app.lastFrame());
		expect(frame).toContain("/status [id]");
		expect(frame).toContain("/stop [reason]");
		expect(frame).not.toContain("/doctor");
	});

	it("completes with Tab, runs on Enter, logs the output", async () => {
		current = mount();
		const { type, started, screen } = current;
		await type("/sta", "\t", "ref", "\r");
		expect(started.map((s) => s.args)).toEqual([["status", "ref"]]);
		expect(screen()).toContain("started status ref");
	});

	it("runs a command without arguments straight from the menu", async () => {
		current = mount();
		const { type, started } = current;
		await type("/doc", "\r");
		expect(started.map((s) => s.args)).toEqual([["doctor"]]);
	});

	it("waits for the argument a command needs", async () => {
		current = mount();
		const { type, started, app } = current;
		await type("/ru", "\r");
		expect(started).toEqual([]);
		expect(plain(app.lastFrame())).toContain("> /run");
	});

	it("runs each line of a paste", async () => {
		current = mount();
		const { type, started } = current;
		await type("/status a\r/status b\r");
		expect(started.map((s) => s.args)).toEqual([
			["status", "a"],
			["status", "b"],
		]);
	});

	it("brings back past lines with the arrows", async () => {
		current = mount();
		const { type, app } = current;
		await type("/status a\r", "/status b\r", "\x1b[A", "\x1b[A");
		expect(plain(app.lastFrame())).toContain("> /status a");
		await type("\x1b[B");
		expect(plain(app.lastFrame())).toContain("> /status b");
	});

	it("names an unknown command and lists them on /help", async () => {
		current = mount();
		const { type, screen } = current;
		await type("/nope\r", "/help\r");
		expect(screen()).toContain("Unknown command /nope. /help lists them.");
		expect(screen()).toContain("/annotate <id>");
	});

	it("hands the terminal over for annotate", async () => {
		current = mount();
		const { type, actions } = current;
		await type("/annotate attacked-v0 -n 60\r");
		expect(actions).toEqual([
			{
				type: "terminal",
				line: "/annotate attacked-v0 -n 60",
				args: ["annotate", "attacked-v0", "-n", "60"],
			},
		]);
	});

	it("asks before quitting during a campaign, then stops it cleanly", async () => {
		current = mount();
		const { type, actions, started, app } = current;
		await type("/run c.yaml\r", "\x03");
		expect(plain(app.lastFrame())).toContain("A campaign is running");
		await type("n");
		expect(actions).toEqual([]);
		await type("\x03", "y");
		await tick();
		expect(started[0]?.args).toEqual(["run", "c.yaml"]);
		expect(actions).toEqual([{ type: "quit" }]);
	});

	it("quits at once without a campaign", async () => {
		current = mount();
		const { type, actions } = current;
		await type("/quit\r");
		expect(actions).toEqual([{ type: "quit" }]);
	});
});
