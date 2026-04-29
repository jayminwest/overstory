import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

interface NewRunDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onStart: (subject: string, body: string) => Promise<void>;
	isStarting: boolean;
	error: string | null;
}

function deriveSubject(subject: string, body: string): string {
	const trimmed = subject.trim();
	if (trimmed !== "") return trimmed;
	const firstLine = body.split("\n")[0]?.slice(0, 80).trim() ?? "";
	if (firstLine !== "") return firstLine;
	return "new run";
}

export function NewRunDialog({
	open,
	onOpenChange,
	onStart,
	isStarting,
	error,
}: NewRunDialogProps) {
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");

	useEffect(() => {
		if (!open) {
			setSubject("");
			setBody("");
		}
	}, [open]);

	const trimmedBody = body.trim();
	const canSubmit = trimmedBody !== "" && !isStarting;

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		const finalSubject = deriveSubject(subject, body);
		await onStart(finalSubject, trimmedBody);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<form onSubmit={handleSubmit} className="contents">
					<DialogHeader>
						<DialogTitle>Start a new run</DialogTitle>
						<DialogDescription>
							Starts the coordinator and sends an initial prompt to seed the run.
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-5">
						<div className="flex flex-col gap-2">
							<label htmlFor="new-run-subject" className="text-sm font-medium">
								Subject <span className="text-muted-foreground font-normal">(optional)</span>
							</label>
							<input
								id="new-run-subject"
								type="text"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								disabled={isStarting}
								placeholder="Derived from the first line if blank"
								className="border border-border rounded-md px-3 py-2 text-sm bg-background placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 transition-shadow"
							/>
						</div>
						<div className="flex flex-col gap-2">
							<label htmlFor="new-run-body" className="text-sm font-medium">
								Initial prompt
							</label>
							<textarea
								id="new-run-body"
								value={body}
								onChange={(e) => setBody(e.target.value)}
								disabled={isStarting}
								rows={6}
								required
								placeholder="What should the coordinator do?"
								className="resize-y border border-border rounded-md px-3 py-2 text-sm leading-relaxed bg-background placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 transition-shadow"
							/>
						</div>
						{error !== null && (
							<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
								{error}
							</div>
						)}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
							disabled={isStarting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!canSubmit}>
							{isStarting ? "Starting…" : "Start run"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
