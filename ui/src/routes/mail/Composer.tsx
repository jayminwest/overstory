import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchMailAgents, replyMail, sendMail } from "@/lib/api";

const GROUP_ADDRESSES = [
	"@all",
	"@builders",
	"@scouts",
	"@reviewers",
	"@leads",
	"@mergers",
	"@coordinators",
];

const SEMANTIC_TYPES = ["status", "question", "result", "error"] as const;
type SemanticType = (typeof SEMANTIC_TYPES)[number];

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
type Priority = (typeof PRIORITIES)[number];

export interface ComposerReplyContext {
	messageId: string;
	to: string;
	subject: string;
}

export interface ComposerProps {
	open: boolean;
	onClose: () => void;
	onSuccess?: (messageId: string | string[]) => void;
	onError?: (error: Error) => void;
	replyTo?: ComposerReplyContext;
}

export function Composer({ open, onClose, onSuccess, onError, replyTo }: ComposerProps) {
	const queryClient = useQueryClient();
	const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
	const datalistId = useId();

	const [to, setTo] = useState("");
	const [from, setFrom] = useState("operator");
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [type, setType] = useState<SemanticType>("status");
	const [priority, setPriority] = useState<Priority>("normal");
	const [payload, setPayload] = useState("");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { data: agents = [] } = useQuery({
		queryKey: ["agents-list"],
		queryFn: fetchMailAgents,
		enabled: open,
	});

	useEffect(() => {
		if (!open) return;
		setError(null);
		setSubmitting(false);
		if (replyTo) {
			setTo(replyTo.to);
			setSubject(replyTo.subject.startsWith("Re: ") ? replyTo.subject : `Re: ${replyTo.subject}`);
			setBody("");
			setShowAdvanced(false);
			setPayload("");
		} else {
			setTo("");
			setSubject("");
			setBody("");
			setType("status");
			setPriority("normal");
			setShowAdvanced(false);
			setPayload("");
		}
	}, [open, replyTo]);

	useEffect(() => {
		if (!open) return;
		const t = window.setTimeout(() => {
			firstFieldRef.current?.focus();
		}, 0);
		return () => window.clearTimeout(t);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	async function handleSubmit() {
		if (submitting) return;
		setError(null);

		const trimmedTo = to.trim();
		const trimmedSubject = subject.trim();
		const trimmedBody = body.trim();

		if (!replyTo) {
			if (trimmedTo === "") {
				setError("To is required");
				return;
			}
			if (trimmedSubject === "") {
				setError("Subject is required");
				return;
			}
		}
		if (trimmedBody === "") {
			setError("Body is required");
			return;
		}

		let payloadString: string | undefined;
		if (showAdvanced && payload.trim() !== "") {
			try {
				JSON.parse(payload);
				payloadString = payload;
			} catch (_err) {
				setError("Payload must be valid JSON");
				return;
			}
		}

		setSubmitting(true);
		try {
			let result: { messageId?: string; messageIds?: string[] };
			if (replyTo) {
				const reply = await replyMail(replyTo.messageId, {
					from: from.trim() || "operator",
					body: trimmedBody,
					type,
					priority,
				});
				result = { messageId: reply.messageId };
			} else {
				result = await sendMail({
					to: trimmedTo,
					from: from.trim() || "operator",
					subject: trimmedSubject,
					body: trimmedBody,
					type,
					priority,
					payload: payloadString,
				});
			}
			await queryClient.invalidateQueries({ queryKey: ["mail"] });
			const idArg = result.messageIds ?? result.messageId ?? "";
			onSuccess?.(idArg);
			onClose();
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			setError(e.message);
			onError?.(e);
		} finally {
			setSubmitting(false);
		}
	}

	function handleBodyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
		if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
			e.preventDefault();
			void handleSubmit();
		}
	}

	const autocompleteOptions = [...new Set([...agents, ...GROUP_ADDRESSES])];
	const isReply = replyTo !== undefined;
	const toInputId = `${datalistId}-to`;

	const inputClass =
		"rounded-md border border-border text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow placeholder:text-muted-foreground/70";

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center p-4"
			role="dialog"
			aria-modal="true"
			aria-label={isReply ? "Reply to message" : "Compose message"}
		>
			<button
				type="button"
				aria-label="Close composer"
				className="absolute inset-0 bg-foreground/40 backdrop-blur-sm cursor-default"
				onClick={onClose}
			/>
			<Card className="relative w-full max-w-xl max-h-[90vh] overflow-auto py-5 gap-0">
				<CardContent className="flex flex-col gap-4 px-6">
					<div className="flex items-center justify-between">
						<h2 className="text-lg font-semibold tracking-tight">
							{isReply ? "Reply" : "New message"}
						</h2>
						<Button type="button" variant="ghost" size="sm" onClick={onClose}>
							Close
						</Button>
					</div>

					<div className="flex flex-col gap-1.5 text-sm">
						<label htmlFor={toInputId} className="text-muted-foreground text-xs font-medium">
							To
						</label>
						<input
							id={toInputId}
							ref={(el) => {
								if (!isReply) firstFieldRef.current = el;
							}}
							type="text"
							list={isReply ? undefined : datalistId}
							className={`${inputClass} ${isReply ? "bg-muted" : "bg-background"}`}
							value={to}
							onChange={(e) => setTo(e.target.value)}
							placeholder="agent or @group"
							readOnly={isReply}
							required={!isReply}
						/>
						<datalist id={datalistId}>
							{autocompleteOptions.map((name) => (
								<option key={name} value={name} />
							))}
						</datalist>
					</div>

					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-muted-foreground text-xs font-medium">Subject</span>
						<input
							type="text"
							className={`${inputClass} ${isReply ? "bg-muted" : "bg-background"}`}
							value={subject}
							onChange={(e) => setSubject(e.target.value)}
							readOnly={isReply}
							required
						/>
					</label>

					<label className="flex flex-col gap-1.5 text-sm">
						<span className="text-muted-foreground text-xs font-medium">Body</span>
						<textarea
							ref={(el) => {
								if (isReply) firstFieldRef.current = el;
							}}
							className={`${inputClass} bg-background font-mono leading-relaxed`}
							rows={6}
							value={body}
							onChange={(e) => setBody(e.target.value)}
							onKeyDown={handleBodyKeyDown}
							placeholder="Cmd/Ctrl+Enter to send"
							required
						/>
					</label>

					<div className="grid grid-cols-3 gap-3 text-sm">
						<label className="flex flex-col gap-1.5">
							<span className="text-muted-foreground text-xs font-medium">From</span>
							<input
								type="text"
								className={`${inputClass} bg-background`}
								value={from}
								onChange={(e) => setFrom(e.target.value)}
							/>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="text-muted-foreground text-xs font-medium">Type</span>
							<select
								className={`${inputClass} bg-background`}
								value={type}
								onChange={(e) => setType(e.target.value as SemanticType)}
							>
								{SEMANTIC_TYPES.map((t) => (
									<option key={t} value={t}>
										{t}
									</option>
								))}
							</select>
						</label>
						<label className="flex flex-col gap-1.5">
							<span className="text-muted-foreground text-xs font-medium">Priority</span>
							<select
								className={`${inputClass} bg-background`}
								value={priority}
								onChange={(e) => setPriority(e.target.value as Priority)}
							>
								{PRIORITIES.map((p) => (
									<option key={p} value={p}>
										{p}
									</option>
								))}
							</select>
						</label>
					</div>

					{!isReply && (
						<div className="flex flex-col gap-2 text-sm">
							<button
								type="button"
								className="text-xs text-muted-foreground self-start hover:text-foreground transition-colors"
								onClick={() => setShowAdvanced((v) => !v)}
							>
								{showAdvanced ? "Hide advanced" : "Show advanced"}
							</button>
							{showAdvanced && (
								<label className="flex flex-col gap-1.5">
									<span className="text-muted-foreground text-xs font-medium">Payload (JSON)</span>
									<textarea
										className={`${inputClass} bg-background font-mono leading-relaxed`}
										rows={4}
										value={payload}
										onChange={(e) => setPayload(e.target.value)}
										placeholder='{"key": "value"}'
									/>
								</label>
							)}
						</div>
					)}

					{error !== null && (
						<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
							{error}
						</div>
					)}

					<div className="flex items-center justify-end gap-2 pt-1">
						<Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={() => {
								void handleSubmit();
							}}
							disabled={submitting}
						>
							{submitting ? "Sending…" : isReply ? "Send reply" : "Send"}
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
