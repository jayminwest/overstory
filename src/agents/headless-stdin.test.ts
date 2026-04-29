import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentFifoPath,
	createAgentFifo,
	removeAgentFifo,
	writeToAgentFifo,
} from "./headless-stdin.ts";

describe("headless-stdin", () => {
	let overstoryDir: string;

	beforeEach(() => {
		overstoryDir = mkdtempSync(join(tmpdir(), "overstory-fifo-test-"));
	});

	afterEach(() => {
		rmSync(overstoryDir, { recursive: true, force: true });
	});

	test("agentFifoPath builds path under agents/<name>/stdin.fifo", () => {
		expect(agentFifoPath("/tmp/overstory", "alice")).toBe("/tmp/overstory/agents/alice/stdin.fifo");
	});

	test("createAgentFifo mkfifo's the path and returns an open RDWR fd", () => {
		const fd = createAgentFifo(overstoryDir, "alpha");
		try {
			expect(typeof fd).toBe("number");
			expect(fd).toBeGreaterThan(0);
			expect(existsSync(agentFifoPath(overstoryDir, "alpha"))).toBe(true);
		} finally {
			closeSync(fd);
			removeAgentFifo(overstoryDir, "alpha");
		}
	});

	test("createAgentFifo is idempotent on a stale FIFO file", () => {
		const fd1 = createAgentFifo(overstoryDir, "alpha");
		closeSync(fd1);
		// File still on disk; second call must reuse it without throwing.
		const fd2 = createAgentFifo(overstoryDir, "alpha");
		try {
			expect(fd2).toBeGreaterThan(0);
		} finally {
			closeSync(fd2);
			removeAgentFifo(overstoryDir, "alpha");
		}
	});

	test("writeToAgentFifo returns no-reader when FIFO file is missing", () => {
		expect(writeToAgentFifo(overstoryDir, "ghost", "data")).toBe("no-reader");
	});

	test("writeToAgentFifo returns no-reader when FIFO exists but no reader is open", () => {
		const fd = createAgentFifo(overstoryDir, "lonely");
		// Close our RDWR handle — now no reader is open.
		closeSync(fd);
		expect(writeToAgentFifo(overstoryDir, "lonely", "data")).toBe("no-reader");
		removeAgentFifo(overstoryDir, "lonely");
	});

	test("writeToAgentFifo delivers when a reader is open", async () => {
		// Simulate the agent: spawn a subprocess that reads stdin and writes
		// captured bytes to a file we can inspect afterward. Use a real script
		// path because `bun run -e` buffers and may not flush before kill().
		const fd = createAgentFifo(overstoryDir, "delivery");
		const outFile = join(overstoryDir, "captured.txt");
		const scriptPath = join(overstoryDir, "reader.ts");
		Bun.write(
			scriptPath,
			`import { openSync, writeSync, closeSync } from "node:fs";
			 const out = openSync(${JSON.stringify(outFile)}, "w");
			 for await (const chunk of Bun.stdin.stream()) {
			   writeSync(out, chunk);
			 }
			 closeSync(out);
			`,
		);
		// Wait for write to flush to disk before spawn.
		await Bun.sleep(50);

		const reader = Bun.spawn(["bun", "run", scriptPath], {
			stdin: fd,
			stdout: "pipe",
			stderr: "pipe",
		});
		closeSync(fd); // child has it now

		// Give the reader a moment to attach to its stdin and start the loop.
		await Bun.sleep(300);

		const result = writeToAgentFifo(overstoryDir, "delivery", "hello-world\n");
		expect(result).toBe("delivered");

		// Wait for the line to land in the capture file.
		await Bun.sleep(200);
		reader.kill();
		await reader.exited;

		const captured = readFileSync(outFile, "utf-8");
		expect(captured).toBe("hello-world\n");

		removeAgentFifo(overstoryDir, "delivery");
	});

	test("removeAgentFifo unlinks the file and is idempotent", () => {
		const fd = createAgentFifo(overstoryDir, "trash");
		closeSync(fd);
		const path = agentFifoPath(overstoryDir, "trash");
		expect(existsSync(path)).toBe(true);

		removeAgentFifo(overstoryDir, "trash");
		expect(existsSync(path)).toBe(false);

		// Second call: no-op, no throw.
		removeAgentFifo(overstoryDir, "trash");
	});

	test("createAgentFifo without close + writeToAgentFifo delivers via RDWR holder", () => {
		// Mirror the production flow: caller holds an RDWR fd until spawn happens.
		// The RDWR handle counts as a reader, so writes succeed even before any
		// child process is attached.
		const fd = createAgentFifo(overstoryDir, "rdwr");
		try {
			const result = writeToAgentFifo(overstoryDir, "rdwr", "ping\n");
			expect(result).toBe("delivered");
			// Drain the FIFO so the test doesn't leak buffer state.
			const buf = new Uint8Array(64);
			const fs = require("node:fs") as typeof import("node:fs");
			const n = fs.readSync(fd, buf, 0, buf.length, null);
			expect(new TextDecoder().decode(buf.subarray(0, n))).toBe("ping\n");
		} finally {
			closeSync(fd);
			removeAgentFifo(overstoryDir, "rdwr");
		}
	});
});
