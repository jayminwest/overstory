// TODO consolidate with ui/src/lib/api.ts when overstory-6c4f merges
import type { MailMessage } from "./types.ts";

export async function fetchMail(filters: {
	unread?: boolean;
	from?: string;
	to?: string;
}): Promise<MailMessage[]> {
	const params = new URLSearchParams();
	if (filters.unread) params.set("unread", "true");
	if (filters.from) params.set("from", filters.from);
	if (filters.to) params.set("to", filters.to);
	const qs = params.toString();
	const res = await fetch(`/api/mail${qs ? `?${qs}` : ""}`);
	const json = (await res.json()) as { success: boolean; data: MailMessage[]; error?: string };
	if (!json.success) throw new Error(json.error ?? "fetch failed");
	return json.data;
}

export async function fetchMessage(
	id: string,
): Promise<{ message: MailMessage; thread: MailMessage[] }> {
	const res = await fetch(`/api/mail/${encodeURIComponent(id)}`);
	const json = (await res.json()) as {
		success: boolean;
		data: { message: MailMessage; thread: MailMessage[] };
		error?: string;
	};
	if (!json.success) throw new Error(json.error ?? "fetch failed");
	return json.data;
}

export async function markRead(id: string): Promise<void> {
	const res = await fetch(`/api/mail/${encodeURIComponent(id)}/read`, { method: "POST" });
	const json = (await res.json()) as { success: boolean; error?: string };
	if (!json.success) throw new Error(json.error ?? "mark read failed");
}

export async function fetchAgents(): Promise<string[]> {
	const res = await fetch("/api/agents");
	const json = (await res.json()) as {
		success: boolean;
		data: Array<{ agentName: string }>;
		error?: string;
	};
	if (!json.success) throw new Error(json.error ?? "fetch agents failed");
	const names = json.data.map((a) => a.agentName);
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
	const res = await fetch("/api/mail", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as {
		success: boolean;
		data: { messageId?: string; messageIds?: string[] };
		error?: string;
	};
	if (!json.success) throw new Error(json.error ?? "send mail failed");
	return json.data;
}

export interface ReplyMailInput {
	from?: string;
	body: string;
	type?: string;
	priority?: string;
}

export async function replyMail(id: string, input: ReplyMailInput): Promise<{ messageId: string }> {
	const res = await fetch(`/api/mail/${encodeURIComponent(id)}/reply`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as {
		success: boolean;
		data: { messageId: string };
		error?: string;
	};
	if (!json.success) throw new Error(json.error ?? "reply mail failed");
	return json.data;
}

export async function deleteMail(id: string): Promise<void> {
	const res = await fetch(`/api/mail/${encodeURIComponent(id)}`, { method: "DELETE" });
	const json = (await res.json()) as { success: boolean; error?: string };
	if (!json.success) throw new Error(json.error ?? "delete mail failed");
}
