import { describe, expect, test } from "bun:test";

import { isNearBottom } from "./use-auto-scroll";

describe("isNearBottom", () => {
	test("returns true when scrolled to the bottom (delta = 0)", () => {
		expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }, 50)).toBe(true);
	});

	test("returns true when within threshold of bottom", () => {
		expect(isNearBottom({ scrollTop: 870, scrollHeight: 1000, clientHeight: 100 }, 50)).toBe(true);
	});

	test("returns false when user has scrolled away (beyond threshold)", () => {
		expect(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 }, 50)).toBe(false);
	});

	test("threshold is inclusive at the boundary", () => {
		expect(isNearBottom({ scrollTop: 850, scrollHeight: 1000, clientHeight: 100 }, 50)).toBe(true);
	});
});

/**
 * Simulator covering the pin/unpin contract documented in the spec:
 *  - pinToBottom snaps scrollTop to scrollHeight and marks pinned
 *  - scrolling away (beyond threshold) flips pinned -> false
 *  - scrolling back within threshold flips pinned -> true
 *  - growth events while pinned snap to the new bottom
 *
 * We model the controller logic the hook installs without spinning up React,
 * since `bun test` has no DOM. This still exercises the contract: a pinned
 * controller follows growth, an unpinned one does not.
 */

interface FakeEl {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

function makeController(el: FakeEl, threshold = 50) {
	let pinned = true;
	return {
		isPinned: () => pinned,
		onScroll: () => {
			pinned = isNearBottom(el, threshold);
		},
		onGrowth: () => {
			if (pinned) el.scrollTop = el.scrollHeight;
		},
		pinToBottom: () => {
			pinned = true;
			el.scrollTop = el.scrollHeight;
		},
	};
}

describe("auto-scroll controller (logic-level)", () => {
	test("pinToBottom snaps scrollTop to scrollHeight", () => {
		const el: FakeEl = { scrollTop: 200, scrollHeight: 1000, clientHeight: 100 };
		const c = makeController(el);
		c.pinToBottom();
		expect(el.scrollTop).toBe(1000);
		expect(c.isPinned()).toBe(true);
	});

	test("scrolling away unpins, scrolling back re-pins", () => {
		const el: FakeEl = { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 };
		const c = makeController(el);

		// User scrolls up far past the threshold.
		el.scrollTop = 100;
		c.onScroll();
		expect(c.isPinned()).toBe(false);

		// Content grows; should NOT auto-follow because user is reading older content.
		el.scrollHeight = 1500;
		c.onGrowth();
		expect(el.scrollTop).toBe(100);

		// User scrolls back near the bottom.
		el.scrollTop = 1380; // 1500 - 100 - 1380 = 20 <= 50
		c.onScroll();
		expect(c.isPinned()).toBe(true);

		// Growth now snaps to the new bottom.
		el.scrollHeight = 2000;
		c.onGrowth();
		expect(el.scrollTop).toBe(2000);
	});
});
