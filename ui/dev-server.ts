import index from "./index.html";

const devPort = Number(process.env.OVERSTORY_DEV_PORT ?? 3000);
const apiPort = Number(process.env.OVERSTORY_API_PORT ?? 8080);
const apiHost = process.env.OVERSTORY_API_HOST ?? "127.0.0.1";
const apiBase = `http://${apiHost}:${apiPort}`;
const wsBase = `ws://${apiHost}:${apiPort}`;

const server = Bun.serve({
	port: devPort,
	hostname: "127.0.0.1",
	development: true,
	routes: { "/": index },
	async fetch(req, srv) {
		const url = new URL(req.url);
		// /ws WebSocket upgrade — bidirectional proxy to api server
		if (url.pathname === "/ws") {
			const target = wsBase + url.pathname + url.search;
			const upstream = new WebSocket(target);
			const ok = srv.upgrade(req, { data: { upstream } });
			return ok ? undefined : new Response("upgrade failed", { status: 500 });
		}
		if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") {
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(apiBase + url.pathname + url.search, {
				method: req.method,
				headers,
				body: req.body,
				redirect: "manual",
			});
		}
		return new Response("Not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			const upstream = (ws.data as { upstream: WebSocket }).upstream;
			upstream.onmessage = (e) => ws.send(e.data as string);
			upstream.onclose = () => ws.close();
		},
		message(ws, msg) {
			const upstream = (ws.data as { upstream: WebSocket }).upstream;
			if (upstream.readyState === WebSocket.OPEN) upstream.send(msg);
			else upstream.addEventListener("open", () => upstream.send(msg), { once: true });
		},
		close(ws) {
			const upstream = (ws.data as { upstream: WebSocket }).upstream;
			try {
				upstream.close();
			} catch {}
		},
	},
});

console.log(`[ui-dev] listening on http://127.0.0.1:${server.port}`);
