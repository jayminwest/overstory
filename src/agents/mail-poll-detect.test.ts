import { describe, expect, test } from "bun:test";
import { detectMailPollPattern } from "./mail-poll-detect.ts";

describe("detectMailPollPattern", () => {
	describe("matched patterns", () => {
		test("until ov mail list with sleep body", () => {
			const result = detectMailPollPattern("until ov mail list; do sleep 1; done");
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("until ov mail loop");
		});

		test("while ! ov mail check with sleep body", () => {
			const result = detectMailPollPattern("while ! ov mail check; do sleep 5; done");
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("while-not ov mail loop");
		});

		test("while ! ov mail list --unread with sleep body", () => {
			const result = detectMailPollPattern("while ! ov mail list --unread; do sleep 2; done");
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("while-not ov mail loop");
		});

		test("until ov mail check with extra args and sleep body", () => {
			const result = detectMailPollPattern("until ov mail check --agent foo; do sleep 1; done");
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("until ov mail loop");
		});

		test("until [ ... $(ov mail list ... | wc -l) ... ] piped condition", () => {
			const result = detectMailPollPattern(
				`until [ "$(ov mail list --unread | wc -l)" -gt 0 ]; do sleep 1; done`,
			);
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("ov mail piped condition");
		});

		test("while [ -z $(ov mail check | jq) ] piped condition", () => {
			const result = detectMailPollPattern(
				`while [ -z "$(ov mail check | jq '.id')" ]; do sleep 2; done`,
			);
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("ov mail piped condition");
		});

		test("multi-line with leading whitespace and tabs is detected", () => {
			const cmd = "\t\tuntil ov mail list;\n\t\tdo\n\t\t\tsleep 1;\n\t\tdone";
			const result = detectMailPollPattern(cmd);
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("until ov mail loop");
		});

		test("multi-line newline-separated (no semicolons before do/done) is detected", () => {
			const cmd = "until ov mail list\ndo\n  sleep 1\ndone";
			const result = detectMailPollPattern(cmd);
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("until ov mail loop");
		});

		test("while loop with negated ov mail and pipe-through is the piped variant", () => {
			// `while [ ... ]` (no `!`) with `ov mail` substituted inside the test
			// expression is the piped form, not while-not.
			const result = detectMailPollPattern(
				`while [ "$(ov mail list --unread --json)" = "[]" ]; do sleep 3; done`,
			);
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("ov mail piped condition");
		});

		test("until with extra padding around ! does not derail kind detection", () => {
			// Note: `until !` is unusual but the spec says `!` may have surrounding
			// spaces; we only assert that `until` direct form still classifies.
			const result = detectMailPollPattern("until   ov mail check  ;  do  sleep 1 ;  done");
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("until ov mail loop");
		});

		test("while !ov (no space after !) still classifies as while-not", () => {
			const result = detectMailPollPattern("while !ov mail check; do sleep 1; done");
			expect(result.matched).toBe(true);
			expect(result.reason).toBe("while-not ov mail loop");
		});
	});

	describe("not matched", () => {
		test("ov mail check (no loop wrapper)", () => {
			expect(detectMailPollPattern("ov mail check").matched).toBe(false);
		});

		test("ov mail list --unread --json (no loop wrapper)", () => {
			expect(detectMailPollPattern("ov mail list --unread --json").matched).toBe(false);
		});

		test("for loop sending mail (bounded, not a wait-poll)", () => {
			const cmd =
				"for i in 1 2 3; do ov mail send --to lead --subject hi --body x --type status; done";
			expect(detectMailPollPattern(cmd).matched).toBe(false);
		});

		test("while read line over a file (no ov mail reference)", () => {
			expect(detectMailPollPattern("while read line; do echo $line; done < file.txt").matched).toBe(
				false,
			);
		});

		test("until-loop with ov mail in condition but no sleep in body (not a poll)", () => {
			// Without `sleep` the body is a one-shot reaction, not a wait-poll.
			expect(detectMailPollPattern("until ov mail check; do echo got-mail; done").matched).toBe(
				false,
			);
		});

		test("non-string command (undefined) returns matched=false without throwing", () => {
			expect(() => detectMailPollPattern(undefined)).not.toThrow();
			expect(detectMailPollPattern(undefined).matched).toBe(false);
		});

		test("non-string command (null) returns matched=false", () => {
			expect(detectMailPollPattern(null).matched).toBe(false);
		});

		test("non-string command (number) returns matched=false", () => {
			expect(detectMailPollPattern(42).matched).toBe(false);
		});

		test("empty string returns matched=false", () => {
			expect(detectMailPollPattern("").matched).toBe(false);
		});

		test("for loop with sleep but no ov mail reference is not a poll", () => {
			expect(detectMailPollPattern("for i in 1 2 3; do sleep 1; echo hi; done").matched).toBe(
				false,
			);
		});
	});

	describe("regex statefulness", () => {
		test("repeated calls return consistent results (no lastIndex leakage)", () => {
			const cmd = "until ov mail list; do sleep 1; done";
			for (let i = 0; i < 5; i++) {
				const result = detectMailPollPattern(cmd);
				expect(result.matched).toBe(true);
				expect(result.reason).toBe("until ov mail loop");
			}
		});

		test("matched call followed by non-match returns non-match correctly", () => {
			expect(detectMailPollPattern("until ov mail list; do sleep 1; done").matched).toBe(true);
			expect(detectMailPollPattern("ov mail check").matched).toBe(false);
			expect(detectMailPollPattern("until ov mail list; do sleep 1; done").matched).toBe(true);
		});
	});
});
