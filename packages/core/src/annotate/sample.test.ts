import { describe, expect, it } from "vitest";
import type { Verdict } from "../store/schema.ts";
import { allocate, type Candidate, drawSample } from "./sample.ts";

const counts = (entries: [Verdict, number][]) => new Map(entries);

// attacked-v0 as judged on 2026-11-16.
const ATTACKED_V0: [Verdict, number][] = [
	["compromised", 63],
	["resisted_failure", 22],
	["resisted_success", 815],
];

let nextId = 1;
const candidates = (entries: [Verdict, number][]): Candidate[] =>
	entries.flatMap(([verdict, n]) =>
		Array.from({ length: n }, () => ({ runId: nextId++, verdict })),
	);

describe("allocate", () => {
	it("gives the same quota to every verdict, the rest of a small one to the others", () => {
		expect(Object.fromEntries(allocate(counts(ATTACKED_V0), 100))).toEqual({
			resisted_failure: 22,
			compromised: 39,
			resisted_success: 39,
		});
	});

	it("never draws more runs than there are, nor more than asked", () => {
		const quotas = allocate(
			counts([
				["compromised", 3],
				["partial", 1],
			]),
			100,
		);
		expect(Object.fromEntries(quotas)).toEqual({ compromised: 3, partial: 1 });
		const total = [...allocate(counts(ATTACKED_V0), 7).values()];
		expect(total.reduce((a, b) => a + b, 0)).toBe(7);
	});

	it("hands the rounding remainder out instead of losing it", () => {
		const quotas = allocate(
			counts([
				["compromised", 50],
				["partial", 50],
				["resisted_success", 50],
			]),
			10,
		);
		expect([...quotas.values()].reduce((a, b) => a + b, 0)).toBe(10);
		expect(Math.max(...quotas.values()) - Math.min(...quotas.values())).toBe(1);
	});

	it("skips a verdict the judge never gave", () => {
		const quotas = allocate(
			counts([
				["partial", 0],
				["compromised", 5],
			]),
			4,
		);
		expect(Object.fromEntries(quotas)).toEqual({ compromised: 4 });
	});
});

describe("drawSample", () => {
	const pool = candidates(ATTACKED_V0);
	const verdictOf = new Map(pool.map((c) => [c.runId, c.verdict]));

	it("draws the quotas, with no run twice", () => {
		const sample = drawSample(pool, 100, "attacked-v0");
		expect(new Set(sample).size).toBe(100);
		const drawn = sample.map((id) => verdictOf.get(id));
		expect(drawn.filter((v) => v === "compromised")).toHaveLength(39);
		expect(drawn.filter((v) => v === "resisted_failure")).toHaveLength(22);
		expect(drawn.filter((v) => v === "resisted_success")).toHaveLength(39);
	});

	it("draws the same runs in the same order for the same seed: a session resumes", () => {
		expect(drawSample(pool, 100, "attacked-v0")).toEqual(
			drawSample([...pool].reverse(), 100, "attacked-v0"),
		);
	});

	it("draws other runs for another seed", () => {
		expect(drawSample(pool, 100, "other")).not.toEqual(
			drawSample(pool, 100, "attacked-v0"),
		);
	});

	it("mixes the verdicts, so the order does not give the judge away", () => {
		const drawn = drawSample(pool, 100, "attacked-v0").map((id) =>
			verdictOf.get(id),
		);
		const changes = drawn.filter((v, i) => i > 0 && v !== drawn[i - 1]).length;
		// Grouped by verdict, there would be 2 changes.
		expect(changes).toBeGreaterThan(20);
	});
});
