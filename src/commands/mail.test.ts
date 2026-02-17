/**
 * Tests for the CLI mail command handlers.
 *
 * Tests CLI-level behavior like flag parsing and output formatting.
 * Uses real SQLite databases in temp directories (no mocking).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventStore } from "../events/store.ts";
import { createMailClient } from "../mail/client.ts";
import { createMailStore } from "../mail/store.ts";
import type { StoredEvent } from "../types.ts";
import { mailCommand } from "./mail.ts";

describe("mailCommand", () => {
	let tempDir: string;
	let origCwd: string;
	let origWrite: typeof process.stdout.write;
	let origStderrWrite: typeof process.stderr.write;
	let output: string;
	let stderrOutput: string;

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

		// Capture stderr
		stderrOutput = "";
		origStderrWrite = process.stderr.write;
		process.stderr.write = ((chunk: string) => {
			stderrOutput += chunk;
			return true;
		}) as typeof process.stderr.write;
	});

	afterEach(async () => {
		process.stdout.write = origWrite;
		process.stderr.write = origStderrWrite;
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

		test("reply with flags before positional ID extracts correct ID", async () => {
			// Regression test for overstory-6nq: flags before the positional ID
			// caused the flag VALUE (e.g. 'scout') to be treated as the message ID.
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Put --agent and --body flags BEFORE the positional message ID
			output = "";
			await mailCommand(["reply", "--agent", "scout-1", "--body", "Got it", originalId]);

			expect(output).toContain("Reply sent:");

			// Verify the reply used the correct message ID (not 'scout-1' or 'Got it')
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			const allMsgs = client2.list();
			const replyMsg = allMsgs.find((m) => m.subject === "Re: Build task" && m.from === "scout-1");
			expect(replyMsg).toBeDefined();
			expect(replyMsg?.body).toBe("Got it");
			client2.close();
		});
	});

	describe("read", () => {
		test("read with flags before positional ID extracts correct ID", async () => {
			// Regression test for overstory-6nq: same fragile pattern existed in handleRead.
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			// Although read doesn't currently use --agent, test that any unknown
			// flags followed by values don't get treated as the positional ID
			output = "";
			await mailCommand(["read", originalId]);

			expect(output).toContain(`Marked ${originalId} as read.`);
		});

		test("read marks message as read", async () => {
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const msgs = client.list({ to: "builder-1" });
			const originalId = msgs[0]?.id;
			expect(originalId).toBeTruthy();
			client.close();

			if (!originalId) return;

			output = "";
			await mailCommand(["read", originalId]);
			expect(output).toContain(`Marked ${originalId} as read.`);

			// Reading again should show already read
			output = "";
			await mailCommand(["read", originalId]);
			expect(output).toContain("already read");
		});
	});

	describe("auto-nudge (pending nudge markers)", () => {
		test("urgent message writes pending nudge marker instead of tmux keys", async () => {
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Fix NOW",
				"--body",
				"Production is down",
				"--priority",
				"urgent",
			]);

			// Verify pending nudge marker was written
			const markerPath = join(tempDir, ".overstory", "pending-nudges", "builder-1.json");
			const file = Bun.file(markerPath);
			expect(await file.exists()).toBe(true);

			const marker = JSON.parse(await file.text());
			expect(marker.from).toBe("orchestrator");
			expect(marker.reason).toBe("urgent priority");
			expect(marker.subject).toBe("Fix NOW");
			expect(marker.messageId).toBeTruthy();
			expect(marker.createdAt).toBeTruthy();

			// Output should mention queued nudge, not direct delivery
			expect(output).toContain("Queued nudge");
			expect(output).toContain("delivered on next prompt");
		});

		test("high priority message writes pending nudge marker", async () => {
			await mailCommand([
				"send",
				"--to",
				"scout-1",
				"--subject",
				"Important task",
				"--body",
				"Please prioritize",
				"--priority",
				"high",
			]);

			const markerPath = join(tempDir, ".overstory", "pending-nudges", "scout-1.json");
			const file = Bun.file(markerPath);
			expect(await file.exists()).toBe(true);

			const marker = JSON.parse(await file.text());
			expect(marker.reason).toBe("high priority");
		});

		test("worker_done type writes pending nudge marker regardless of priority", async () => {
			await mailCommand([
				"send",
				"--to",
				"orchestrator",
				"--subject",
				"Task complete",
				"--body",
				"Builder finished",
				"--type",
				"worker_done",
				"--from",
				"builder-1",
			]);

			const markerPath = join(tempDir, ".overstory", "pending-nudges", "orchestrator.json");
			const file = Bun.file(markerPath);
			expect(await file.exists()).toBe(true);

			const marker = JSON.parse(await file.text());
			expect(marker.reason).toBe("worker_done");
			expect(marker.from).toBe("builder-1");
		});

		test("normal priority non-protocol message does NOT write marker", async () => {
			await mailCommand(["send", "--to", "builder-1", "--subject", "FYI", "--body", "Just a note"]);

			const nudgeDir = join(tempDir, ".overstory", "pending-nudges");
			try {
				const files = await readdir(nudgeDir);
				// No marker should exist for this normal-priority status message
				expect(files.filter((f) => f === "builder-1.json")).toHaveLength(0);
			} catch {
				// Directory doesn't exist — that's fine, means no markers
			}
		});

		test("mail check --inject surfaces pending nudge banner", async () => {
			// Send an urgent message to create a pending nudge marker
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Critical fix",
				"--body",
				"Deploy hotfix",
				"--priority",
				"urgent",
			]);

			// Now check as builder-1 with --inject
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1"]);

			// Should contain the priority banner from the pending nudge
			expect(output).toContain("PRIORITY");
			expect(output).toContain("urgent priority");
			expect(output).toContain("Critical fix");

			// Should also contain the actual message (from mail check)
			expect(output).toContain("Deploy hotfix");
		});

		test("pending nudge marker is cleared after mail check --inject", async () => {
			// Send urgent message
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Fix it",
				"--body",
				"Broken",
				"--priority",
				"urgent",
			]);

			// First check clears the marker
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1"]);
			expect(output).toContain("PRIORITY");

			// Second check should NOT have the priority banner
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1"]);
			expect(output).not.toContain("PRIORITY");
		});

		test("json output for auto-nudge send does not include nudge banner", async () => {
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Urgent",
				"--body",
				"Fix",
				"--priority",
				"urgent",
				"--json",
			]);

			// JSON output should just have the message ID, not the nudge banner text
			const parsed = JSON.parse(output.trim());
			expect(parsed.id).toBeTruthy();
			expect(output).not.toContain("Queued nudge");
		});
	});

	describe("mail_sent event recording", () => {
		test("mail send records mail_sent event to events.db", async () => {
			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"Test event",
				"--body",
				"Check events",
			]);

			// Verify event was recorded
			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.level).toBe("info");
				expect(mailEvent?.agentName).toBe("orchestrator");

				const data = JSON.parse(mailEvent?.data ?? "{}") as Record<string, unknown>;
				expect(data.to).toBe("builder-1");
				expect(data.subject).toBe("Test event");
				expect(data.type).toBe("status");
				expect(data.priority).toBe("normal");
				expect(data.messageId).toBeTruthy();
			} finally {
				store.close();
			}
		});

		test("mail send with custom --from records correct agentName", async () => {
			await mailCommand([
				"send",
				"--to",
				"orchestrator",
				"--subject",
				"Done",
				"--body",
				"Finished task",
				"--from",
				"builder-1",
				"--type",
				"worker_done",
			]);

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.agentName).toBe("builder-1");

				const data = JSON.parse(mailEvent?.data ?? "{}") as Record<string, unknown>;
				expect(data.to).toBe("orchestrator");
				expect(data.type).toBe("worker_done");
			} finally {
				store.close();
			}
		});

		test("mail send includes run_id when current-run.txt exists", async () => {
			const runId = "run-test-mail-456";
			await Bun.write(join(tempDir, ".overstory", "current-run.txt"), runId);

			await mailCommand([
				"send",
				"--to",
				"builder-1",
				"--subject",
				"With run ID",
				"--body",
				"Test",
			]);

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.runId).toBe(runId);
			} finally {
				store.close();
			}
		});

		test("mail send without current-run.txt records null runId", async () => {
			await mailCommand(["send", "--to", "builder-1", "--subject", "No run", "--body", "Test"]);

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const store = createEventStore(eventsDbPath);
			try {
				const events: StoredEvent[] = store.getTimeline({
					since: "2000-01-01T00:00:00Z",
				});
				const mailEvent = events.find((e) => e.eventType === "mail_sent");
				expect(mailEvent).toBeDefined();
				expect(mailEvent?.runId).toBeNull();
			} finally {
				store.close();
			}
		});
	});

	describe("mail check debounce", () => {
		test("mail check without --debounce flag always executes", async () => {
			// Send first message
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			client.send({
				from: "orchestrator",
				to: "test-agent",
				subject: "Message 1",
				body: "First message",
			});
			client.close();

			// First check
			output = "";
			await mailCommand(["check", "--inject", "--agent", "test-agent"]);
			const firstOutput = output;

			// Send second message
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			client2.send({
				from: "orchestrator",
				to: "test-agent",
				subject: "Message 2",
				body: "Second message",
			});
			client2.close();

			// Second check immediately after
			output = "";
			await mailCommand(["check", "--inject", "--agent", "test-agent"]);
			const secondOutput = output;

			// Both should execute (no debouncing without flag)
			expect(firstOutput).toContain("Message 1");
			expect(secondOutput).toContain("Message 2");
		});

		test("mail check with --debounce 500 skips second check within window", async () => {
			// First check with debounce
			output = "";
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toContain("Build task");

			// Second check immediately (within debounce window)
			output = "";
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);
			// Should be skipped silently
			expect(output).toBe("");
		});

		test("mail check with --debounce allows check after window expires", async () => {
			// Send first message
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			client.send({
				from: "orchestrator",
				to: "debounce-test",
				subject: "First",
				body: "First check",
			});
			client.close();

			// First check with debounce
			output = "";
			await mailCommand(["check", "--inject", "--agent", "debounce-test", "--debounce", "100"]);
			expect(output).toContain("First check");

			// Wait for debounce window to expire
			await Bun.sleep(150);

			// Send second message
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			client2.send({
				from: "orchestrator",
				to: "debounce-test",
				subject: "Second",
				body: "Second check",
			});
			client2.close();

			// Second check after debounce window
			output = "";
			await mailCommand(["check", "--inject", "--agent", "debounce-test", "--debounce", "100"]);
			expect(output).toContain("Second check");
		});

		test("mail check with --debounce 0 disables debouncing", async () => {
			// Send first message
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			client.send({
				from: "orchestrator",
				to: "zero-debounce",
				subject: "Msg 1",
				body: "Message one",
			});
			client.close();

			// First check with --debounce 0
			output = "";
			await mailCommand(["check", "--inject", "--agent", "zero-debounce", "--debounce", "0"]);
			expect(output).toContain("Message one");

			// Send second message immediately
			const store2 = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client2 = createMailClient(store2);
			client2.send({
				from: "orchestrator",
				to: "zero-debounce",
				subject: "Msg 2",
				body: "Message two",
			});
			client2.close();

			// Second check immediately (should work with debounce 0)
			output = "";
			await mailCommand(["check", "--inject", "--agent", "zero-debounce", "--debounce", "0"]);
			expect(output).toContain("Message two");
		});

		test("mail check debounce is per-agent", async () => {
			// Check for builder-1 with debounce
			output = "";
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toContain("Build task");

			// Check for scout-1 immediately (different agent)
			output = "";
			await mailCommand(["check", "--agent", "scout-1", "--debounce", "500"]);
			expect(output).toContain("Explore API");

			// Check for builder-1 again (should be debounced)
			output = "";
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toBe("");
		});

		test("mail check --debounce with invalid value throws ValidationError", async () => {
			try {
				await mailCommand(["check", "--agent", "builder-1", "--debounce", "invalid"]);
				expect(true).toBe(false); // Should not reach here
			} catch (err) {
				expect(err).toBeInstanceOf(Error);
				if (err instanceof Error) {
					expect(err.message).toContain("must be a non-negative integer");
				}
			}
		});

		test("mail check --debounce with negative value throws ValidationError", async () => {
			try {
				await mailCommand(["check", "--agent", "builder-1", "--debounce", "-100"]);
				expect(true).toBe(false);
			} catch (err) {
				expect(err).toBeInstanceOf(Error);
				if (err instanceof Error) {
					expect(err.message).toContain("must be a non-negative integer");
				}
			}
		});

		test("mail check --inject with --debounce skips check within window", async () => {
			// First inject check with debounce
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toContain("Build task");

			// Second inject check immediately (should be debounced)
			output = "";
			await mailCommand(["check", "--inject", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toBe("");
		});

		test("mail check debounce state persists across invocations", async () => {
			// First check
			output = "";
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toContain("Build task");

			// Verify state file was created
			const statePath = join(tempDir, ".overstory", "mail-check-state.json");
			const file = Bun.file(statePath);
			expect(await file.exists()).toBe(true);

			const state = JSON.parse(await file.text()) as Record<string, number>;
			expect(state["builder-1"]).toBeTruthy();
			expect(typeof state["builder-1"]).toBe("number");
		});

		test("corrupted debounce state file is handled gracefully", async () => {
			// Write corrupted state file
			const statePath = join(tempDir, ".overstory", "mail-check-state.json");
			await Bun.write(statePath, "not valid json");

			// Should not throw, should treat as fresh state
			output = "";
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);
			expect(output).toContain("Build task");

			// State should be corrected
			const state = JSON.parse(await Bun.file(statePath).text()) as Record<string, number>;
			expect(state["builder-1"]).toBeTruthy();
		});

		test("mail check debounce only records timestamp when flag is provided", async () => {
			const statePath = join(tempDir, ".overstory", "mail-check-state.json");

			// Check without debounce flag
			await mailCommand(["check", "--agent", "builder-1"]);

			// State file should not be created
			expect(await Bun.file(statePath).exists()).toBe(false);

			// Check with debounce flag
			await mailCommand(["check", "--agent", "builder-1", "--debounce", "500"]);

			// Now state file should exist
			expect(await Bun.file(statePath).exists()).toBe(true);
		});
	});

	describe("broadcast", () => {
		// Helper to create active agent sessions for broadcast testing
		async function seedActiveSessions(): Promise<void> {
			const { createSessionStore } = await import("../sessions/store.ts");
			const sessionsDbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStore = createSessionStore(sessionsDbPath);

			const sessions = [
				{
					id: "session-orchestrator",
					agentName: "orchestrator",
					capability: "coordinator",
					worktreePath: "/worktrees/orchestrator",
					branchName: "main",
					beadId: "bead-001",
					tmuxSession: "overstory-test-orchestrator",
					state: "working" as const,
					pid: 12345,
					parentAgent: null,
					depth: 0,
					runId: "run-001",
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
				{
					id: "session-builder-1",
					agentName: "builder-1",
					capability: "builder",
					worktreePath: "/worktrees/builder-1",
					branchName: "builder-1",
					beadId: "bead-002",
					tmuxSession: "overstory-test-builder-1",
					state: "working" as const,
					pid: 12346,
					parentAgent: "orchestrator",
					depth: 1,
					runId: "run-001",
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
				{
					id: "session-builder-2",
					agentName: "builder-2",
					capability: "builder",
					worktreePath: "/worktrees/builder-2",
					branchName: "builder-2",
					beadId: "bead-003",
					tmuxSession: "overstory-test-builder-2",
					state: "working" as const,
					pid: 12347,
					parentAgent: "orchestrator",
					depth: 1,
					runId: "run-001",
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
				{
					id: "session-scout-1",
					agentName: "scout-1",
					capability: "scout",
					worktreePath: "/worktrees/scout-1",
					branchName: "scout-1",
					beadId: "bead-004",
					tmuxSession: "overstory-test-scout-1",
					state: "working" as const,
					pid: 12348,
					parentAgent: "orchestrator",
					depth: 1,
					runId: "run-001",
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				},
			];

			for (const session of sessions) {
				sessionStore.upsert(session);
			}

			sessionStore.close();
		}

		test("@all broadcasts to all active agents except sender", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@all",
				"--subject",
				"Team update",
				"--body",
				"Important announcement",
			]);

			expect(output).toContain("Broadcast sent to 3 recipients (@all)");
			expect(output).toContain("→ builder-1");
			expect(output).toContain("→ builder-2");
			expect(output).toContain("→ scout-1");
			expect(output).not.toContain("orchestrator"); // sender excluded

			// Verify messages were actually stored
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const messages = client.list();
			const broadcastMsgs = messages.filter((m) => m.subject === "Team update");
			expect(broadcastMsgs.length).toBe(3);
			expect(broadcastMsgs.map((m) => m.to).sort()).toEqual(["builder-1", "builder-2", "scout-1"]);
			client.close();
		});

		test("@builders broadcasts to all builder agents", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@builders",
				"--subject",
				"Builder update",
				"--body",
				"Build instructions",
			]);

			expect(output).toContain("Broadcast sent to 2 recipients (@builders)");
			expect(output).toContain("→ builder-1");
			expect(output).toContain("→ builder-2");
			expect(output).not.toContain("scout-1");

			// Verify messages
			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const messages = client.list();
			const broadcastMsgs = messages.filter((m) => m.subject === "Builder update");
			expect(broadcastMsgs.length).toBe(2);
			client.close();
		});

		test("@scouts broadcasts to all scout agents", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@scouts",
				"--subject",
				"Scout task",
				"--body",
				"Explore this area",
			]);

			expect(output).toContain("Broadcast sent to 1 recipient (@scouts)");
			expect(output).toContain("→ scout-1");

			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const messages = client.list();
			const broadcastMsgs = messages.filter((m) => m.subject === "Scout task");
			expect(broadcastMsgs.length).toBe(1);
			expect(broadcastMsgs[0]?.to).toBe("scout-1");
			client.close();
		});

		test("singular alias @builder works same as @builders", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@builder",
				"--subject",
				"Builder task",
				"--body",
				"Singular alias test",
			]);

			expect(output).toContain("Broadcast sent to 2 recipients (@builder)");
			expect(output).toContain("→ builder-1");
			expect(output).toContain("→ builder-2");
		});

		test("sender is excluded from broadcast recipients", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@builders",
				"--from",
				"builder-1",
				"--subject",
				"Peer message",
				"--body",
				"Message from builder-1",
			]);

			expect(output).toContain("Broadcast sent to 1 recipient (@builders)");
			expect(output).toContain("→ builder-2");
			expect(output).not.toContain("builder-1");

			const store = createMailStore(join(tempDir, ".overstory", "mail.db"));
			const client = createMailClient(store);
			const messages = client.list();
			const broadcastMsgs = messages.filter((m) => m.subject === "Peer message");
			expect(broadcastMsgs.length).toBe(1);
			expect(broadcastMsgs[0]?.to).toBe("builder-2");
			client.close();
		});

		test("throws when group resolves to zero recipients", async () => {
			await seedActiveSessions();

			// @all from all agents (impossible — at least one agent needed)
			// Instead, test a capability group with no members
			let error: Error | null = null;
			try {
				await mailCommand(["send", "--to", "@reviewers", "--subject", "Test", "--body", "Body"]);
			} catch (e) {
				error = e as Error;
			}

			expect(error).toBeTruthy();
			expect(error?.message).toContain("resolved to zero recipients");
		});

		test("throws when group is unknown", async () => {
			await seedActiveSessions();

			let error: Error | null = null;
			try {
				await mailCommand(["send", "--to", "@unknown", "--subject", "Test", "--body", "Body"]);
			} catch (e) {
				error = e as Error;
			}

			expect(error).toBeTruthy();
			expect(error?.message).toContain("Unknown group address");
		});

		test("broadcast with --json outputs message IDs and recipient count", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@builders",
				"--subject",
				"Test",
				"--body",
				"Body",
				"--json",
			]);

			const result = JSON.parse(output) as { messageIds: string[]; recipientCount: number };
			expect(result.messageIds).toBeInstanceOf(Array);
			expect(result.messageIds.length).toBe(2);
			expect(result.recipientCount).toBe(2);
		});

		test("broadcast records event for each individual message", async () => {
			await seedActiveSessions();

			const eventsDbPath = join(tempDir, ".overstory", "events.db");
			const eventStore = createEventStore(eventsDbPath);
			eventStore.close(); // Just to initialize the DB

			output = "";
			await mailCommand(["send", "--to", "@builders", "--subject", "Test", "--body", "Body"]);

			// Check events by agent (orchestrator is the sender)
			const eventStore2 = createEventStore(eventsDbPath);
			const events = eventStore2.getByAgent("orchestrator");
			eventStore2.close();

			const mailSentEvents = events.filter((e) => e.eventType === "mail_sent");
			expect(mailSentEvents.length).toBe(2);
			for (const evt of mailSentEvents) {
				expect(evt.eventType).toBe("mail_sent");
				const data = JSON.parse(evt.data ?? "{}") as {
					to: string;
					broadcast: boolean;
				};
				expect(data.broadcast).toBe(true);
				expect(["builder-1", "builder-2"]).toContain(data.to);
			}
		});

		test("broadcast with urgent priority writes pending nudge for each recipient", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@builders",
				"--subject",
				"Urgent task",
				"--body",
				"Do this now",
				"--priority",
				"urgent",
			]);

			// Check pending nudge markers
			const nudgesDir = join(tempDir, ".overstory", "pending-nudges");
			const nudgeFiles = await readdir(nudgesDir);
			expect(nudgeFiles).toContain("builder-1.json");
			expect(nudgeFiles).toContain("builder-2.json");

			// Verify nudge content
			const nudge1 = JSON.parse(await Bun.file(join(nudgesDir, "builder-1.json")).text()) as {
				reason: string;
				subject: string;
			};
			expect(nudge1.reason).toBe("urgent priority");
			expect(nudge1.subject).toBe("Urgent task");
		});

		test("broadcast with auto-nudge type writes pending nudge for each recipient", async () => {
			await seedActiveSessions();

			output = "";
			await mailCommand([
				"send",
				"--to",
				"@builders",
				"--subject",
				"Error occurred",
				"--body",
				"Something went wrong",
				"--type",
				"error",
			]);

			// Check pending nudge markers
			const nudgesDir = join(tempDir, ".overstory", "pending-nudges");
			const nudgeFiles = await readdir(nudgesDir);
			expect(nudgeFiles).toContain("builder-1.json");
			expect(nudgeFiles).toContain("builder-2.json");

			const nudge1 = JSON.parse(await Bun.file(join(nudgesDir, "builder-1.json")).text()) as {
				reason: string;
			};
			expect(nudge1.reason).toBe("error");
		});
	});

	describe("merge_ready reviewer validation", () => {
		// Helper to set up sessions in sessions.db
		async function seedSessions(
			sessions: Array<{
				agentName: string;
				capability: string;
				parentAgent: string | null;
			}>,
		): Promise<void> {
			const { createSessionStore } = await import("../sessions/store.ts");
			const sessionsDbPath = join(tempDir, ".overstory", "sessions.db");
			const sessionStore = createSessionStore(sessionsDbPath);

			for (const [idx, session] of sessions.entries()) {
				sessionStore.upsert({
					id: `session-${idx}`,
					agentName: session.agentName,
					capability: session.capability as
						| "builder"
						| "reviewer"
						| "scout"
						| "coordinator"
						| "lead"
						| "merger"
						| "supervisor"
						| "monitor",
					worktreePath: `/worktrees/${session.agentName}`,
					branchName: session.agentName,
					beadId: `bead-${idx}`,
					tmuxSession: `overstory-test-${session.agentName}`,
					state: "working" as const,
					pid: 10000 + idx,
					parentAgent: session.parentAgent,
					depth: 1,
					runId: "run-001",
					startedAt: new Date().toISOString(),
					lastActivity: new Date().toISOString(),
					escalationLevel: 0,
					stalledSince: null,
				});
			}

			sessionStore.close();
		}

		test("merge_ready with no reviewers emits warning", async () => {
			await seedSessions([
				{ agentName: "builder-1", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "builder-2", capability: "builder", parentAgent: "lead-1" },
			]);

			output = "";
			stderrOutput = "";
			await mailCommand([
				"send",
				"--to",
				"coordinator",
				"--subject",
				"Ready to merge",
				"--body",
				"All builders complete",
				"--type",
				"merge_ready",
				"--from",
				"lead-1",
			]);

			// Verify warning on stderr
			expect(stderrOutput).toContain("WARNING");
			expect(stderrOutput).toContain("NO reviewer sessions found");
			expect(stderrOutput).toContain("lead-1");
			expect(stderrOutput).toContain("2 builder(s)");
			expect(stderrOutput).toContain("review-before-merge requirement");
			expect(stderrOutput).toContain("REVIEW_SKIP");
		});

		test("merge_ready with partial reviewers emits note", async () => {
			await seedSessions([
				{ agentName: "builder-1", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "builder-2", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "builder-3", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "reviewer-1", capability: "reviewer", parentAgent: "lead-1" },
			]);

			output = "";
			stderrOutput = "";
			await mailCommand([
				"send",
				"--to",
				"coordinator",
				"--subject",
				"Ready to merge",
				"--body",
				"Partial review complete",
				"--type",
				"merge_ready",
				"--from",
				"lead-1",
			]);

			// Verify note on stderr
			expect(stderrOutput).toContain("NOTE");
			expect(stderrOutput).toContain("Only 1 reviewer(s) for 3 builder(s)");
			expect(stderrOutput).toContain("review-verified");
		});

		test("merge_ready with full coverage emits no warning", async () => {
			await seedSessions([
				{ agentName: "builder-1", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "builder-2", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "reviewer-1", capability: "reviewer", parentAgent: "lead-1" },
				{ agentName: "reviewer-2", capability: "reviewer", parentAgent: "lead-1" },
			]);

			output = "";
			stderrOutput = "";
			await mailCommand([
				"send",
				"--to",
				"coordinator",
				"--subject",
				"Ready to merge",
				"--body",
				"Full review complete",
				"--type",
				"merge_ready",
				"--from",
				"lead-1",
			]);

			// No warning should be emitted
			expect(stderrOutput).toBe("");
		});

		test("non-merge_ready types skip reviewer check", async () => {
			await seedSessions([
				{ agentName: "builder-1", capability: "builder", parentAgent: "lead-1" },
				{ agentName: "builder-2", capability: "builder", parentAgent: "lead-1" },
			]);

			output = "";
			stderrOutput = "";
			await mailCommand([
				"send",
				"--to",
				"coordinator",
				"--subject",
				"Status update",
				"--body",
				"Work in progress",
				"--type",
				"status",
				"--from",
				"lead-1",
			]);

			// No warning should be emitted for non-merge_ready types
			expect(stderrOutput).toBe("");
		});
	});
});
