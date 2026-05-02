import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
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
			<Select
				className="px-2.5 py-1.5"
				value={filters.from}
				onChange={(e) => onChange({ ...filters, from: e.target.value })}
			>
				<option value="">All from</option>
				{agents.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</Select>
			<Select
				className="px-2.5 py-1.5"
				value={filters.to}
				onChange={(e) => onChange({ ...filters, to: e.target.value })}
			>
				<option value="">All to</option>
				{agents.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</Select>
		</div>
	);
}
