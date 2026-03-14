import { describe, expect, test } from "bun:test";
import { resolveOverstoryBin } from "./bin.ts";

describe("resolveOverstoryBin", () => {
	test("returns a non-empty string", async () => {
		const bin = await resolveOverstoryBin();
		expect(typeof bin).toBe("string");
		expect(bin.length).toBeGreaterThan(0);
	});
});
