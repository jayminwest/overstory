import { Trash2 } from "lucide-react";
import { useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { useScrollFade } from "@/lib/use-scroll-fade";
import type { MailMessage, MailMessageType } from "./types.ts";

function typeVariant(type: MailMessageType): "default" | "secondary" | "destructive" | "outline" {
	switch (type) {
		case "error":
		case "merge_failed":
			return "destructive";
		case "worker_done":
		case "merged":
		case "merge_ready":
			return "default";
		case "status":
			return "outline";
		default:
			return "secondary";
	}
}

interface ThreadListProps {
	items: MailMessage[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onDelete?: (id: string) => void;
}

export function ThreadList({ items, selectedId, onSelect, onDelete }: ThreadListProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	useScrollFade(viewportRef);

	if (items.length === 0) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-sm text-muted-foreground text-center">
				<p>No messages.</p>
				<p className="leading-relaxed max-w-md">
					Send one with{" "}
					<code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
						{`ov mail send --to coordinator --subject "..." --body "..." --type status`}
					</code>
					.
				</p>
			</div>
		);
	}

	return (
		<div ref={viewportRef} className="flex-1 min-h-0 overflow-auto">
			<div className="flex flex-col">
				{items.map((msg) => (
					<div key={msg.id} className="relative group">
						<button
							type="button"
							onClick={() => onSelect(msg.id)}
							className={[
								"w-full flex flex-col gap-1.5 px-4 py-3 text-left border-b border-border hover:bg-accent/40 transition-colors",
								selectedId === msg.id ? "bg-accent text-accent-foreground" : "",
							].join(" ")}
						>
							<div className="flex items-center justify-between gap-2 pr-7">
								<span className="text-sm font-medium truncate flex-1">{msg.subject}</span>
								<div className="flex items-center gap-1.5 shrink-0">
									<Badge variant={typeVariant(msg.type)}>{msg.type}</Badge>
									{!msg.read && <div className="size-2 rounded-full bg-primary" />}
								</div>
							</div>
							<span className="text-xs text-muted-foreground">
								{msg.from} → {msg.to}
							</span>
						</button>
						{onDelete !== undefined && (
							<button
								type="button"
								aria-label={`Delete message ${msg.subject}`}
								onClick={(e) => {
									e.stopPropagation();
									onDelete(msg.id);
								}}
								className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-accent"
							>
								<Trash2 className="size-3.5" />
							</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
