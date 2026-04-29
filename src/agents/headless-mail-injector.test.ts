import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { type InjectionWriteResult, startMailInjectionLoop } from "./headless-mail-injector.ts";

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

	function makeWriter(received: string[], result: InjectionWriteResult = "delivered") {
		return (data: string | Uint8Array): InjectionWriteResult => {
			received.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			return result;
		};
	}

	test("delivers unread mail via writer fn as stream-json user turn", async () => {
		const received: string[] = [];

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

		const stop = startMailInjectionLoop("test-agent", makeWriter(received), mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBeGreaterThan(0);
		const firstMessage = received[0];
		expect(firstMessage).toBeDefined();
		const parsed = JSON.parse(firstMessage?.trimEnd() ?? "");
		expect(parsed.type).toBe("user");
		expect(parsed.message.role).toBe("user");
		const text: string = parsed.message.content[0].text;
		expect(text).toContain("Dispatch: test-task");
		expect(text).toContain("Begin working on test-task.");
	});

	test("batches multiple pending messages into one user turn", async () => {
		const received: string[] = [];

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

		const stop = startMailInjectionLoop("test-agent", makeWriter(received), mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBeGreaterThanOrEqual(1);
		const batchedText = received[0] ?? "";
		expect(batchedText).toContain("Task A");
		expect(batchedText).toContain("Task B");
	});

	test("does not invoke writer when no unread mail", async () => {
		const received: string[] = [];

		const stop = startMailInjectionLoop("test-agent", makeWriter(received), mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		expect(received.length).toBe(0);
	});

	test("marks messages as read after successful delivery", async () => {
		const writer = (_data: string | Uint8Array): InjectionWriteResult => "delivered";

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

		const stop = startMailInjectionLoop("reader-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 350));
		stop();

		const checkStore = createMailStore(mailDbPath);
		try {
			const remaining = checkStore.getUnread("reader-agent");
			expect(remaining.length).toBe(0);
		} finally {
			checkStore.close();
		}
	});

	test("leaves messages unread when writer reports no-reader", async () => {
		const writer = (_data: string | Uint8Array): InjectionWriteResult => "no-reader";

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "absent-agent",
			subject: "Wait",
			body: "Hold for revive.",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("absent-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 250));
		stop();

		const checkStore = createMailStore(mailDbPath);
		try {
			const remaining = checkStore.getUnread("absent-agent");
			expect(remaining.length).toBe(1);
		} finally {
			checkStore.close();
		}
	});

	test("auto-stops the loop after writer reports no-reader", async () => {
		let invocations = 0;
		const writer = (_data: string | Uint8Array): InjectionWriteResult => {
			invocations++;
			return "no-reader";
		};

		const store = createMailStore(mailDbPath);
		const client = createMailClient(store);
		client.send({
			from: "coordinator",
			to: "stopped-agent",
			subject: "X",
			body: "y",
			type: "dispatch",
			priority: "normal",
		});
		store.close();

		const stop = startMailInjectionLoop("stopped-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 500));
		stop();

		// The loop should have invoked the writer exactly once before
		// auto-stopping; further ticks must not fire it again.
		expect(invocations).toBe(1);
	});

	test("returns a cleanup function that stops the loop", async () => {
		let writeCount = 0;
		const writer = (_data: string | Uint8Array): InjectionWriteResult => {
			writeCount++;
			return "delivered";
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

		const stop = startMailInjectionLoop("stop-test-agent", writer, mailDbPath, 100);
		await new Promise((resolve) => setTimeout(resolve, 150));
		stop();

		const countAfterStop = writeCount;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(writeCount).toBe(countAfterStop);
	});
});
