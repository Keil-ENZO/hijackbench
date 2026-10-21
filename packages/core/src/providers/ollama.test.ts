import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderError } from "./errors.ts";
import { createOllamaProvider } from "./ollama.ts";
import type { ChatRequest } from "./types.ts";

// A fake Ollama: a real HTTP server on a random port, one handler per test.

type Handler = (
	body: unknown,
	req: IncomingMessage,
	res: ServerResponse,
) => void;

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

async function fakeOllama(handler: Handler) {
	const received: unknown[] = [];
	const server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw);
			received.push({ url: req.url, body });
			handler(body, req, res);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${port}`, received };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const completion = (message: object, finish_reason = "stop") => ({
	id: "chatcmpl-1",
	object: "chat.completion",
	choices: [
		{ index: 0, message: { role: "assistant", ...message }, finish_reason },
	],
	usage: { prompt_tokens: 120, completion_tokens: 15, total_tokens: 135 },
});

const request: ChatRequest = {
	messages: [{ role: "user", content: "When is the deadline?" }],
	tools: [],
};

async function rejection(promise: Promise<unknown>) {
	const error = await promise.then(
		() => {
			throw new Error("expected a rejection");
		},
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ProviderError);
	return error as ProviderError;
}

describe("ollama provider", () => {
	it("sends an OpenAI-compatible request", async () => {
		const { baseUrl, received } = await fakeOllama((_, __, res) =>
			json(res, 200, completion({ content: "Friday." })),
		);
		const provider = createOllamaProvider({ model: "llama3.1:8b", baseUrl });

		await provider.chat({
			messages: [
				{ role: "system", content: "You are an assistant." },
				{ role: "user", content: "Read the deadline." },
				{
					role: "assistant",
					content: null,
					toolCalls: [
						{
							id: "call_1",
							name: "read_file",
							arguments: '{"path":"notes/deadline.txt"}',
						},
					],
				},
				{ role: "tool", toolCallId: "call_1", content: "November 14." },
			],
			tools: [
				{
					name: "read_file",
					description: "Read a file.",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
			temperature: 0.7,
			maxTokens: 1024,
		});

		expect(received).toEqual([
			{
				url: "/v1/chat/completions",
				body: {
					model: "llama3.1:8b",
					stream: false,
					temperature: 0.7,
					max_tokens: 1024,
					messages: [
						{ role: "system", content: "You are an assistant." },
						{ role: "user", content: "Read the deadline." },
						{
							role: "assistant",
							content: null,
							tool_calls: [
								{
									id: "call_1",
									type: "function",
									function: {
										name: "read_file",
										arguments: '{"path":"notes/deadline.txt"}',
									},
								},
							],
						},
						{ role: "tool", tool_call_id: "call_1", content: "November 14." },
					],
					tools: [
						{
							type: "function",
							function: {
								name: "read_file",
								description: "Read a file.",
								parameters: {
									type: "object",
									properties: { path: { type: "string" } },
									required: ["path"],
								},
							},
						},
					],
				},
			},
		]);
	});

	it("omits tools, temperature and max_tokens when not given", async () => {
		const { baseUrl, received } = await fakeOllama((_, __, res) =>
			json(res, 200, completion({ content: "ok" })),
		);
		await createOllamaProvider({ model: "m", baseUrl: `${baseUrl}/` }).chat(
			request,
		);
		expect(received).toEqual([
			{
				url: "/v1/chat/completions",
				body: { model: "m", stream: false, messages: request.messages },
			},
		]);
	});

	it("reads a text reply and its usage", async () => {
		const { baseUrl } = await fakeOllama((_, __, res) =>
			json(res, 200, completion({ content: "November 14." })),
		);
		const response = await createOllamaProvider({ model: "m", baseUrl }).chat(
			request,
		);
		expect(response).toEqual({
			message: { role: "assistant", content: "November 14.", toolCalls: [] },
			finishReason: "stop",
			usage: { inputTokens: 120, outputTokens: 15 },
		});
	});

	it("reads tool calls, fills missing ids, keeps raw arguments", async () => {
		const { baseUrl } = await fakeOllama((_, __, res) =>
			json(
				res,
				200,
				completion(
					{
						content: "",
						tool_calls: [
							{
								id: "call_abc",
								type: "function",
								function: {
									name: "list_files",
									arguments: '{"folder":"notes"}',
								},
							},
							{
								type: "function",
								function: { name: "read_file", arguments: { path: "a.txt" } },
							},
							{
								id: "call_bad",
								type: "function",
								function: { name: "read_file", arguments: '{"path": ' },
							},
						],
					},
					"tool_calls",
				),
			),
		);
		const response = await createOllamaProvider({ model: "m", baseUrl }).chat(
			request,
		);
		expect(response.finishReason).toBe("tool_calls");
		expect(response.message.toolCalls).toEqual([
			{ id: "call_abc", name: "list_files", arguments: '{"folder":"notes"}' },
			{ id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
			{ id: "call_bad", name: "read_file", arguments: '{"path": ' },
		]);
	});

	it("maps unknown finish reasons and missing usage", async () => {
		const { baseUrl } = await fakeOllama((_, __, res) =>
			json(res, 200, {
				choices: [{ message: { role: "assistant" }, finish_reason: "weird" }],
			}),
		);
		const response = await createOllamaProvider({ model: "m", baseUrl }).chat(
			request,
		);
		expect(response).toEqual({
			message: { role: "assistant", content: null, toolCalls: [] },
			finishReason: "other",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
	});

	it("rejects an invalid request before sending it", async () => {
		const { baseUrl, received } = await fakeOllama((_, __, res) =>
			json(res, 200, completion({ content: "ok" })),
		);
		const provider = createOllamaProvider({ model: "m", baseUrl });
		await expect(provider.chat({ messages: [], tools: [] })).rejects.toThrow();
		expect(received).toEqual([]);
	});

	describe("technical errors", () => {
		it("reports an HTTP error with its status", async () => {
			const { baseUrl } = await fakeOllama((_, __, res) =>
				json(res, 404, { error: 'model "nope" not found' }),
			);
			const error = await rejection(
				createOllamaProvider({ model: "nope", baseUrl }).chat(request),
			);
			expect(error.kind).toBe("http");
			expect(error.status).toBe(404);
			expect(error.message).toContain("not found");
		});

		it("reports a body that is not JSON", async () => {
			const { baseUrl } = await fakeOllama((_, __, res) =>
				json(res, 200, "<html>proxy error</html>"),
			);
			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl }).chat(request),
			);
			expect(error.kind).toBe("invalid_response");
		});

		it("reports a JSON body with no choice", async () => {
			const { baseUrl } = await fakeOllama((_, __, res) =>
				json(res, 200, { choices: [] }),
			);
			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl }).chat(request),
			);
			expect(error.kind).toBe("invalid_response");
		});

		it("reports an unreachable server as a network error", async () => {
			const { baseUrl } = await fakeOllama(() => {});
			const server = servers.pop();
			server?.close();
			await new Promise((resolve) => server?.once("close", resolve));

			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl }).chat(request),
			);
			expect(error.kind).toBe("network");
			expect(error.message).toContain(baseUrl);
		});

		it("reports a server that never answers as a timeout", async () => {
			const { baseUrl } = await fakeOllama(() => {});
			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl, timeoutMs: 50 }).chat(
					request,
				),
			);
			expect(error.kind).toBe("timeout");
		});

		it("times out a reply whose body stalls", async () => {
			const { baseUrl } = await fakeOllama((_, __, res) => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.write('{"choices":');
			});
			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl, timeoutMs: 50 }).chat(
					request,
				),
			);
			expect(error.kind).toBe("timeout");
		});
	});

	describe("cancellation", () => {
		it("aborts a request in flight", async () => {
			const controller = new AbortController();
			const { baseUrl } = await fakeOllama(() => controller.abort());
			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl }).chat(request, {
					signal: controller.signal,
				}),
			);
			expect(error.kind).toBe("aborted");
		});

		it("sends nothing when already aborted", async () => {
			const { baseUrl, received } = await fakeOllama((_, __, res) =>
				json(res, 200, completion({ content: "ok" })),
			);
			const error = await rejection(
				createOllamaProvider({ model: "m", baseUrl }).chat(request, {
					signal: AbortSignal.abort(),
				}),
			);
			expect(error.kind).toBe("aborted");
			expect(received).toEqual([]);
		});
	});
});
