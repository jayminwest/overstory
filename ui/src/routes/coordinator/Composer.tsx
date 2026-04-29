import { type KeyboardEvent, useMemo, useRef, useState } from "react";

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
	return trimmed === "" || trimmed === "/" || /^\/[a-z-]*$/.test(trimmed);
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
	const [askArmed, setAskArmed] = useState<{ subject: string } | null>(null);

	const showSlashMenu = useMemo(() => isSlashOnly(value), [value]);
	const slashEntries = useMemo(() => matchSlashEntries(value), [value]);

	function dispatchSubmit(opts: { askMode: boolean }) {
		const trimmed = value.trim();
		if (trimmed === "") return;

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
			return;
		}
		onSlashCommand(entry.cmd);
		onChange("");
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
		<div className="border-t bg-background shrink-0">
			{askArmed !== null && (
				<div className="px-4 pt-2 text-xs text-muted-foreground flex items-center gap-2">
					<span>Ask mode armed:</span>
					<span className="font-medium text-foreground">{askArmed.subject}</span>
					<button
						type="button"
						className="ml-auto hover:text-foreground"
						onClick={() => setAskArmed(null)}
					>
						cancel
					</button>
				</div>
			)}
			<div className="relative px-4 py-3 flex items-end gap-2">
				{showSlashMenu && slashEntries.length > 0 && (
					<div className="absolute left-4 right-4 bottom-full mb-1 border rounded-md bg-popover shadow-md text-sm z-10">
						{slashEntries.map((e) => (
							<button
								key={e.cmd}
								type="button"
								className="w-full text-left px-3 py-2 hover:bg-accent flex items-baseline gap-3 first:rounded-t-md last:rounded-b-md"
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
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={handleKeyDown}
					placeholder={placeholder}
					rows={2}
					className="flex-1 resize-none border rounded-md px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
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
