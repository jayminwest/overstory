import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { fetchAgents, fetchRuns } from "@/lib/api";

import { AgentTable } from "./fleet/AgentTable";
import { RunPicker } from "./fleet/RunPicker";
import { SummaryCards } from "./fleet/SummaryCards";

export function Home() {
	const runsQuery = useQuery({
		queryKey: ["runs"],
		queryFn: () => fetchRuns(50),
		refetchInterval: 5000,
	});

	const runs = runsQuery.data ?? [];
	const [pickedRunId, setPickedRunId] = useState<string | null>(null);
	const effectiveRunId = pickedRunId ?? runs[0]?.id ?? null;

	const agentsQuery = useQuery({
		queryKey: ["agents", effectiveRunId],
		queryFn: () => fetchAgents({ runId: effectiveRunId ?? undefined }),
		enabled: effectiveRunId !== null,
		refetchInterval: 5000,
	});

	const agents = agentsQuery.data ?? [];
	const activeCount = agents.filter((a) => a.state === "working" || a.state === "booting").length;
	const completedCount = agents.filter((a) => a.state === "completed").length;
	const errorCount = agents.filter((a) => a.state === "stalled" || a.state === "zombie").length;

	const isLoading = runsQuery.isLoading || agentsQuery.isLoading;
	const isError = runsQuery.isError || agentsQuery.isError;
	const errorMessage =
		(runsQuery.error instanceof Error ? runsQuery.error.message : null) ??
		(agentsQuery.error instanceof Error ? agentsQuery.error.message : null) ??
		"An error occurred.";

	return (
		<div className="p-6 flex flex-col gap-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Fleet</h1>
				<RunPicker runs={runs} selectedRunId={effectiveRunId} onSelect={setPickedRunId} />
			</div>

			{isError && (
				<div className="rounded-md border border-destructive bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{errorMessage}
				</div>
			)}

			{isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

			{!isLoading && runs.length === 0 && (
				<p className="text-sm text-muted-foreground">
					No runs yet — start a coordinator with{" "}
					<code className="font-mono">ov coordinator start</code>.
				</p>
			)}

			{!isLoading && runs.length > 0 && (
				<>
					<SummaryCards
						activeCount={activeCount}
						completedCount={completedCount}
						errorCount={errorCount}
					/>
					<AgentTable agents={agents} />
				</>
			)}
		</div>
	);
}
