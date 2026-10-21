// Builds a fresh environment for each run from the JSON seed.
//
// The seed is validated and frozen once. Each call returns a deep copy,
// so nothing a run does can reach the next one.

import { z } from "zod";
import { isCanary } from "./canary.ts";
import contactsJson from "./data/contacts.json" with { type: "json" };
import filesJson from "./data/files.json" with { type: "json" };
import mailboxJson from "./data/mailbox.json" with { type: "json" };
import userJson from "./data/user.json" with { type: "json" };
import {
	ContactSchema,
	type Environment,
	FileSchema,
	MailSchema,
	UserSchema,
} from "./types.ts";

export const CANARY_PLACEHOLDER = "{{CANARY}}";

const SeedSchema = z
	.object({
		user: UserSchema,
		contacts: z.array(ContactSchema).min(1),
		mailbox: z.array(MailSchema).min(1),
		files: z.array(FileSchema).min(1),
	})
	.superRefine((seed, ctx) => {
		const unique = (values: string[], what: string) => {
			if (new Set(values).size !== values.length)
				ctx.addIssue({ code: "custom", message: `duplicate ${what}` });
		};
		unique(
			seed.mailbox.map((mail) => mail.id),
			"mail id",
		);
		unique(
			seed.files.map((file) => file.path),
			"file path",
		);
		unique(
			seed.contacts.map((contact) => contact.address),
			"contact address",
		);

		const sensitive = seed.files.filter((file) => file.sensitive);
		if (sensitive.length !== 1)
			ctx.addIssue({
				code: "custom",
				message: "exactly one sensitive file expected",
			});
		const placeholders = JSON.stringify(seed).split(CANARY_PLACEHOLDER).length;
		if (
			placeholders !== 2 ||
			!sensitive[0]?.content.includes(CANARY_PLACEHOLDER)
		)
			ctx.addIssue({
				code: "custom",
				message: `${CANARY_PLACEHOLDER} must appear once, in the sensitive file`,
			});
	});
type Seed = z.infer<typeof SeedSchema>;

export const SEED: Readonly<Seed> = deepFreeze(
	SeedSchema.parse({
		user: userJson,
		contacts: contactsJson,
		mailbox: mailboxJson,
		files: filesJson,
	}),
);

export function createEnvironment(options: { canary: string }): Environment {
	if (!isCanary(options.canary))
		throw new Error(`Invalid canary: ${JSON.stringify(options.canary)}`);
	const seed = structuredClone(SEED) as Seed;
	return {
		...seed,
		files: seed.files.map((file) =>
			file.sensitive
				? {
						...file,
						content: file.content.replace(CANARY_PLACEHOLDER, options.canary),
					}
				: file,
		),
		sent: [],
		canary: options.canary,
	};
}

export const sensitiveFile = (env: Environment) =>
	env.files.find((file) => file.sensitive);

export const isAuthorizedRecipient = (env: Environment, address: string) =>
	env.contacts.some(
		(contact) => contact.address.toLowerCase() === address.toLowerCase(),
	);

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const inner of Object.values(value)) deepFreeze(inner);
		Object.freeze(value);
	}
	return value;
}
