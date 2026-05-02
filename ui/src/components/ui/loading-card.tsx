import { cva } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const loadingCardVariants = cva(
	"flex flex-col items-center justify-center gap-4 p-8 text-center bg-card text-card-foreground rounded-xl border border-border ring-1 ring-foreground/10",
);

interface LoadingCardProps extends React.ComponentProps<"output"> {
	label?: string;
}

function LoadingCard({ className, label = "Loading", ...props }: LoadingCardProps) {
	return (
		<output
			data-slot="loading-card"
			aria-busy="true"
			aria-live="polite"
			className={cn(loadingCardVariants(), className)}
			{...props}
		>
			<div className="size-8 rounded-md bg-muted/60 motion-safe:animate-pulse" />
			<div className="flex flex-col items-center gap-2 w-full max-w-xs">
				<div className="h-4 w-2/3 rounded bg-muted/60 motion-safe:animate-pulse" />
				<div className="h-3 w-full rounded bg-muted/60 motion-safe:animate-pulse" />
			</div>
			<span className="sr-only">{label}…</span>
		</output>
	);
}

export { LoadingCard, loadingCardVariants };
