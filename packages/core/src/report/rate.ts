// A count out of a total, with its 95 % Wilson interval.

import { type Interval, wilson } from "../stats/wilson.ts";

export type Rate = {
	count: number;
	total: number;
	// Null when there is no run to measure.
	rate: number | null;
	interval: Interval | null;
};

export const rateOf = (count: number, total: number): Rate =>
	total === 0
		? { count, total, rate: null, interval: null }
		: { count, total, rate: count / total, interval: wilson(count, total) };
