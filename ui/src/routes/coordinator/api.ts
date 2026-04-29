// Coordinator REST fetchers. Mirrors the envelope-unwrap pattern in
// ui/src/lib/api.ts. Keep scoped to this directory — the consolidation in
// overstory-6c4f will pull these into the shared lib later.

const API_BASE = "/api/coordinator";

interface Envelope<T> {
	success: boolean;
	command?: string;
	data?: T;
	error?: string;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
	const init: RequestInit = { method: "POST" };
	if (body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(body);
	}
	const res = await fetch(path, init);
	const json = (await res.json()) as Envelope<T>;
	if (!res.ok || json.success !== true || json.data === undefined) {
		throw new Error(json.error ?? `Request failed: ${res.status}`);
	}
	return json.data;
}

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(path);
	const json = (await res.json()) as Envelope<T>;
	if (!res.ok || json.success !== true || json.data === undefined) {
		throw new Error(json.error ?? `Request failed: ${res.status}`);
	}
	return json.data;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CoordinatorState {
	running: boolean;
	agentName: string;
	pid: number | null;
	tmuxSession: string | null;
	runId: string | null;
	startedAt: string | null;
	lastActivityAt: string | null;
	headless: boolean;
}

export interface CoordinatorReply {
	id: string;
	body: string;
	subject: string;
}

export interface CheckCompleteTrigger {
	enabled: boolean;
	met: boolean;
	detail: string;
}

export interface CheckCompleteResult {
	complete: boolean;
	triggers: {
		allAgentsDone: CheckCompleteTrigger;
		taskTrackerEmpty: CheckCompleteTrigger;
		onShutdownSignal: CheckCompleteTrigger;
	};
}

export interface SendResult {
	messageId: string;
}

export interface AskResult {
	messageId: string;
	reply: CoordinatorReply | null;
	timedOut: boolean;
}

export interface StartResult {
	started: boolean;
	alreadyRunning: boolean;
	pid: number | null;
	runId: string | null;
}

export interface StopResult {
	stopped: boolean;
}

// ── Fetchers ───────────────────────────────────────────────────────────────

export function fetchCoordinatorState(): Promise<CoordinatorState> {
	return getJson<CoordinatorState>(`${API_BASE}/state`);
}

export function postCoordinatorSend(body: {
	subject: string;
	body: string;
	from?: string;
}): Promise<SendResult> {
	return postJson<SendResult>(`${API_BASE}/send`, body);
}

export function postCoordinatorAsk(body: {
	subject: string;
	body: string;
	timeoutSec?: number;
	from?: string;
}): Promise<AskResult> {
	return postJson<AskResult>(`${API_BASE}/ask`, body);
}

export function postCoordinatorCheckComplete(): Promise<CheckCompleteResult> {
	return postJson<CheckCompleteResult>(`${API_BASE}/check-complete`);
}

export function postCoordinatorStart(): Promise<StartResult> {
	return postJson<StartResult>(`${API_BASE}/start`);
}

export function postCoordinatorStop(): Promise<StopResult> {
	return postJson<StopResult>(`${API_BASE}/stop`);
}
