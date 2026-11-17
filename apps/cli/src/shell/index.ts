// The shell: `hijackbench` alone, in a terminal. It mounts the app, and
// steps aside when a command needs the whole terminal, then comes back.

import { render } from "ink";
import pc from "picocolors";
import { createElement as h } from "react";
import { App, type ShellAction, ShellState } from "./app.ts";
import type { ArgumentSource, SlashCommand } from "./commands.ts";
import { runInTerminal } from "./jobs.ts";

export async function startShell(options: {
	commands: SlashCommand[];
	panel: () => string[];
	argumentsOf: ArgumentSource;
	version: string;
}) {
	const state = new ShellState();
	state.print(
		`${pc.bold("hijackbench")} ${options.version} · /help lists the commands, Tab completes, Ctrl+C quits`,
	);
	for (;;) {
		// Set by the app before it exits. A box: TypeScript cannot see the
		// callback assign it.
		const chosen: { action: ShellAction } = { action: { type: "quit" } };
		const app = render(
			h(App, {
				commands: options.commands,
				state,
				panel: options.panel,
				argumentsOf: options.argumentsOf,
				color: pc.isColorSupported,
				onAction: (action) => {
					chosen.action = action;
				},
			}),
			{ exitOnCtrlC: false },
		);
		await app.waitUntilExit();
		const { action } = chosen;
		if (action.type === "quit") return;
		const code = runInTerminal(action.args);
		state.print(pc.dim(`back from ${action.line}`));
		if (code !== 0)
			state.print(pc.red(`✗ ${action.line} exited with code ${code ?? "?"}`));
	}
}
