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
	booting: "secondary",
	completed: "outline",
	stalled: "destructive",
	zombie: "destructive",
};

interface AgentTableProps {
	agents: AgentRow[];
}

export function AgentTable({ agents }: AgentTableProps) {
	const navigate = useNavigate();

	if (agents.length === 0) {
		return <p className="text-sm text-muted-foreground py-4">No agents in this run yet.</p>;
	}

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Name</TableHead>
					<TableHead>Capability</TableHead>
					<TableHead>State</TableHead>
					<TableHead>Parent</TableHead>
					<TableHead>Started</TableHead>
					<TableHead>Last Event</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{agents.map((agent) => (
					<TableRow
						key={agent.id}
						className="cursor-pointer"
						onClick={() => navigate(`/agents/${encodeURIComponent(agent.agentName)}`)}
					>
						<TableCell className="font-mono text-xs">{agent.agentName}</TableCell>
						<TableCell>{agent.capability}</TableCell>
						<TableCell>
							<Badge variant={STATE_VARIANT[agent.state]}>{agent.state}</Badge>
						</TableCell>
						<TableCell className="text-muted-foreground text-xs">
							{agent.parentAgent ?? "—"}
						</TableCell>
						<TableCell className="text-xs">{formatRelativeTime(agent.startedAt)}</TableCell>
						<TableCell className="text-xs">{formatRelativeTime(agent.lastActivity)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
