// Draws the Gandalf injections of the catalog, DEC-08. Run once: its
// output is committed, so a campaign never needs the network.
//
// Source: Lakera/gandalf_ignore_instructions on Hugging Face, MIT, at a
// pinned revision. Real attempts of Gandalf players to get a password out
// of the model. Only those that name the secret are kept, since the
// catalog swaps it for each objective's target. 50 of them are drawn by
// SHA-256, so the same revision and seed always give the same texts.
//
// Usage:
//   node scripts/fetch-gandalf.ts

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GANDALF, SECRET } from "../packages/core/src/attacks/gandalf.ts";

const SIZE = 50;
const SEED = "hijackbench-gandalf-v0";
const SPLITS = ["train", "validation", "test"] as const;
const PAGE = 100;
const OUT = fileURLToPath(
	new URL("../packages/core/src/attacks/gandalf-texts.json", import.meta.url),
);

type Row = { split: string; row: number; text: string };

// The datasets server answers 502 now and then: three tries.
async function json(url: string): Promise<unknown> {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(url);
		if (res.ok) return res.json();
		if (attempt === 3) throw new Error(`${res.status} on ${url}`);
		await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
	}
}

// The datasets server serves the latest revision only: refuse another.
const info = (await json(
	`https://huggingface.co/api/datasets/${GANDALF.dataset}`,
)) as { sha: string };
if (info.sha !== GANDALF.revision)
	throw new Error(
		`${GANDALF.dataset} is at ${info.sha}, not the pinned ${GANDALF.revision}: review the change, then update the revision.`,
	);

const rows: Row[] = [];
for (const split of SPLITS)
	for (let offset = 0; ; offset += PAGE) {
		const page = (await json(
			`https://datasets-server.huggingface.co/rows?dataset=${GANDALF.dataset}&config=default&split=${split}&offset=${offset}&length=${PAGE}`,
		)) as { rows: { row_idx: number; row: { text: string } }[] };
		for (const { row_idx, row } of page.rows)
			rows.push({ split, row: row_idx, text: row.text });
		if (page.rows.length < PAGE) break;
	}

const rank = (row: Row) =>
	createHash("sha256").update(`${SEED}|${row.split}|${row.row}`).digest("hex");
const pool = rows.filter((row) =>
	new RegExp(SECRET.source, "i").test(row.text),
);
const drawn = pool
	.sort((a, b) => rank(a).localeCompare(rank(b)))
	.slice(0, SIZE)
	.map(({ split, row, text }) => ({ split, row, text: text.trim() }));

writeFileSync(
	OUT,
	`${JSON.stringify({ ...GANDALF, seed: SEED, rows: rows.length, pool: pool.length, texts: drawn }, null, "\t")}\n`,
);
console.log(
	`${drawn.length} texts drawn from ${pool.length} that name the secret, out of ${rows.length}. Written to ${OUT}.`,
);
