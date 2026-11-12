#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type CampaignConfig,
	CampaignConfigError,
	CampaignConfigSchema,
	CampaignMismatchError,
	campaignStatus,
	createOllamaProvider,
	createThermalGuard,
	DEFAULT_VRAM_FILE,
	defaultCampaignId,
	JUDGE_VERSION,
	judgeCampaign,
	loadCampaign,
	openStore,
	type RunnerEvent,
	readVram,
	runCampaign,
	type Store,
	VERDICTS,
	VERSION,
} from "@hijackbench/core";
import cliProgress from "cli-progress";
import { Command } from "commander";
import pc from "picocolors";
import { formatDuration, renderStatus } from "./display.ts";

// The base lives in HIJACKBENCH_DATA: /data in Docker, ./data otherwise.
function openBase() {
	const dir = process.env.HIJACKBENCH_DATA ?? "data";
	mkdirSync(dir, { recursive: true });
	return openStore(join(dir, "hijackbench.db"));
}

// One line per event: what a log file or a pipe gets.
function printLine(event: RunnerEvent) {
	switch (event.type) {
		case "start":
			console.log(
				`Campaign ${event.campaignId}: ${event.planned} runs planned, ${event.skipped} already done.`,
			);
			break;
		case "model":
			console.log(`\n${event.model}`);
			break;
		case "run": {
			const { run, status, taskSuccess, durationMs } = event;
			const result =
				status === "error" ? "ERROR" : taskSuccess ? "task ok" : "task failed";
			console.log(
				`  [${event.index}] ${run.taskId}${run.attackId ? `+${run.attackId}` : ""} #${run.repetition}  ${result}  ${(durationMs / 1000).toFixed(1)}s  (${event.remaining} left)`,
			);
			break;
		}
		case "retry":
			console.log(`  retry ${event.attempt}: ${event.error.slice(0, 200)}`);
			break;
		case "cut":
			console.log(
				`  CUT: VRAM at ${event.vram} °C, run dropped, cooling down before running it again`,
			);
			break;
		case "pause":
			console.log(
				`  ${event.kind === "cut" ? "cooled after cut" : "paused"}: ${event.fromC} → ${event.toC} °C in ${Math.round(event.durationMs / 1000)} s`,
			);
			break;
		case "stop":
			console.log(`\nStopped: ${event.reason}. Resume with the same id.`);
			break;
		case "end": {
			const s = event.summary;
			console.log(
				`\n${s.done} runs done, ${s.errors} errors, ${s.skipped} skipped, ${s.planned} planned.`,
			);
		}
	}
}

// The VRAM file is a machine setting, not part of the campaign.
const vramFile = () => process.env.HIJACKBENCH_VRAM_FILE ?? DEFAULT_VRAM_FILE;

// Undefined on a machine without the exporter: status still works there.
function vramNow(): number | undefined {
	try {
		return readVram(vramFile());
	} catch {
		return undefined;
	}
}

// In a terminal: one bar with the time left and the live temperature.
// Runs do not scroll by, only what needs an eye does: pauses, cuts,
// retries. `status` gives the detail from another terminal.
function progressBar(store: Store, config: CampaignConfig) {
	const multi = new cliProgress.MultiBar({
		format: `{bar} {value}/{total} · {percentage} % · {left} · {vram} · {now} · ok {ok}, failed {failed}, errors {errors}`,
		barCompleteChar: "█",
		barIncompleteChar: "░",
		barsize: 24,
		hideCursor: true,
		clearOnComplete: false,
		stopOnComplete: false,
		forceRedraw: true,
	});
	const state = { ok: 0, failed: 0, errors: 0, now: "starting", left: "" };
	const vram = () => {
		const c = vramNow();
		if (c === undefined) return "VRAM ?";
		const text = `VRAM ${c} °C`;
		return c >= config.thermal.abortAt
			? pc.red(text)
			: c >= config.thermal.pauseAt
				? pc.yellow(text)
				: text;
	};
	const payload = () => ({ ...state, vram: vram() });
	let bar: cliProgress.SingleBar | undefined;
	let timer: NodeJS.Timeout | undefined;
	const log = (line: string) => multi.log(`${line}\n`);
	const left = () => {
		const eta = campaignStatus(store, config.id)?.etaMs;
		if (eta == null) return "";
		return eta > 0 ? `about ${formatDuration(eta)} left` : "finished";
	};
	const close = () => {
		clearInterval(timer);
		multi.stop();
	};

	return {
		close,
		onWait(c: number) {
			state.now = `cooling down from ${c} °C`;
		},
		onEvent(event: RunnerEvent) {
			switch (event.type) {
				case "start":
					console.log(
						`Campaign ${pc.bold(event.campaignId)}: ${event.planned} runs planned, ${event.skipped} already done. Ctrl+C or \`hijackbench stop\` stops it cleanly.`,
					);
					state.left = left() || "estimating";
					bar = multi.create(event.planned, event.skipped, payload());
					// The temperature moves between two runs too.
					timer = setInterval(() => bar?.update(payload()), 1000);
					break;
				case "model":
					state.now = event.model;
					break;
				case "run": {
					if (event.status === "error") state.errors++;
					else if (event.taskSuccess) state.ok++;
					else state.failed++;
					const { run } = event;
					state.now = `${run.model} ${run.taskId}${run.attackId ? `+${run.attackId}` : ""} #${run.repetition}`;
					state.left = left();
					bar?.update(event.index, payload());
					break;
				}
				case "retry":
					log(`retry ${event.attempt}: ${event.error.slice(0, 200)}`);
					break;
				case "cut":
					log(
						pc.red(
							`CUT: VRAM at ${event.vram} °C, run dropped, cooling down before running it again`,
						),
					);
					break;
				case "pause":
					log(
						`${event.kind === "cut" ? "cooled after cut" : "paused"}: ${event.fromC} → ${event.toC} °C in ${Math.round(event.durationMs / 1000)} s`,
					);
					break;
				case "stop":
					close();
					console.log(
						`\n${pc.yellow("Stopped")}: ${event.reason}. Resume with: hijackbench resume ${config.id}`,
					);
					break;
				case "end": {
					close();
					const s = event.summary;
					console.log(
						`\n${s.done} runs done, ${s.errors} errors, ${s.skipped} skipped, ${s.planned} planned. Detail: hijackbench status ${config.id}`,
					);
				}
			}
		},
	};
}

async function execute(config: CampaignConfig) {
	const store = openBase();
	// Ctrl+C stops cleanly: the run in flight is dropped, resume reruns it.
	const controller = new AbortController();
	const onSignal = () => controller.abort(new Error("interrupted"));
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	// A bar in a terminal, plain lines in a pipe or a log file.
	const bar = process.stdout.isTTY ? progressBar(store, config) : undefined;
	let lastWait = 0;
	const thermal = config.thermal.enabled
		? createThermalGuard({
				thresholds: config.thermal,
				read: () => readVram(vramFile()),
				// One line a minute while the card cools down.
				onWait: (vram) => {
					if (bar) return bar.onWait(vram);
					if (Date.now() - lastWait < 60_000) return;
					lastWait = Date.now();
					console.log(
						`  waiting: VRAM at ${vram} °C, resumes at ${config.thermal.resumeAt} °C`,
					);
				},
			})
		: undefined;
	try {
		if (!thermal)
			console.warn("Warning: thermal guard disabled by the campaign config.");
		const summary = await runCampaign({
			...(thermal && { thermal }),
			config,
			store,
			signal: controller.signal,
			providerFor: (model) =>
				createOllamaProvider({
					model,
					baseUrl: config.ollama.baseUrl,
					timeoutMs: config.ollama.timeoutMs,
				}),
			onEvent: bar ? bar.onEvent : printLine,
		});
		if (summary.stopped) process.exitCode = 130;
	} finally {
		bar?.close();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		store.close();
	}
}

function fail(error: unknown): never {
	if (
		error instanceof CampaignConfigError ||
		error instanceof CampaignMismatchError
	) {
		console.error(error.message);
		process.exit(1);
	}
	throw error;
}

const program = new Command()
	.name("hijackbench")
	.description(
		"Measure how well tool-using AI agents resist indirect prompt injection.",
	)
	.version(VERSION)
	.showHelpAfterError();

program
	.command("run")
	.description("Run a campaign from its config file")
	.argument("<file>", "campaign file, e.g. campaigns/reference-v0.yaml")
	.addHelpText(
		"after",
		"\nIf the campaign is already in the base with the same config, its missing runs are run.",
	)
	.action(async (file: string) => {
		let config: CampaignConfig;
		try {
			config = loadCampaign(file);
		} catch (error) {
			fail(error);
		}
		await execute(config).catch(fail);
	});

program
	.command("resume")
	.description("Resume a stopped campaign, with the config stored in the base")
	.argument("<id>", "campaign id, as written in its file")
	.action(async (id: string) => {
		const store = openBase();
		const campaign = store.getCampaign(id);
		store.close();
		if (!campaign) {
			console.error(`No campaign "${id}" in the base. Start it with run.`);
			process.exit(1);
		}
		await execute(CampaignConfigSchema.parse(campaign.config)).catch(fail);
	});

program
	.command("stop")
	.description(
		"Emergency stop: cut the run in flight and unload the model, within seconds",
	)
	.argument(
		"[reason]",
		"kept in the log of the stopped campaign",
		"stop command",
	)
	.addHelpText(
		"after",
		`
The run in flight is dropped, never saved: resume runs it again.
From another machine:
  $ ssh enzo@homelab-01 '~/Developer/hijackbench/bin/hijackbench stop'`,
	)
	.action((reason: string) => {
		const store = openBase();
		try {
			store.requestStop(reason);
		} finally {
			store.close();
		}
		console.log(
			"Stop requested. A running campaign stops within a few seconds and unloads its model.",
		);
	});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

program
	.command("status")
	.description(
		"Show where a campaign stands: progress, time left, temperature, success rates",
	)
	.argument(
		"[id]",
		"campaign id, by default the one running, or else the newest",
	)
	.option("--json", "print the status as JSON, for scripts")
	.option("-w, --watch [seconds]", "refresh until Ctrl+C, every 2 s by default")
	.addHelpText(
		"after",
		`
Reads the base only: it works while a campaign runs, from another terminal.
Examples:
  $ hijackbench status
  $ hijackbench status reference-v0 --watch
  $ hijackbench status reference-v0 --json
From another machine:
  $ ssh enzo@homelab-01 '~/Developer/hijackbench/bin/hijackbench status'

Exit codes: 0 when the campaign is found, 1 when it is not.`,
	)
	.action(
		async (
			id: string | undefined,
			options: { json?: boolean; watch?: string | boolean },
		) => {
			const every =
				options.watch === undefined
					? undefined
					: options.watch === true
						? 2
						: Number(options.watch);
			if (every !== undefined && !(every >= 1)) {
				console.error("--watch takes a number of seconds, 1 or more.");
				process.exit(1);
			}
			const store = openBase();
			process.once("SIGINT", () => {
				store.close();
				process.exit(0);
			});
			try {
				for (;;) {
					const campaignId = id ?? defaultCampaignId(store);
					const status = campaignId && campaignStatus(store, campaignId);
					if (!status) {
						console.error(
							campaignId
								? `No campaign "${campaignId}" in the base.`
								: "No campaign in the base yet. Start one with: hijackbench run <file>",
						);
						process.exitCode = 1;
						return;
					}
					const vram = vramNow();
					const config = CampaignConfigSchema.parse(
						store.getCampaign(status.id)?.config,
					);
					if (options.json)
						console.log(JSON.stringify({ ...status, vram: vram ?? null }));
					else {
						// Redraw in place in a terminal, append in a pipe.
						if (every && process.stdout.isTTY)
							process.stdout.write("\x1b[H\x1b[2J");
						console.log(renderStatus(status, vram, config.thermal));
					}
					if (!every) return;
					await sleep(every * 1000);
				}
			} finally {
				store.close();
			}
		},
	);

program
	.command("judge")
	.description(
		"Give every run of a campaign its verdict, again if judged before",
	)
	.argument("<id>", "campaign id, as written in its file")
	.action((id: string) => {
		const store = openBase();
		try {
			if (!store.getCampaign(id)) {
				console.error(`No campaign "${id}" in the base.`);
				process.exit(1);
			}
			const { judged, counts } = judgeCampaign(store, id);
			console.log(`${judged} runs judged, judge v${JUDGE_VERSION}.`);
			for (const [model, byVerdict] of Object.entries(counts)) {
				console.log(`\n${model}`);
				for (const verdict of VERDICTS)
					console.log(`  ${verdict.padEnd(18)} ${byVerdict[verdict]}`);
			}
		} finally {
			store.close();
		}
	});

program.addHelpText(
	"after",
	`
Examples:
  $ hijackbench run campaigns/reference-v0.yaml
  $ hijackbench status
  $ hijackbench resume reference-v0
  $ hijackbench judge reference-v0
  $ hijackbench stop "VRAM at 94 °C"`,
);

await program.parseAsync();
