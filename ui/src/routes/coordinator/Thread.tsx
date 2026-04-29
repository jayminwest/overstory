import { useCallback, useEffect, useRef } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import type { StoredEvent } from "@/lib/ws";

import { PendingBubble } from "./PendingBubble";

export type TurnKind = "operator" | "coordinator" | "system";

export interface ChatTurn {
	kind: TurnKind;
	id: string;
	subject: string;
	body: string;
	createdAt: string;
	threadId: string | null;
	pending?: {
		clientToken: string;
		workEvents: StoredEvent[];
		status: "pending" | "stalled";
	};
}

interface ThreadProps {
	turns: ChatTurn[];
}

export function Thread({ turns }: ThreadProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const isAtBottomRef = useRef(true);

	const getViewport = useCallback((): HTMLElement | null => {
		return (
			containerRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null
		);
	}, []);

	useEffect(() => {
		const viewport = getViewport();
		if (!viewport) return;
		const onScroll = () => {
			const { scrollHeight, scrollTop, clientHeight } = viewport;
			isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
		};
		viewport.addEventListener("scroll", onScroll, { passive: true });
		return () => viewport.removeEventListener("scroll", onScroll);
	}, [getViewport]);

	useEffect(() => {
		if (!isAtBottomRef.current || turns.length === 0) return;
		const viewport = getViewport();
		if (viewport) viewport.scrollTop = viewport.scrollHeight;
	}, [turns, getViewport]);

	return (
		<div ref={containerRef} className="flex-1 min-h-0">
			<ScrollArea className="h-full">
				<div className="px-6 py-5 flex flex-col gap-4 max-w-4xl mx-auto">
					{turns.map((turn) => (
						<TurnBubble key={turn.pending?.clientToken ?? turn.id} turn={turn} />
					))}
				</div>
			</ScrollArea>
		</div>
	);
}

function TurnBubble({ turn }: { turn: ChatTurn }) {
	if (turn.pending !== undefined && turn.kind === "coordinator") {
		return (
			<PendingBubble
				clientToken={turn.pending.clientToken}
				workEvents={turn.pending.workEvents}
				status={turn.pending.status}
			/>
		);
	}

	const align =
		turn.kind === "operator" ? "ml-auto" : turn.kind === "system" ? "mx-auto" : "mr-auto";
	const bubbleClasses =
		turn.kind === "operator"
			? "bg-primary text-primary-foreground shadow-sm"
			: turn.kind === "system"
				? "bg-muted/60 text-muted-foreground border border-dashed border-border"
				: "bg-card border border-border shadow-sm";

	return (
		<div className={`max-w-[85%] ${align} flex flex-col gap-1.5`}>
			{turn.subject !== "" && turn.kind !== "system" && (
				<span className="text-xs text-muted-foreground px-1 font-medium">{turn.subject}</span>
			)}
			<div className={`rounded-xl px-4 py-3 ${bubbleClasses}`}>
				<pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{turn.body}</pre>
			</div>
			<span className="text-xs text-muted-foreground px-1">
				{new Date(turn.createdAt).toLocaleTimeString()}
			</span>
		</div>
	);
}
