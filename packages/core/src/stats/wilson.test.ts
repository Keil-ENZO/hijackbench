import { describe, expect, it } from "vitest";
import { wilson } from "./wilson.ts";

// Newcombe, "Two-sided confidence intervals for the single proportion",
// Statistics in Medicine 17 (1998), table I, method 3, four decimals.
const NEWCOMBE: [
	successes: number,
	total: number,
	low: number,
	high: number,
][] = [
	[81, 263, 0.2553, 0.3662],
	[15, 148, 0.0624, 0.1605],
	[0, 20, 0, 0.1611],
	[1, 29, 0.0061, 0.1718],
];

describe("wilson", () => {
	it.each(NEWCOMBE)("matches Newcombe for %i of %i", (k, n, low, high) => {
		const interval = wilson(k, n);
		expect(interval.low).toBeCloseTo(low, 4);
		expect(interval.high).toBeCloseTo(high, 4);
	});

	it("gives exact bounds at both edges", () => {
		expect(wilson(0, 300).low).toBe(0);
		expect(wilson(300, 300).high).toBe(1);
		expect(wilson(0, 300).high).toBeGreaterThan(0);
	});

	it("is symmetric around one half", () => {
		const a = wilson(3, 10);
		const b = wilson(7, 10);
		expect(a.low).toBeCloseTo(1 - b.high, 12);
		expect(a.high).toBeCloseTo(1 - b.low, 12);
	});

	it("narrows as the runs grow", () => {
		const small = wilson(2, 20);
		const large = wilson(20, 200);
		expect(large.high - large.low).toBeLessThan(small.high - small.low);
	});

	it("refuses counts that make no rate", () => {
		expect(() => wilson(0, 0)).toThrow(/No run/);
		expect(() => wilson(5, 4)).toThrow(/5 successes out of 4/);
		expect(() => wilson(-1, 4)).toThrow();
		expect(() => wilson(1.5, 4)).toThrow(/integers/);
	});
});
