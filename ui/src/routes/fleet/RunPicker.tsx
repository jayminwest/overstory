import type { Run } from "@/lib/api";

import { formatAbsoluteTime } from "./format";

interface RunPickerProps {
	runs: Run[];
	selectedRunId: string | null;
	onSelect: (runId: string) => void;
}

export function RunPicker({ runs, selectedRunId, onSelect }: RunPickerProps) {
	if (runs.length === 0) return null;

	const value = selectedRunId ?? runs[0]?.id ?? "";

	return (
		<div className="flex items-center gap-2">
			<label htmlFor="run-picker" className="text-sm text-muted-foreground whitespace-nowrap">
				Run:
			</label>
			<select
				id="run-picker"
				className="border border-border rounded-md px-2.5 py-1.5 text-sm bg-background text-foreground hover:bg-accent/40 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
				value={value}
				onChange={(e) => onSelect(e.target.value)}
			>
				{runs.map((run) => (
					<option key={run.id} value={run.id}>
						{run.id} — {run.status} — {formatAbsoluteTime(run.startedAt)}
					</option>
				))}
			</select>
		</div>
	);
}
