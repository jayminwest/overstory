/**
 * Time parsing utilities.
 */

/**
 * Parse relative time formats like "1h", "30m", "2d", "10s" into a Date object.
 * Falls back to parsing as ISO 8601 if not in relative format.
 */
export function parseRelativeTime(timeStr: string): Date {
	const relativeMatch = /^(\d+)(s|m|h|d)$/.exec(timeStr);
	if (relativeMatch) {
		const value = Number.parseInt(relativeMatch[1] ?? "0", 10);
		const unit = relativeMatch[2];
		const now = Date.now();
		let offsetMs = 0;

		switch (unit) {
			case "s":
				offsetMs = value * 1000;
				break;
			case "m":
				offsetMs = value * 60 * 1000;
				break;
			case "h":
				offsetMs = value * 60 * 60 * 1000;
				break;
			case "d":
				offsetMs = value * 24 * 60 * 60 * 1000;
				break;
		}

		return new Date(now - offsetMs);
	}

	// Not a relative format, treat as ISO 8601
	return new Date(timeStr);
}
