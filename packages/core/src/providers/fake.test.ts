import { describe, expect, it } from "vitest";
import { ProviderError } from "./errors.ts";
import { callTools, createFakeProvider, reply } from "./fake.ts";
import type { ChatRequest } from "./types.ts";

const request: ChatRequest = {
	messages: [{ role: "user", content: "hi" }],
	tools: [],
};

describe("fake provider", () => {
	it("plays its script in order and records requests", async () => {
		const provider = createFakeProvider([
			callTools({ name: "read_file", args: { path: "a.txt" } }),
			(req) => reply(`saw ${req.messages.length} messages`),
		]);

		const first = await provider.chat(request);
		expect(first.message.toolCalls).toEqual([
			{ id: "call_0", name: "read_file", arguments: '{"path":"a.txt"}' },
		]);

		const second = await provider.chat({
			...request,
			messages: [...request.messages, first.message],
		});
		expect(second.message.content).toBe("saw 2 messages");
		expect(provider.requests).toHaveLength(2);
	});

	it("throws a scripted error", async () => {
		const provider = createFakeProvider([
			new ProviderError("timeout", "too slow"),
		]);
		await expect(provider.chat(request)).rejects.toMatchObject({
			kind: "timeout",
		});
	});

	it("honors an aborted signal", async () => {
		const provider = createFakeProvider([reply("never")]);
		await expect(
			provider.chat(request, { signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ kind: "aborted" });
		expect(provider.requests).toEqual([]);
	});

	it("fails loudly when the script runs out", async () => {
		const provider = createFakeProvider([]);
		await expect(provider.chat(request)).rejects.toThrow(/ran out of steps/);
	});
});
