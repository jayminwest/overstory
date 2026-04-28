import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function Home() {
	return (
		<div className="p-6">
			<Card className="max-w-md">
				<CardHeader>
					<CardTitle>Overstory UI — Phase 1 scaffold</CardTitle>
					<CardDescription>
						Fleet view ships in overstory-6c4f. This is the Phase 1 placeholder.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-sm text-muted-foreground">
						The real fleet view with live agent panels, run status, and swarm topology is coming in
						the next issue.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
