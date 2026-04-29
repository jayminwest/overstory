import { describe, expect, test } from "bun:test";

import { computeFadeMask } from "./use-scroll-fade";

describe("computeFadeMask", () => {
	test("returns null when content fits (no overflow)", () => {
		expect(computeFadeMask({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBeNull();
	});

	test("returns null when at top with no overflow at bottom edge", () => {
		// overflow > 0 but scrollTop=0 and scrollTop+clientHeight === scrollHeight
		// shouldn't happen in practice; the explicit no-fade short-circuit applies
		// only when overflow <= 0. Here overflow=0 -> null.
		expect(computeFadeMask({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 })).toBeNull();
	});

	test("only bottom fade when scrolled to top", () => {
		const mask = computeFadeMask({ scrollTop: 0, scrollHeight: 1000, clientHeight: 100 });
		expect(mask).not.toBeNull();
		expect(mask).toContain("black 0px,"); // top stop = 0
		expect(mask).toContain("calc(100% - 24px)"); // bottom fade present
	});

	test("only top fade when scrolled to bottom", () => {
		const mask = computeFadeMask({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 });
		expect(mask).not.toBeNull();
		expect(mask).toContain("black 24px,"); // top fade present
		expect(mask).toContain("calc(100% - 0px)"); // bottom stop = 0
	});

	test("both fades active when scrolled in the middle", () => {
		const mask = computeFadeMask({ scrollTop: 400, scrollHeight: 1000, clientHeight: 100 });
		expect(mask).not.toBeNull();
		expect(mask).toContain("black 24px,");
		expect(mask).toContain("calc(100% - 24px)");
	});
});
