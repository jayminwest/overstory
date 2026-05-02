import { cva } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

const emptyStateVariants = cva(
	"flex flex-col items-center justify-center gap-4 p-8 text-center bg-card text-card-foreground rounded-xl border border-border ring-1 ring-foreground/10",
);

interface EmptyStateProps extends Omit<React.ComponentProps<"div">, "title"> {
	icon?: LucideIcon;
	title: React.ReactNode;
	description?: React.ReactNode;
	action?: React.ReactNode;
}

function EmptyState({
	icon: Icon,
	title,
	description,
	action,
	className,
	...props
}: EmptyStateProps) {
	return (
		<div data-slot="empty-state" className={cn(emptyStateVariants(), className)} {...props}>
			{Icon !== undefined && <Icon className="size-8 text-muted-foreground" aria-hidden="true" />}
			<div className="flex flex-col gap-1.5 items-center">
				<h3 className="text-sm font-medium tracking-tight">{title}</h3>
				{description !== undefined && (
					<div className="text-sm text-muted-foreground leading-relaxed max-w-md">
						{description}
					</div>
				)}
			</div>
			{action !== undefined && <div className="mt-1">{action}</div>}
		</div>
	);
}

export { EmptyState, emptyStateVariants };
