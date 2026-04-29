import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { deleteMail, fetchMail } from "./mail/api.ts";
import { Composer, type ComposerReplyContext } from "./mail/Composer.tsx";
import { FilterChips, type MailFilters } from "./mail/FilterChips.tsx";
import { MessageDetail } from "./mail/MessageDetail.tsx";
import { ThreadList } from "./mail/ThreadList.tsx";
import type { MailMessage } from "./mail/types.ts";
import { useMailSocket } from "./mail/ws.ts";

function prependDedup(msg: MailMessage, prev: MailMessage[]): MailMessage[] {
	const idx = prev.findIndex((m) => m.id === msg.id);
	if (idx !== -1) {
		const next = [...prev];
		next[idx] = msg;
		return next;
	}
	return [msg, ...prev];
}

interface ComposerState {
	open: boolean;
	replyTo?: ComposerReplyContext;
}

export function Mail() {
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [filters, setFilters] = useState<MailFilters>({ unread: false, from: "", to: "" });
	const [composerState, setComposerState] = useState<ComposerState>({ open: false });

	const { data: list = [] } = useQuery({
		queryKey: ["mail", filters],
		queryFn: () => fetchMail(filters),
		refetchInterval: 5000,
	});

	useMailSocket((msg) => {
		queryClient.setQueryData<MailMessage[]>(["mail", filters], (prev) =>
			prependDedup(msg, prev ?? []),
		);
	});

	function handleSelect(id: string) {
		setSelectedId(id);
		// Optimistically flip read flag; fire-and-forget
		queryClient.setQueryData<MailMessage[]>(["mail", filters], (prev) =>
			prev !== undefined ? prev.map((m) => (m.id === id ? { ...m, read: true } : m)) : undefined,
		);
		void import("./mail/api.ts").then(({ markRead }) => markRead(id));
	}

	function handleReply(msg: MailMessage) {
		setComposerState({
			open: true,
			replyTo: { messageId: msg.id, to: msg.from, subject: msg.subject },
		});
	}

	function handleCompose() {
		setComposerState({ open: true });
	}

	function handleCloseComposer() {
		setComposerState({ open: false });
	}

	async function handleDelete(id: string) {
		const queryKey = ["mail", filters] as const;
		const previous = queryClient.getQueryData<MailMessage[]>(queryKey);
		queryClient.setQueryData<MailMessage[]>(queryKey, (prev) =>
			prev !== undefined ? prev.filter((m) => m.id !== id) : undefined,
		);
		if (selectedId === id) setSelectedId(null);
		try {
			await deleteMail(id);
			await queryClient.invalidateQueries({ queryKey: ["mail"] });
		} catch (err) {
			console.error("delete failed", err);
			if (previous !== undefined) queryClient.setQueryData<MailMessage[]>(queryKey, previous);
		}
	}

	return (
		<>
			<ResizablePanelGroup direction="horizontal" className="h-full">
				<ResizablePanel defaultSize={35} minSize={25}>
					<div className="flex flex-col h-full">
						<div className="flex items-center justify-end gap-2 px-3 py-2 border-b">
							<Button size="sm" onClick={handleCompose}>
								Compose
							</Button>
						</div>
						<FilterChips filters={filters} onChange={setFilters} />
						<ThreadList
							items={list}
							selectedId={selectedId}
							onSelect={handleSelect}
							onDelete={(id) => {
								void handleDelete(id);
							}}
						/>
					</div>
				</ResizablePanel>
				<ResizableHandle withHandle />
				<ResizablePanel defaultSize={65}>
					<MessageDetail messageId={selectedId} onReply={handleReply} />
				</ResizablePanel>
			</ResizablePanelGroup>
			<Composer
				open={composerState.open}
				onClose={handleCloseComposer}
				replyTo={composerState.replyTo}
				onError={(e) => console.error("compose failed", e)}
			/>
		</>
	);
}
