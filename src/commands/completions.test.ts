/**
 * Tests for shell completion generation.
 */

import { describe, expect, it, mock } from "bun:test";
import {
	COMMANDS,
	completionsCommand,
	generateBash,
	generateFish,
	generateZsh,
} from "./completions.ts";

describe("COMMANDS array", () => {
	it("should have exactly 26 commands", () => {
		expect(COMMANDS).toHaveLength(26);
	});

	it("should include all expected command names", () => {
		const names = COMMANDS.map((c) => c.name);
		expect(names).toContain("init");
		expect(names).toContain("sling");
		expect(names).toContain("prime");
		expect(names).toContain("status");
		expect(names).toContain("dashboard");
		expect(names).toContain("inspect");
		expect(names).toContain("merge");
		expect(names).toContain("nudge");
		expect(names).toContain("clean");
		expect(names).toContain("doctor");
		expect(names).toContain("log");
		expect(names).toContain("watch");
		expect(names).toContain("trace");
		expect(names).toContain("errors");
		expect(names).toContain("replay");
		expect(names).toContain("costs");
		expect(names).toContain("metrics");
		expect(names).toContain("spec");
		expect(names).toContain("coordinator");
		expect(names).toContain("supervisor");
		expect(names).toContain("hooks");
		expect(names).toContain("monitor");
		expect(names).toContain("mail");
		expect(names).toContain("group");
		expect(names).toContain("worktree");
		expect(names).toContain("run");
	});
});

describe("generateBash", () => {
	it("should return a bash completion script", () => {
		const script = generateBash();
		expect(script).toContain("_overstory()");
		expect(script).toContain("complete -F _overstory overstory");
		expect(script).toContain("_init_completion");
	});

	it("should include all 26 command names", () => {
		const script = generateBash();
		for (const cmd of COMMANDS) {
			expect(script).toContain(cmd.name);
		}
	});

	it("should include sling command", () => {
		const script = generateBash();
		expect(script).toContain("sling");
		// The flag names are in the script
		expect(script).toContain("--capability");
	});

	it("should include mail subcommands", () => {
		const script = generateBash();
		expect(script).toContain("send");
		expect(script).toContain("check");
		expect(script).toContain("list");
		expect(script).toContain("read");
		expect(script).toContain("reply");
		expect(script).toContain("purge");
	});
});

describe("generateZsh", () => {
	it("should return a zsh completion script", () => {
		const script = generateZsh();
		expect(script).toContain("#compdef overstory");
		expect(script).toContain("_overstory()");
		expect(script).toContain("_describe");
		expect(script).toContain("_arguments");
	});

	it("should include all 26 command names", () => {
		const script = generateZsh();
		for (const cmd of COMMANDS) {
			expect(script).toContain(cmd.name);
		}
	});

	it("should include sling command with capability flag", () => {
		const script = generateZsh();
		expect(script).toContain("sling");
		expect(script).toContain("--capability");
		expect(script).toContain("builder");
		expect(script).toContain("scout");
	});

	it("should include global options", () => {
		const script = generateZsh();
		expect(script).toContain("--help");
		expect(script).toContain("--version");
		expect(script).toContain("--completions");
	});
});

describe("generateFish", () => {
	it("should return a fish completion script", () => {
		const script = generateFish();
		expect(script).toContain("complete -c overstory");
		expect(script).toContain("__fish_use_subcommand");
	});

	it("should include all 26 command names", () => {
		const script = generateFish();
		for (const cmd of COMMANDS) {
			expect(script).toContain(cmd.name);
		}
	});

	it("should include capability values for sling command", () => {
		const slingCmd = COMMANDS.find((c) => c.name === "sling");
		expect(slingCmd).toBeDefined();
		const capabilityFlag = slingCmd?.flags?.find((f) => f.name === "--capability");
		expect(capabilityFlag?.values).toContain("builder");
	});

	it("should include message type values for mail send", () => {
		const script = generateFish();
		expect(script).toContain("status");
		expect(script).toContain("question");
		expect(script).toContain("result");
		expect(script).toContain("error");
		expect(script).toContain("worker_done");
	});
});

describe("completionsCommand", () => {
	it("should write bash completion to stdout", () => {
		const originalWrite = process.stdout.write;
		let output = "";

		// Mock stdout.write to capture output
		process.stdout.write = mock((chunk: unknown) => {
			output += String(chunk);
			return true;
		});

		try {
			completionsCommand(["bash"]);
			expect(output).toContain("_overstory()");
			expect(output).toContain("complete -F _overstory overstory");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("should write zsh completion to stdout", () => {
		const originalWrite = process.stdout.write;
		let output = "";

		process.stdout.write = mock((chunk: unknown) => {
			output += String(chunk);
			return true;
		});

		try {
			completionsCommand(["zsh"]);
			expect(output).toContain("#compdef overstory");
			expect(output).toContain("_overstory()");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("should write fish completion to stdout", () => {
		const originalWrite = process.stdout.write;
		let output = "";

		process.stdout.write = mock((chunk: unknown) => {
			output += String(chunk);
			return true;
		});

		try {
			completionsCommand(["fish"]);
			expect(output).toContain("complete -c overstory");
		} finally {
			process.stdout.write = originalWrite;
		}
	});

	it("should exit with error for missing shell argument", () => {
		const originalExit = process.exit;
		const originalStderr = process.stderr.write;
		let exitCode: number | undefined;
		let stderrOutput = "";

		process.exit = mock((code?: string | number | null | undefined) => {
			exitCode = typeof code === "number" ? code : 1;
			throw new Error("process.exit called");
		}) as never;

		process.stderr.write = mock((chunk: unknown) => {
			stderrOutput += String(chunk);
			return true;
		});

		try {
			expect(() => completionsCommand([])).toThrow("process.exit called");
			expect(exitCode).toBe(1);
			expect(stderrOutput).toContain("missing shell argument");
		} finally {
			process.exit = originalExit;
			process.stderr.write = originalStderr;
		}
	});

	it("should exit with error for unknown shell", () => {
		const originalExit = process.exit;
		const originalStderr = process.stderr.write;
		let exitCode: number | undefined;
		let stderrOutput = "";

		process.exit = mock((code?: string | number | null | undefined) => {
			exitCode = typeof code === "number" ? code : 1;
			throw new Error("process.exit called");
		}) as never;

		process.stderr.write = mock((chunk: unknown) => {
			stderrOutput += String(chunk);
			return true;
		});

		try {
			expect(() => completionsCommand(["powershell"])).toThrow("process.exit called");
			expect(exitCode).toBe(1);
			expect(stderrOutput).toContain("unknown shell");
			expect(stderrOutput).toContain("powershell");
		} finally {
			process.exit = originalExit;
			process.stderr.write = originalStderr;
		}
	});
});

describe("Flag completions", () => {
	it("should have fixed values for --capability flag", () => {
		const sling = COMMANDS.find((c) => c.name === "sling");
		expect(sling).toBeDefined();

		const capFlag = sling?.flags?.find((f) => f.name === "--capability");
		expect(capFlag).toBeDefined();
		expect(capFlag?.takesValue).toBe(true);
		expect(capFlag?.values).toEqual(["builder", "scout", "reviewer", "lead", "merger"]);
	});

	it("should have fixed values for --type flag in mail send", () => {
		const mail = COMMANDS.find((c) => c.name === "mail");
		expect(mail).toBeDefined();

		const sendSub = mail?.subcommands?.find((s) => s.name === "send");
		expect(sendSub).toBeDefined();

		const typeFlag = sendSub?.flags?.find((f) => f.name === "--type");
		expect(typeFlag).toBeDefined();
		expect(typeFlag?.takesValue).toBe(true);
		expect(typeFlag?.values).toContain("status");
		expect(typeFlag?.values).toContain("question");
		expect(typeFlag?.values).toContain("result");
		expect(typeFlag?.values).toContain("error");
		expect(typeFlag?.values).toContain("worker_done");
	});

	it("should have fixed values for --priority flag in mail send", () => {
		const mail = COMMANDS.find((c) => c.name === "mail");
		const sendSub = mail?.subcommands?.find((s) => s.name === "send");
		const priorityFlag = sendSub?.flags?.find((f) => f.name === "--priority");

		expect(priorityFlag).toBeDefined();
		expect(priorityFlag?.takesValue).toBe(true);
		expect(priorityFlag?.values).toEqual(["low", "normal", "high", "urgent"]);
	});

	it("should have fixed values for --category flag in doctor", () => {
		const doctor = COMMANDS.find((c) => c.name === "doctor");
		const catFlag = doctor?.flags?.find((f) => f.name === "--category");

		expect(catFlag).toBeDefined();
		expect(catFlag?.takesValue).toBe(true);
		expect(catFlag?.values).toContain("dependencies");
		expect(catFlag?.values).toContain("config");
		expect(catFlag?.values).toContain("databases");
	});
});

describe("Subcommands", () => {
	it("should have correct subcommands for mail command", () => {
		const mail = COMMANDS.find((c) => c.name === "mail");
		expect(mail?.subcommands).toBeDefined();

		const subNames = mail?.subcommands?.map((s) => s.name);
		expect(subNames).toContain("send");
		expect(subNames).toContain("check");
		expect(subNames).toContain("list");
		expect(subNames).toContain("read");
		expect(subNames).toContain("reply");
		expect(subNames).toContain("purge");
	});

	it("should have correct subcommands for coordinator command", () => {
		const coordinator = COMMANDS.find((c) => c.name === "coordinator");
		expect(coordinator?.subcommands).toBeDefined();

		const subNames = coordinator?.subcommands?.map((s) => s.name);
		expect(subNames).toContain("start");
		expect(subNames).toContain("stop");
		expect(subNames).toContain("status");
	});

	it("should have correct subcommands for run command", () => {
		const run = COMMANDS.find((c) => c.name === "run");
		expect(run?.subcommands).toBeDefined();

		const subNames = run?.subcommands?.map((s) => s.name);
		expect(subNames).toContain("list");
		expect(subNames).toContain("show");
		expect(subNames).toContain("complete");
	});
});
