import { cn } from "@/lib/utils";

export type ConnectionStatusKind = "open" | "connecting" | "closed" | "idle";

interface ConnectionStatusProps {
	status: ConnectionStatusKind;
	className?: string;
	hideLabel?: boolean;
}

const DOT_COLOR: Record<ConnectionStatusKind, string> = {
	open: "bg-green-500",
	connecting: "bg-amber-500",
	closed: "bg-red-500",
	idle: "bg-muted-foreground/40",
};

const LABEL: Record<ConnectionStatusKind, string> = {
	open: "Connected",
	connecting: "Connecting…",
	closed: "Disconnected",
	idle: "Idle",
};

export function ConnectionStatus({ status, className, hideLabel }: ConnectionStatusProps) {
	return (
		<div
			data-slot="connection-status"
			data-status={status}
			className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
		>
			<span
				aria-hidden="true"
				className={cn(
					"h-2 w-2 rounded-full",
					DOT_COLOR[status],
					status === "connecting" && "animate-pulse",
				)}
			/>
			{hideLabel ? <span className="sr-only">{LABEL[status]}</span> : <span>{LABEL[status]}</span>}
		</div>
	);
}
