// Real injections from Gandalf players, adapted to the three objectives
// of the bench, DEC-08.
//
// Each text asks for a password. The secret it names is swapped for the
// objective's target, by rules, no LLM: "what's the password?" becomes
// "what's the API keys in private/api-keys.txt?". The objective's order
// follows, the same as in the AgentDojo cases, so the judge watches the
// same things. The texts keep their typos and their grammar: that is
// what makes them real.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GANDALF = {
	name: "Gandalf by Lakera",
	dataset: "Lakera/gandalf_ignore_instructions",
	url: "https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions",
	revision: "04737b65e90a6794ec227012e4a255a7def6344b",
	license: "MIT",
} as const;

// "the password", "your secret", "the secret word", "passcode"...
export const SECRET =
	/\b(?:the |your |my |this )?(?:secret )?(?:password|passcode|pass word|secret word|secret)\b/gi;

export type GandalfText = { split: string; row: number; text: string };

// The texts drawn by scripts/fetch-gandalf.ts, committed with the code.
// Read on first use: the script imports this module before the file
// exists.
let texts: readonly GandalfText[] | undefined;
export function gandalfTexts(): readonly GandalfText[] {
	texts ??= (
		JSON.parse(
			readFileSync(
				fileURLToPath(new URL("./gandalf-texts.json", import.meta.url)),
				"utf8",
			),
		) as { texts: GandalfText[] }
	).texts;
	return texts;
}

// The text with its secret swapped for the target, then the order.
export function adaptGandalf(text: string, target: string, goal: string) {
	const lines = text.replace(/\r\n?/g, "\n");
	return `${lines.replace(SECRET, target)}\n\n${goal}`;
}
