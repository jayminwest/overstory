/**
 * REST API handlers for `ov serve`.
 *
 * Registers read-only endpoints that surface data from existing SQLite stores
 * (EventStore, MailStore, SessionStore, RunStore). No new persistence.
 *
 * Route registration via registerApiHandler — no changes to serve.ts required
 * beyond the single registerRestApi() call.
 */

import { join } from "node:path";
import { OverstoryError, ValidationError } from "../../errors.ts";
import { createEventStore } from "../../events/store.ts";
import { apiError, apiJson } from "../../json.ts";
import type { MailStore } from "../../mail/store.ts";
import { createMailStore } from "../../mail/store.ts";
import type { SessionStore } from "../../sessions/store.ts";
import { createRunStore, createSessionStore } from "../../sessions/store.ts";
import type { EventStore, RunStore } from "../../types.ts";
import { registerApiHandler } from "../serve.ts";
import { deleteMail, replyMail, sendMail } from "./mail-actions.ts";

// ─── Cursor helpers ───────────────────────────────────────────────────────────

type Cursor = { ts: string; id: string };

function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(s: string): Cursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf-8"));
	} catch {
		throw new ValidationError("Invalid cursor", { field: "cursor", value: s });
	}
	const p = parsed as Record<string, unknown>;
	if (typeof p.ts !== "string" || typeof p.id !== "string") {
		throw new ValidationError("Invalid cursor", { field: "cursor", value: s });
	}
	return { ts: p.ts, id: p.id };
}

function parseLimitAndCursor(params: URLSearchParams): { limit: number; cursor: Cursor | null } {
	const limitStr = params.get("limit");
	const limit = limitStr !== null ? Number.parseInt(limitStr, 10) : 100;
	if (Number.isNaN(limit) || limit < 1 || limit > 500) {
		throw new ValidationError(`Invalid limit: ${limitStr ?? "undefined"}`, {
			field: "limit",
			value: limitStr,
		});
	}

	const cursorStr = params.get("cursor");
	const cursor = cursorStr !== null ? decodeCursor(cursorStr) : null;

	return { limit, cursor };
}

// ─── Generic paginator (for string-id collections) ───────────────────────────

interface PaginateResult<T> {
	page: T[];
	nextCursor: string | null;
}

/**
 * Client-side paginator for pre-sorted collections with string IDs.
 * direction="asc":  keep items where (ts > cursorTs) OR (ts === cursorTs AND id > cursorId)
 * direction="desc": keep items where (ts < cursorTs) OR (ts === cursorTs AND id < cursorId)
 */
function paginateItems<T extends { id: string }>(
	items: T[],
	cursor: Cursor | null,
	limit: number,
	getTs: (item: T) => string,
	direction: "asc" | "desc",
): PaginateResult<T> {
	let filtered = items;

	if (cursor !== null) {
		const { ts: cTs, id: cId } = cursor;
		if (direction === "asc") {
			filtered = items.filter((item) => {
				const ts = getTs(item);
				if (ts > cTs) return true;
				if (ts === cTs && item.id > cId) return true;
				return false;
			});
		} else {
			filtered = items.filter((item) => {
				const ts = getTs(item);
				if (ts < cTs) return true;
				if (ts === cTs && item.id < cId) return true;
				return false;
			});
		}
	}

	const page = filtered.slice(0, limit);
	const hasMore = filtered.length > limit;
	const lastItem = page[page.length - 1];
	const nextCursor =
		hasMore && lastItem !== undefined
			? encodeCursor({ ts: getTs(lastItem), id: lastItem.id })
			: null;

	return { page, nextCursor };
}

// ─── Error → HTTP status ──────────────────────────────────────────────────────

function statusFromError(err: OverstoryError): number {
	if (err instanceof ValidationError) return 400;
	return 500;
}

// ─── Stores ───────────────────────────────────────────────────────────────────

export interface RestApiDeps {
	_runStore?: RunStore;
	_sessionStore?: SessionStore;
	_eventStore?: EventStore;
	_mailStore?: MailStore;
	_projectRoot?: string;
}

interface Stores {
	run: RunStore;
	session: SessionStore;
	event: EventStore;
	mail: MailStore;
}

function openStores(projectRoot: string): Stores {
	const ovDir = join(projectRoot, ".overstory");
	const sessionsDb = join(ovDir, "sessions.db");
	const eventsDb = join(ovDir, "events.db");
	const mailDb = join(ovDir, "mail.db");
	return {
		run: createRunStore(sessionsDb),
		session: createSessionStore(sessionsDb),
		event: createEventStore(eventsDb),
		mail: createMailStore(mailDb),
	};
}

// ─── Route table ─────────────────────────────────────────────────────────────

type RouteHandler = (
	req: Request,
	match: RegExpMatchArray,
	params: URLSearchParams,
	stores: Stores,
) => Promise<Response>;

interface Route {
	method: string;
	pattern: RegExp;
	handler: RouteHandler;
}

// ─── Individual handlers ──────────────────────────────────────────────────────

async function handleGetRuns(
	_req: Request,
	_match: RegExpMatchArray,
	params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const { limit, cursor } = parseLimitAndCursor(params);
	const all = stores.run.listRuns();
	// Sort DESC by (startedAt, id)
	const sorted = [...all].sort((a, b) => {
		if (b.startedAt !== a.startedAt) return b.startedAt < a.startedAt ? -1 : 1;
		return b.id < a.id ? -1 : 1;
	});
	const { page, nextCursor } = paginateItems(sorted, cursor, limit, (r) => r.startedAt, "desc");
	return apiJson(page, { nextCursor });
}

async function handleGetRun(
	_req: Request,
	match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const id = match[1];
	if (id === undefined) return apiError("Run ID required", 400);
	const run = stores.run.getRun(id);
	if (run === null) return apiError(`Run not found: ${id}`, 404);
	const agents = stores.session.getByRun(id);
	// Sort agents ASC by (startedAt, id)
	const sortedAgents = [...agents].sort((a, b) => {
		if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
		return a.id < b.id ? -1 : 1;
	});
	return apiJson({ ...run, agents: sortedAgents });
}

async function handleGetAgents(
	_req: Request,
	_match: RegExpMatchArray,
	params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const { limit, cursor } = parseLimitAndCursor(params);
	const runId = params.get("run");

	const all = runId !== null ? stores.session.getByRun(runId) : stores.session.getAll();
	// Sort ASC by (startedAt, id)
	const sorted = [...all].sort((a, b) => {
		if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? -1 : 1;
		return a.id < b.id ? -1 : 1;
	});
	const { page, nextCursor } = paginateItems(sorted, cursor, limit, (a) => a.startedAt, "asc");
	return apiJson(page, { nextCursor });
}

async function handleGetAgent(
	_req: Request,
	match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const name = match[1];
	if (name === undefined) return apiError("Agent name required", 400);
	const agent = stores.session.getByName(decodeURIComponent(name));
	if (agent === null) return apiError(`Agent not found: ${name}`, 404);
	return apiJson(agent);
}

async function handleGetEvents(
	_req: Request,
	_match: RegExpMatchArray,
	params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const { limit, cursor } = parseLimitAndCursor(params);
	const agentFilter = params.get("agent");
	const runFilter = params.get("run");
	const sinceParam = params.get("since");

	// Validate sinceParam as an ISO date if provided
	if (sinceParam !== null && Number.isNaN(Date.parse(sinceParam))) {
		throw new ValidationError(`Invalid since timestamp: ${sinceParam}`, {
			field: "since",
			value: sinceParam,
		});
	}

	// Effective since: cursor.ts > explicit since > default epoch
	const effectiveSince = cursor !== null ? cursor.ts : (sinceParam ?? "1970-01-01T00:00:00.000Z");

	// Over-fetch by 1 to detect next page
	const fetchOpts = { since: effectiveSince, limit: limit + 1 };

	let rawItems =
		agentFilter !== null
			? stores.event.getByAgent(agentFilter, fetchOpts)
			: runFilter !== null
				? stores.event.getByRun(runFilter, fetchOpts)
				: stores.event.getTimeline(fetchOpts);

	// Drop entries <= cursor.id (ties at cursor.ts)
	if (cursor !== null) {
		const cursorIdNum = Number.parseInt(cursor.id, 10);
		rawItems = rawItems.filter((e) => e.id > cursorIdNum);
	}

	const page = rawItems.slice(0, limit);
	const hasMore = rawItems.length > limit;
	const lastItem = page[page.length - 1];
	const nextCursor =
		hasMore && lastItem !== undefined
			? encodeCursor({ ts: lastItem.createdAt, id: String(lastItem.id) })
			: null;

	return apiJson(page, { nextCursor });
}

async function handleGetMail(
	_req: Request,
	_match: RegExpMatchArray,
	params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const { limit, cursor } = parseLimitAndCursor(params);
	const toFilter = params.get("to") ?? undefined;
	const fromFilter = params.get("from") ?? undefined;
	const unreadParam = params.get("unread");
	const unreadFilter = unreadParam !== null ? unreadParam === "true" : undefined;

	// Fetch a large window when cursor is present for client-side pagination
	const fetchLimit = cursor !== null ? limit * 5 : undefined;
	const all = stores.mail.getAll({
		to: toFilter,
		from: fromFilter,
		unread: unreadFilter,
		limit: fetchLimit,
	});

	// Already sorted DESC by createdAt from the store; sort explicitly for stability
	const sorted = [...all].sort((a, b) => {
		if (b.createdAt !== a.createdAt) return b.createdAt < a.createdAt ? -1 : 1;
		return b.id < a.id ? -1 : 1;
	});

	const { page, nextCursor } = paginateItems(sorted, cursor, limit, (m) => m.createdAt, "desc");
	return apiJson(page, { nextCursor });
}

async function handleGetMailMessage(
	_req: Request,
	match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const id = match[1];
	if (id === undefined) return apiError("Message ID required", 400);
	const message = stores.mail.getById(id);
	if (message === null) return apiError(`Message not found: ${id}`, 404);
	const thread = message.threadId !== null ? stores.mail.getByThread(message.threadId) : [message];
	return apiJson({ message, thread });
}

async function handleMarkMailRead(
	_req: Request,
	match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const id = match[1];
	if (id === undefined) return apiError("Message ID required", 400);
	const message = stores.mail.getById(id);
	if (message === null) return apiError(`Message not found: ${id}`, 404);
	stores.mail.markRead(id);
	return apiJson({ id, read: true });
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch (err) {
		throw new ValidationError(
			`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
			{
				field: "body",
			},
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new ValidationError("Request body must be a JSON object", { field: "body" });
	}
	return parsed as Record<string, unknown>;
}

async function handleSendMail(
	req: Request,
	_match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const body = await parseJsonBody(req);
	const result = sendMail({ mail: stores.mail, session: stores.session }, body);
	return apiJson(result);
}

async function handleReplyMail(
	req: Request,
	match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const id = match[1];
	if (id === undefined) return apiError("Message ID required", 400);
	if (stores.mail.getById(id) === null) {
		return apiError(`Message not found: ${id}`, 404);
	}
	const body = await parseJsonBody(req);
	const result = replyMail({ mail: stores.mail, session: stores.session }, id, body);
	return apiJson(result);
}

async function handleDeleteMail(
	_req: Request,
	match: RegExpMatchArray,
	_params: URLSearchParams,
	stores: Stores,
): Promise<Response> {
	const id = match[1];
	if (id === undefined) return apiError("Message ID required", 400);
	const result = deleteMail({ mail: stores.mail, session: stores.session }, id);
	if (result === null) return apiError(`Message not found: ${id}`, 404);
	return apiJson(result);
}

// ─── Route table ─────────────────────────────────────────────────────────────

const ROUTES: Route[] = [
	{ method: "GET", pattern: /^\/api\/runs$/, handler: handleGetRuns },
	{ method: "GET", pattern: /^\/api\/runs\/([^/]+)$/, handler: handleGetRun },
	{ method: "GET", pattern: /^\/api\/agents$/, handler: handleGetAgents },
	{ method: "GET", pattern: /^\/api\/agents\/([^/]+)$/, handler: handleGetAgent },
	{ method: "GET", pattern: /^\/api\/events$/, handler: handleGetEvents },
	{ method: "GET", pattern: /^\/api\/mail$/, handler: handleGetMail },
	{ method: "POST", pattern: /^\/api\/mail$/, handler: handleSendMail },
	{ method: "GET", pattern: /^\/api\/mail\/([^/]+)$/, handler: handleGetMailMessage },
	{ method: "DELETE", pattern: /^\/api\/mail\/([^/]+)$/, handler: handleDeleteMail },
	{ method: "POST", pattern: /^\/api\/mail\/([^/]+)\/read$/, handler: handleMarkMailRead },
	{ method: "POST", pattern: /^\/api\/mail\/([^/]+)\/reply$/, handler: handleReplyMail },
];

// ─── Public registration ──────────────────────────────────────────────────────

/**
 * Register all REST API handlers with the serve scaffold.
 * Deps allows injecting stores for testing; in production, stores are opened
 * from projectRoot/.overstory/{sessions,events,mail}.db.
 */
export function registerRestApi(deps?: RestApiDeps): void {
	let stores: Stores | null = null;

	function getStores(): Stores {
		if (stores !== null) return stores;
		const root = deps?._projectRoot ?? (deps === undefined ? process.cwd() : process.cwd());

		if (
			deps?._runStore !== undefined &&
			deps._sessionStore !== undefined &&
			deps._eventStore !== undefined &&
			deps._mailStore !== undefined
		) {
			stores = {
				run: deps._runStore,
				session: deps._sessionStore,
				event: deps._eventStore,
				mail: deps._mailStore,
			};
		} else {
			stores = openStores(root);
		}
		return stores;
	}

	registerApiHandler((req: Request): Response | Promise<Response> | null => {
		const url = new URL(req.url);
		const path = url.pathname;

		// Two passes: first try to match path+method exactly. If none matches
		// but the path matched some route, return 405 (method not allowed).
		let matchedRoute: { route: Route; match: RegExpMatchArray } | null = null;
		let pathMatched = false;
		for (const route of ROUTES) {
			const match = path.match(route.pattern);
			if (match === null) continue;
			pathMatched = true;
			if (req.method === route.method) {
				matchedRoute = { route, match };
				break;
			}
		}

		if (matchedRoute !== null) {
			const { route, match } = matchedRoute;
			return (async (): Promise<Response> => {
				try {
					return await route.handler(req, match, url.searchParams, getStores());
				} catch (err) {
					if (err instanceof OverstoryError) {
						return apiError(err.message, statusFromError(err));
					}
					process.stderr.write(`REST handler error: ${String(err)}\n`);
					return apiError("Internal server error", 500);
				}
			})();
		}

		if (pathMatched) {
			return apiError("Method not allowed", 405);
		}

		return null;
	});
}
