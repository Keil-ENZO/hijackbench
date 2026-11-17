#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
	AnnotationError,
	type CampaignConfig,
	CampaignConfigError,
	CampaignConfigSchema,
	CampaignMismatchError,
	type CompromiseRate,
	campaignStatus,
	compromiseRates,
	createOllamaClient,
	createOllamaProvider,
	createThermalGuard,
	DEFAULT_OLLAMA_URL,
	DEFAULT_THRESHOLDS,
	DEFAULT_VRAM_FILE,
	type DoctorInput,
	defaultCampaignId,
	JUDGE_VERSION,
	judgeCampaign,
	loadCampaign,
	loadReport,
	openSession,
	openStore,
	type RunnerEvent,
	readVram,
	renderCsv,
	renderMarkdown,
	runCampaign,
	runDoctor,
	type Store,
	VERDICTS,
	VERSION,
} from "@hijackbench/core";
import cliProgress from "cli-progress";
import { Command } from "commander";
import pc from "picocolors";
import { annotateSession, LABELS } from "./annotate.ts";
import { formatDuration, renderStatus } from "./display.ts";
import { renderChecks, renderModels } from "./doctor.ts";

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

// "7.1 % [4.7, 10.7] of 281": the rate, its 95 % Wilson interval, the runs.
function formatRate({ rate, interval, compromised, exposed }: CompromiseRate) {
	if (rate === null || !interval) return "no exposed run";
	const bounds = `[${(interval.low * 100).toFixed(1)}, ${(interval.high * 100).toFixed(1)}]`;
	return `${pct(rate)} ${bounds}, ${compromised} of ${exposed}`;
}

// The base lives in HIJACKBENCH_DATA: /data in Docker, ./data otherwise.
const basePath = () =>
	join(process.env.HIJACKBENCH_DATA ?? "data", "hijackbench.db");

function openBase() {
	mkdirSync(process.env.HIJACKBENCH_DATA ?? "data", { recursive: true });
	return openStore(basePath());
}

// Out of a campaign, Ollama is found through OLLAMA_URL.
const ollamaUrl = () => process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;

// The GPU as nvidia-smi names it. Undefined in Docker, where it is absent.
function gpuName(): string | undefined {
	try {
		const out = execFileSync(
			"nvidia-smi",
			["--query-gpu=name", "--format=csv,noheader"],
			{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
		);
		return out.trim().split("\n")[0] || undefined;
	} catch {
		return undefined;
	}
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
	.command("doctor")
	.description(
		"Check the install before a campaign: base, Ollama, models, thermal probe, GPU",
	)
	.argument("[file]", "a campaign file, to check it and its models too")
	.addHelpText(
		"after",
		`
Loads no model: it never heats the card.
Examples:
  $ hijackbench doctor
  $ hijackbench doctor campaigns/attacked-v0.yaml

Exit codes: 0 when ready, warnings included, 1 when something must be fixed.`,
	)
	.action(async (file: string | undefined) => {
		let base: DoctorInput["base"];
		try {
			const store = openBase();
			base = { path: basePath(), campaigns: store.listCampaigns().length };
			store.close();
		} catch (error) {
			base = { path: basePath(), error: (error as Error).message };
		}
		let campaign: DoctorInput["campaign"];
		if (file)
			try {
				campaign = { source: file, config: loadCampaign(file) };
			} catch (error) {
				campaign = { source: file, error: (error as Error).message };
			}
		const config =
			campaign && "config" in campaign ? campaign.config : undefined;
		const name = gpuName();
		const checks = await runDoctor({
			version: VERSION,
			base,
			ollama: createOllamaClient(config?.ollama.baseUrl ?? ollamaUrl()),
			vramFile: vramFile(),
			...(name && { gpuName: name }),
			...(campaign && { campaign }),
			thresholds: config?.thermal ?? DEFAULT_THRESHOLDS,
		});
		console.log(renderChecks(checks));
		if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
	});

program
	.command("models")
	.description("List the Ollama models, their tool support and what is loaded")
	.addHelpText(
		"after",
		`
A campaign needs models with tool support. Ollama is found through OLLAMA_URL,
${DEFAULT_OLLAMA_URL} by default.`,
	)
	.action(async () => {
		const ollama = createOllamaClient(ollamaUrl());
		try {
			const [installed, loaded] = await Promise.all([
				ollama.installed(),
				ollama.loaded(),
			]);
			console.log(renderModels(installed, loaded));
		} catch (error) {
			console.error(
				`${(error as Error).message}. Start Ollama, or point OLLAMA_URL to it.`,
			);
			process.exitCode = 1;
		}
	});

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
			const { judged, counts, unexposed } = judgeCampaign(store, id);
			console.log(`${judged} runs judged, judge v${JUDGE_VERSION}.`);
			const rates = new Map(
				compromiseRates(store.listVerdicts(id)).map((r) => [r.model, r]),
			);
			for (const [model, byVerdict] of Object.entries(counts)) {
				console.log(`\n${model}`);
				for (const verdict of VERDICTS)
					console.log(`  ${verdict.padEnd(18)} ${byVerdict[verdict]}`);
				const rate = rates.get(model);
				if (!rate) continue;
				console.log(`  ${"not exposed".padEnd(18)} ${unexposed[model] ?? 0}`);
				console.log(`  ${"compromise rate".padEnd(18)} ${formatRate(rate)}`);
			}
		} finally {
			store.close();
		}
	});

program
	.command("annotate")
	.description(
		"Show runs drawn from a campaign and record your own verdict, to calibrate the judge",
	)
	.argument("<id>", "campaign id, e.g. attacked-v0")
	.option(
		"-n, --size <runs>",
		"runs to draw, the same quota per verdict",
		"100",
	)
	.option("--seed <text>", "seed of the draw, the campaign id by default")
	.addHelpText(
		"after",
		`
Blind: the judge's verdict shows only after yours. Every answer is saved
at once. Run the same command again to resume: the same size and seed draw
the same runs, and the ones annotated are skipped.
Needs a terminal. From another machine:
  $ ssh -t enzo@homelab-01 '~/Developer/hijackbench/bin/hijackbench annotate attacked-v0'`,
	)
	.action(async (id: string, options: { size: string; seed?: string }) => {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			console.error("annotate needs a terminal. Over SSH, use ssh -t.");
			process.exit(1);
		}
		const store = openBase();
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			const session = openSession(store, id, {
				size: Number(options.size),
				...(options.seed !== undefined && { seed: options.seed }),
			});
			const quotas = Object.entries(session.quotas)
				.map(([verdict, n]) => `${n} ${LABELS[verdict as keyof typeof LABELS]}`)
				.join(", ");
			console.log(
				`${session.sample.length} runs drawn from ${id}: ${quotas}. ${session.sample.length - session.pending.length} annotated, ${session.pending.length} left.`,
			);
			if (session.pending.length === 0) return;
			// Ctrl+C ends the session like q: what is answered is saved.
			const quit = new Promise<"quit">((resolve) =>
				rl.once("SIGINT", () => resolve("quit")),
			);
			const result = await Promise.race([
				annotateSession(store, session, rl),
				quit,
			]);
			if (result === "quit") {
				console.log("\nStopped. Your answers are saved.");
				return;
			}
			console.log(
				`\n${result.annotated} annotated, ${result.agreed} agreeing with the judge, ${result.skipped} skipped, ${result.left} left in the sample.`,
			);
		} catch (error) {
			if (!(error instanceof AnnotationError)) throw error;
			console.error(error.message);
			process.exitCode = 1;
		} finally {
			rl.close();
			store.close();
		}
	});

program
	.command("report")
	.description(
		"Write the results report in Markdown, or the raw CSV, from an attacked campaign and its reference",
	)
	.argument("<id>", "attacked campaign id, e.g. attacked-v0")
	.requiredOption(
		"-r, --reference <id>",
		"reference campaign, same models without attack",
	)
	.option("--csv", "print the raw CSV, one line per run, instead")
	.option("-o, --out <dir>", "write report.md and runs.csv into this directory")
	.addHelpText(
		"after",
		`
Both campaigns must be judged by the current judge, in the same base.
Without --out, the report goes to stdout: that is how Docker writes it.
Examples:
  $ hijackbench report attacked-v0 -r reference-v0-r3 > reports/v0/report.md
  $ hijackbench report attacked-v0 -r reference-v0-r3 --csv > reports/v0/runs.csv
  $ node apps/cli/src/index.ts report attacked-v0 -r reference-v0-r3 -o reports/v0`,
	)
	.action(
		(
			id: string,
			options: { reference: string; csv?: boolean; out?: string },
		) => {
			const store = openBase();
			let built: ReturnType<typeof loadReport>;
			try {
				built = loadReport(store, id, options.reference);
			} catch (error) {
				console.error(error instanceof Error ? error.message : error);
				process.exit(1);
			} finally {
				store.close();
			}
			const markdown = renderMarkdown(built.report);
			const csv = renderCsv(built.results);
			if (!options.out) {
				process.stdout.write(options.csv ? csv : markdown);
				return;
			}
			mkdirSync(options.out, { recursive: true });
			writeFileSync(join(options.out, "report.md"), markdown);
			writeFileSync(join(options.out, "runs.csv"), csv);
			console.error(
				`Wrote ${join(options.out, "report.md")} and runs.csv, ${built.results.length} runs.`,
			);
		},
	);

program.addHelpText(
	"after",
	`
Examples:
  $ hijackbench doctor campaigns/reference-v0.yaml
  $ hijackbench run campaigns/reference-v0.yaml
  $ hijackbench status
  $ hijackbench resume reference-v0
  $ hijackbench judge reference-v0
  $ hijackbench report attacked-v0 -r reference-v0
  $ hijackbench annotate attacked-v0
  $ hijackbench stop "VRAM at 94 °C"`,
);

await program.parseAsync();
