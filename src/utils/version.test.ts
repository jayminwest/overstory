import { describe, expect, test } from "bun:test";
import { fetchLatestVersion, getCurrentVersion, getInstalledVersion } from "./version.ts";

describe("getCurrentVersion", () => {
	test("returns a semver string", async () => {
		const version = await getCurrentVersion();
		expect(version).toMatch(/^\d+\.\d+\.\d+/);
	});
});

describe("fetchLatestVersion", () => {
	test("fetches a semver string from npm registry", async () => {
		const version = await fetchLatestVersion("@os-eco/overstory-cli");
		expect(version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("throws for nonexistent package", async () => {
		await expect(fetchLatestVersion("@nonexistent/package-xyz-999")).rejects.toThrow();
	});
});

describe("getInstalledVersion", () => {
	test("returns version for an installed CLI (bun)", async () => {
		const version = await getInstalledVersion("bun");
		expect(version).not.toBeNull();
		expect(version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("returns null for nonexistent CLI", async () => {
		const version = await getInstalledVersion("nonexistent-cli-xyz-999");
		expect(version).toBeNull();
	});
});
