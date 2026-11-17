// The shell's screen, in Ink: the log of what ran, then the live panel,
// the prompt and the command menu. No JSX: Node runs these sources as
// they are, and its type stripping does not transform JSX.

import { Box, Static, Text, useApp, useInput } from "ink";
import pc from "picocolors";
import { createElement as h, useEffect, useState } from "react";
import { complete, parseLine, type SlashCommand } from "./commands.ts";
import { type Job, startJob, stopJob } from "./jobs.ts";

export type Entry = { id: number; text: string };

// What outlives one mount of the app: annotate unmounts it to take the
// terminal, and the log, the history and the jobs must come back.
export class ShellState {
	log: Entry[] = [];
	// Entries already printed above the screen, never printed twice.
	printed = 0;
	history: string[] = [];
	jobs = new Map<number, Job>();
	private listeners = new Set<() => void>();

	print(text: string) {
		this.log.push({ id: this.log.length, text });
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
};

const help = (commands: readonly SlashCommand[]) => {
	const width = Math.max(
		...commands.map((c) => `/${c.name} ${c.usage}`.trimEnd().length),
	);
	return commands
		.map(
			(c) =>
				`  ${`/${c.name} ${c.usage}`.trimEnd().padEnd(width)}  ${pc.dim(c.description)}`,
		)
		.join("\n");
};

// A required argument in the usage: the menu completes, Enter waits.
const needsArgs = (command: SlashCommand) => command.usage.includes("<");

export function App({
	commands,
	state,
	panel,
	refreshMs = 2000,
	color,
	onAction,
	launch = startJob,
}: AppProps) {
	const { exit } = useApp();
	const [startAt] = useState(() => state.printed);
	const [, setTick] = useState(0);
	const [lines, setLines] = useState(panel);
	const [input, setInput] = useState("");
	const [selected, setSelected] = useState(0);
	// Index in the history while browsing it, null when typing.
	const [browsing, setBrowsing] = useState<number | null>(null);
	const [confirming, setConfirming] = useState(false);

	useEffect(() => state.subscribe(() => setTick((t) => t + 1)), [state]);
	useEffect(() => {
		const timer = setInterval(() => setLines(panel()), refreshMs);
		return () => clearInterval(timer);
	}, [panel, refreshMs]);

	const menu = complete(input, commands);
	const campaigns = [...state.jobs.values()].filter((j) => j.campaign);

	const leave = (action: ShellAction) => {
		state.printed = state.log.length;
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
		if (!line.trim()) return;
		if (state.history.at(-1) !== line) state.history.push(line);
		state.print(pc.dim(`> ${line}`));
		const parsed = parseLine(line, commands);
		if (parsed.kind === "empty") return;
		if (parsed.kind === "unknown") {
			state.print(`Unknown command /${parsed.name}. /help lists them.`);
			return;
		}
		const { command, args } = parsed;
		if (command.name === "help") return state.print(help(commands));
		if (command.name === "quit") return quit();
		if (command.mode === "terminal")
			return leave({ type: "terminal", line, args: [command.name, ...args] });
		const job = launch(line, [command.name, ...args], {
			campaign: command.mode === "campaign",
			color,
			onLine: (text) => state.print(text),
		});
		state.jobs.set(job.id, job);
		state.changed();
		void job.done.then((code) => {
			state.jobs.delete(job.id);
			if (code !== 0)
				state.print(pc.red(`✗ ${line} exited with code ${code ?? "?"}`));
			else state.changed();
			setLines(panel());
		});
	};

	useInput((key, special) => {
		if (confirming) {
			setConfirming(false);
			if (key.toLowerCase() !== "y") return;
			state.print("Stopping the campaign cleanly…");
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
			if (choice && input !== `/${choice.name}`) {
				if (needsArgs(choice)) setInput(`/${choice.name} `);
				else execute(`/${choice.name}`);
				return;
			}
			return execute(input);
		}
		if (special.tab) {
			const choice = menu[selected];
			if (choice) setInput(`/${choice.name} `);
			return;
		}
		if (special.upArrow || special.downArrow) {
			const step = special.upArrow ? -1 : 1;
			if (menu.length > 0) {
				setSelected((s) => (s + step + menu.length) % menu.length);
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
			setBrowsing(null);
		}
	});

	const running = [...state.jobs.values()];
	return h(
		Box,
		{ flexDirection: "column" },
		h(Static<Entry>, {
			items: state.log.slice(startAt),
			// biome-ignore lint/correctness/noChildrenProp: Static takes a render function, and its props type requires it there
			children: (entry: Entry) => h(Text, { key: entry.id }, entry.text),
		}),
		h(
			Box,
			{ borderStyle: "round", paddingX: 1, flexDirection: "column" },
			...lines.map((line, i) => h(Text, { key: i }, line)),
		),
		running.length > 0
			? h(
					Text,
					{ dimColor: true },
					`running: ${running.map((j) => j.line).join(", ")}`,
				)
			: null,
		confirming
			? h(
					Text,
					{ color: "yellow" },
					"A campaign is running. Stop it cleanly and quit? [y/N]",
				)
			: h(
					Text,
					null,
					pc.bold("> "),
					input || pc.dim("/help lists the commands"),
					pc.inverse(" "),
				),
		...menu.map((command, i) =>
			h(
				Text,
				{ key: command.name },
				i === selected
					? pc.cyan(`  /${command.name} ${command.usage}`.trimEnd())
					: `  /${command.name} ${command.usage}`.trimEnd(),
				`  ${pc.dim(command.description)}`,
			),
		),
	);
}
