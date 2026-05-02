import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { fetchMailAgents } from "@/lib/api";

export interface MailFilters {
	unread: boolean;
	from: string;
	to: string;
}

interface FilterChipsProps {
	filters: MailFilters;
	onChange: (filters: MailFilters) => void;
}

export function FilterChips({ filters, onChange }: FilterChipsProps) {
	const { data: agents = [] } = useQuery({ queryKey: ["agents-list"], queryFn: fetchMailAgents });

	return (
		<div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/30 shrink-0">
			<Button
				variant={filters.unread ? "default" : "outline"}
				size="sm"
				onClick={() => onChange({ ...filters, unread: !filters.unread })}
			>
				Unread
			</Button>
			<select
				className="rounded-md border border-border bg-background text-sm px-2.5 py-1.5 hover:bg-accent/40 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
				value={filters.from}
				onChange={(e) => onChange({ ...filters, from: e.target.value })}
			>
				<option value="">All from</option>
				{agents.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</select>
			<select
				className="rounded-md border border-border bg-background text-sm px-2.5 py-1.5 hover:bg-accent/40 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
				value={filters.to}
				onChange={(e) => onChange({ ...filters, to: e.target.value })}
			>
				<option value="">All to</option>
				{agents.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</select>
		</div>
	);
}
