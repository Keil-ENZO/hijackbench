// The thermal guard: keeps the GDDR6X of the 3090 out of the red during
// unattended campaigns.
//
// The memory temperature is not in nvidia-smi on a 3090. gputemps-exporter
// reads it and writes a Prometheus textfile, readable without root. The
// thresholds come from the J0 measure: pause at 84 °C, resume at 60 °C,
// cut the run in flight at 90 °C.

import { readFileSync } from "node:fs";

export const DEFAULT_VRAM_FILE =
	"/var/lib/node_exporter/textfile/gputemps.prom";

// Older than this, a reading means the exporter is down: never take a
// dead exporter for a cold card.
const MAX_AGE_MS = 30_000;

export type Thresholds = { pauseAt: number; resumeAt: number; abortAt: number };

export type Reading = { vram: number; updatedAt: number };

export class ThermalReadError extends Error {
	override readonly name = "ThermalReadError";
}

// Parses the textfile:
//   gputemps_vram_celsius{gpu="0"} 80
//   gputemps_last_success_timestamp_seconds 1794238955
export function parseGputemps(text: string): Reading {
	const vram = text.match(/^gputemps_vram_celsius\{[^}]*\} (\d+(?:\.\d+)?)$/m);
	const stamp = text.match(
		/^gputemps_last_success_timestamp_seconds (\d+(?:\.\d+)?)$/m,
	);
	if (!vram || !stamp)
		throw new ThermalReadError("no VRAM temperature in the gputemps file");
	return { vram: Number(vram[1]), updatedAt: Number(stamp[1]) * 1000 };
}

// Reads the VRAM temperature, or throws if it is missing or stale.
export function readVram(
	file = DEFAULT_VRAM_FILE,
	now = Date.now(),
	read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): number {
	let text: string;
	try {
		text = read(file);
	} catch (error) {
		throw new ThermalReadError(
			`cannot read ${file}: ${(error as Error).message}`,
		);
	}
	const { vram, updatedAt } = parseGputemps(text);
	const age = now - updatedAt;
	if (age > MAX_AGE_MS)
		throw new ThermalReadError(
			`the VRAM reading is ${Math.round(age / 1000)} s old: is gputemps-exporter running?`,
		);
	return vram;
}

export type Pause = {
	startedAt: string;
	durationMs: number;
	fromC: number;
	toC: number;
};

export type ThermalGuard = {
	thresholds: Thresholds;
	// Current VRAM temperature. Throws ThermalReadError if unknown.
	read(): number;
	// Waits until the card is cool enough to start a run. Returns the pause
	// it made, if any. Gives up when the signal aborts. With force, waits
	// for resumeAt even below pauseAt: after a cut, the card must cool down
	// fully before the run goes again.
	coolDown(
		signal: AbortSignal,
		options?: { force?: boolean },
	): Promise<Pause | undefined>;
};

export function createThermalGuard(options: {
	thresholds: Thresholds;
	read: () => number;
	pollMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	clock?: () => Date;
	onWait?: (vram: number) => void;
}): ThermalGuard {
	const { thresholds, read } = options;
	const pollMs = options.pollMs ?? 5_000;
	const clock = options.clock ?? (() => new Date());
	const sleep = options.sleep ?? sleepUnlessAborted;

	return {
		thresholds,
		read,
		async coolDown(signal, { force = false } = {}) {
			const fromC = read();
			const coolEnough = force
				? fromC <= thresholds.resumeAt
				: fromC < thresholds.pauseAt;
			if (coolEnough) return undefined;
			const start = clock();
			let vram = fromC;
			while (vram > thresholds.resumeAt) {
				options.onWait?.(vram);
				await sleep(pollMs, signal);
				vram = read();
			}
			return {
				startedAt: start.toISOString(),
				durationMs: clock().getTime() - start.getTime(),
				fromC,
				toC: vram,
			};
		},
	};
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
