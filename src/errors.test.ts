/**
 * Tests for all Overstory error classes.
 *
 * Validates constructor fields, instanceof chains, name, code, and cause chaining.
 */

import { describe, expect, test } from "bun:test";
import {
	AgentError,
	ConfigError,
	GroupError,
	HierarchyError,
	LifecycleError,
	MailError,
	MergeError,
	OverstoryError,
	ValidationError,
	WorktreeError,
} from "./errors.ts";

describe("OverstoryError", () => {
	test("sets message, code, and name", () => {
		const err = new OverstoryError("something broke", "TEST_CODE");
		expect(err.message).toBe("something broke");
		expect(err.code).toBe("TEST_CODE");
		expect(err.name).toBe("OverstoryError");
	});

	test("is instanceof Error", () => {
		const err = new OverstoryError("msg", "CODE");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(OverstoryError);
	});

	test("supports cause chaining", () => {
		const cause = new Error("root cause");
		const err = new OverstoryError("wrapper", "CODE", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("ConfigError", () => {
	test("sets code and name", () => {
		const err = new ConfigError("bad config");
		expect(err.code).toBe("CONFIG_ERROR");
		expect(err.name).toBe("ConfigError");
	});

	test("defaults context fields to null", () => {
		const err = new ConfigError("missing");
		expect(err.configPath).toBeNull();
		expect(err.field).toBeNull();
	});

	test("stores context fields", () => {
		const err = new ConfigError("invalid", {
			configPath: "/path/to/config.yaml",
			field: "agents.maxConcurrent",
		});
		expect(err.configPath).toBe("/path/to/config.yaml");
		expect(err.field).toBe("agents.maxConcurrent");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new ConfigError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("parse failed");
		const err = new ConfigError("bad yaml", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("AgentError", () => {
	test("sets code and name", () => {
		const err = new AgentError("spawn failed");
		expect(err.code).toBe("AGENT_ERROR");
		expect(err.name).toBe("AgentError");
	});

	test("defaults context fields to null", () => {
		const err = new AgentError("msg");
		expect(err.agentName).toBeNull();
		expect(err.capability).toBeNull();
	});

	test("stores context fields", () => {
		const err = new AgentError("failed", {
			agentName: "builder-1",
			capability: "builder",
		});
		expect(err.agentName).toBe("builder-1");
		expect(err.capability).toBe("builder");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new AgentError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("tmux failed");
		const err = new AgentError("spawn failed", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("HierarchyError", () => {
	test("sets code and name", () => {
		const err = new HierarchyError("depth exceeded");
		expect(err.code).toBe("HIERARCHY_VIOLATION");
		expect(err.name).toBe("HierarchyError");
	});

	test("defaults context fields to null", () => {
		const err = new HierarchyError("msg");
		expect(err.agentName).toBeNull();
		expect(err.requestedCapability).toBeNull();
	});

	test("stores context fields", () => {
		const err = new HierarchyError("violation", {
			agentName: "coordinator",
			requestedCapability: "builder",
		});
		expect(err.agentName).toBe("coordinator");
		expect(err.requestedCapability).toBe("builder");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new HierarchyError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("inner");
		const err = new HierarchyError("violation", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("WorktreeError", () => {
	test("sets code and name", () => {
		const err = new WorktreeError("creation failed");
		expect(err.code).toBe("WORKTREE_ERROR");
		expect(err.name).toBe("WorktreeError");
	});

	test("defaults context fields to null", () => {
		const err = new WorktreeError("msg");
		expect(err.worktreePath).toBeNull();
		expect(err.branchName).toBeNull();
	});

	test("stores context fields", () => {
		const err = new WorktreeError("conflict", {
			worktreePath: "/tmp/wt",
			branchName: "agent/builder-1",
		});
		expect(err.worktreePath).toBe("/tmp/wt");
		expect(err.branchName).toBe("agent/builder-1");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new WorktreeError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("git error");
		const err = new WorktreeError("failed", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("MailError", () => {
	test("sets code and name", () => {
		const err = new MailError("db locked");
		expect(err.code).toBe("MAIL_ERROR");
		expect(err.name).toBe("MailError");
	});

	test("defaults context fields to null", () => {
		const err = new MailError("msg");
		expect(err.agentName).toBeNull();
		expect(err.messageId).toBeNull();
	});

	test("stores context fields", () => {
		const err = new MailError("delivery failed", {
			agentName: "scout-1",
			messageId: "msg-abc",
		});
		expect(err.agentName).toBe("scout-1");
		expect(err.messageId).toBe("msg-abc");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new MailError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("sqlite busy");
		const err = new MailError("failed", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("MergeError", () => {
	test("sets code and name", () => {
		const err = new MergeError("conflict");
		expect(err.code).toBe("MERGE_ERROR");
		expect(err.name).toBe("MergeError");
	});

	test("defaults context fields to null/empty", () => {
		const err = new MergeError("msg");
		expect(err.branchName).toBeNull();
		expect(err.conflictFiles).toEqual([]);
	});

	test("stores context fields including conflictFiles array", () => {
		const err = new MergeError("unresolvable", {
			branchName: "agent/builder-1",
			conflictFiles: ["src/index.ts", "src/types.ts"],
		});
		expect(err.branchName).toBe("agent/builder-1");
		expect(err.conflictFiles).toEqual(["src/index.ts", "src/types.ts"]);
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new MergeError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("git merge failed");
		const err = new MergeError("conflict", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("ValidationError", () => {
	test("sets code and name", () => {
		const err = new ValidationError("invalid input");
		expect(err.code).toBe("VALIDATION_ERROR");
		expect(err.name).toBe("ValidationError");
	});

	test("defaults context fields to null", () => {
		const err = new ValidationError("msg");
		expect(err.field).toBeNull();
		expect(err.value).toBeNull();
	});

	test("stores context fields", () => {
		const err = new ValidationError("bad name", {
			field: "agentName",
			value: "",
		});
		expect(err.field).toBe("agentName");
		expect(err.value).toBe("");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new ValidationError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("schema violation");
		const err = new ValidationError("failed", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("GroupError", () => {
	test("sets code and name", () => {
		const err = new GroupError("not found");
		expect(err.code).toBe("GROUP_ERROR");
		expect(err.name).toBe("GroupError");
	});

	test("defaults groupId to null", () => {
		const err = new GroupError("msg");
		expect(err.groupId).toBeNull();
	});

	test("stores groupId", () => {
		const err = new GroupError("not found", { groupId: "group-abc12345" });
		expect(err.groupId).toBe("group-abc12345");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new GroupError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("disk error");
		const err = new GroupError("failed", { cause });
		expect(err.cause).toBe(cause);
	});
});

describe("LifecycleError", () => {
	test("sets code and name", () => {
		const err = new LifecycleError("checkpoint failed");
		expect(err.code).toBe("LIFECYCLE_ERROR");
		expect(err.name).toBe("LifecycleError");
	});

	test("defaults context fields to null", () => {
		const err = new LifecycleError("msg");
		expect(err.agentName).toBeNull();
		expect(err.sessionId).toBeNull();
	});

	test("stores context fields", () => {
		const err = new LifecycleError("handoff failed", {
			agentName: "lead-1",
			sessionId: "sess-xyz",
		});
		expect(err.agentName).toBe("lead-1");
		expect(err.sessionId).toBe("sess-xyz");
	});

	test("is instanceof OverstoryError and Error", () => {
		const err = new LifecycleError("msg");
		expect(err).toBeInstanceOf(OverstoryError);
		expect(err).toBeInstanceOf(Error);
	});

	test("supports cause chaining", () => {
		const cause = new Error("save failed");
		const err = new LifecycleError("checkpoint", { cause });
		expect(err.cause).toBe(cause);
	});
});
