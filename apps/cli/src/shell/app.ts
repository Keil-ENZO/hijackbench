// The shell's screen, in Ink, full screen like Claude Code: the live
// panel at the top, the log of what ran in blocks, then the prompt in its
// frame, the menu and a line of keys. No JSX: Node runs these sources as
// they are, and its type stripping does not transform JSX.

import { Box, Text, useApp, useInput, useStdout } from "ink";
import pc from "picocolors";
import { createElement as h, useEffect, useState } from "react";
import {
	type ArgumentSource,
	complete,
	parseLine,
	type SlashCommand,
} from "./commands.ts";
import { type Job, startJob, stopJob } from "./jobs.ts";
import { type Block, layoutLog } from "./log.ts";

// Lines of the menu on screen at once.
const MENU_LINES = 10;

// What outlives one mount of the app: annotate unmounts it to take the
// terminal, and the log, the history and the jobs must come back.
export class ShellState {
	blocks: Block[] = [];
	history: string[] = [];
	jobs = new Map<number, Job>();
	private listeners = new Set<() => void>();

	// A line or a few, outside any command.
	note(text: string) {
		this.blocks.push({
			id: this.blocks.length,
			kind: "note",
			title: "",
			lines: text.split("\n"),
			state: "ok",
		});
		this.changed();
	}

	start(title: string): Block {
		const block: Block = {
			id: this.blocks.length,
			kind: "command",
			title,
			lines: [],
			state: "running",
		};
		this.blocks.push(block);
		this.changed();
		return block;
	}

	append(block: Block, text: string) {
		block.lines.push(text);
		this.changed();
	}

	finish(block: Block, code: number | null) {
		block.state = code === 0 ? "ok" : "failed";
		block.code = code;
		this.changed();
	}

	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	changed() {
		for (const listener of this.listeners) listener();
	}
}

export type ShellAction =
	| { type: "quit" }
	| { type: "terminal"; line: string; args: string[] };

export type Launch = typeof startJob;

export type AppProps = {
	commands: SlashCommand[];
	state: ShellState;
	// The panel's lines, read again every refreshMs.
	panel: () => string[];
	refreshMs?: number;
	color: boolean;
	onAction: (action: ShellAction) => void;
	launch?: Launch;
	argumentsOf?: ArgumentSource;
};

const help = (commands: readonly SlashCommand[]) => {
	const width = Math.max(
		...commands.map((c) => `/${c.name} ${c.usage}`.trimEnd().length),
	);
	return commands
		.map(
			(c) =>
				`${`/${c.name} ${c.usage}`.trimEnd().padEnd(width)}  ${pc.dim(c.description)}`,
		)
		.join("\n");
};

const KEYS =
	"/ commands · Tab completes · ↑↓ history · PgUp PgDn scroll · Ctrl+C quits";

export function App({
	commands,
	state,
	panel,
	refreshMs = 2000,
	color,
	onAction,
	launch = startJob,
	argumentsOf,
}: AppProps) {
	const { exit } = useApp();
	// A terminal in practice: it has a size.
	const stdout = useStdout().stdout as NodeJS.WriteStream;
	const [size, setSize] = useState(() => ({
		columns: stdout.columns || 80,
		rows: stdout.rows || 24,
	}));
	// Lines scrolled up from the bottom of the log, 0 to follow it.
	const [scroll, setScroll] = useState(0);
	const [, setTick] = useState(0);
	const [lines, setLines] = useState(panel);
	const [input, setInput] = useState("");
	const [selected, setSelected] = useState(0);
	// Whether the arrows moved in the menu: Enter then takes that line.
	const [picked, setPicked] = useState(false);
	// Index in the history while browsing it, null when typing.
	const [browsing, setBrowsing] = useState<number | null>(null);
	const [confirming, setConfirming] = useState(false);

	useEffect(() => state.subscribe(() => setTick((t) => t + 1)), [state]);
	useEffect(() => {
		const resize = () =>
			setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
		stdout.on("resize", resize);
		return () => {
			stdout.off("resize", resize);
		};
	}, [stdout]);
	useEffect(() => {
		const timer = setInterval(() => setLines(panel()), refreshMs);
		return () => clearInterval(timer);
	}, [panel, refreshMs]);

	// No menu while browsing the history: the arrows stay on it.
	const menu = browsing === null ? complete(input, commands, argumentsOf) : [];
	const campaigns = [...state.jobs.values()].filter((j) => j.campaign);

	const leave = (action: ShellAction) => {
		onAction(action);
		exit();
	};

	const quit = () => {
		if (campaigns.length > 0) setConfirming(true);
		else {
			for (const job of state.jobs.values()) job.child.kill();
			leave({ type: "quit" });
		}
	};

	const execute = (line: string) => {
		setInput("");
		setBrowsing(null);
		setSelected(0);
		setPicked(false);
		setScroll(0);
		if (!line.trim()) return;
		if (state.history.at(-1) !== line) state.history.push(line);
		const parsed = parseLine(line, commands);
		if (parsed.kind === "empty") return;
		if (parsed.kind === "unknown") {
			state.note(pc.red(`Unknown command /${parsed.name}. /help lists them.`));
			return;
		}
		const { command, args } = parsed;
		if (command.name === "help") {
			const block = state.start(line);
			state.append(block, help(commands));
			state.finish(block, 0);
			return;
		}
		if (command.name === "quit") return quit();
		if (command.mode === "terminal")
			return leave({ type: "terminal", line, args: [command.name, ...args] });
		const block = state.start(line);
		const job = launch(line, [command.name, ...args], {
			campaign: command.mode === "campaign",
			color,
			// The log's indent and padding take 6 columns.
			columns: size.columns - 6,
			onLine: (text) => state.append(block, text),
		});
		state.jobs.set(job.id, job);
		state.changed();
		void job.done.then((code) => {
			state.jobs.delete(job.id);
			state.finish(block, code);
			setLines(panel());
		});
	};

	useInput((key, special) => {
		if (confirming) {
			setConfirming(false);
			if (key.toLowerCase() !== "y") return;
			state.note(pc.yellow("Stopping the campaign cleanly…"));
			void Promise.all(campaigns.map(stopJob)).then(() => {
				for (const job of state.jobs.values()) job.child.kill();
				leave({ type: "quit" });
			});
			return;
		}
		if (special.ctrl && key === "c") {
			if (input) setInput("");
			else quit();
			return;
		}
		if (special.return) {
			const choice = menu[selected];
			// An argument menu under "/status " must not swallow a plain
			// /status: its line is taken once picked or partly typed.
			const take =
				choice && (choice.kind === "command" || picked || !input.endsWith(" "));
			if (!choice || !take) return execute(input);
			if (choice.ready) return execute(choice.text);
			setInput(choice.text);
			setSelected(0);
			return;
		}
		if (special.pageUp || special.pageDown) {
			const page = Math.max(logHeight - 2, 1);
			const most = Math.max(log.length - logHeight, 0);
			setScroll((s) =>
				Math.min(Math.max(s + (special.pageUp ? page : -page), 0), most),
			);
			return;
		}
		if (special.tab) {
			const choice = menu[selected];
			if (choice) {
				setInput(choice.text.endsWith(" ") ? choice.text : `${choice.text} `);
				setSelected(0);
				setPicked(false);
			}
			return;
		}
		if (special.upArrow || special.downArrow) {
			const step = special.upArrow ? -1 : 1;
			if (menu.length > 0) {
				setSelected((s) => (s + step + menu.length) % menu.length);
				setPicked(true);
				return;
			}
			const { history } = state;
			if (history.length === 0) return;
			const at =
				browsing === null
					? special.upArrow
						? history.length - 1
						: null
					: browsing + step;
			if (at === null || at >= history.length) {
				setBrowsing(null);
				setInput("");
			} else {
				const index = Math.max(0, at);
				setBrowsing(index);
				setInput(history[index] ?? "");
			}
			return;
		}
		if (special.escape) {
			setInput("");
			setSelected(0);
			return;
		}
		if (special.backspace || special.delete) {
			setInput((s) => s.slice(0, -1));
			setSelected(0);
			setPicked(false);
			return;
		}
		if (key && !special.ctrl && !special.meta) {
			// A paste comes in one piece: each line ends like on Enter.
			const lines = key.split(/\r\n|\r|\n/);
			if (lines.length > 1) {
				const last = lines.pop() ?? "";
				for (const [i, line] of lines.entries())
					execute(i === 0 ? input + line : line);
				setInput(last);
				return;
			}
			setInput((s) => s + key);
			setSelected(0);
			setPicked(false);
			setBrowsing(null);
		}
	});

	// The screen, top to bottom. The log takes what the rest leaves.
	const shown = menu.slice(0, MENU_LINES);
	const fixed =
		lines.length +
		2 +
		3 +
		shown.length +
		(menu.length > MENU_LINES ? 1 : 0) +
		1 +
		(confirming ? 1 : 0);
	const logHeight = Math.max(size.rows - fixed, 3);
	const log = layoutLog(state.blocks, size.columns - 2);
	const end = log.length - scroll;
	const visible = log.slice(Math.max(end - logHeight, 0), end);
	const above = Math.max(end - logHeight, 0);
	if (above > 0) visible[0] = pc.dim(`↑ ${above} more lines, PgUp to scroll`);

	const running = state.jobs.size;
	return h(
		Box,
		{ flexDirection: "column", height: size.rows, width: size.columns },
		h(
			Box,
			{
				borderStyle: "round",
				borderColor: "cyan",
				paddingX: 1,
				flexDirection: "column",
				flexShrink: 0,
			},
			...lines.map((line, i) =>
				h(Text, { key: i, wrap: "truncate-end" }, line),
			),
		),
		h(
			Box,
			{
				flexDirection: "column",
				height: logHeight,
				justifyContent: "flex-end",
				paddingX: 1,
				flexShrink: 0,
			},
			...visible.map((line, i) =>
				h(Text, { key: i, wrap: "truncate-end" }, line || " "),
			),
		),
		confirming
			? h(
					Text,
					{ color: "yellow" },
					"A campaign is running. Stop it cleanly and quit? [y/N]",
				)
			: null,
		h(
			Box,
			{
				borderStyle: "round",
				borderColor: confirming ? "yellow" : "gray",
				paddingX: 1,
				flexShrink: 0,
			},
			h(
				Text,
				null,
				pc.bold("> "),
				input || pc.dim("Type / for the commands"),
				pc.inverse(" "),
			),
		),
		...shown.map((choice, i) =>
			h(
				Text,
				{ key: choice.text, wrap: "truncate-end" },
				i === selected ? pc.cyan(`  ${choice.label}`) : `  ${choice.label}`,
				`  ${pc.dim(choice.detail)}`,
			),
		),
		menu.length > MENU_LINES
			? h(
					Text,
					{ dimColor: true },
					`  … ${menu.length - MENU_LINES} more, type to narrow`,
				)
			: null,
		h(
			Text,
			{ dimColor: true, wrap: "truncate-end" },
			`  ${running > 0 ? `${running} running · ` : ""}${KEYS}`,
		),
	);
}
