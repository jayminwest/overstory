/**
 * Tests for the CLI mail command handlers.
 *
 * Tests CLI-level behavior like flag parsing and output formatting.
 * Uses real SQLite databases in temp directories (no mocking).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import { mailCommand } from "./mail.ts";

describe("mailCommand", () => {
	let tempDir: string;
	let origCwd: string;
	let origWrite: typeof process.stdout.write;
	let output: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-mail-cmd-test-"));
		await mkdir(join(tempDir, ".overstory"), { recursive: true });

		// Seed some messages via the store directly
		const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
		const client = createMailClient(store);
		client.send({
			from: "orchestrator",
			to: "builder-1",
			subject: "Build task",
			body: "Implement feature X",
		});
		client.send({
			from: "orchestrator",
			to: "scout-1",
			subject: "Explore API",
			body: "Investigate endpoints",
		});
		client.close();

		// Change cwd to temp dir so the command finds .overstory/mail.db
		origCwd = process.cwd();
		process.chdir(tempDir);

		// Capture stdout
		output = "";
		origWrite = process.stdout.write;
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;
	});

	afterEach(async () => {
		process.stdout.write = origWrite;
		process.chdir(origCwd);
		await rm(tempDir, { recursive: true, force: true });
	});

	describe("list", () => {
		test("--unread shows all unread messages globally", async () => {
			await mailCommand(["list", "--unread"]);
			expect(output).toContain("Build task");
			expect(output).toContain("Explore API");
			expect(output).toContain("Total: 2 messages");
		});

		test("--agent filters by recipient (alias for --to)", async () => {
			await mailCommand(["list", "--agent", "builder-1"]);
			expect(output).toContain("Build task");
			expect(output).not.toContain("Explore API");
			expect(output).toContain("Total: 1 message");
		});

		test("--agent combined with --unread shows only unread for that agent", async () => {
			// Mark builder-1's message as read
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const msgId = msgs[0]?.id;
			expect(msgId).toBeTruthy();
			if (msgId) {
				client.markRead(msgId);
			}
			client.close();

			await mailCommand(["list", "--agent", "builder-1", "--unread"]);
			expect(output).toContain("No messages found.");
		});

		test("--to takes precedence over --agent when both provided", async () => {
			await mailCommand(["list", "--to", "scout-1", "--agent", "builder-1"]);
			// --to is checked first via getFlag, so it should win
			expect(output).toContain("Explore API");
			expect(output).not.toContain("Build task");
		});

		test("list without filters shows all messages", async () => {
			await mailCommand(["list"]);
			expect(output).toContain("Build task");
			expect(output).toContain("Explore API");
			expect(output).toContain("Total: 2 messages");
		});
	});

	describe("reply", () => {
		test("reply to own sent message goes to original recipient", async () => {
			// Get the message ID of the message orchestrator sent to builder-1
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Reply as orchestrator (the original sender)
			output = "";
			await mailCommand(["reply", originalId, "--body", "Actually also do Y"]);

			expect(output).toContain("Reply sent:");

			// Verify the reply went to builder-1, not back to orchestrator
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			const allMsgs = client2.list();
			const replyMsg = allMsgs.find((m) => m.subject === "Re: Build task");
			expect(replyMsg).toBeDefined();
			expect(replyMsg?.from).toBe("orchestrator");
			expect(replyMsg?.to).toBe("builder-1");
			client2.close();
		});

		test("reply as recipient goes to original sender", async () => {
			// Get the message ID
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Reply as builder-1 (the recipient of the original)
			output = "";
			await mailCommand(["reply", originalId, "--body", "Done", "--agent", "builder-1"]);

			expect(output).toContain("Reply sent:");

			// Verify the reply went to orchestrator (original sender)
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			const allMsgs = client2.list();
			const replyMsg = allMsgs.find(
				(m) => m.subject === "Re: Build task" && m.from === "builder-1",
			);
			expect(replyMsg).toBeDefined();
			expect(replyMsg?.from).toBe("builder-1");
			expect(replyMsg?.to).toBe("orchestrator");
			client2.close();
		});
	});
});
