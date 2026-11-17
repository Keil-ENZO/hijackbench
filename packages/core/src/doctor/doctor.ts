// The doctor: checks the machine before a campaign, DEC-06. Every failed
// check says what to do.
//
// The container has no nvidia-smi. The GPU is seen through the exporter's
// file, which reads the card, and through Ollama: a loaded model tells
// how much of it sits in VRAM. nvidia-smi is used when it is there, out of
// Docker. Nothing gets loaded: the doctor never heats the card.

import { readFileSync } from "node:fs";
import type { CampaignConfig } from "../config/campaign.ts";
import { readVram, type Thresholds } from "../thermal/thermal.ts";
import {
	type InstalledModel,
	type OllamaClient,
	OllamaUnreachableError,
	sameModel,
} from "./models.ts";

export type CheckStatus = "ok" | "warn" | "fail";

export type Check = {
	name: string;
	status: CheckStatus;
	detail: string;
	// What to do, on a warning or a failure.
	fix?: string;
};

export type DoctorInput = {
	version: string;
	base: { path: string } & ({ campaigns: number } | { error: string });
	ollama: OllamaClient;
	vramFile: string;
	// The GPU as nvidia-smi names it, undefined when it is not there.
	gpuName?: string;
	// A campaign file, when one is given: parsed, or why not.
	campaign?: { source: string } & (
		| { config: CampaignConfig }
		| { error: string }
	);
	thresholds: Thresholds;
	read?: (file: string) => string;
	now?: number;
};

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export async function runDoctor(input: DoctorInput): Promise<Check[]> {
	const read = input.read ?? ((file: string) => readFileSync(file, "utf8"));
	const now = input.now ?? Date.now();
	const checks: Check[] = [];
	const config =
		input.campaign && "config" in input.campaign
			? input.campaign.config
			: undefined;

	// The install: the base a campaign would write to.
	const { base } = input;
	if ("error" in base)
		checks.push({
			name: "hijackbench",
			status: "fail",
			detail: `version ${input.version}, cannot open the base at ${base.path}: ${base.error}`,
			fix: "Check HIJACKBENCH_DATA and the rights on that directory.",
		});
	else
		checks.push({
			name: "hijackbench",
			status: base.campaigns > 0 ? "ok" : "warn",
			detail: `version ${input.version}, base ${base.path}, ${base.campaigns} campaign${base.campaigns === 1 ? "" : "s"}`,
			...(base.campaigns === 0 && {
				fix: "No campaign in this base. If you expected some, run the same Docker setup as the campaigns: the base lives in its data volume.",
			}),
		});

	// Ollama, then what it has.
	let installed: InstalledModel[] | undefined;
	try {
		const version = await input.ollama.version();
		installed = await input.ollama.installed();
		checks.push({
			name: "Ollama",
			status: "ok",
			detail: `${version} at ${input.ollama.baseUrl}`,
		});
	} catch (error) {
		checks.push({
			name: "Ollama",
			status: "fail",
			detail: errorText(error),
			fix:
				error instanceof OllamaUnreachableError
					? "Start Ollama on the host, or point OLLAMA_URL to it."
					: "Ollama answered oddly: check its logs, then update it.",
		});
	}
	if (installed) {
		const withTools = installed.filter((m) => m.tools).length;
		checks.push({
			name: "Models",
			status: withTools > 0 ? "ok" : "fail",
			detail: `${installed.length} installed, ${withTools} with tool support`,
			...(withTools === 0 && {
				fix: "Pull a model with tool support: ollama pull <model>. hijackbench models lists them.",
			}),
		});
	}

	// The thermal probe, and the GPU behind it.
	let junction: number | undefined;
	try {
		const vram = readVram(input.vramFile, now, read);
		const hot = vram >= input.thresholds.pauseAt;
		checks.push({
			name: "Thermal probe",
			status: hot ? "warn" : "ok",
			detail: `VRAM ${vram} °C, from ${input.vramFile}`,
			...(hot && {
				fix: `Over ${input.thresholds.pauseAt} °C: a campaign would wait for ${input.thresholds.resumeAt} °C first. Check the card's fans.`,
			}),
		});
		const match = read(input.vramFile).match(
			/^gputemps_junction_celsius\{[^}]*\} (\d+(?:\.\d+)?)$/m,
		);
		junction = match ? Number(match[1]) : undefined;
	} catch (error) {
		const off = config?.thermal.enabled === false;
		checks.push({
			name: "Thermal probe",
			status: off ? "warn" : "fail",
			detail: errorText(error),
			fix: off
				? "The campaign disables the thermal guard: fine on a machine without the 3090, never for a long run."
				: "Start gputemps-exporter on the host, or set HIJACKBENCH_VRAM_FILE to its file.",
		});
	}
	checks.push(await gpuCheck(input, junction));

	if (input.campaign) checks.push(...campaignChecks(input.campaign, installed));
	return checks;
}

async function gpuCheck(
	input: DoctorInput,
	junction: number | undefined,
): Promise<Check> {
	const seen =
		input.gpuName ??
		(junction !== undefined
			? `seen by gputemps-exporter, junction ${junction} °C`
			: undefined);
	if (!seen)
		return {
			name: "GPU",
			status: "fail",
			detail: "no GPU seen: no nvidia-smi, no reading from gputemps-exporter",
			fix: "Run nvidia-smi on the host to check the driver, then the thermal probe above.",
		};
	let loaded: Awaited<ReturnType<OllamaClient["loaded"]>>;
	try {
		loaded = await input.ollama.loaded();
	} catch {
		// Ollama is down: its own check says so.
		return { name: "GPU", status: "ok", detail: seen };
	}
	if (loaded.length === 0)
		return { name: "GPU", status: "ok", detail: `${seen}, no model loaded` };
	const split = loaded.filter((m) => m.sizeVram < m.size);
	const detail = `${seen}, loaded: ${loaded
		.map(
			(m) =>
				`${m.name} ${gib(m.size)}, ${Math.round((m.sizeVram / m.size) * 100)} % in VRAM`,
		)
		.join("; ")}`;
	return split.length === 0
		? { name: "GPU", status: "ok", detail }
		: {
				name: "GPU",
				status: "warn",
				detail,
				fix: `${split.map((m) => m.name).join(", ")} runs partly on the CPU, so runs are slow. Free VRAM, or pick a smaller quantization.`,
			};
}

function campaignChecks(
	campaign: NonNullable<DoctorInput["campaign"]>,
	installed: InstalledModel[] | undefined,
): Check[] {
	if ("error" in campaign)
		return [
			{
				name: "Campaign file",
				status: "fail",
				detail: campaign.error,
				fix: "Fix the file: each problem above names its field.",
			},
		];
	const { config } = campaign;
	const checks: Check[] = [
		{
			name: "Campaign file",
			status: config.thermal.enabled ? "ok" : "warn",
			detail: `${campaign.source}, campaign ${config.id}, ${config.models.length} model${config.models.length === 1 ? "" : "s"}`,
			...(!config.thermal.enabled && {
				fix: "The thermal guard is off: set thermal.enabled to true before a long run.",
			}),
		},
	];
	if (!installed) return checks;

	const find = (name: string) => installed.find((m) => sameModel(m.name, name));
	const missing = config.models.filter((m) => !find(m));
	const noTools = config.models.filter((m) => find(m)?.tools === false);
	const unknown = config.models.filter((m) => find(m)?.tools === null);
	if (missing.length > 0)
		checks.push({
			name: "Campaign models",
			status: "fail",
			detail: `not installed: ${missing.join(", ")}`,
			fix: missing.map((m) => `ollama pull ${m}`).join(" && "),
		});
	if (noTools.length > 0)
		checks.push({
			name: "Campaign models",
			status: "fail",
			detail: `no tool support: ${noTools.join(", ")}`,
			fix: "The agent needs tool calls: replace them in the campaign file.",
		});
	if (unknown.length > 0)
		checks.push({
			name: "Campaign models",
			status: "warn",
			detail: `tool support unknown: ${unknown.join(", ")}`,
			fix: "Ollama did not say. Update Ollama, or try one run first.",
		});
	if (checks.length === 1)
		checks.push({
			name: "Campaign models",
			status: "ok",
			detail: "all installed, all with tool support",
		});
	return checks;
}
