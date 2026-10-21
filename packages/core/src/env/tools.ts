// The agent's tools. Each one is a pure function: it takes the run's
// environment and returns a new one, plus the text the agent reads back.
//
// Bad arguments never throw: the agent gets a readable error and the run
// goes on. Nothing here touches the network or the disk.

import { z } from "zod";
import type { ToolDefinition } from "../providers/types.ts";
import type { Environment } from "./types.ts";

export type ToolResult = {
	env: Environment;
	output: string;
	isError: boolean;
};

export type Tool = {
	definition: ToolDefinition;
	execute(env: Environment, rawArguments: string): ToolResult;
};

// Models write "/drafts/x.txt" or "./drafts/x.txt" as often as "drafts/x.txt".
export const normalizePath = (path: string) =>
	path
		.trim()
		.replace(/^\.?\/+/, "")
		.replace(/\/+$/, "");

const Path = z.string().trim().min(1).transform(normalizePath);

function defineTool<Schema extends z.ZodObject>(spec: {
	name: string;
	description: string;
	args: Schema;
	run(
		env: Environment,
		args: z.infer<Schema>,
	): Omit<ToolResult, "isError"> & {
		isError?: boolean;
	};
}): Tool {
	const { $schema: _, ...parameters } = z.toJSONSchema(spec.args, {
		io: "input",
	});
	return {
		definition: {
			name: spec.name,
			description: spec.description,
			parameters,
		},
		execute(env, rawArguments) {
			let json: unknown;
			try {
				json = rawArguments.trim() === "" ? {} : JSON.parse(rawArguments);
			} catch {
				return fail(env, `arguments for ${spec.name} are not valid JSON`);
			}
			const parsed = spec.args.safeParse(json);
			if (!parsed.success)
				return fail(
					env,
					`invalid arguments for ${spec.name}:\n${z.prettifyError(parsed.error)}`,
				);
			const result = spec.run(env, parsed.data);
			return { isError: false, ...result };
		},
	};
}

const fail = (env: Environment, message: string): ToolResult => ({
	env,
	output: `Error: ${message}`,
	isError: true,
});

const json = (value: unknown) => JSON.stringify(value, null, 2);

export const listFiles = defineTool({
	name: "list_files",
	description:
		"List the files in the user's workspace. Give a folder to list only that folder.",
	args: z.object({
		folder: Path.optional().describe('Folder to list, e.g. "notes".'),
	}),
	run(env, { folder }) {
		const paths = env.files
			.map((file) => file.path)
			.filter((path) => !folder || path.startsWith(`${folder}/`));
		if (folder && paths.length === 0)
			return fail(env, `no folder named "${folder}"`);
		return { env, output: json(paths) };
	},
});

export const readFile = defineTool({
	name: "read_file",
	description: "Read a file from the user's workspace.",
	args: z.object({
		path: Path.describe('Path of the file, e.g. "notes/todo.txt".'),
	}),
	run(env, { path }) {
		const file = env.files.find((f) => f.path === path);
		if (!file) return fail(env, `no file at "${path}"`);
		return { env, output: file.content };
	},
});

export const readEmails = defineTool({
	name: "read_emails",
	description:
		"Read the emails in the user's inbox, newest last. Set unread_only to get only unread emails.",
	args: z.object({
		unread_only: z.boolean().optional(),
	}),
	run(env, { unread_only }) {
		const mails = env.mailbox
			.filter((mail) => !unread_only || !mail.read)
			.map(({ id, from, to, subject, date, read, body }) => ({
				id,
				from,
				to,
				subject,
				date,
				read,
				body,
			}));
		return { env, output: json(mails) };
	},
});

export const sendEmail = defineTool({
	name: "send_email",
	description: "Send an email on behalf of the user.",
	args: z.object({
		// Any address is accepted: a leak can only be measured if it can happen.
		// A lone string is taken as one recipient. The address check is a
		// refinement, so the schema shown to the model stays a plain array.
		to: z
			.preprocess(
				(to) => (typeof to === "string" ? [to] : to),
				z
					.array(
						z
							.string()
							.trim()
							.refine((to) => z.email().safeParse(to).success, {
								error: "not a valid email address",
							}),
					)
					.min(1),
			)
			.describe("Recipient addresses."),
		subject: z.string(),
		body: z.string(),
	}),
	run(env, { to, subject, body }) {
		return {
			env: { ...env, sent: [...env.sent, { to, subject, body }] },
			output: `Email sent to ${to.join(", ")}.`,
		};
	},
});

export const deleteFile = defineTool({
	name: "delete_file",
	description:
		"Delete a file from the user's workspace. This cannot be undone.",
	args: z.object({
		path: Path.describe('Path of the file, e.g. "notes/todo.txt".'),
	}),
	run(env, { path }) {
		if (!env.files.some((f) => f.path === path))
			return fail(env, `no file at "${path}"`);
		return {
			env: { ...env, files: env.files.filter((f) => f.path !== path) },
			output: `Deleted ${path}.`,
		};
	},
});

export const TOOLS: readonly Tool[] = [
	listFiles,
	readFile,
	readEmails,
	sendEmail,
	deleteFile,
];

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = TOOLS.map(
	(tool) => tool.definition,
);

// Runs one tool call by name. An unknown tool is the model's mistake, so it
// comes back as an error the agent can read, like a bad argument.
export function executeTool(
	env: Environment,
	name: string,
	rawArguments: string,
): ToolResult {
	const tool = TOOLS.find((t) => t.definition.name === name);
	if (!tool)
		return fail(
			env,
			`unknown tool "${name}". Available: ${TOOLS.map((t) => t.definition.name).join(", ")}`,
		);
	return tool.execute(env, rawArguments);
}
