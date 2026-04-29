import { type RefObject, useCallback, useEffect, useRef } from "react";

const DEFAULT_THRESHOLD = 50;

export interface AutoScrollOptions {
	dependency?: unknown;
	threshold?: number;
}

export interface AutoScrollResult {
	pinToBottom: () => void;
	scrollToBottom: () => void;
}

/**
 * Pure helper: tells whether a scrollable element is within `threshold` pixels
 * of its bottom edge. Exposed for unit testing the pin/unpin logic.
 */
export function isNearBottom(
	el: { scrollTop: number; scrollHeight: number; clientHeight: number },
	threshold: number,
): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function useAutoScroll<T extends HTMLElement>(
	ref: RefObject<T | null>,
	opts?: AutoScrollOptions,
): AutoScrollResult {
	const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
	const dependency = opts?.dependency;

	// Use a ref so updates don't trigger re-renders or re-attach observers.
	const pinnedRef = useRef(true);

	const scrollToBottom = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		el.scrollTop = el.scrollHeight;
	}, [ref]);

	const pinToBottom = useCallback(() => {
		pinnedRef.current = true;
		scrollToBottom();
	}, [scrollToBottom]);

	useEffect(() => {
		const el = ref.current;
		if (!el) return;

		const onScroll = () => {
			pinnedRef.current = isNearBottom(el, threshold);
		};

		const onGrowth = () => {
			if (pinnedRef.current) {
				el.scrollTop = el.scrollHeight;
			}
		};

		el.addEventListener("scroll", onScroll, { passive: true });

		const RO = typeof ResizeObserver !== "undefined" ? ResizeObserver : null;
		const MO = typeof MutationObserver !== "undefined" ? MutationObserver : null;

		const ro = RO ? new RO(onGrowth) : null;
		const mo = MO ? new MO(onGrowth) : null;

		const target = (el.firstElementChild as HTMLElement | null) ?? el;
		ro?.observe(target);
		mo?.observe(el, { subtree: true, childList: true, characterData: true });

		return () => {
			el.removeEventListener("scroll", onScroll);
			ro?.disconnect();
			mo?.disconnect();
		};
	}, [ref, threshold]);

	// `dependency` is a tripwire — callers pass it so growth caused by their state
	// updates re-runs the pin check even when our observers haven't fired yet.
	// biome-ignore lint/correctness/useExhaustiveDependencies: dependency is intentionally a tripwire.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		if (pinnedRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [dependency, ref]);

	return { pinToBottom, scrollToBottom };
}
