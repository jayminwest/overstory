import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingCard } from "@/components/ui/loading-card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchMessage } from "@/lib/api";
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
		<div className="flex flex-col gap-1.5 px-6 py-4 border-b border-border last:border-0">
			<div className="flex items-center justify-between gap-2">
				<span className="text-sm font-medium truncate flex-1">{msg.subject}</span>
				<Badge variant={typeVariant(msg.type)}>{msg.type}</Badge>
			</div>
			<span className="text-xs text-muted-foreground">
				{msg.from} → {msg.to}
			</span>
			<CodeBlock variant="block" className="mt-2">
				{msg.body}
			</CodeBlock>
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
			<div className="h-full flex items-center justify-center p-8">
				<EmptyState
					icon={Inbox}
					title="Select a message"
					description="Choose a thread on the left to read it."
				/>
			</div>
		);
	}

	if (isLoading || data === undefined) {
		return (
			<div className="h-full flex items-center justify-center p-8">
				<LoadingCard label="Loading message" />
			</div>
		);
	}

	const { message, thread } = data;

	return (
		<ScrollArea className="h-full">
			<div className="flex flex-col gap-0">
				{/* Header */}
				<div className="px-6 py-4 border-b border-border flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-3">
						<span className="font-semibold text-lg truncate flex-1 tracking-tight">
							{message.subject}
						</span>
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
				<div className="px-6 py-4 border-b border-border">
					<CodeBlock variant="block">{message.body}</CodeBlock>
				</div>

				{/* Payload */}
				{message.payload !== null && (
					<div className="px-6 py-4 border-b border-border">
						<Collapsible>
							<CollapsibleTrigger>Payload</CollapsibleTrigger>
							<CollapsibleContent className="mt-3">
								<CodeBlock variant="block">
									{(() => {
										try {
											return JSON.stringify(JSON.parse(message.payload ?? ""), null, 2);
										} catch {
											return message.payload ?? "";
										}
									})()}
								</CodeBlock>
							</CollapsibleContent>
						</Collapsible>
					</div>
				)}

				{/* Thread replies */}
				{thread.length > 0 && (
					<div className="flex flex-col">
						<div className="px-6 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground border-b border-border bg-muted/30">
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
