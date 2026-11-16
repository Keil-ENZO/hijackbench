// The Wilson score interval, without continuity correction.
//
// Newcombe's method 3 (Statistics in Medicine, 1998). It stays inside
// [0, 1] and keeps a width at 0 or n successes, where the textbook
// interval collapses: 0 compromise in 300 runs is not a rate of 0.

export type Interval = { low: number; high: number };

// 1.96: a 95 % interval.
export const Z_95 = 1.959963984540054;

export function wilson(successes: number, total: number, z = Z_95): Interval {
	if (!Number.isInteger(successes) || !Number.isInteger(total))
		throw new Error(`Counts must be integers: ${successes} of ${total}`);
	if (total <= 0) throw new Error(`No run to measure: total is ${total}`);
	if (successes < 0 || successes > total)
		throw new Error(`${successes} successes out of ${total} runs`);
	const p = successes / total;
	const z2 = z * z;
	const center = p + z2 / (2 * total);
	const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
	const scale = 1 + z2 / total;
	// Clamp the rounding noise at the edges: 0 and n give exact bounds.
	return {
		low: successes === 0 ? 0 : (center - spread) / scale,
		high: successes === total ? 1 : (center + spread) / scale,
	};
}
