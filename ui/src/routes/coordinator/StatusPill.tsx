import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";

import { type CheckCompleteResult, fetchCoordinatorState } from "./api";

interface StatusPillProps {
	lastCheck: { at: string; result: CheckCompleteResult } | null;
}

type Variant = "default" | "secondary" | "destructive" | "outline";

interface PillState {
	label: string;
	variant: Variant;
}

function pillFor(state: { running: boolean; headless: boolean }): PillState {
	if (!state.running) return { label: "stopped", variant: "secondary" };
	if (state.headless) return { label: "running (headless)", variant: "default" };
	return { label: "running (tmux)", variant: "outline" };
}

function buildTitle(opts: {
	pid: number | null;
	runId: string | null;
	startedAt: string | null;
}): string {
	const parts: string[] = [];
	if (opts.pid !== null) parts.push(`pid: ${opts.pid}`);
	if (opts.runId !== null) parts.push(`run: ${opts.runId}`);
	if (opts.startedAt !== null) parts.push(`started: ${opts.startedAt}`);
	return parts.join("\n");
}

export function StatusPill({ lastCheck }: StatusPillProps) {
	const { data, isLoading, isError } = useQuery({
		queryKey: ["coordinator-state"],
		queryFn: fetchCoordinatorState,
		refetchInterval: 5000,
	});

	if (isLoading) {
		return (
			<Badge variant="secondary" className="font-normal">
				…
			</Badge>
		);
	}

	if (isError || data === undefined) {
		return (
			<Badge variant="destructive" className="font-normal">
				state unavailable
			</Badge>
		);
	}

	const pill = pillFor(data);
	const title = buildTitle(data);

	return (
		<div className="flex items-center gap-2">
			<Badge variant={pill.variant} className="font-normal" title={title || undefined}>
				{pill.label}
			</Badge>
			{lastCheck !== null && (
				<span className="text-xs text-muted-foreground">
					Last check-complete: {lastCheck.result.complete ? "YES" : "NO"} ·{" "}
					{new Date(lastCheck.at).toLocaleTimeString()}
				</span>
			)}
		</div>
	);
}
