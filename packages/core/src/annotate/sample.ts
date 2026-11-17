// Which runs Enzo annotates, for the judge calibration of J7.
//
// A stratified draw: the same quota for every verdict the judge gave, so
// the rare ones get as many runs as the common one. A verdict with fewer
// runs than its quota gives them all and hands the rest to the others.
//
// Deterministic: the order comes from a hash of the seed and the run id,
// never from Math.random. The same seed draws the same runs, which is how
// an annotation session resumes.

import { createHash } from "node:crypto";
import type { Verdict } from "../store/schema.ts";

export const DEFAULT_SAMPLE_SIZE = 100;

export type Candidate = { runId: number; verdict: Verdict };

// A stable pseudo-random rank for a run under a seed.
const rank = (seed: string, salt: string, runId: number) =>
	createHash("sha256").update(`${seed}|${salt}|${runId}`).digest("hex");

const byRank = (seed: string, salt: string) => (a: number, b: number) => {
	const ra = rank(seed, salt, a);
	const rb = rank(seed, salt, b);
	return ra < rb ? -1 : ra > rb ? 1 : 0;
};

// How many runs each verdict gives. The smallest verdicts are served
// first, so what they cannot fill goes to the larger ones.
export function allocate(
	counts: ReadonlyMap<Verdict, number>,
	size: number,
): Map<Verdict, number> {
	const verdicts = [...counts.entries()]
		.filter(([, count]) => count > 0)
		.sort(([va, a], [vb, b]) => a - b || va.localeCompare(vb));
	const quotas = new Map<Verdict, number>();
	let left = size;
	verdicts.forEach(([verdict, count], i) => {
		const share = Math.floor(left / (verdicts.length - i));
		const take = Math.min(count, share);
		quotas.set(verdict, take);
		left -= take;
	});
	// Rounding down can leave a few runs: they go to whoever has some left.
	for (const [verdict, count] of verdicts) {
		if (left === 0) break;
		const extra = Math.min(left, count - (quotas.get(verdict) ?? 0));
		quotas.set(verdict, (quotas.get(verdict) ?? 0) + extra);
		left -= extra;
	}
	return quotas;
}

// The run ids to annotate, in the order to show them. Verdicts are mixed:
// grouped, the order alone would give the judge's verdict away.
export function drawSample(
	candidates: readonly Candidate[],
	size: number,
	seed: string,
): number[] {
	const byVerdict = new Map<Verdict, number[]>();
	for (const { runId, verdict } of candidates)
		byVerdict.set(verdict, [...(byVerdict.get(verdict) ?? []), runId]);
	const counts = new Map(
		[...byVerdict].map(([verdict, ids]) => [verdict, ids.length]),
	);
	const picked = [...allocate(counts, size)].flatMap(([verdict, quota]) =>
		(byVerdict.get(verdict) ?? []).sort(byRank(seed, verdict)).slice(0, quota),
	);
	return picked.sort(byRank(seed, "order"));
}
