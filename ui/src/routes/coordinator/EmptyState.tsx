import { Card, CardContent } from "@/components/ui/card";

const STARTER_PROMPTS = [
	{ icon: "📋", text: "What's currently in flight? Give me a one-screen summary." },
	{ icon: "🚦", text: "Are we ready to ship? Run /check-complete." },
	{ icon: "🌱", text: "Spawn a lead for the next ready issue." },
] as const;

interface EmptyStateProps {
	onSelect: (text: string) => void;
}

export function EmptyState({ onSelect }: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center justify-center h-full gap-6 p-6">
			<div className="text-center">
				<h2 className="text-lg font-semibold">Coordinator console</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Send a message to start. Replies arrive inline.
				</p>
			</div>
			<div className="grid gap-3 w-full max-w-2xl sm:grid-cols-3">
				{STARTER_PROMPTS.map((p) => (
					<button key={p.text} type="button" onClick={() => onSelect(p.text)} className="text-left">
						<Card className="py-4 gap-2 transition-colors hover:bg-accent">
							<CardContent className="px-4 flex flex-col gap-2">
								<span className="text-xl leading-none">{p.icon}</span>
								<span className="text-sm">{p.text}</span>
							</CardContent>
						</Card>
					</button>
				))}
			</div>
		</div>
	);
}
