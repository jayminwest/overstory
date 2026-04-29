import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SummaryCardsProps {
	activeCount: number;
	completedCount: number;
	errorCount: number;
}

export function SummaryCards({ activeCount, completedCount, errorCount }: SummaryCardsProps) {
	return (
		<div className="grid grid-cols-3 gap-4">
			<Card className="gap-3 py-5">
				<CardHeader>
					<CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Active
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-3xl font-semibold tabular-nums">{activeCount}</p>
				</CardContent>
			</Card>
			<Card className="gap-3 py-5">
				<CardHeader>
					<CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Completed
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-3xl font-semibold tabular-nums">{completedCount}</p>
				</CardContent>
			</Card>
			<Card className="gap-3 py-5">
				<CardHeader>
					<CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Errors
					</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-3xl font-semibold tabular-nums text-destructive">{errorCount}</p>
				</CardContent>
			</Card>
		</div>
	);
}
