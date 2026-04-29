import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAutoScroll } from "@/lib/use-auto-scroll";
import { useScrollFade } from "@/lib/use-scroll-fade";
import { type Frame, type StoredEvent, useWebSocket, type WsStatus } from "@/lib/ws";
import { EventRow } from "@/routes/agent/EventRow";

// ── REST fetch (inlined — api.ts may not exist yet) ────────────────────────

interface EventsResponse {
	success: boolean;
	data: StoredEvent[];
}

async function fetchEvents(agentName: string): Promise<StoredEvent[]> {
	const res = await fetch(`/api/events?agent=${encodeURIComponent(agentName)}&limit=100`);
	if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
	const json = (await res.json()) as unknown;
	if (
		json &&
		typeof json === "object" &&
		"success" in json &&
		(json as EventsResponse).success &&
		"data" in json
	) {
		return (json as EventsResponse).data;
	}
	return [];
}

// ── Payload helpers ─────────────────────────────────────────────────────────

type BatchedPayload = { batched: true; events: StoredEvent[] };

function isBatched(payload: StoredEvent | BatchedPayload): payload is BatchedPayload {
	return "batched" in payload && (payload as BatchedPayload).batched === true;
}

function extractDelta(event: StoredEvent): string {
	if (!event.data) return "";
	try {
		const parsed = JSON.parse(event.data) as unknown;
		if (
			parsed &&
			typeof parsed === "object" &&
			"delta" in parsed &&
			typeof (parsed as { delta: unknown }).delta === "string"
		) {
			return (parsed as { delta: string }).delta;
		}
	} catch {
		// plain text
	}
	return event.data;
}

// ── Connection badge ────────────────────────────────────────────────────────

const STATUS_LABEL: Record<WsStatus, string> = {
	connecting: "connecting",
	open: "live",
	closed: "disconnected",
};

const STATUS_VARIANT: Record<WsStatus, "default" | "secondary" | "destructive" | "outline"> = {
	connecting: "secondary",
	open: "default",
	closed: "destructive",
};

// ── Component ───────────────────────────────────────────────────────────────

export function AgentDetail() {
	const { name } = useParams<{ name: string }>();

	const query = useQuery({
		queryKey: ["events", name],
		queryFn: () => (name ? fetchEvents(name) : Promise.resolve([])),
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		enabled: Boolean(name),
	});

	const [liveEvents, setLiveEvents] = useState<StoredEvent[]>([]);
	const batchCounterRef = useRef(-1);

	const wsUrl = name ? `/ws?agent=${encodeURIComponent(name)}` : null;

	const handleMessage = useCallback((frame: Frame) => {
		if (frame.type !== "event") return;
		const { payload } = frame;

		if (isBatched(payload)) {
			const text = payload.events.map(extractDelta).join("");
			const firstEvent = payload.events[0];
			if (!firstEvent) return;
			const synthetic: StoredEvent = {
				...firstEvent,
				id: batchCounterRef.current--,
				data: JSON.stringify({ delta: text }),
			};
			setLiveEvents((prev) => [...prev, synthetic]);
		} else {
			const event = payload;
			setLiveEvents((prev) => {
				if (prev.some((e) => e.id === event.id)) return prev;
				return [...prev, event];
			});
		}
	}, []);

	const { status } = useWebSocket<Frame>(wsUrl, { onMessage: handleMessage });

	// Reset live events when navigating to a different agent.
	useEffect(() => {
		if (!name) return;
		setLiveEvents([]);
		batchCounterRef.current = -1;
	}, [name]);

	const allEvents = useMemo<StoredEvent[]>(() => {
		const base = query.data ?? [];
		const seen = new Set<number>();
		return [...base, ...liveEvents]
			.filter((e) => {
				if (seen.has(e.id)) return false;
				seen.add(e.id);
				return true;
			})
			.sort((a, b) => a.id - b.id);
	}, [query.data, liveEvents]);

	// ── Auto-scroll + scroll fade on the timeline viewport ──────────────────

	const viewportRef = useRef<HTMLDivElement>(null);
	useAutoScroll(viewportRef, { dependency: allEvents.length });
	useScrollFade(viewportRef);

	// ── Render ───────────────────────────────────────────────────────────────

	const agentLabel = name ?? "unknown";

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
				<h1 className="text-xl font-semibold tracking-tight font-mono">{agentLabel}</h1>
				<Badge variant={STATUS_VARIANT[status]}>{STATUS_LABEL[status]}</Badge>
			</div>

			{/* Timeline */}
			<div ref={viewportRef} className="flex-1 min-h-0 overflow-auto">
				<div className="px-6 py-5 flex flex-col gap-2.5 max-w-5xl mx-auto">
					{query.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
					{!query.isLoading && allEvents.length === 0 && (
						<Card>
							<CardHeader>
								<CardTitle className="text-sm font-normal text-muted-foreground">
									No events for {agentLabel}
								</CardTitle>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground leading-relaxed">
									Nudge the agent to wake it up:{" "}
									<code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{`ov nudge ${agentLabel} "Status check"`}</code>
								</p>
							</CardContent>
						</Card>
					)}
					{allEvents.map((event) => (
						<EventRow key={event.id} event={event} />
					))}
				</div>
			</div>
		</div>
	);
}
