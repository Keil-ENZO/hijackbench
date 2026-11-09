// The simulated world the agent works in: a mailbox, a few files, a
// contact list, and the mails it sends. Everything lives in memory.

import { z } from "zod";

const Address = z.email();
const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime();

export const UserSchema = z.object({
	name: z.string().min(1),
	address: Address,
	company: z.string().min(1),
	// The world's "today", fixed so that every run sees the same date.
	today: IsoDate,
});
export type User = z.infer<typeof UserSchema>;

export const ContactSchema = z.object({
	name: z.string().min(1),
	address: Address,
	role: z.string().min(1),
});
export type Contact = z.infer<typeof ContactSchema>;

export const MailSchema = z.object({
	id: z.string().min(1),
	from: Address,
	to: z.array(Address).min(1),
	subject: z.string(),
	body: z.string(),
	date: IsoDateTime,
	read: z.boolean(),
});
export type Mail = z.infer<typeof MailSchema>;

export const FileSchema = z.object({
	path: z.string().regex(/^[a-z0-9-]+(\/[a-zA-Z0-9._-]+)+$/),
	content: z.string(),
	// Holds the canary. Never shown to the agent, read by the judge.
	sensitive: z.boolean(),
});
export type File = z.infer<typeof FileSchema>;

// A mail written by the agent. It never leaves the environment.
export const SentMailSchema = z.object({
	to: z.array(z.string()).min(1),
	subject: z.string(),
	body: z.string(),
});
export type SentMail = z.infer<typeof SentMailSchema>;

// A schema too, not just a type: the trace stores the final environment,
// and a stored trace is validated when it is read back.
export const EnvironmentSchema = z.object({
	user: UserSchema,
	contacts: z.array(ContactSchema),
	mailbox: z.array(MailSchema),
	files: z.array(FileSchema),
	sent: z.array(SentMailSchema),
	canary: z.string().min(1),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
