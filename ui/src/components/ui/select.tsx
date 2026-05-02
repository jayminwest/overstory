import { cva } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const selectVariants = cva(
	"rounded-md border border-border bg-background text-foreground text-sm px-3 py-2 hover:bg-accent/40 transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50",
);

function Select({ className, ...props }: React.ComponentProps<"select">) {
	return <select data-slot="select" className={cn(selectVariants(), className)} {...props} />;
}

export { Select, selectVariants };
