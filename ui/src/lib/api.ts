const API_BASE = "/api";

interface ApiEnvelope<T> {
	success: boolean;
	command: string;
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

export interface MailMessage {
	id: string;
	from: string;
	to: string;
	subject: string;
	body: string;
	type: string;
	priority: string;
	createdAt: string;
	readAt: string | null;
	threadId: string | null;
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

export async function fetchMail(opts?: {
	to?: string;
	from?: string;
	unread?: boolean;
	limit?: number;
}): Promise<{ data: MailMessage[]; nextCursor: string | null }> {
	const params = new URLSearchParams();
	if (opts?.to) params.set("to", opts.to);
	if (opts?.from) params.set("from", opts.from);
	if (opts?.unread) params.set("unread", "true");
	if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
	const query = params.size > 0 ? `?${params.toString()}` : "";
	return fetchJson<MailMessage[]>(`${API_BASE}/mail${query}`);
}
