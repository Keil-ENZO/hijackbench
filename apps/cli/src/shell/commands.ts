// The slash commands of the shell: one per CLI command, plus the shell's
// own. Built from the Commander program, so a new command shows up here
// without a line to add. DEC-07.

export type CommandMode =
	// Runs as a child process, its output in the log.
	| "capture"
	// Same, and it is a campaign: quitting the shell stops it first.
	| "campaign"
	// Takes the whole terminal, the shell steps aside until it ends.
	| "terminal";

export type SlashCommand = {
	name: string;
	// Arguments and options, as the help writes them.
	usage: string;
	description: string;
	// Undefined for the shell's own commands.
	mode?: CommandMode;
};

const MODES: Record<string, CommandMode> = {
	run: "campaign",
	resume: "campaign",
	annotate: "terminal",
};

export const SHELL_COMMANDS: SlashCommand[] = [
	{ name: "help", usage: "", description: "List the commands" },
	{ name: "quit", usage: "", description: "Leave the shell" },
];

export function slashCommands(
	commands: readonly {
		name(): string;
		usage(): string;
		description(): string;
	}[],
): SlashCommand[] {
	const cli = commands
		.filter((c) => c.name() !== "help")
		.map((c) => ({
			name: c.name(),
			usage: c.usage().replace(/^\[options\] ?/, ""),
			description: c.description(),
			mode: MODES[c.name()] ?? "capture",
		}));
	return [...cli, ...SHELL_COMMANDS];
}

// Splits a line like a shell would, quotes kept together:
// /stop "VRAM at 94 °C" → ["stop", "VRAM at 94 °C"].
export function tokenize(line: string): string[] {
	const tokens: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (const match of line.matchAll(re))
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
	return tokens;
}

export type Parsed =
	| { kind: "empty" }
	| { kind: "unknown"; name: string }
	| { kind: "command"; command: SlashCommand; args: string[] };

// The leading slash is optional: "status" works like "/status".
export function parseLine(
	line: string,
	commands: readonly SlashCommand[],
): Parsed {
	const [head, ...args] = tokenize(line.trim());
	if (!head) return { kind: "empty" };
	const name = head.replace(/^\//, "");
	const command = commands.find((c) => c.name === name);
	return command
		? { kind: "command", command, args }
		: { kind: "unknown", name };
}

// A line the menu offers. Picking it puts text in the prompt; a ready
// line runs on Enter, the others wait for what is missing.
export type Suggestion = {
	kind: "command" | "argument";
	text: string;
	label: string;
	detail: string;
	ready: boolean;
};

// The values an argument can take, with a word on each: campaign files
// for run, campaign ids for status. Empty for a command without one.
export type ArgumentSource = (
	command: string,
) => { value: string; detail: string }[];

// A required argument in the usage: completing the command is not enough.
const needsArgs = (command: SlashCommand) => command.usage.includes("<");

// The commands a partial first word could become, or the values its
// first argument could take. Nothing once a second argument starts.
export function complete(
	line: string,
	commands: readonly SlashCommand[],
	argumentsOf: ArgumentSource = () => [],
): Suggestion[] {
	if (line.startsWith("/") && !/\s/.test(line)) {
		const prefix = line.slice(1);
		return commands
			.filter((c) => c.name.startsWith(prefix))
			.map((c) => ({
				kind: "command",
				text: needsArgs(c) ? `/${c.name} ` : `/${c.name}`,
				label: `/${c.name} ${c.usage}`.trimEnd(),
				detail: c.description,
				ready: !needsArgs(c),
			}));
	}
	const match = line.match(/^\/?(\S+) (\S*)$/);
	if (!match) return [];
	const [, name = "", partial = ""] = match;
	if (!commands.some((c) => c.name === name)) return [];
	return argumentsOf(name)
		.filter((a) => a.value.includes(partial))
		.map((a) => ({
			kind: "argument",
			text: `/${name} ${a.value}`,
			label: a.value,
			detail: a.detail,
			ready: true,
		}));
}
