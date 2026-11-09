#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type CampaignConfig,
	CampaignConfigError,
	CampaignConfigSchema,
	CampaignMismatchError,
	createOllamaProvider,
	loadCampaign,
	openStore,
	type RunnerEvent,
	runCampaign,
	VERSION,
} from "@hijackbench/core";
import { Command } from "commander";

// The base lives in HIJACKBENCH_DATA: /data in Docker, ./data otherwise.
function openBase() {
	const dir = process.env.HIJACKBENCH_DATA ?? "data";
	mkdirSync(dir, { recursive: true });
	return openStore(join(dir, "hijackbench.db"));
}

// Plain lines for now. The progress bar and ETA come with US-27.
function print(event: RunnerEvent) {
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

async function execute(config: CampaignConfig) {
	const store = openBase();
	// Ctrl+C stops cleanly: the run in flight is dropped, resume reruns it.
	const controller = new AbortController();
	const onSignal = () => controller.abort(new Error("interrupted"));
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		console.warn(
			"Warning: no automatic thermal pause yet (US-16). Watch the GDDR6X.",
		);
		const summary = await runCampaign({
			config,
			store,
			signal: controller.signal,
			providerFor: (model) =>
				createOllamaProvider({
					model,
					baseUrl: config.ollama.baseUrl,
					timeoutMs: config.ollama.timeoutMs,
				}),
			onEvent: print,
		});
		if (summary.stopped) process.exitCode = 130;
	} finally {
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
  $ ssh homelab-01 ~/Developer/hijackbench/bin/hijackbench stop`,
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

program.addHelpText(
	"after",
	`
Examples:
  $ hijackbench run campaigns/reference-v0.yaml
  $ hijackbench resume reference-v0
  $ hijackbench stop "VRAM at 94 °C"`,
);

await program.parseAsync();
