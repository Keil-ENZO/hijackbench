// What Ollama has installed and loaded, over its native API. For `models`
// and `doctor`: the campaign itself only talks to /v1/chat/completions.

import { z } from "zod";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export type InstalledModel = {
	name: string;
	// On disk, in bytes.
	size: number;
	// As Ollama writes it, e.g. "25.2B". Null when it does not say.
	parameterSize: string | null;
	quantization: string | null;
	// Null when /api/show failed or predates capabilities.
	tools: boolean | null;
};

export type LoadedModel = {
	name: string;
	// In memory, in bytes, and the part of it in VRAM.
	size: number;
	sizeVram: number;
};

export class OllamaUnreachableError extends Error {
	override readonly name = "OllamaUnreachableError";
}

const TagsSchema = z.object({
	models: z.array(
		z.object({
			name: z.string(),
			size: z.number(),
			details: z
				.object({
					parameter_size: z.string().nullish(),
					quantization_level: z.string().nullish(),
				})
				.nullish(),
		}),
	),
});

const ShowSchema = z.object({
	capabilities: z.array(z.string()).nullish(),
});

const PsSchema = z.object({
	models: z.array(
		z.object({ name: z.string(), size: z.number(), size_vram: z.number() }),
	),
});

export type OllamaClient = {
	baseUrl: string;
	version(): Promise<string>;
	installed(): Promise<InstalledModel[]>;
	loaded(): Promise<LoadedModel[]>;
};

export function createOllamaClient(
	baseUrl = DEFAULT_OLLAMA_URL,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
	timeoutMs = 5_000,
): OllamaClient {
	const base = baseUrl.replace(/\/+$/, "");

	async function call(path: string, body?: unknown): Promise<unknown> {
		let res: Response;
		try {
			res = await fetchImpl(`${base}${path}`, {
				method: body === undefined ? "GET" : "POST",
				...(body !== undefined && {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new OllamaUnreachableError(`cannot reach Ollama at ${base}`, {
				cause: error,
			});
		}
		if (!res.ok) throw new Error(`Ollama returned ${res.status} on ${path}`);
		return res.json();
	}

	return {
		baseUrl: base,

		async version() {
			const json = (await call("/api/version")) as { version?: unknown };
			return String(json.version ?? "unknown");
		},

		// Sorted by name. One /api/show per model, for its capabilities.
		async installed() {
			const { models } = TagsSchema.parse(await call("/api/tags"));
			const rows = await Promise.all(
				models.map(async (m): Promise<InstalledModel> => {
					let tools: boolean | null = null;
					try {
						const show = ShowSchema.parse(
							await call("/api/show", { model: m.name }),
						);
						tools = show.capabilities?.includes("tools") ?? null;
					} catch {
						// Unknown, not false: the model may well support tools.
					}
					return {
						name: m.name,
						size: m.size,
						parameterSize: m.details?.parameter_size ?? null,
						quantization: m.details?.quantization_level ?? null,
						tools,
					};
				}),
			);
			return rows.sort((a, b) => a.name.localeCompare(b.name));
		},

		async loaded() {
			const { models } = PsSchema.parse(await call("/api/ps"));
			return models.map((m) => ({
				name: m.name,
				size: m.size,
				sizeVram: m.size_vram,
			}));
		},
	};
}

// Ollama adds ":latest" to a bare name.
export const sameModel = (a: string, b: string) => {
	const full = (name: string) => (name.includes(":") ? name : `${name}:latest`);
	return full(a) === full(b);
};
