import { useNavigate } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { AgentRow, AgentState } from "@/lib/api";

import { formatRelativeTime } from "./format";

const STATE_VARIANT: Record<AgentState, "default" | "secondary" | "outline" | "destructive"> = {
	working: "default",
	in_turn: "default",
	between_turns: "secondary",
	booting: "secondary",
	completed: "outline",
	stalled: "destructive",
	zombie: "destructive",
};

/**
 * Human-readable labels for the badge so the spawn-per-turn substates render
 * as "in turn" / "between turns" instead of the raw snake_case string
 * (overstory-3087). Falls back to the raw state for any value we don't have
 * an override for, so future additions show up without a UI change.
 */
const STATE_LABEL: Partial<Record<AgentState, string>> = {
	in_turn: "in turn",
	between_turns: "between turns",
};

interface AgentTableProps {
	agents: AgentRow[];
}

export function AgentTable({ agents }: AgentTableProps) {
	const navigate = useNavigate();

	if (agents.length === 0) {
		return (
			<p className="text-sm text-muted-foreground py-4 leading-relaxed">
				No agents in this run yet — spawn one with{" "}
				<code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
					{"ov sling <task-id> --capability builder --name <name>"}
				</code>
				.
			</p>
		);
	}

	return (
		<div className="rounded-xl border border-border overflow-hidden bg-card">
			<Table>
				<TableHeader>
					<TableRow className="bg-muted/40 hover:bg-muted/40">
						<TableHead className="px-4 h-11">Name</TableHead>
						<TableHead className="px-4 h-11">Capability</TableHead>
						<TableHead className="px-4 h-11">State</TableHead>
						<TableHead className="px-4 h-11">Parent</TableHead>
						<TableHead className="px-4 h-11">Started</TableHead>
						<TableHead className="px-4 h-11">Last Event</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{agents.map((agent) => (
						<TableRow
							key={agent.id}
							className="cursor-pointer"
							onClick={() => navigate(`/agents/${encodeURIComponent(agent.agentName)}`)}
						>
							<TableCell className="font-mono text-xs px-4 py-3">{agent.agentName}</TableCell>
							<TableCell className="px-4 py-3 text-sm">{agent.capability}</TableCell>
							<TableCell className="px-4 py-3">
								<Badge variant={STATE_VARIANT[agent.state]}>
									{STATE_LABEL[agent.state] ?? agent.state}
								</Badge>
							</TableCell>
							<TableCell className="text-muted-foreground text-xs px-4 py-3">
								{agent.parentAgent ?? "—"}
							</TableCell>
							<TableCell className="text-xs px-4 py-3">
								{formatRelativeTime(agent.startedAt)}
							</TableCell>
							<TableCell className="text-xs px-4 py-3">
								{formatRelativeTime(agent.lastActivity)}
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
