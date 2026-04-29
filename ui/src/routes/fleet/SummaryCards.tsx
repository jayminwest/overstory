import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SummaryCardsProps {
	activeCount: number;
	completedCount: number;
	errorCount: number;
}

export function SummaryCards({ activeCount, completedCount, errorCount }: SummaryCardsProps) {
	return (
		<div className="grid grid-cols-3 gap-4">
			<Card>
				<CardHeader>
					<CardTitle className="text-sm font-medium text-muted-foreground">Active</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-2xl font-bold">{activeCount}</p>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-sm font-medium text-muted-foreground">Completed</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-2xl font-bold">{completedCount}</p>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle className="text-sm font-medium text-muted-foreground">Errors</CardTitle>
				</CardHeader>
				<CardContent>
					<p className="text-2xl font-bold text-destructive">{errorCount}</p>
				</CardContent>
			</Card>
		</div>
	);
}
