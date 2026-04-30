import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

export type SlashCommand = "/check-complete" | "/status" | "/stop" | "/start";

interface ComposerProps {
	value: string;
	onChange: (value: string) => void;
	onSend: (body: string) => void;
	/** Sends a follow-up "STOP" message — does NOT kill the coordinator process. */
	onStop: () => void;
	onAsk: (subject: string, body: string) => void;
	onSlashCommand: (cmd: SlashCommand) => void;
	isPending: boolean;
}

interface SlashEntry {
	cmd: SlashCommand | "/ask";
	hint: string;
}

const SLASH_ENTRIES: SlashEntry[] = [
	{ cmd: "/check-complete", hint: "Evaluate exit triggers" },
	{ cmd: "/status", hint: "Show coordinator state" },
	{ cmd: "/stop", hint: "Stop the coordinator (confirm)" },
	{ cmd: "/start", hint: "Start the coordinator" },
	{ cmd: "/ask", hint: "/ask <subject> — switch to ask mode for next send" },
];

function isSlashOnly(value: string): boolean {
	const trimmed = value.trim();
	return trimmed === "/" || /^\/[a-z-]*$/.test(trimmed);
}

function matchSlashEntries(value: string): SlashEntry[] {
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return SLASH_ENTRIES;
	return SLASH_ENTRIES.filter((e) => e.cmd.startsWith(trimmed));
}

export function Composer({
	value,
	onChange,
	onSend,
	onStop,
	onAsk,
	onSlashCommand,
	isPending,
}: ComposerProps) {
	const taRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [askArmed, setAskArmed] = useState<{ subject: string } | null>(null);
	const [dismissed, setDismissed] = useState(false);

	const showSlashMenu = useMemo(() => isSlashOnly(value) && !dismissed, [value, dismissed]);
	const slashEntries = useMemo(() => matchSlashEntries(value), [value]);

	useEffect(() => {
		if (!showSlashMenu) return;
		function handleMouseDown(e: MouseEvent) {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setDismissed(true);
			}
		}
		document.addEventListener("mousedown", handleMouseDown);
		return () => document.removeEventListener("mousedown", handleMouseDown);
	}, [showSlashMenu]);

	function dispatchSubmit(opts: { askMode: boolean }) {
		const trimmed = value.trim();
		if (trimmed === "") return;

		setDismissed(true);

		// Built-in slash commands fire immediately on submit.
		if (
			trimmed === "/check-complete" ||
			trimmed === "/status" ||
			trimmed === "/stop" ||
			trimmed === "/start"
		) {
			onSlashCommand(trimmed);
			onChange("");
			return;
		}

		// `/ask <subject>` arms ask mode; the next non-slash send becomes the body.
		if (trimmed.startsWith("/ask ")) {
			const subject = trimmed.slice("/ask ".length).trim();
			if (subject !== "") {
				setAskArmed({ subject });
				onChange("");
			}
			return;
		}

		if (askArmed !== null) {
			onAsk(askArmed.subject, trimmed);
			setAskArmed(null);
			onChange("");
			return;
		}

		if (opts.askMode) {
			// Cmd/Ctrl+Shift+Enter → ask mode with a synthetic subject.
			onAsk("question", trimmed);
			onChange("");
			return;
		}

		onSend(trimmed);
		onChange("");
	}

	function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
		if (e.key === "Escape" && showSlashMenu) {
			e.preventDefault();
			setDismissed(true);
			return;
		}
		const meta = e.metaKey || e.ctrlKey;
		if (e.key === "Enter" && meta) {
			e.preventDefault();
			dispatchSubmit({ askMode: e.shiftKey });
		}
	}

	function handleSelectSlash(entry: SlashEntry) {
		if (entry.cmd === "/ask") {
			onChange("/ask ");
			taRef.current?.focus();
			setDismissed(true);
			return;
		}
		onSlashCommand(entry.cmd);
		onChange("");
		setDismissed(true);
	}

	function handleSendClick() {
		if (isPending) {
			onStop();
			return;
		}
		dispatchSubmit({ askMode: false });
	}

	const placeholder = askArmed
		? `Ask body for "${askArmed.subject}" (Cmd+Enter to send)…`
		: 'Type a message. "/" for commands. Cmd+Enter to send.';

	return (
		<div ref={containerRef} className="border-t border-border bg-background shrink-0">
			{askArmed !== null && (
				<div className="px-6 pt-3 text-xs text-muted-foreground flex items-center gap-2">
					<span>Ask mode armed:</span>
					<span className="font-medium text-foreground">{askArmed.subject}</span>
					<button
						type="button"
						className="ml-auto hover:text-foreground transition-colors"
						onClick={() => setAskArmed(null)}
					>
						cancel
					</button>
				</div>
			)}
			<div className="relative px-6 py-4 flex items-end gap-3 max-w-4xl mx-auto w-full">
				{showSlashMenu && slashEntries.length > 0 && (
					<div className="absolute left-6 right-6 bottom-full mb-2 border border-border rounded-lg bg-popover shadow-md text-sm z-10 overflow-hidden">
						{slashEntries.map((e) => (
							<button
								key={e.cmd}
								type="button"
								className="w-full text-left px-4 py-2.5 hover:bg-accent flex items-baseline gap-3 transition-colors"
								onMouseDown={(ev) => ev.preventDefault()}
								onClick={() => handleSelectSlash(e)}
							>
								<span className="font-mono text-xs">{e.cmd}</span>
								<span className="text-xs text-muted-foreground">{e.hint}</span>
							</button>
						))}
					</div>
				)}
				<textarea
					ref={taRef}
					value={value}
					onChange={(e) => {
						onChange(e.target.value);
						setDismissed(false);
					}}
					onKeyDown={handleKeyDown}
					onBlur={() => setDismissed(true)}
					placeholder={placeholder}
					rows={2}
					className="flex-1 resize-none border border-border rounded-lg px-3 py-2.5 text-sm leading-relaxed bg-background placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent transition-shadow"
				/>
				<Button
					type="button"
					onClick={handleSendClick}
					variant={isPending ? "secondary" : "default"}
					size="default"
				>
					{isPending ? "Stop" : askArmed !== null ? "Ask" : "Send"}
				</Button>
			</div>
		</div>
	);
}
