// What the menu offers after a command: the campaign files for run, the
// campaign ids of the base for the commands that take one. Each with its
// state, so the right campaign is picked at a glance.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CampaignStatus,
	campaignStatus,
	loadCampaign,
	type Store,
} from "@hijackbench/core";
import type { ArgumentSource } from "./commands.ts";

// The commands whose first argument is a campaign id of the base.
const TAKES_ID = new Set(["resume", "status", "judge", "annotate", "report"]);

function stateOf(status: CampaignStatus): string {
	if (status.state === "running")
		return `running, ${status.stored}/${status.planned} runs`;
	if (status.stored >= status.planned)
		return `complete, ${status.planned} runs: nothing to run`;
	return `stopped at ${status.stored}/${status.planned} runs`;
}

// The first line of an error: a campaign file's problems span several.
const firstLine = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

export function campaignFiles(
	store: Store,
	dir: string,
): { value: string; detail: string }[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
	} catch {
		return [];
	}
	return names.sort().map((name) => {
		const value = join(dir, name);
		try {
			const config = loadCampaign(value);
			const stored = store.getCampaign(config.id);
			// The state first: a long name is cut at the end of the line.
			const head = `${config.id} · ${config.name}`;
			if (!stored) return { value, detail: `new · ${head}` };
			if (!isDeepStrictEqual(stored.config, config))
				return {
					value,
					detail: `id in the base with another config, give it a new one · ${head}`,
				};
			const status = campaignStatus(store, config.id);
			return { value, detail: `${status ? stateOf(status) : "new"} · ${head}` };
		} catch (error) {
			return { value, detail: `invalid: ${firstLine(error)}` };
		}
	});
}

export function campaignIds(store: Store): { value: string; detail: string }[] {
	return store.listCampaigns().map((campaign) => {
		const status = campaignStatus(store, campaign.id);
		return {
			value: campaign.id,
			detail: `${status ? stateOf(status) : "?"} · ${campaign.name}`,
		};
	});
}

// Read on each keystroke: a few small files and the base, in a blink.
export function argumentSource(
	store: Store,
	dir = "campaigns",
): ArgumentSource {
	return (command) => {
		try {
			if (command === "run") return campaignFiles(store, dir);
			if (TAKES_ID.has(command)) return campaignIds(store);
		} catch {
			// A menu never breaks the shell: no suggestion, that is all.
		}
		return [];
	};
}
