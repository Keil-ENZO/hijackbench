import { describe, expect, it } from "vitest";
import { VERSION } from "./index.ts";

describe("core", () => {
	it("exposes a version", () => {
		expect(VERSION).toBe("0.0.0");
	});
});
