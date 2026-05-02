import { useEffect, useRef, useState } from "react";

import type { MailMessage } from "./api";
import { useRegisterWsStatus } from "./ws-status";

// ── Types (mirrored locally — do not import server types) ──────────────────

export type EventType =
	| "tool_start"
	| "tool_end"
	| "session_start"
	| "session_end"
	| "mail_sent"
	| "mail_received"
	| "spawn"
	| "error"
	| "custom"
	| "turn_start"
	| "turn_end"
	| "progress"
	| "result";

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface StoredEvent {
	id: number;
	runId: string | null;
	agentName: string;
	sessionId: string | null;
	eventType: EventType;
	toolName: string | null;
	/** JSON string: { args, summary } from filterToolArgs */
	toolArgs: string | null;
	toolDurationMs: number | null;
	level: EventLevel;
	/** JSON string OR plain text */
	data: string | null;
	createdAt: string;
}

export type Frame =
	| { type: "event"; ts: string; payload: StoredEvent | { batched: true; events: StoredEvent[] } }
	| { type: "mail"; ts: string; payload: { message: unknown } }
	| { type: "agent_state"; ts: string; payload: { agentName: string; state: string } };

// ── Hook ───────────────────────────────────────────────────────────────────

export type WsStatus = "connecting" | "open" | "closed";

export interface UseWebSocketResult {
	status: WsStatus;
	ws: WebSocket | null;
}

interface UseWebSocketOpts<T> {
	onMessage?: (frame: T) => void;
}

const MIN_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

/**
 * Reconnecting WebSocket hook with exponential backoff.
 *
 * Pass `url = null` to skip connecting (useful when route params are loading).
 * The `url` should be a path like `/ws?agent=foo`; the hook resolves ws:// vs wss://
 * from window.location.protocol.
 */
export function useWebSocket<T>(
	url: string | null,
	opts?: UseWebSocketOpts<T>,
): UseWebSocketResult {
	const [status, setStatus] = useState<WsStatus>("closed");
	const wsRef = useRef<WebSocket | null>(null);
	// Always hold the latest onMessage so reconnects pick it up without re-running the effect.
	const onMessageRef = useRef(opts?.onMessage);

	useEffect(() => {
		onMessageRef.current = opts?.onMessage;
	});

	useEffect(() => {
		if (!url) {
			wsRef.current?.close();
			wsRef.current = null;
			setStatus("closed");
			return;
		}

		let active = true;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let backoff = MIN_BACKOFF_MS;

		const connect = () => {
			if (!active) return;
			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${protocol}//${window.location.host}${url}`;

			setStatus("connecting");
			const ws = new WebSocket(wsUrl);
			wsRef.current = ws;

			ws.onopen = () => {
				if (!active) {
					ws.close();
					return;
				}
				backoff = MIN_BACKOFF_MS;
				setStatus("open");
			};

			ws.onmessage = (ev) => {
				try {
					const frame = JSON.parse(ev.data as string) as T;
					onMessageRef.current?.(frame);
				} catch {
					console.warn("[ws] malformed frame", ev.data);
				}
			};

			const scheduleReconnect = () => {
				if (!active) return;
				setStatus("closed");
				const delay = backoff;
				backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
				timer = setTimeout(connect, delay);
			};

			ws.onclose = scheduleReconnect;
			ws.onerror = scheduleReconnect;
		};

		connect();

		return () => {
			active = false;
			if (timer !== null) clearTimeout(timer);
			wsRef.current?.close();
			wsRef.current = null;
			setStatus("closed");
		};
	}, [url]);

	// Publish status into the global registry when active; null means "not connected".
	useRegisterWsStatus(url === null ? null : status);

	return { status, ws: wsRef.current };
}

export function useMailSocket(onMessage: (m: MailMessage) => void): void {
	const cb = useRef(onMessage);
	cb.current = onMessage;
	useEffect(() => {
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${proto}//${location.host}/ws?mail=true`);
		ws.onmessage = (e) => {
			try {
				const frame = JSON.parse(typeof e.data === "string" ? e.data : "") as unknown;
				if (
					frame !== null &&
					typeof frame === "object" &&
					"type" in (frame as Record<string, unknown>) &&
					(frame as Record<string, unknown>).type === "mail" &&
					"payload" in (frame as Record<string, unknown>)
				) {
					const payload = (frame as Record<string, unknown>).payload as Record<
						string,
						unknown
					> | null;
					if (payload !== null && payload !== undefined && "message" in payload) {
						cb.current(payload.message as MailMessage);
					}
				}
			} catch {
				// ignore malformed frames
			}
		};
		return () => ws.close();
	}, []);
}
