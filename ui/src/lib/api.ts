const API_BASE = "/api";

interface ApiEnvelope<T> {
	success: boolean;
	command?: string;
	data?: T;
	error?: string;
	nextCursor?: string | null;
}

async function fetchJson<T>(path: string): Promise<{ data: T; nextCursor: string | null }> {
	const res = await fetch(path);
	const body = (await res.json()) as ApiEnvelope<T>;
	if (!res.ok || body.success !== true || body.data === undefined) {
		throw new Error(body.error ?? `Request failed: ${res.status}`);
	}
	return { data: body.data, nextCursor: body.nextCursor ?? null };
}

export type RunStatus = "active" | "completed" | "failed";
export interface Run {
	id: string;
	startedAt: string;
	completedAt: string | null;
	agentCount: number;
	coordinatorSessionId: string | null;
	coordinatorName: string | null;
	status: RunStatus;
}

export type AgentState = "booting" | "working" | "completed" | "stalled" | "zombie";
export interface AgentRow {
	id: string;
	agentName: string;
	capability: string;
	state: AgentState;
	parentAgent: string | null;
	startedAt: string;
	lastActivity: string;
	runId: string | null;
	depth: number;
	taskId: string;
}

export interface TimelineEvent {
	id: number;
	agentName: string;
	createdAt: string;
	eventType: string;
	toolName: string | null;
	payload: unknown;
}

export type MailSemanticType = "status" | "question" | "result" | "error";

export type MailProtocolType =
	| "worker_done"
	| "merge_ready"
	| "merged"
	| "merge_failed"
	| "escalation"
	| "health_check"
	| "dispatch"
	| "assign"
	| "decision_gate";

export type MailMessageType = MailSemanticType | MailProtocolType;

export interface MailMessage {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	priority: "low" | "normal" | "high" | "urgent";
	type: MailMessageType;
	threadId: string | null;
	payload: string | null;
	read: boolean;
	createdAt: string;
}

export async function fetchRuns(limit = 50): Promise<Run[]> {
	const { data } = await fetchJson<Run[]>(`${API_BASE}/runs?limit=${limit}`);
	return data;
}

export async function fetchRun(id: string): Promise<Run & { agents: AgentRow[] }> {
	const { data } = await fetchJson<Run & { agents: AgentRow[] }>(
		`${API_BASE}/runs/${encodeURIComponent(id)}`,
	);
	return data;
}

export async function fetchAgents(opts?: { runId?: string; limit?: number }): Promise<AgentRow[]> {
	const params = new URLSearchParams();
	if (opts?.runId) params.set("run", opts.runId);
	if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
	const query = params.size > 0 ? `?${params.toString()}` : "";
	const { data } = await fetchJson<AgentRow[]>(`${API_BASE}/agents${query}`);
	return data;
}

export async function fetchAgent(name: string): Promise<AgentRow> {
	const { data } = await fetchJson<AgentRow>(`${API_BASE}/agents/${encodeURIComponent(name)}`);
	return data;
}

export async function fetchEvents(opts?: {
	runId?: string;
	agent?: string;
	since?: string;
	limit?: number;
}): Promise<{ data: TimelineEvent[]; nextCursor: string | null }> {
	const params = new URLSearchParams();
	if (opts?.runId) params.set("run", opts.runId);
	if (opts?.agent) params.set("agent", opts.agent);
	if (opts?.since) params.set("since", opts.since);
	if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
	const query = params.size > 0 ? `?${params.toString()}` : "";
	return fetchJson<TimelineEvent[]>(`${API_BASE}/events${query}`);
}

export async function fetchMail(filters?: {
	unread?: boolean;
	from?: string;
	to?: string;
}): Promise<MailMessage[]> {
	const params = new URLSearchParams();
	if (filters?.unread) params.set("unread", "true");
	if (filters?.from) params.set("from", filters.from);
	if (filters?.to) params.set("to", filters.to);
	const qs = params.toString();
	const { data } = await fetchJson<MailMessage[]>(`${API_BASE}/mail${qs ? `?${qs}` : ""}`);
	return data;
}

export async function fetchMessage(
	id: string,
): Promise<{ message: MailMessage; thread: MailMessage[] }> {
	const { data } = await fetchJson<{ message: MailMessage; thread: MailMessage[] }>(
		`${API_BASE}/mail/${encodeURIComponent(id)}`,
	);
	return data;
}

export async function markRead(id: string): Promise<void> {
	const res = await fetch(`${API_BASE}/mail/${encodeURIComponent(id)}/read`, { method: "POST" });
	const json = (await res.json()) as ApiEnvelope<unknown>;
	if (!res.ok || json.success !== true) {
		throw new Error(json.error ?? "mark read failed");
	}
}

export async function fetchMailAgents(): Promise<string[]> {
	const { data } = await fetchJson<Array<{ agentName: string }>>(`${API_BASE}/agents`);
	const names = data.map((a) => a.agentName);
	return [...new Set(names)].sort();
}

export interface SendMailInput {
	to: string;
	from?: string;
	subject: string;
	body: string;
	type?: string;
	priority?: string;
	payload?: string;
}

export async function sendMail(
	input: SendMailInput,
): Promise<{ messageId?: string; messageIds?: string[] }> {
	const res = await fetch(`${API_BASE}/mail`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as ApiEnvelope<{ messageId?: string; messageIds?: string[] }>;
	if (!res.ok || json.success !== true || json.data === undefined) {
		throw new Error(json.error ?? "send mail failed");
	}
	return json.data;
}

export interface ReplyMailInput {
	from?: string;
	body: string;
	type?: string;
	priority?: string;
}

export async function replyMail(id: string, input: ReplyMailInput): Promise<{ messageId: string }> {
	const res = await fetch(`${API_BASE}/mail/${encodeURIComponent(id)}/reply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as ApiEnvelope<{ messageId: string }>;
	if (!res.ok || json.success !== true || json.data === undefined) {
		throw new Error(json.error ?? "reply mail failed");
	}
	return json.data;
}

export async function deleteMail(id: string): Promise<void> {
	const res = await fetch(`${API_BASE}/mail/${encodeURIComponent(id)}`, { method: "DELETE" });
	const json = (await res.json()) as ApiEnvelope<unknown>;
	if (!res.ok || json.success !== true) {
		throw new Error(json.error ?? "delete mail failed");
	}
}
