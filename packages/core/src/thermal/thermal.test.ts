import { describe, expect, it } from "vitest";
import {
	createThermalGuard,
	parseGputemps,
	readVram,
	ThermalReadError,
} from "./thermal.ts";

const NOW = 1_794_238_955_000;
const file = (
	vram: number,
	ageS = 2,
) => `# HELP gputemps_vram_celsius GDDR6X temperature
# TYPE gputemps_vram_celsius gauge
gputemps_vram_celsius{gpu="0"} ${vram}
gputemps_junction_celsius{gpu="0"} 70
gputemps_last_success_timestamp_seconds ${NOW / 1000 - ageS}
`;

describe("readVram", () => {
	it("reads the VRAM temperature of the exporter's file", () => {
		expect(parseGputemps(file(82))).toEqual({
			vram: 82,
			updatedAt: NOW - 2000,
		});
		expect(readVram("f", NOW, () => file(82))).toBe(82);
	});

	it("refuses a stale reading: a dead exporter is not a cold card", () => {
		expect(() => readVram("f", NOW, () => file(40, 45))).toThrow(
			/45 s old: is gputemps-exporter running/,
		);
	});

	it("refuses a file without the VRAM line", () => {
		expect(() => readVram("f", NOW, () => "up 1\n")).toThrow(ThermalReadError);
	});

	it("refuses a missing file", () => {
		expect(() =>
			readVram("/nope", NOW, () => {
				throw new Error("ENOENT");
			}),
		).toThrow(/cannot read \/nope: ENOENT/);
	});
});

// A guard reading temperatures from a list, one per read.
function guard(temps: number[]) {
	const queue = [...temps];
	const waits: number[] = [];
	let t = 0;
	const g = createThermalGuard({
		thresholds: { pauseAt: 84, resumeAt: 60, abortAt: 90 },
		read: () => {
			const next = queue.shift();
			if (next === undefined) throw new Error("no more readings");
			return next;
		},
		sleep: async () => {},
		clock: () => {
			t += 5000;
			return new Date(t);
		},
		onWait: (vram) => waits.push(vram),
	});
	return { g, waits, left: () => queue.length };
}

const signal = () => new AbortController().signal;

describe("coolDown", () => {
	it("does not pause under pauseAt", async () => {
		const { g, left } = guard([83]);
		expect(await g.coolDown(signal())).toBeUndefined();
		expect(left()).toBe(0);
	});

	it("pauses at pauseAt and waits for resumeAt", async () => {
		const { g, waits } = guard([84, 75, 66, 60]);
		expect(await g.coolDown(signal())).toEqual({
			startedAt: new Date(5000).toISOString(),
			durationMs: 5000,
			fromC: 84,
			toC: 60,
		});
		expect(waits).toEqual([84, 75, 66]);
	});

	it("after a cut, waits for resumeAt even under pauseAt", async () => {
		const { g } = guard([70, 61, 58]);
		const pause = await g.coolDown(signal(), { force: true });
		expect(pause).toMatchObject({ fromC: 70, toC: 58 });
	});

	it("after a cut, does not wait if already cool", async () => {
		const { g } = guard([55]);
		expect(await g.coolDown(signal(), { force: true })).toBeUndefined();
	});

	it("gives up when stopped", async () => {
		const controller = new AbortController();
		const g = createThermalGuard({
			thresholds: { pauseAt: 84, resumeAt: 60, abortAt: 90 },
			read: () => 88,
			pollMs: 60_000,
		});
		const waiting = g.coolDown(controller.signal);
		controller.abort(new Error("stop"));
		await expect(waiting).rejects.toThrow("stop");
	});
});
