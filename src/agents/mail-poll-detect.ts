/**
 * Defense-in-depth detector for Bash mail-poll patterns (overstory-c92c).
 *
 * The lead.md prompt forbids Bash polling for mail (overstory-fa84) — the
 * primary mitigation. This helper is the runtime backstop: if a future custom
 * overlay or contributed agent definition silently reintroduces the pattern,
 * the turn-runner emits a warning and a custom event so it surfaces in
 * `ov logs` / `ov feed` / the UI. Warn-only by design; the seed's P3 severity
 * is met without aborting the turn.
 *
 * What counts as a wait-poll:
 *   1. A `until` or `while` loop construct.
 *   2. The loop condition references `ov mail check` or `ov mail list`
 *      (directly, negated with `!`, or wrapped in `[ "$(...)" ... ]`).
 *   3. The loop body contains `sleep` (otherwise it's bounded work, not a
 *      poll).
 *
 * `for` loops are bounded and never classified as wait-polls — `for i in 1 2 3;
 * do ov mail send ...; done` is a legitimate batched send, not a poll.
 */

const LOOP_PATTERN =
	/\b(until|while)\b([\s\S]*?)\s*(?:;|\n)\s*do\b([\s\S]*?)\s*(?:;|\n)\s*\bdone\b/g;
const SLEEP_IN_BODY = /\bsleep\b/;
const OV_MAIL_REF = /\bov\s+mail\s+(?:check|list)\b/;
const DIRECT_OV_MAIL = /^ov\s+mail\s+(?:check|list)\b/;
const NEGATED_OV_MAIL = /^!\s*ov\s+mail\s+(?:check|list)\b/;

export interface MailPollDetectionResult {
	matched: boolean;
	reason?: string;
}

/**
 * Pure detector — no I/O, no side effects. Accepts any input and returns
 * `{ matched: false }` for non-string values so callers can pass the raw
 * `event.input.command` field without pre-validation.
 */
export function detectMailPollPattern(command: unknown): MailPollDetectionResult {
	if (typeof command !== "string") return { matched: false };

	// Reset lastIndex because the regex is module-level with the `g` flag.
	LOOP_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null = LOOP_PATTERN.exec(command);
	while (match !== null) {
		const kind = match[1] as "until" | "while";
		const condition = (match[2] ?? "").trim();
		const body = match[3] ?? "";

		if (!SLEEP_IN_BODY.test(body)) {
			match = LOOP_PATTERN.exec(command);
			continue;
		}
		if (!OV_MAIL_REF.test(condition)) {
			match = LOOP_PATTERN.exec(command);
			continue;
		}

		if (kind === "until") {
			if (DIRECT_OV_MAIL.test(condition)) {
				return { matched: true, reason: "until ov mail loop" };
			}
			return { matched: true, reason: "ov mail piped condition" };
		}

		if (NEGATED_OV_MAIL.test(condition)) {
			return { matched: true, reason: "while-not ov mail loop" };
		}
		return { matched: true, reason: "ov mail piped condition" };
	}

	return { matched: false };
}
