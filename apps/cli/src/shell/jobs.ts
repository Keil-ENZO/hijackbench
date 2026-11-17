// A slash command runs the CLI itself as a child process: the commands
// stay the only implementation, and several can run at once, a campaign
// and a status for instance.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";

export type Job = {
	id: number;
	line: string;
	campaign: boolean;
	child: ChildProcess;
	done: Promise<number | null>;
};

const argvOf = (args: readonly string[]) => [
	...process.execArgv,
	process.argv[1] ?? "",
	...args,
];

let next = 1;

// Lines of stdout and stderr go to onLine as they come. Colors stay on
// when the shell has them: the child has no terminal to tell.
export function startJob(
	line: string,
	args: readonly string[],
	options: {
		campaign: boolean;
		color: boolean;
		// Room for the output in the log, for commands that fit their tables.
		columns?: number;
		onLine: (text: string) => void;
	},
): Job {
	const child = spawn(process.execPath, argvOf(args), {
		env: {
			...process.env,
			...(options.color && !process.env.NO_COLOR && { FORCE_COLOR: "1" }),
			...(options.columns && { COLUMNS: String(options.columns) }),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const stream of [child.stdout, child.stderr]) {
		let rest = "";
		stream?.setEncoding("utf8");
		stream?.on("data", (chunk: string) => {
			const lines = (rest + chunk).split("\n");
			rest = lines.pop() ?? "";
			for (const text of lines) options.onLine(text);
		});
		stream?.on("end", () => {
			if (rest) options.onLine(rest);
		});
	}
	const done = new Promise<number | null>((resolve) => {
		child.on("close", (code) => resolve(code));
		child.on("error", (error) => {
			options.onLine(`Error: ${error.message}`);
			resolve(1);
		});
	});
	return { id: next++, line, campaign: options.campaign, child, done };
}

// A command that needs the terminal, like annotate: it gets it whole.
export function runInTerminal(args: readonly string[]): number | null {
	return spawnSync(process.execPath, argvOf(args), { stdio: "inherit" }).status;
}

// A campaign stops like on Ctrl+C: the run in flight is dropped, resume
// runs it again.
export function stopJob(job: Job): Promise<number | null> {
	job.child.kill("SIGINT");
	return job.done;
}
