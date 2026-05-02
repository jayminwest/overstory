import { cva } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const inputVariants = cva(
	"rounded-md border border-border bg-background text-foreground text-sm px-3 py-2 transition-shadow placeholder:text-muted-foreground/70 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 read-only:bg-muted read-only:cursor-default",
);

function Input({ className, ...props }: React.ComponentProps<"input">) {
	return <input data-slot="input" className={cn(inputVariants(), className)} {...props} />;
}

export { Input, inputVariants };
