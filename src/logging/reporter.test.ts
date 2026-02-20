import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { LogEvent } from "../types.ts";
import { colorsEnabled } from "./color.ts";
import { formatLogLine, printToConsole } from "./reporter.ts";

// Helper to build a LogEvent with sensible defaults
function makeEvent(overrides: Partial<LogEvent> = {}): LogEvent {
	return {
		timestamp: "2026-02-13T14:30:00.123Z",
		level: "info",
		event: "test.event",
		agentName: "test-agent",
		data: {},
		...overrides,
	};
}

describe("formatLogLine", () => {
	test("uses DBG label for debug level", () => {
		const result = formatLogLine(makeEvent({ level: "debug" }));
		expect(result).toContain("DBG");
	});

	test("uses INF label for info level", () => {
		const result = formatLogLine(makeEvent({ level: "info" }));
		expect(result).toContain("INF");
	});

	test("uses WRN label for warn level", () => {
		const result = formatLogLine(makeEvent({ level: "warn" }));
		expect(result).toContain("WRN");
	});

	test("uses ERR label for error level", () => {
		const result = formatLogLine(makeEvent({ level: "error" }));
		expect(result).toContain("ERR");
	});

	test("includes agent name and separator when present", () => {
		const result = formatLogLine(makeEvent({ agentName: "scout-1" }));
		expect(result).toContain("scout-1");
		expect(result).toContain(" | ");
	});

	test("omits agent name and separator when null", () => {
		const result = formatLogLine(makeEvent({ agentName: null }));
		expect(result).not.toContain(" | ");
	});

	test("includes event name in output", () => {
		const result = formatLogLine(makeEvent({ event: "agent.started" }));
		expect(result).toContain("agent.started");
	});

	test("formats string data values as key=value", () => {
		const result = formatLogLine(makeEvent({ data: { status: "ok" } }));
		expect(result).toContain("status=ok");
	});

	test("formats number data values as key=value", () => {
		const result = formatLogLine(makeEvent({ data: { duration: 5000 } }));
		expect(result).toContain("duration=5000");
	});

	test("formats object data values as JSON", () => {
		const result = formatLogLine(makeEvent({ data: { config: { enabled: true, timeout: 5000 } } }));
		expect(result).toContain('config={"enabled":true,"timeout":5000}');
	});

	test("formats null data values as key=null", () => {
		const result = formatLogLine(makeEvent({ data: { value: null } }));
		expect(result).toContain("value=null");
	});

	test("formats undefined data values as key=null", () => {
		const result = formatLogLine(makeEvent({ data: { value: undefined } }));
		expect(result).toContain("value=null");
	});

	test("quotes string data values containing spaces", () => {
		const result = formatLogLine(makeEvent({ data: { message: "hello world", status: "ok" } }));
		expect(result).toContain('message="hello world"');
		expect(result).toContain("status=ok");
	});

	test("handles multiple data key=value pairs", () => {
		const result = formatLogLine(makeEvent({ data: { taskId: "task-123", duration: 5000 } }));
		expect(result).toContain("taskId=task-123");
		expect(result).toContain("duration=5000");
	});

	test("produces no data suffix for empty data object", () => {
		const result = formatLogLine(makeEvent({ data: {} }));
		// The event name should be at the end with no trailing key=value content
		expect(result).toContain("test.event");
		// No equals sign means no key=value pairs present
		expect(result).not.toMatch(/\w+=\S/);
	});

	test("extracts HH:MM:SS time from ISO timestamp", () => {
		const result = formatLogLine(makeEvent({ timestamp: "2026-02-13T14:30:00.123Z" }));
		expect(result).toContain("[14:30:00]");
	});

	test("falls back to raw timestamp when no T separator", () => {
		const result = formatLogLine(makeEvent({ timestamp: "invalid-timestamp" }));
		expect(result).toContain("[invalid-timestamp]");
	});

	test("contains ANSI escape codes in output", () => {
		const result = formatLogLine(makeEvent());
		if (colorsEnabled) {
			// \x1b[ is the ANSI escape sequence prefix
			expect(result).toContain("\x1b[");
			// Reset sequence should appear at least once
			expect(result).toContain("\x1b[0m");
			return;
		}

		expect(result).not.toContain("\x1b[");
	});

	test("uses different ANSI color codes for different levels", () => {
		const debugResult = formatLogLine(makeEvent({ level: "debug" }));
		const infoResult = formatLogLine(makeEvent({ level: "info" }));
		const warnResult = formatLogLine(makeEvent({ level: "warn" }));
		const errorResult = formatLogLine(makeEvent({ level: "error" }));

		if (colorsEnabled) {
			// Each level uses a distinct color: gray(90), blue(34), yellow(33), red(31)
			expect(debugResult).toContain("\x1b[90m");
			expect(infoResult).toContain("\x1b[34m");
			expect(warnResult).toContain("\x1b[33m");
			expect(errorResult).toContain("\x1b[31m");
			return;
		}

		// Color is disabled, but level labels should still be present.
		expect(debugResult).toContain("DBG");
		expect(infoResult).toContain("INF");
		expect(warnResult).toContain("WRN");
		expect(errorResult).toContain("ERR");
		expect(debugResult).not.toContain("\x1b[");
		expect(infoResult).not.toContain("\x1b[");
		expect(warnResult).not.toContain("\x1b[");
		expect(errorResult).not.toContain("\x1b[");
	});

	test("formats boolean data values via String()", () => {
		const result = formatLogLine(makeEvent({ data: { enabled: true } }));
		expect(result).toContain("enabled=true");
	});
});

describe("printToConsole", () => {
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		logSpy?.mockRestore();
		errorSpy?.mockRestore();
	});

	test("sends info events to console.log", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		// Clear any calls captured during spy setup (bun's test reporter
		// may flush output through console.log between spy creation and here)
		logSpy.mockClear();
		errorSpy.mockClear();

		printToConsole(makeEvent({ level: "info" }), true);

		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(0);
	});

	test("sends warn events to console.log", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		logSpy.mockClear();
		errorSpy.mockClear();

		printToConsole(makeEvent({ level: "warn" }), false);

		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(0);
	});

	test("sends error events to console.error", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		logSpy.mockClear();
		errorSpy.mockClear();

		printToConsole(makeEvent({ level: "error" }), false);

		expect(logSpy).toHaveBeenCalledTimes(0);
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	test("suppresses debug events when verbose is false", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		logSpy.mockClear();
		errorSpy.mockClear();

		printToConsole(makeEvent({ level: "debug" }), false);

		expect(logSpy).toHaveBeenCalledTimes(0);
		expect(errorSpy).toHaveBeenCalledTimes(0);
	});

	test("shows debug events when verbose is true", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		logSpy.mockClear();
		errorSpy.mockClear();

		printToConsole(makeEvent({ level: "debug" }), true);

		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(0);
	});

	test("passes formatted line to console method", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});

		const event = makeEvent({ level: "info", event: "my.custom.event" });
		printToConsole(event, true);

		const calledWith = logSpy.mock.calls[0]?.[0] as string;
		expect(calledWith).toContain("my.custom.event");
		expect(calledWith).toContain("INF");
	});

	test("error event output contains the formatted line", () => {
		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});

		const event = makeEvent({ level: "error", event: "fatal.crash" });
		printToConsole(event, false);

		const calledWith = errorSpy.mock.calls[0]?.[0] as string;
		expect(calledWith).toContain("fatal.crash");
		expect(calledWith).toContain("ERR");
	});

	test("suppresses non-error output when quiet mode is enabled", () => {
		const { setQuiet } = require("./color.ts") as { setQuiet: (enabled: boolean) => void };

		logSpy = spyOn(console, "log").mockImplementation(() => {});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});
		logSpy.mockClear();
		errorSpy.mockClear();

		// Enable quiet mode
		setQuiet(true);

		// info, warn, debug should all be suppressed
		printToConsole(makeEvent({ level: "info" }), true);
		printToConsole(makeEvent({ level: "warn" }), true);
		printToConsole(makeEvent({ level: "debug" }), true);

		expect(logSpy).toHaveBeenCalledTimes(0);
		expect(errorSpy).toHaveBeenCalledTimes(0);

		// errors should still be output
		printToConsole(makeEvent({ level: "error" }), true);

		expect(logSpy).toHaveBeenCalledTimes(0);
		expect(errorSpy).toHaveBeenCalledTimes(1);

		// Restore quiet mode
		setQuiet(false);
	});
});
