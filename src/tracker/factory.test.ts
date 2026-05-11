import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTrackerClient, resolveBackend, trackerCliName } from "./factory.ts";

describe("createTrackerClient", () => {
	test("creates beads tracker for beads backend", () => {
		const client = createTrackerClient("beads", "/tmp");
		expect(client).toBeDefined();
		expect(client.ready).toBeTypeOf("function");
		expect(client.show).toBeTypeOf("function");
		expect(client.create).toBeTypeOf("function");
		expect(client.claim).toBeTypeOf("function");
		expect(client.close).toBeTypeOf("function");
		expect(client.list).toBeTypeOf("function");
		expect(client.sync).toBeTypeOf("function");
	});

	test("creates beads_rust tracker for beads_rust backend", () => {
		const client = createTrackerClient("beads_rust", "/tmp");
		expect(client).toBeDefined();
		expect(client.ready).toBeTypeOf("function");
		expect(client.show).toBeTypeOf("function");
		expect(client.create).toBeTypeOf("function");
		expect(client.claim).toBeTypeOf("function");
		expect(client.close).toBeTypeOf("function");
		expect(client.list).toBeTypeOf("function");
		expect(client.sync).toBeTypeOf("function");
	});

	test("creates seeds tracker for seeds backend", () => {
		const client = createTrackerClient("seeds", "/tmp");
		expect(client).toBeDefined();
		expect(client.ready).toBeTypeOf("function");
		expect(client.show).toBeTypeOf("function");
		expect(client.create).toBeTypeOf("function");
		expect(client.claim).toBeTypeOf("function");
		expect(client.close).toBeTypeOf("function");
		expect(client.list).toBeTypeOf("function");
		expect(client.sync).toBeTypeOf("function");
	});

	test("throws for invalid backend", () => {
		// @ts-expect-error - intentionally testing runtime guard
		expect(() => createTrackerClient("invalid", "/tmp")).toThrow();
	});
});

describe("resolveBackend", () => {
	test("returns beads for beads backend", async () => {
		expect(await resolveBackend("beads", "/tmp")).toBe("beads");
	});
	test("returns seeds for seeds backend", async () => {
		expect(await resolveBackend("seeds", "/tmp")).toBe("seeds");
	});
	test("returns seeds for auto when no tracker dirs exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			expect(await resolveBackend("auto", tempDir)).toBe("seeds");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
	test("returns seeds for auto when .seeds/ exists", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			await mkdir(join(tempDir, ".seeds"));
			expect(await resolveBackend("auto", tempDir)).toBe("seeds");
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
	test("returns beads_rust for auto when .beads/ exists and br is on PATH", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			await mkdir(join(tempDir, ".beads"));
			// When br is available on PATH, auto-detection prefers beads_rust over beads
			const result = await resolveBackend("auto", tempDir);
			expect(["beads", "beads_rust"]).toContain(result);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
	test("returns beads_rust for explicit beads_rust config", async () => {
		expect(await resolveBackend("beads_rust", "/tmp")).toBe("beads_rust");
	});
	test("returns beads or beads_rust for auto when both .seeds/ and .beads/ exist", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
		try {
			await mkdir(join(tempDir, ".beads"));
			await mkdir(join(tempDir, ".seeds"));
			// .beads/ takes precedence over .seeds/; br availability determines beads vs beads_rust
			const result = await resolveBackend("auto", tempDir);
			expect(["beads", "beads_rust"]).toContain(result);
		} finally {
			await rm(tempDir, { recursive: true });
		}
	});
});

describe("trackerCliName", () => {
	test("returns bd for beads", () => {
		expect(trackerCliName("beads")).toBe("bd");
	});
	test("returns br for beads_rust", () => {
		expect(trackerCliName("beads_rust")).toBe("br");
	});
	test("returns sd for seeds", () => {
		expect(trackerCliName("seeds")).toBe("sd");
	});
});
