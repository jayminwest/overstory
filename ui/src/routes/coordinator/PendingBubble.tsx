import { useState } from "react";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { StoredEvent } from "@/lib/ws";
import { EventRow } from "@/routes/agent/EventRow";

export type PendingStatus = "pending" | "stalled";

interface PendingBubbleProps {
	clientToken: string;
	workEvents: StoredEvent[];
	status: PendingStatus;
}

const HEADER_PENDING = "Coordinator is working…";
const HEADER_STALLED = "Still waiting…";

export function PendingBubble({ workEvents, status }: PendingBubbleProps) {
	const defaultCollapsed = workEvents.length >= 5;
	const [collapsed, setCollapsed] = useState(defaultCollapsed);

	return (
		<Card className="py-3 gap-2 max-w-[85%] mr-auto border-dashed border-border">
			<CardHeader className="px-4 pb-0 pt-0">
				<div className="flex items-center gap-2">
					<Spinner stalled={status === "stalled"} />
					<span className="text-xs text-muted-foreground font-medium">
						{status === "stalled" ? HEADER_STALLED : HEADER_PENDING}
					</span>
					{workEvents.length > 0 && (
						<button
							type="button"
							className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => setCollapsed((v) => !v)}
						>
							{collapsed ? `[+] ${workEvents.length} events` : "[-] hide"}
						</button>
					)}
				</div>
			</CardHeader>
			{workEvents.length > 0 && !collapsed && (
				<CardContent className="px-4 pt-2 flex flex-col gap-2">
					{workEvents.map((event) => (
						<EventRow key={event.id} event={event} />
					))}
				</CardContent>
			)}
		</Card>
	);
}

function Spinner({ stalled }: { stalled: boolean }) {
	const color = stalled ? "border-muted-foreground" : "border-primary";
	return (
		<span
			aria-hidden="true"
			className={`inline-block size-3 rounded-full border-2 ${color} border-t-transparent animate-spin`}
		/>
	);
}
