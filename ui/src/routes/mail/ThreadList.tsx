import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
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
	if (items.length === 0) {
		return (
			<div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
				No messages
			</div>
		);
	}

	return (
		<ScrollArea className="flex-1">
			<div className="flex flex-col">
				{items.map((msg) => (
					<div key={msg.id} className="relative group">
						<button
							type="button"
							onClick={() => onSelect(msg.id)}
							className={[
								"w-full flex flex-col gap-1 px-3 py-2 text-left border-b hover:bg-accent/50 transition-colors",
								selectedId === msg.id ? "bg-accent text-accent-foreground" : "",
							].join(" ")}
						>
							<div className="flex items-center justify-between gap-2 pr-6">
								<span className="text-sm font-medium truncate flex-1">{msg.subject}</span>
								<div className="flex items-center gap-1 shrink-0">
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
								className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity rounded p-1 text-muted-foreground hover:text-destructive hover:bg-accent"
							>
								<Trash2 className="size-3.5" />
							</button>
						)}
					</div>
				))}
			</div>
		</ScrollArea>
	);
}
