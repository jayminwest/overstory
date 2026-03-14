import { describe, expect, test } from "bun:test";
import { parseRelativeTime } from "./time.ts";

describe("parseRelativeTime", () => {
	test("parses '30s' as ~30 seconds ago", () => {
		const before = Date.now();
		const result = parseRelativeTime("30s");
		const after = Date.now();
		expect(result.getTime()).toBeGreaterThanOrEqual(before - 30 * 1000 - 50);
		expect(result.getTime()).toBeLessThanOrEqual(after - 30 * 1000 + 50);
	});

	test("parses '5m' as ~5 minutes ago", () => {
		const before = Date.now();
		const result = parseRelativeTime("5m");
		const expected = before - 5 * 60 * 1000;
		expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
	});

	test("parses '2h' as ~2 hours ago", () => {
		const before = Date.now();
		const result = parseRelativeTime("2h");
		const expected = before - 2 * 60 * 60 * 1000;
		expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
	});

	test("parses '1d' as ~1 day ago", () => {
		const before = Date.now();
		const result = parseRelativeTime("1d");
		const expected = before - 24 * 60 * 60 * 1000;
		expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
	});

	test("parses ISO 8601 timestamp", () => {
		const result = parseRelativeTime("2026-01-15T10:30:00.000Z");
		expect(result.toISOString()).toBe("2026-01-15T10:30:00.000Z");
	});

	test("returns invalid Date for garbage input", () => {
		const result = parseRelativeTime("not-a-time");
		expect(Number.isNaN(result.getTime())).toBe(true);
	});
});
