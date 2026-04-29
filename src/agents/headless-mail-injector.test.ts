import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { startMailInjectionLoop } from "./headless-mail-injector.ts";

describe("startMailInjectionLoop", () => {
	let tempDir: string;
	let mailDbPath: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-injector-test-"));
		mailDbPath = join(tempDir, "mail.db");
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("delivers unread mail to agent stdin as stream-json user turn", async () => {
		const received: string[] = [];
		const mockStdin = {
			write(data: string | Uint8Array) {
				received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
				return Promise.resolve(typeof data === "string" ? data.length : data.byteLength);
			},
		};

		// Send a mail message before starting the loop
		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "test-agent",
			subject: "Dispatch: test-task",
			body: "Begin working on test-task.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		// Start injection loop with a short interval
		const stop = startMailInjectionLoop("test-agent", mockStdin, mailDbPath, 100);

		// Wait for at least one poll
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBeGreaterThan(0);
		const firstMessage = received[0];
		expect(firstMessage).toBeDefined();
		// Should be valid JSON ending with newline
		expect(firstMessage?.trimEnd()).toBeTruthy();
		const parsed = JSON.parse(firstMessage?.trimEnd() ?? "");
		expect(parsed.type).toBe("user");
		expect(parsed.message.role).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Dispatch: test-task");
		expect(text).toContain("Begin working on test-task.");
	});

	test("batches multiple pending messages into one user turn", async () => {
		const received: string[] = [];
		const mockStdin = {
			write(data: string | Uint8Array) {
				received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
				return Promise.resolve(0);
			},
		};

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "lead",
			to: "test-agent",
			subject: "Task A",
			body: "Work on A.",
			type: "dispatch",
			priority: "normal",
		});
		client.send({
			from: "orchestrator",
			to: "test-agent",
			subject: "Task B",
			body: "Work on B.",
			type: "status",
			priority: "low",
		});
		store.close();

		const stop = startMailInjectionLoop("test-agent", mockStdin, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		// Both messages should appear in a single write (batched)
		expect(received.length).toBeGreaterThanOrEqual(1);
		const batchedText = received[0] ?? "";
		expect(batchedText).toContain("Task A");
		expect(batchedText).toContain("Task B");
	});

	test("does not write to stdin when no unread mail", async () => {
		const received: string[] = [];
		const mockStdin = {
			write(data: string | Uint8Array) {
				received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
				return Promise.resolve(0);
			},
		};

		// No messages sent — inbox is empty
		const stop = startMailInjectionLoop("test-agent", mockStdin, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBe(0);
	});

	test("marks messages as read after delivery", async () => {
		const mockStdin = {
			write(_data: string | Uint8Array) {
				return Promise.resolve(0);
			},
		};

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "reader-agent",
			subject: "Once",
			body: "Deliver once only.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("reader-agent", mockStdin, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 350));
		stop();

		// After delivery, unread count should be 0
		const checkStore = createMailStore(mailDbPath);
		try {
			const remaining = checkStore.getUnread("reader-agent");
			expect(remaining.length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("returns a cleanup function that stops the loop", async () => {
		let writeCount = 0;
		const mockStdin = {
			write(_data: string | Uint8Array) {
				writeCount++;
				return Promise.resolve(0);
			},
		};

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "stop-test-agent",
			subject: "Stop test",
			body: "This should be delivered.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("stop-test-agent", mockStdin, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 150));
		stop();

		const countAfterStop = writeCount;
		// Wait another 300ms — the loop should not fire again
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(writeCount).toBe(countAfterStop);
	});
});
