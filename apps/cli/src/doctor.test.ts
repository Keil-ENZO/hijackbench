import { describe, expect, it } from "vitest";
import { renderChecks, renderModels } from "./doctor.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colors
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderChecks", () => {
	it("prints every check, the fix under a failure, and a verdict", () => {
		const out = plain(
			renderChecks([
				{ name: "Ollama", status: "ok", detail: "0.35.1" },
				{
					name: "Thermal probe",
					status: "fail",
					detail: "cannot read /prom",
					fix: "Start gputemps-exporter.",
				},
			]),
		);
		expect(out).toContain("✓ Ollama         0.35.1");
		expect(out).toContain("✗ Thermal probe  cannot read /prom");
		expect(out).toContain("→ Start gputemps-exporter.");
		expect(out).toMatch(/1 problem to fix before a campaign\.$/);
	});

	it("is ready with warnings only", () => {
		const out = plain(
			renderChecks([
				{ name: "GPU", status: "warn", detail: "split", fix: "x" },
			]),
		);
		expect(out).toMatch(/Ready, with 1 warning\.$/);
	});
});

describe("renderModels", () => {
	it("lists the models with their tool support and VRAM share", () => {
		const out = plain(
			renderModels(
				[
					{
						name: "gemma4:26b",
						size: 18.7e9,
						parameterSize: "25.2B",
						quantization: "Q4_K_M",
						tools: true,
					},
					{
						name: "old:7b",
						size: 4e9,
						parameterSize: null,
						quantization: null,
						tools: false,
					},
				],
				[{ name: "gemma4:26b", size: 20e9, sizeVram: 20e9 }],
			),
		);
		expect(out).toMatch(
			/gemma4:26b\s+25\.2B\s+Q4_K_M\s+18\.7 GB\s+yes\s+100 % in VRAM/,
		);
		expect(out).toMatch(/old:7b\s+\?\s+\?\s+4\.0 GB\s+no$/m);
		expect(out).toContain("2 models, 1 with tool support.");
	});

	it("says how to get a model when there is none", () => {
		expect(renderModels([], [])).toContain("ollama pull");
	});
});
