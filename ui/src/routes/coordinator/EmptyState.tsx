import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const STARTER_PROMPTS = [
	{ icon: "📋", text: "What's currently in flight? Give me a one-screen summary." },
	{ icon: "🚦", text: "Are we ready to ship? Run /check-complete." },
	{ icon: "🌱", text: "Spawn a lead for the next ready issue." },
] as const;

interface EmptyStateProps {
	onSelect: (text: string) => void;
	onStartNewRun?: () => void;
	isStopped?: boolean;
}

export function EmptyState({ onSelect, onStartNewRun, isStopped }: EmptyStateProps) {
	const showStartCta = isStopped === true && onStartNewRun !== undefined;

	return (
		<div className="flex flex-col items-center justify-center h-full gap-8 p-8">
			<div className="text-center max-w-md">
				<h2 className="text-2xl font-semibold tracking-tight">Coordinator console</h2>
				<p className="text-sm text-muted-foreground mt-2 leading-relaxed">
					Send a message to start. Replies arrive inline.
				</p>
			</div>
			{showStartCta && (
				<div className="flex flex-col items-center gap-3">
					<p className="text-sm text-muted-foreground">Coordinator is stopped.</p>
					<Button type="button" size="lg" onClick={onStartNewRun}>
						Start new run
					</Button>
				</div>
			)}
			<div className="grid gap-3 w-full max-w-3xl sm:grid-cols-3">
				{STARTER_PROMPTS.map((p) => (
					<button key={p.text} type="button" onClick={() => onSelect(p.text)} className="text-left">
						<Card className="py-5 gap-3 h-full transition-colors hover:bg-accent hover:border-accent-foreground/20">
							<CardContent className="px-5 flex flex-col gap-3">
								<span className="text-2xl leading-none">{p.icon}</span>
								<span className="text-sm leading-relaxed">{p.text}</span>
							</CardContent>
						</Card>
					</button>
				))}
			</div>
		</div>
	);
}
