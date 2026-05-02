import { MessageSquareText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState as EmptyStatePrimitive } from "@/components/ui/empty-state";

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
			<EmptyStatePrimitive
				className="max-w-md border-0 ring-0 bg-transparent"
				icon={MessageSquareText}
				title="Coordinator console"
				description="Send a message to start. Replies arrive inline."
				action={
					showStartCta ? (
						<Button type="button" size="lg" onClick={onStartNewRun}>
							Start new run
						</Button>
					) : undefined
				}
			/>
			<div className="grid gap-3 w-full max-w-3xl sm:grid-cols-3">
				{STARTER_PROMPTS.map((p) => (
					<button
						key={p.text}
						type="button"
						aria-label={p.text}
						onClick={() => onSelect(p.text)}
						className="text-left"
					>
						<Card className="py-5 gap-3 h-full transition-colors hover:bg-accent hover:border-accent-foreground/20">
							<CardContent className="px-5 flex flex-col gap-3">
								<span aria-hidden="true" role="img" className="text-2xl leading-none">
									{p.icon}
								</span>
								<span className="text-sm leading-relaxed">{p.text}</span>
							</CardContent>
						</Card>
					</button>
				))}
			</div>
		</div>
	);
}
