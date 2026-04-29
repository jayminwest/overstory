import { type RefObject, useEffect } from "react";

const FADE_PX = 24;

interface FadeMetrics {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
}

/**
 * Pure helper: builds the CSS `linear-gradient(...)` mask for a scrollable
 * element based on its current scroll position. Exposed for unit testing.
 *
 * Returns `null` when the content fits without scrolling (no fade needed).
 */
export function computeFadeMask({
	scrollTop,
	scrollHeight,
	clientHeight,
}: FadeMetrics): string | null {
	const overflow = scrollHeight - clientHeight;
	if (overflow <= 0) return null;

	const topFade = scrollTop > 0;
	const bottomFade = scrollTop + clientHeight < scrollHeight;

	if (!topFade && !bottomFade) return null;

	const top = topFade ? `${FADE_PX}px` : "0px";
	const bottom = bottomFade ? `${FADE_PX}px` : "0px";
	return `linear-gradient(to bottom, transparent 0, black ${top}, black calc(100% - ${bottom}), transparent 100%)`;
}

export function useScrollFade<T extends HTMLElement>(ref: RefObject<T | null>): void {
	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const apply = () => {
			const mask = computeFadeMask({
				scrollTop: el.scrollTop,
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
			});
			const value = mask ?? "";
			el.style.maskImage = value;
			// Safari support — the property name with a hyphen.
			el.style.setProperty("-webkit-mask-image", value);
		};

		apply();
		el.addEventListener("scroll", apply, { passive: true });

		const RO = typeof ResizeObserver !== "undefined" ? ResizeObserver : null;
		const ro = RO ? new RO(apply) : null;
		ro?.observe(el);

		return () => {
			el.removeEventListener("scroll", apply);
			ro?.disconnect();
		};
	}, [ref]);
}
