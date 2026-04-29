import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { type Frame, type StoredEvent, useWebSocket } from "@/lib/ws";

import {
	type CheckCompleteResult,
	fetchCoordinatorState,
	postCoordinatorAsk,
	postCoordinatorCheckComplete,
	postCoordinatorSend,
	postCoordinatorStart,
	postCoordinatorStop,
} from "./api";
import { Composer, type SlashCommand } from "./Composer";
import { EmptyState } from "./EmptyState";
import { NewRunDialog } from "./NewRunDialog";
import { StatusPill } from "./StatusPill";
import { type ChatTurn, Thread } from "./Thread";

const COORDINATOR = "coordinator";
const OPERATOR = "operator";
const STALL_AFTER_MS = 60_000;
const NEW_RUN_POLL_INTERVAL_MS = 500;
const NEW_RUN_TIMEOUT_MS = 30_000;

interface MailMessageWire {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	createdAt: string;
	threadId: string | null;
}

interface MailEnvelope {
	success: boolean;
	data?: MailMessageWire[];
	error?: string;
}

async function fetchMailDirected(opts: { from: string; to: string }): Promise<MailMessageWire[]> {
	const params = new URLSearchParams({
		from: opts.from,
		to: opts.to,
		limit: "200",
	});
	const res = await fetch(`/api/mail?${params.toString()}`);
	const json = (await res.json()) as MailEnvelope;
	if (!res.ok || json.success !== true || json.data === undefined) {
		throw new Error(json.error ?? `mail fetch failed: ${res.status}`);
	}
	return json.data;
}

async function fetchInitialThread(): Promise<ChatTurn[]> {
	const [out, inn] = await Promise.all([
		fetchMailDirected({ from: OPERATOR, to: COORDINATOR }),
		fetchMailDirected({ from: COORDINATOR, to: OPERATOR }),
	]);
	const turns: ChatTurn[] = [];
	for (const m of out) {
		turns.push({
			kind: "operator",
			id: m.id,
			subject: m.subject,
			body: m.body,
			createdAt: m.createdAt,
			threadId: m.threadId,
		});
	}
	for (const m of inn) {
		turns.push({
			kind: "coordinator",
			id: m.id,
			subject: m.subject,
			body: m.body,
			createdAt: m.createdAt,
			threadId: m.threadId,
		});
	}
	turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	return turns;
}

function isStoredEvent(payload: unknown): payload is StoredEvent {
	return (
		payload !== null &&
		typeof payload === "object" &&
		"id" in payload &&
		"agentName" in payload &&
		"eventType" in payload
	);
}

interface BatchedEvents {
	batched: true;
	events: StoredEvent[];
}

function isBatched(payload: unknown): payload is BatchedEvents {
	return (
		payload !== null &&
		typeof payload === "object" &&
		"batched" in payload &&
		(payload as { batched: unknown }).batched === true
	);
}

function isMailWire(payload: unknown): payload is MailMessageWire {
	return (
		payload !== null &&
		typeof payload === "object" &&
		"id" in payload &&
		"from" in payload &&
		"to" in payload &&
		"body" in payload &&
		"createdAt" in payload
	);
}

interface PendingTurn {
	clientToken: string;
	subject: string;
	body: string;
	sentAt: number;
	messageId: string | null;
}

function formatCheckComplete(r: CheckCompleteResult): string {
	const t = r.triggers;
	const line = (label: string, trig: { enabled: boolean; met: boolean; detail: string }) =>
		`${trig.met ? "✓" : trig.enabled ? "·" : "○"} ${label}: ${trig.detail}`;
	return [
		line("allAgentsDone", t.allAgentsDone),
		line("taskTrackerEmpty", t.taskTrackerEmpty),
		line("onShutdownSignal", t.onShutdownSignal),
		`Complete: ${r.complete ? "YES" : "NO"}`,
	].join("\n");
}

export function ConsolePage() {
	const [turns, setTurns] = useState<ChatTurn[]>([]);
	const [pending, setPending] = useState<PendingTurn | null>(null);
	const [composerValue, setComposerValue] = useState("");
	const [lastCheck, setLastCheck] = useState<{
		at: string;
		result: CheckCompleteResult;
	} | null>(null);
	const [initialLoaded, setInitialLoaded] = useState(false);
	const [newRunOpen, setNewRunOpenState] = useState(false);
	const [isStartingNewRun, setIsStartingNewRun] = useState(false);
	const [newRunError, setNewRunError] = useState<string | null>(null);

	const setNewRunOpen = useCallback((open: boolean) => {
		setNewRunOpenState(open);
		if (!open) setNewRunError(null);
	}, []);

	const pendingRef = useRef<PendingTurn | null>(null);
	useEffect(() => {
		pendingRef.current = pending;
	}, [pending]);

	// Initial load from mail.db.
	const initial = useQuery({
		queryKey: ["coordinator-thread"],
		queryFn: fetchInitialThread,
		refetchInterval: 5000,
	});

	useEffect(() => {
		if (initial.data === undefined) return;
		setTurns((prev) => {
			// Merge: real messages from server + any locally appended turns
			// (system bubbles, optimistic operator messages not yet round-tripped).
			const seen = new Set<string>();
			const merged: ChatTurn[] = [];
			for (const t of initial.data) {
				seen.add(t.id);
				merged.push(t);
			}
			for (const t of prev) {
				if (!seen.has(t.id)) merged.push(t);
			}
			merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
			return merged;
		});
		setInitialLoaded(true);
	}, [initial.data]);

	// Polled coordinator state — used to disable Send when not running.
	const stateQuery = useQuery({
		queryKey: ["coordinator-state-page"],
		queryFn: fetchCoordinatorState,
		refetchInterval: 5000,
	});

	// Stall detection: tick every 5s; if pending older than threshold, mark stalled.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (pending === null) return;
		const t = setInterval(() => setNow(Date.now()), 5000);
		return () => clearInterval(t);
	}, [pending]);

	const pendingStatus: "pending" | "stalled" =
		pending !== null && now - pending.sentAt > STALL_AFTER_MS ? "stalled" : "pending";

	// Apply pending status to any pending turn currently rendered.
	useEffect(() => {
		setTurns((prev) =>
			prev.map((t) =>
				t.pending !== undefined && t.pending.status !== pendingStatus
					? { ...t, pending: { ...t.pending, status: pendingStatus } }
					: t,
			),
		);
	}, [pendingStatus]);

	const ingestMail = useCallback((m: MailMessageWire) => {
		// Only care about coord ↔ operator traffic.
		const isCoordToOp = m.from === COORDINATOR && m.to === OPERATOR;
		const isOpToCoord = m.from === OPERATOR && m.to === COORDINATOR;
		if (!isCoordToOp && !isOpToCoord) return;

		setTurns((prev) => {
			// Dedup by id.
			if (prev.some((t) => t.id === m.id)) return prev;

			const cur = pendingRef.current;
			if (isCoordToOp && cur !== null) {
				// Settle the pending coordinator bubble in place if this is the reply
				// to our most recent send. Match by threadId === messageId, falling
				// back to the temporal window (within stall threshold).
				const matchById = cur.messageId !== null && m.threadId === cur.messageId;
				const matchByWindow = cur.messageId === null && Date.now() - cur.sentAt < STALL_AFTER_MS;
				if (matchById || matchByWindow) {
					const next = prev.map((t) =>
						t.pending !== undefined && t.pending.clientToken === cur.clientToken
							? {
									kind: "coordinator" as const,
									id: m.id,
									subject: m.subject,
									body: m.body,
									createdAt: m.createdAt,
									threadId: m.threadId,
								}
							: t,
					);
					pendingRef.current = null;
					setPending(null);
					return next;
				}
			}

			// Otherwise just append (and replace any optimistic operator turn that
			// shares subject+body — coarse but adequate).
			if (isOpToCoord) {
				const idx = prev.findIndex(
					(t) =>
						t.kind === "operator" &&
						t.id.startsWith("pending-op-") &&
						t.subject === m.subject &&
						t.body === m.body,
				);
				if (idx >= 0) {
					const next = [...prev];
					next[idx] = {
						kind: "operator",
						id: m.id,
						subject: m.subject,
						body: m.body,
						createdAt: m.createdAt,
						threadId: m.threadId,
					};
					return next;
				}
			}

			return [
				...prev,
				{
					kind: isCoordToOp ? ("coordinator" as const) : ("operator" as const),
					id: m.id,
					subject: m.subject,
					body: m.body,
					createdAt: m.createdAt,
					threadId: m.threadId,
				},
			].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		});
	}, []);

	// WebSocket — coordinator events + mail.
	const handleFrame = useCallback(
		(frame: Frame) => {
			if (frame.type === "event") {
				const { payload } = frame;
				const events: StoredEvent[] = isBatched(payload)
					? payload.events
					: isStoredEvent(payload)
						? [payload]
						: [];
				if (events.length === 0) return;
				const cur = pendingRef.current;
				if (cur === null) return;
				const coordEvents = events.filter((e) => e.agentName === COORDINATOR);
				if (coordEvents.length === 0) return;
				setTurns((prev) =>
					prev.map((t) =>
						t.pending !== undefined && t.pending.clientToken === cur.clientToken
							? {
									...t,
									pending: {
										...t.pending,
										workEvents: [...t.pending.workEvents, ...coordEvents],
									},
								}
							: t,
					),
				);
				return;
			}

			if (frame.type === "mail") {
				const message = (frame.payload as { message: unknown }).message;
				if (!isMailWire(message)) return;
				ingestMail(message);
			}
		},
		[ingestMail],
	);

	useWebSocket<Frame>(`/ws?agent=${COORDINATOR}`, { onMessage: handleFrame });

	const appendSystem = useCallback((subject: string, body: string) => {
		setTurns((prev) => [
			...prev,
			{
				kind: "system",
				id: `sys-${crypto.randomUUID()}`,
				subject,
				body,
				createdAt: new Date().toISOString(),
				threadId: null,
			},
		]);
	}, []);

	const handleSend = useCallback(
		async (body: string) => {
			const clientToken = crypto.randomUUID();
			const sentAt = Date.now();
			const subject = body.split("\n")[0]?.slice(0, 80) || "message";
			const createdAt = new Date(sentAt).toISOString();

			setTurns((prev) => [
				...prev,
				{
					kind: "operator",
					id: `pending-op-${clientToken}`,
					subject,
					body,
					createdAt,
					threadId: null,
				},
				{
					kind: "coordinator",
					id: `pending-coord-${clientToken}`,
					subject: "",
					body: "",
					createdAt,
					threadId: null,
					pending: { clientToken, workEvents: [], status: "pending" },
				},
			]);
			setPending({ clientToken, subject, body, sentAt, messageId: null });

			try {
				const result = await postCoordinatorSend({ subject, body, from: OPERATOR });
				setPending((cur) =>
					cur !== null && cur.clientToken === clientToken
						? { ...cur, messageId: result.messageId }
						: cur,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				// Rip out optimistic bubbles; surface error inline.
				setTurns((prev) =>
					prev.filter(
						(t) => t.id !== `pending-op-${clientToken}` && t.id !== `pending-coord-${clientToken}`,
					),
				);
				setPending(null);
				appendSystem("send failed", msg);
			}
		},
		[appendSystem],
	);

	const handleStop = useCallback(async () => {
		if (pendingRef.current === null) return;
		try {
			await postCoordinatorSend({
				subject: "STOP",
				body: "Operator requested stop.",
				from: OPERATOR,
			});
			appendSystem("STOP sent", "Sent a STOP follow-up. The coordinator decides how to respond.");
		} catch (err) {
			appendSystem("STOP failed", err instanceof Error ? err.message : String(err));
		}
	}, [appendSystem]);

	const handleAsk = useCallback(
		async (subject: string, body: string) => {
			try {
				const result = await postCoordinatorAsk({ subject, body, from: OPERATOR });
				if (result.timedOut) {
					appendSystem(`/ask ${subject}`, "Timed out waiting for reply.");
					return;
				}
				if (result.reply !== null) {
					appendSystem(
						`/ask ${subject} → reply`,
						`${result.reply.subject}\n\n${result.reply.body}`,
					);
				} else {
					appendSystem(`/ask ${subject}`, "No reply received.");
				}
			} catch (err) {
				appendSystem(`/ask ${subject}`, err instanceof Error ? err.message : String(err));
			}
		},
		[appendSystem],
	);

	const handleSlashCommand = useCallback(
		async (cmd: SlashCommand) => {
			try {
				if (cmd === "/check-complete") {
					const result = await postCoordinatorCheckComplete();
					setLastCheck({ at: new Date().toISOString(), result });
					appendSystem("/check-complete", formatCheckComplete(result));
					return;
				}
				if (cmd === "/status") {
					const state = await fetchCoordinatorState();
					const lines = [
						`running: ${state.running}`,
						`agentName: ${state.agentName}`,
						`headless: ${state.headless}`,
						`pid: ${state.pid ?? "—"}`,
						`runId: ${state.runId ?? "—"}`,
						`startedAt: ${state.startedAt ?? "—"}`,
						`lastActivityAt: ${state.lastActivityAt ?? "—"}`,
					];
					appendSystem("/status", lines.join("\n"));
					return;
				}
				if (cmd === "/start") {
					const result = await postCoordinatorStart();
					const lines = [
						`started: ${result.started}`,
						`alreadyRunning: ${result.alreadyRunning}`,
						`pid: ${result.pid ?? "—"}`,
						`runId: ${result.runId ?? "—"}`,
					];
					appendSystem("/start", lines.join("\n"));
					return;
				}
				if (cmd === "/stop") {
					if (!window.confirm("Stop the coordinator?")) {
						appendSystem("/stop", "Cancelled.");
						return;
					}
					const result = await postCoordinatorStop();
					appendSystem("/stop", `stopped: ${result.stopped}`);
					return;
				}
			} catch (err) {
				appendSystem(cmd, err instanceof Error ? err.message : String(err));
			}
		},
		[appendSystem],
	);

	const handleStartNewRun = useCallback(
		async (subject: string, body: string) => {
			setIsStartingNewRun(true);
			setNewRunError(null);
			try {
				await postCoordinatorStart();
				const deadline = Date.now() + NEW_RUN_TIMEOUT_MS;
				let running = false;
				while (Date.now() < deadline) {
					const state = await fetchCoordinatorState();
					if (state.running) {
						running = true;
						break;
					}
					await new Promise((r) => setTimeout(r, NEW_RUN_POLL_INTERVAL_MS));
				}
				if (!running) {
					throw new Error("Timed out waiting for the coordinator to start.");
				}
				await postCoordinatorSend({ subject, body, from: OPERATOR });
				setNewRunOpen(false);
				appendSystem("Run started", `Sent initial prompt: ${subject}`);
			} catch (err) {
				setNewRunError(err instanceof Error ? err.message : String(err));
			} finally {
				setIsStartingNewRun(false);
			}
		},
		[appendSystem, setNewRunOpen],
	);

	const showEmpty = initialLoaded && turns.length === 0 && pending === null;

	const visibleTurns = useMemo(() => turns, [turns]);

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center gap-3 px-6 py-4 border-b border-border shrink-0">
				<h1 className="text-xl font-semibold tracking-tight">Coordinator</h1>
				<div className="ml-auto">
					<StatusPill lastCheck={lastCheck} />
				</div>
			</div>

			{showEmpty ? (
				<div className="flex-1 min-h-0">
					<EmptyState
						onSelect={(t) => setComposerValue(t)}
						onStartNewRun={() => setNewRunOpen(true)}
						isStopped={stateQuery.data?.running === false}
					/>
				</div>
			) : (
				<Thread turns={visibleTurns} />
			)}

			{!showEmpty && stateQuery.data?.running === false && (
				<div className="px-6 py-3 border-t border-border flex items-center gap-3 shrink-0 bg-muted/40">
					<span className="text-sm text-muted-foreground">Coordinator is stopped.</span>
					<Button type="button" size="sm" className="ml-auto" onClick={() => setNewRunOpen(true)}>
						Start new run
					</Button>
				</div>
			)}

			<Composer
				value={composerValue}
				onChange={setComposerValue}
				onSend={handleSend}
				onStop={handleStop}
				onAsk={handleAsk}
				onSlashCommand={handleSlashCommand}
				isPending={pending !== null}
			/>

			<NewRunDialog
				open={newRunOpen}
				onOpenChange={setNewRunOpen}
				onStart={handleStartNewRun}
				isStarting={isStartingNewRun}
				error={newRunError}
			/>
		</div>
	);
}
