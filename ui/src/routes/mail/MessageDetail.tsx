import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchMessage } from "./api.ts";
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

function MessageRow({ msg }: { msg: MailMessage }) {
	return (
		<div className="flex flex-col gap-1 px-3 py-2 border-b last:border-0">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium truncate flex-1">{msg.subject}</span>
				<Badge variant={typeVariant(msg.type)}>{msg.type}</Badge>
			</div>
			<span className="text-xs text-muted-foreground">
				{msg.from} → {msg.to}
			</span>
			<pre className="whitespace-pre-wrap font-mono text-xs mt-1">{msg.body}</pre>
		</div>
	);
}

interface MessageDetailProps {
	messageId: string | null;
	onReply?: (msg: MailMessage) => void;
}

export function MessageDetail({ messageId, onReply }: MessageDetailProps) {
	const { data, isLoading } = useQuery({
		queryKey: ["mail", "message", messageId],
		queryFn: () => fetchMessage(messageId ?? ""),
		enabled: messageId !== null,
	});

	if (messageId === null) {
		return (
			<div className="h-full flex items-center justify-center p-6">
				<Card className="max-w-xs w-full">
					<CardContent className="pt-6 text-sm text-muted-foreground text-center">
						Select a message
					</CardContent>
				</Card>
			</div>
		);
	}

	if (isLoading || data === undefined) {
		return (
			<div className="h-full flex items-center justify-center p-6 text-sm text-muted-foreground">
				Loading…
			</div>
		);
	}

	const { message, thread } = data;

	return (
		<ScrollArea className="h-full">
			<div className="flex flex-col gap-0">
				{/* Header */}
				<div className="px-4 py-3 border-b flex flex-col gap-1">
					<div className="flex items-center justify-between gap-2">
						<span className="font-semibold text-base truncate flex-1">{message.subject}</span>
						<div className="flex items-center gap-2 shrink-0">
							<Badge variant={typeVariant(message.type)}>{message.type}</Badge>
							{onReply !== undefined && (
								<Button type="button" variant="outline" size="sm" onClick={() => onReply(message)}>
									Reply
								</Button>
							)}
						</div>
					</div>
					<span className="text-xs text-muted-foreground">
						{message.from} → {message.to}
					</span>
					<span className="text-xs text-muted-foreground">
						{new Date(message.createdAt).toISOString()}
					</span>
				</div>

				{/* Body */}
				<div className="px-4 py-3 border-b">
					<pre className="whitespace-pre-wrap font-mono text-xs">{message.body}</pre>
				</div>

				{/* Payload */}
				{message.payload !== null && (
					<div className="px-4 py-3 border-b">
						<details>
							<summary className="text-xs text-muted-foreground cursor-pointer select-none">
								Payload
							</summary>
							<pre className="whitespace-pre-wrap font-mono text-xs mt-2">
								{(() => {
									try {
										return JSON.stringify(JSON.parse(message.payload ?? ""), null, 2);
									} catch {
										return message.payload ?? "";
									}
								})()}
							</pre>
						</details>
					</div>
				)}

				{/* Thread replies */}
				{thread.length > 0 && (
					<div className="flex flex-col">
						<div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b">
							Thread ({thread.length})
						</div>
						{thread.map((msg) => (
							<MessageRow key={msg.id} msg={msg} />
						))}
					</div>
				)}
			</div>
		</ScrollArea>
	);
}
