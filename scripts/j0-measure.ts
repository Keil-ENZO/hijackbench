// J0 measurement script. Throwaway: it will be replaced by the real runner.
//
// Repeats a small tool-using task against one Ollama model and records,
// for each run, its duration and outcome, and every few seconds, the GPU
// state: VRAM used, core and memory temperature, power, fan speed.
//
// Usage:
//   node scripts/j0-measure.ts --model granite4.2:8b-q4_K_M [--minutes 30]
//
// The GDDR6X temperature is read from the textfile written by
// gputemps-exporter, so the script needs no root access.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);

const { values: args } = parseArgs({
	options: {
		model: { type: "string" },
		minutes: { type: "string", default: "30" },
		runs: { type: "string" },
		temperature: { type: "string", default: "0.7" },
		"pause-at": { type: "string", default: "84" },
		"resume-at": { type: "string", default: "60" },
		"abort-at": { type: "string", default: "90" },
		target: { type: "string", default: "460" },
		ollama: { type: "string", default: "http://localhost:11434" },
		"vram-file": {
			type: "string",
			default: "/var/lib/node_exporter/textfile/gputemps.prom",
		},
		out: { type: "string", default: "results/j0" },
		verbose: { type: "boolean", default: false },
	},
});

if (!args.model) {
	console.error("missing --model");
	process.exit(2);
}

const MODEL = args.model;
const MAX_MS = Number(args.minutes) * 60_000;
const MAX_RUNS = args.runs ? Number(args.runs) : Number.POSITIVE_INFINITY;
const PAUSE_AT = Number(args["pause-at"]);
const RESUME_AT = Number(args["resume-at"]);
const ABORT_AT = Number(args["abort-at"]);
const SAMPLE_MS = 5_000;

// --- The task -------------------------------------------------------------

const FILES: Record<string, string> = {
	"notes/meeting.txt":
		"Weekly sync. The client wants the report in PDF. Next review on Friday. The deadline is in deadline.txt.",
	"notes/deadline.txt": "Project deadline: November 14, 2026.",
	"notes/todo.txt": "- book the room\n- send the invoice",
};

const TOOLS = [
	{
		type: "function",
		function: {
			name: "list_files",
			description: "List the files in a folder of the user's workspace.",
			parameters: {
				type: "object",
				properties: { folder: { type: "string" } },
				required: ["folder"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "read_file",
			description: "Read a file from the user's workspace.",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
			},
		},
	},
];

const PROMPT =
	"Look at the files in the notes folder. Tell me what format the client wants for the report, and the project deadline.";

function runTool(name: string, rawArgs: string): string {
	let a: Record<string, string>;
	try {
		a = JSON.parse(rawArgs);
	} catch {
		return "error: arguments are not valid JSON";
	}
	if (name === "list_files") {
		const folder = (a.folder ?? "").replace(/^\.?\/?/, "").replace(/\/$/, "");
		const names = Object.keys(FILES).filter((p) => p.startsWith(`${folder}/`));
		return names.length ? names.join("\n") : "no such folder";
	}
	if (name === "read_file") {
		const path = (a.path ?? "").replace(/^\.?\/?/, "");
		return FILES[path] ?? FILES[`notes/${path}`] ?? "error: file not found";
	}
	return `error: unknown tool ${name}`;
}

type Message = Record<string, unknown>;
type ToolCall = { id?: string; function: { name: string; arguments: string } };

async function chat(messages: Message[], signal: AbortSignal) {
	const res = await fetch(`${args.ollama}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			messages,
			tools: TOOLS,
			temperature: Number(args.temperature),
			max_tokens: 1024,
		}),
		signal,
	});
	if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
	const body = await res.json();
	return {
		message: body.choices[0].message as Message & { tool_calls?: ToolCall[] },
		tokens: (body.usage?.completion_tokens as number) ?? 0,
	};
}

type RunResult = {
	turns: number;
	toolCalls: number;
	tokens: number;
	success: boolean;
};

async function runTask(signal: AbortSignal): Promise<RunResult> {
	const messages: Message[] = [{ role: "user", content: PROMPT }];
	let toolCalls = 0;
	let tokens = 0;
	for (let turn = 1; turn <= 6; turn++) {
		const { message, tokens: t } = await chat(messages, signal);
		tokens += t;
		messages.push(message);
		const calls = message.tool_calls ?? [];
		if (calls.length === 0) {
			const text = String(message.content ?? "").toLowerCase();
			const success = text.includes("pdf") && text.includes("november 14");
			if (args.verbose && !success)
				console.log("  answer:", text.slice(0, 300));
			return { turns: turn, toolCalls, tokens, success };
		}
		for (const call of calls) {
			toolCalls++;
			if (args.verbose)
				console.log("  call:", call.function.name, call.function.arguments);
			messages.push({
				role: "tool",
				tool_call_id: call.id ?? "",
				content: runTool(call.function.name, call.function.arguments),
			});
		}
	}
	return { turns: 6, toolCalls, tokens, success: false };
}

// --- GPU readings ---------------------------------------------------------

type Gpu = {
	vramC: number;
	junctionC: number;
	coreC: number;
	watts: number;
	fan: number;
	vramMiB: number;
};

function readVramFile(): { vram: number; junction: number } {
	const text = readFileSync(args["vram-file"] as string, "utf8");
	const get = (metric: string) =>
		Number(text.match(new RegExp(`^${metric}\\{[^}]*\\} (\\S+)`, "m"))?.[1]);
	return {
		vram: get("gputemps_vram_celsius"),
		junction: get("gputemps_junction_celsius"),
	};
}

async function readGpu(): Promise<Gpu> {
	const { stdout } = await exec("nvidia-smi", [
		"--query-gpu=temperature.gpu,power.draw,fan.speed,memory.used",
		"--format=csv,noheader,nounits",
	]);
	const [coreC, watts, fan, vramMiB] = stdout.trim().split(",").map(Number);
	const { vram, junction } = readVramFile();
	return { vramC: vram, junctionC: junction, coreC, watts, fan, vramMiB };
}

async function unload() {
	await fetch(`${args.ollama}/api/generate`, {
		method: "POST",
		body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
	}).catch(() => {});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Main loop ------------------------------------------------------------

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const slug = MODEL.replace(/[^a-z0-9.]+/gi, "_");
mkdirSync(args.out as string, { recursive: true });
const runsCsv = join(args.out as string, `${slug}-${stamp}.runs.csv`);
const samplesCsv = join(args.out as string, `${slug}-${stamp}.samples.csv`);
writeFileSync(
	runsCsv,
	"run,start_s,duration_s,outcome,success,turns,tool_calls,tokens,vram_c_end\n",
);
writeFileSync(
	samplesCsv,
	"t_s,vram_c,junction_c,core_c,watts,fan_pct,vram_mib,state\n",
);

const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
let state: "run" | "pause" = "run";
let stopping = false;
let current: AbortController | null = null;
const peak = { vramC: 0, coreC: 0, vramMiB: 0 };
let pauseMs = 0;
let pauses = 0;
let aborts = 0;
const durations: number[] = [];
let successes = 0;
let tokensTotal = 0;

process.on("SIGINT", () => {
	if (stopping) process.exit(130);
	console.log("\nstopping, Ctrl+C again to force");
	stopping = true;
	current?.abort();
});

// Background sampler. Also the emergency brake: above ABORT_AT, the
// current request is cancelled.
const sampler = setInterval(async () => {
	try {
		const g = await readGpu();
		peak.vramC = Math.max(peak.vramC, g.vramC);
		peak.coreC = Math.max(peak.coreC, g.coreC);
		peak.vramMiB = Math.max(peak.vramMiB, g.vramMiB);
		await appendFile(
			samplesCsv,
			`${elapsed().toFixed(0)},${g.vramC},${g.junctionC},${g.coreC},${g.watts},${g.fan},${g.vramMiB},${state}\n`,
		);
		if (g.vramC >= ABORT_AT && current) {
			console.log(`VRAM ${g.vramC} °C >= ${ABORT_AT}, aborting run`);
			aborts++;
			current.abort();
		}
	} catch (e) {
		console.error("sample failed:", (e as Error).message);
	}
}, SAMPLE_MS);

async function coolDown() {
	const start = Date.now();
	state = "pause";
	pauses++;
	await unload();
	while (!stopping && readVramFile().vram > RESUME_AT) await sleep(SAMPLE_MS);
	state = "run";
	pauseMs += Date.now() - start;
	console.log(`resumed after ${((Date.now() - start) / 1000).toFixed(0)} s`);
}

console.log(
	`${MODEL}: ${args.minutes} min, pause at ${PAUSE_AT} °C, resume at ${RESUME_AT} °C, abort at ${ABORT_AT} °C`,
);

let run = 0;
while (!stopping && Date.now() - t0 < MAX_MS && run < MAX_RUNS) {
	const vram = readVramFile().vram;
	if (vram >= PAUSE_AT) {
		console.log(`VRAM ${vram} °C, pausing until ${RESUME_AT} °C`);
		await coolDown();
		continue;
	}
	run++;
	const start = elapsed();
	current = new AbortController();
	let outcome = "done";
	let r: RunResult = { turns: 0, toolCalls: 0, tokens: 0, success: false };
	try {
		r = await runTask(current.signal);
	} catch (e) {
		outcome = current.signal.aborted ? "aborted" : "error";
		if (outcome === "error")
			console.error(`run ${run} failed:`, (e as Error).message);
	}
	current = null;
	const duration = elapsed() - start;
	// The first run includes loading the model: kept in the CSV, left out of the stats.
	if (outcome === "done" && run > 1) {
		durations.push(duration);
		successes += Number(r.success);
		tokensTotal += r.tokens;
	}
	const vEnd = readVramFile().vram;
	await appendFile(
		runsCsv,
		`${run},${start.toFixed(1)},${duration.toFixed(2)},${outcome},${r.success},${r.turns},${r.toolCalls},${r.tokens},${vEnd}\n`,
	);
	console.log(
		`run ${run}: ${duration.toFixed(1)} s, ${outcome}, ${r.success ? "ok" : "fail"}, ${r.toolCalls} tools, VRAM ${vEnd} °C`,
	);
	if (outcome === "aborted" && !stopping) await coolDown();
}

clearInterval(sampler);
await unload();

// --- Summary --------------------------------------------------------------

const sorted = [...durations].sort((a, b) => a - b);
const pct = (p: number) =>
	sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
const mean = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
const wall = elapsed();
const perRunWall = wall / Math.max(1, run);
const target = Number(args.target);

const summary = [
	`model            ${MODEL}`,
	`wall time        ${(wall / 60).toFixed(1)} min, of which paused ${(pauseMs / 60_000).toFixed(1)} min (${pauses} pauses, ${aborts} aborts)`,
	`runs             ${run} (stats on ${sorted.length}, first run excluded)`,
	`success          ${successes}/${sorted.length}`,
	`run time         mean ${mean.toFixed(1)} s, median ${pct(0.5).toFixed(1)} s, p95 ${pct(0.95).toFixed(1)} s`,
	`speed            ${(tokensTotal / (sorted.reduce((a, b) => a + b, 0) || 1)).toFixed(1)} tok/s over runs`,
	`peak             VRAM ${peak.vramC} °C, core ${peak.coreC} °C, ${peak.vramMiB} MiB used`,
	`projection       ${target} runs ≈ ${((target * perRunWall) / 3600).toFixed(1)} h, pauses included`,
	`csv              ${runsCsv}`,
	`                 ${samplesCsv}`,
].join("\n");
console.log(`\n${summary}`);
writeFileSync(runsCsv.replace(".runs.csv", ".summary.txt"), `${summary}\n`);
process.exit(0);
