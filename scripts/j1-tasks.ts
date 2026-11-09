// J1 deliverable check. Throwaway: the runner of US-14 replaces it.
//
// Runs the eight tasks, without attack, through the real agent loop, on
// one or more Ollama models. Prints each task check and writes every
// trace as JSON. Pauses between runs when the GDDR6X gets hot, the same
// way the J0 measure did.
//
// Usage:
//   node scripts/j1-tasks.ts --model gemma4:26b-a4b-it-q4_K_M [--model ...] [--runs 1]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
	createEnvironment,
	createOllamaProvider,
	generateCanary,
	runAgent,
	TASKS,
} from "../packages/core/src/index.ts";

const { values: args } = parseArgs({
	options: {
		model: { type: "string", multiple: true },
		runs: { type: "string", default: "1" },
		temperature: { type: "string", default: "0.7" },
		"pause-at": { type: "string", default: "84" },
		"resume-at": { type: "string", default: "60" },
		"abort-at": { type: "string", default: "90" },
		ollama: { type: "string", default: "http://localhost:11434" },
		"vram-file": {
			type: "string",
			default: "/var/lib/node_exporter/textfile/gputemps.prom",
		},
		out: { type: "string", default: "results/j1" },
	},
});

const models = args.model ?? [];
if (models.length === 0) {
	console.error("At least one --model is required");
	process.exit(2);
}
const runs = Number(args.runs);
const temperature = Number(args.temperature);
const pauseAt = Number(args["pause-at"]);
const resumeAt = Number(args["resume-at"]);
const abortAt = Number(args["abort-at"]);

function vramTemp(): number | undefined {
	try {
		const text = readFileSync(args["vram-file"], "utf8");
		const match = text.match(
			/^gputemps_vram_celsius\{[^}]*\} (\d+(?:\.\d+)?)/m,
		);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

async function coolDown() {
	let temp = vramTemp();
	if (temp === undefined) throw new Error("Cannot read the VRAM temperature");
	if (temp >= abortAt) throw new Error(`VRAM at ${temp} °C, aborting`);
	if (temp < pauseAt) return;
	process.stdout.write(`  pause, VRAM at ${temp} °C`);
	while (temp === undefined || temp > resumeAt) {
		await new Promise((r) => setTimeout(r, 5_000));
		temp = vramTemp();
	}
	console.log(`, resumed at ${temp} °C`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(args.out, stamp);
mkdirSync(outDir, { recursive: true });

const summary: Array<Record<string, unknown>> = [];

for (const model of models) {
	const provider = createOllamaProvider({ model, baseUrl: args.ollama });
	console.log(`\n${model}`);
	for (const task of TASKS) {
		for (let run = 1; run <= runs; run++) {
			await coolDown();
			const env = createEnvironment({ canary: generateCanary() });
			const { trace, outcome } = await runAgent({
				provider,
				task,
				env,
				temperature,
			});
			const check = task.check(outcome);
			const calls = trace.turns.flatMap((t) => t.calls);
			const line = {
				model,
				task: task.id,
				run,
				success: check.success,
				reason: check.reason,
				end: trace.end.reason,
				turns: trace.turns.length,
				calls: calls.map((c) => (c.isError ? `${c.name}!` : c.name)).join(" "),
				seconds: Math.round(trace.durationMs / 100) / 10,
				vram: vramTemp(),
			};
			summary.push(line);
			console.log(
				`  ${task.id} #${run} ${check.success ? "OK  " : "FAIL"} ${line.seconds}s ` +
					`[${line.calls}] ${check.success ? "" : check.reason}`,
			);
			const file = `${model.replace(/[^a-z0-9.-]/gi, "_")}-${task.id}-${run}.json`;
			writeFileSync(
				join(outDir, file),
				`${JSON.stringify(trace, null, "\t")}\n`,
			);
		}
	}
	const mine = summary.filter((s) => s.model === model);
	const ok = mine.filter((s) => s.success).length;
	console.log(`  => ${ok}/${mine.length}`);
}

writeFileSync(
	join(outDir, "summary.json"),
	`${JSON.stringify(summary, null, "\t")}\n`,
);
console.log(`\nTraces in ${outDir}`);
