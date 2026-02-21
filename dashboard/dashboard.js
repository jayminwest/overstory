(() => {
	// ── State ──
	// Detect browser's default hour cycle: h23/h24 → 24h, h11/h12 → 12h
	const _browserUses24h = (() => {
		try {
			const hc = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
				.hourCycle;
			return hc === "h23" || hc === "h24";
		} catch {
			return true;
		}
	})();

	const S = {
		sessions: [],
		selectedAgent: null,
		centerTab: "overview",
		rightTab: "inbox",
		mail: [],
		mergeQueue: [],
		events: [],
		metrics: [],
		inspect: null,
		trace: [],
		use24h: _browserUses24h,
		agentMail: [],
		tmux: "",
		status: null,
		lastMailRefresh: 0,
		lastMetricsRefresh: 0,
		usage: null,
		lastUsageRefresh: 0,
	};

	const $ = (id) => document.getElementById(id);
	const REFRESH = 3000;
	const MAIL_REFRESH = 8000;
	const METRICS_REFRESH = 15000;

	// ── Utils ──

	function fmtTime(date) {
		if (!date) date = new Date();
		return date.toLocaleTimeString(undefined, { hour12: !S.use24h });
	}

	function esc(s) {
		if (!s) return "";
		const d = document.createElement("div");
		d.textContent = String(s);
		return d.innerHTML;
	}

	function timeAgo(iso) {
		if (!iso) return "";
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 0) return "just now";
		const s = Math.floor(diff / 1000);
		if (s < 60) return `${s}s ago`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	function dur(ms) {
		if (!ms && ms !== 0) return "";
		const s = Math.floor(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ${s % 60}s`;
		const h = Math.floor(m / 60);
		return `${h}h ${m % 60}m`;
	}

	function durFromDates(start, end) {
		if (!start) return "";
		const ms = (end ? new Date(end) : new Date()) - new Date(start);
		return dur(ms);
	}

	// ── API ──

	async function api(path) {
		try {
			const r = await fetch(path);
			if (!r.ok) return { error: `HTTP ${r.status}` };
			const ct = r.headers.get("content-type") || "";
			if (ct.includes("text/plain")) return await r.text();
			return await r.json();
		} catch (e) {
			return { error: e.message };
		}
	}

	// ── Agent Tree ──

	function buildTree(sessions) {
		const byName = {};
		const arr = Array.isArray(sessions) ? sessions : [];
		arr.forEach((s) => {
			byName[s.agent_name] = { ...s, children: [] };
		});
		const roots = [];
		arr.forEach((s) => {
			if (s.parent_agent && byName[s.parent_agent]) {
				byName[s.parent_agent].children.push(byName[s.agent_name]);
			} else {
				roots.push(byName[s.agent_name]);
			}
		});
		return roots;
	}

	function flattenTree(nodes, prefix, _parentIsLast) {
		const items = [];
		nodes.forEach((node, i) => {
			const isLast = i === nodes.length - 1;
			const connector = prefix === "" ? "" : isLast ? "\u2514\u2500 " : "\u251C\u2500 ";
			items.push({ node, prefix: prefix + connector });
			if (node.children.length) {
				const childPrefix = prefix === "" ? "" : prefix + (isLast ? "   " : "\u2502  ");
				items.push(...flattenTree(node.children, childPrefix));
			}
		});
		return items;
	}

	// ── Sidebar ──

	window._startOrchestrator = async () => {
		const btn = document.querySelector(".start-orchestrator-btn");
		if (btn) {
			btn.textContent = "Starting...";
			btn.disabled = true;
		}
		const result = await api("/dash/api/terminal-start");
		if (result.error) {
			if (btn) {
				btn.textContent = "Retry Start";
				btn.disabled = false;
				const errDiv =
					btn.parentElement.querySelector(".start-error") || document.createElement("div");
				errDiv.className = "start-error";
				errDiv.style.cssText =
					"color:var(--red,#f38ba8);font-size:12px;margin-top:8px;max-width:400px;word-break:break-word";
				errDiv.textContent = result.error;
				if (!btn.parentElement.querySelector(".start-error")) btn.parentElement.appendChild(errDiv);
			}
			return;
		}
		if (btn) btn.textContent = "Started! Loading...";
		setTimeout(() => refresh(), 2000);
	};

	function renderSidebar() {
		const list = $("agent-list");
		const hasOrchestrator =
			Array.isArray(S.sessions) &&
			S.sessions.some(
				(s) =>
					s.agent_name === "orchestrator" && ["working", "booting", "stalled"].includes(s.state),
			);
		let btnHtml = "";
		if (!hasOrchestrator) {
			btnHtml =
				'<button class="start-orchestrator-btn" onclick="window._startOrchestrator()">Start Orchestrator</button>';
		}
		if (!Array.isArray(S.sessions) || S.sessions.length === 0) {
			list.innerHTML = `${btnHtml}<div class="empty-state">No sessions found</div>`;
			return;
		}
		const tree = buildTree(S.sessions);
		const flat = flattenTree(tree, "");
		let html = "";
		for (const { node, prefix } of flat) {
			const active = ["working", "booting", "stalled"].includes(node.state);
			const sel = S.selectedAgent === node.agent_name ? " selected" : "";
			const cls = active ? "" : " completed";
			html += `<div class="agent-node${sel}${cls}" onclick="window._selectAgent('${esc(node.agent_name)}')">
        <span class="tree-prefix">${esc(prefix)}</span>
        <span class="state-dot ${esc(node.state)}"></span>
        <span class="agent-info">
          <span class="agent-name-text">${esc(node.agent_name)}</span>
          <span class="agent-cap cap-${esc(node.capability)}">${esc(node.capability)}</span>
        </span>
        <span class="agent-dur">${durFromDates(node.started_at)}</span>
      </div>`;
		}
		list.innerHTML = btnHtml + html;
	}

	// ── Stats ──

	function renderStats() {
		const st = S.status || {};
		const active = Array.isArray(st.agents) ? st.agents.length : 0;
		const unread = st.unreadMailCount || 0;
		const merges = st.mergeQueueCount || 0;
		const worktrees = Array.isArray(st.worktrees) ? st.worktrees.length : 0;
		$("topbar-stats").innerHTML = `
      <div class="topbar-stat"><span class="val">${active}</span> active</div>
      <div class="topbar-stat"><span class="val">${unread}</span> unread</div>
      <div class="topbar-stat"><span class="val">${merges}</span> merges</div>
      <div class="topbar-stat"><span class="val">${worktrees}</span> worktrees</div>
    `;
		$("topbar-time").textContent = fmtTime();
	}

	// ── Center Panel ──

	window._selectAgent = (name) => {
		cleanupTerminal();
		S.selectedAgent = name;
		S.centerTab = "overview";
		renderSidebar();
		renderCenterHeader();
		loadAgentDetail();
	};

	function renderCenterHeader() {
		const id = $("agent-identity");
		if (!S.selectedAgent) {
			id.innerHTML = '<span class="empty-hint">Select an agent to inspect</span>';
			return;
		}
		const session = S.sessions.find((s) => s.agent_name === S.selectedAgent);
		if (!session) {
			id.innerHTML = `<span class="empty-hint">${esc(S.selectedAgent)}</span>`;
			return;
		}
		id.innerHTML = `
      <span class="state-dot ${esc(session.state)}"></span>
      <span class="agent-id-name">${esc(session.agent_name)}</span>
      <span class="agent-cap cap-${esc(session.capability)}">${esc(session.capability)}</span>
      <span class="agent-id-meta">
        <span>${esc(session.bead_id || "")}</span>
        <span>${durFromDates(session.started_at)}</span>
        <span class="state-badge badge-${esc(session.state)}">${esc(session.state)}</span>
      </span>
    `;
	}

	async function loadAgentDetail() {
		if (!S.selectedAgent) return;
		const agent = S.selectedAgent;
		// Load inspect + agent mail in parallel
		const [inspect, mail] = await Promise.all([
			api(`/dash/api/inspect/${agent}`),
			api(`/dash/api/mail?agent=${agent}&limit=50`),
		]);
		if (S.selectedAgent !== agent) return; // agent changed during load
		S.inspect = inspect;
		S.agentMail = Array.isArray(mail) ? mail : [];
		renderCenter();
	}

	function renderCenter() {
		// Update tab active states
		$("center-tabs")
			.querySelectorAll(".tab")
			.forEach((t) => {
				t.classList.toggle("active", t.dataset.tab === S.centerTab);
			});

		switch (S.centerTab) {
			case "overview":
				renderOverview();
				break;
			case "terminal":
				loadTerminal();
				break;
			case "trace":
				loadTrace();
				break;
			case "agent-mail":
				renderAgentMail();
				break;
		}
	}

	function renderOverview() {
		const el = $("center-content");
		const ins = S.inspect || {};
		if (ins.error) {
			el.innerHTML = `<div class="empty-state">${esc(ins.error)}</div>`;
			return;
		}
		const session = ins.session || {};
		const tokens = ins.tokenUsage || {};
		const toolStats = Array.isArray(ins.toolStats) ? ins.toolStats : [];
		const recent = Array.isArray(ins.recentToolCalls) ? ins.recentToolCalls.slice(0, 15) : [];

		let html = '<div class="overview-grid">';

		// Identity card
		html += `<div class="ov-card">
      <div class="ov-card-title">Session</div>
      <div class="ov-row"><span class="label">Agent</span><span class="value">${esc(session.agent_name)}</span></div>
      <div class="ov-row"><span class="label">Capability</span><span class="value">${esc(session.capability)}</span></div>
      <div class="ov-row"><span class="label">State</span><span class="value"><span class="state-badge badge-${esc(session.state)}">${esc(session.state)}</span></span></div>
      <div class="ov-row"><span class="label">Bead</span><span class="value">${esc(session.bead_id || "none")}</span></div>
      <div class="ov-row"><span class="label">Branch</span><span class="value">${esc(session.branch_name || "none")}</span></div>
      <div class="ov-row"><span class="label">Parent</span><span class="value">${esc(session.parent_agent || "none")}</span></div>
      <div class="ov-row"><span class="label">Depth</span><span class="value">${session.depth ?? ""}</span></div>
      <div class="ov-row"><span class="label">Duration</span><span class="value">${durFromDates(session.started_at)}</span></div>
      <div class="ov-row"><span class="label">Started</span><span class="value">${timeAgo(session.started_at)}</span></div>
      <div class="ov-row"><span class="label">Last Activity</span><span class="value">${timeAgo(session.last_activity)}</span></div>
    </div>`;

		// Token usage
		if (tokens.input_tokens || tokens.output_tokens) {
			html += `<div class="ov-card">
        <div class="ov-card-title">Token Usage</div>
        <div class="ov-row"><span class="label">Input</span><span class="value">${(tokens.input_tokens || 0).toLocaleString()}</span></div>
        <div class="ov-row"><span class="label">Output</span><span class="value">${(tokens.output_tokens || 0).toLocaleString()}</span></div>
        <div class="ov-row"><span class="label">Cache Read</span><span class="value">${(tokens.cache_read_tokens || 0).toLocaleString()}</span></div>
        <div class="ov-row"><span class="label">Cache Write</span><span class="value">${(tokens.cache_creation_tokens || 0).toLocaleString()}</span></div>
        <div class="ov-row"><span class="label">Est. Cost</span><span class="value">$${(tokens.estimated_cost_usd || 0).toFixed(3)}</span></div>
        <div class="ov-row"><span class="label">Model</span><span class="value">${esc(tokens.model_used || "")}</span></div>
      </div>`;
		}

		// Tool stats
		if (toolStats.length) {
			html += `<div class="ov-card">
        <div class="ov-card-title">Tool Usage</div>
        ${toolStats
					.map(
						(t) => `<div class="ov-row">
          <span class="label">${esc(t.toolName || t.tool_name)}</span>
          <span class="value">${t.count}x  avg ${dur(t.avgDuration || t.avg_duration || 0)}</span>
        </div>`,
					)
					.join("")}
      </div>`;
		}

		html += "</div>";

		// Recent tool calls
		if (recent.length) {
			html +=
				'<div style="margin-top:16px"><div class="ov-card-title" style="padding:0 0 8px">RECENT ACTIVITY</div>';
			html += recent
				.map((ev) => {
					let detail = "";
					if (ev.tool_args) {
						try {
							const args =
								typeof ev.tool_args === "string" ? JSON.parse(ev.tool_args) : ev.tool_args;
							detail = args.command || args.file_path || args.pattern || args.query || "";
						} catch (_e) {
							detail = "";
						}
					}
					return `<div class="trace-item">
          <span class="trace-time">${timeAgo(ev.created_at)}</span>
          <span class="trace-type level-${esc(ev.level || "info")}">${esc(ev.event_type)}</span>
          <span class="trace-tool">${esc(ev.tool_name || "")}</span>
          <span class="trace-detail" title="${esc(detail)}">${esc(detail)}</span>
          ${ev.tool_duration_ms ? `<span class="trace-dur">${dur(ev.tool_duration_ms)}</span>` : ""}
        </div>`;
				})
				.join("");
			html += "</div>";
		}

		el.innerHTML = html;
	}

	let activeTerminal = null;
	let activeWs = null;
	let activeResizeObserver = null;
	let activeWindowResizeHandler = null;

	function cleanupTerminal() {
		if (activeWs) {
			try {
				activeWs.close();
			} catch {}
			activeWs = null;
		}
		if (activeTerminal) {
			try {
				activeTerminal.dispose();
			} catch {}
			activeTerminal = null;
		}
		if (activeResizeObserver) {
			try {
				activeResizeObserver.disconnect();
			} catch {}
			activeResizeObserver = null;
		}
		if (activeWindowResizeHandler) {
			window.removeEventListener("resize", activeWindowResizeHandler);
			activeWindowResizeHandler = null;
		}
	}

	function loadTerminal() {
		const el = $("center-content");
		cleanupTerminal();

		// If no agent selected, show start button
		if (!S.selectedAgent) {
			const hasOrchestrator =
				Array.isArray(S.sessions) &&
				S.sessions.some(
					(s) =>
						s.agent_name === "orchestrator" && ["working", "booting", "stalled"].includes(s.state),
				);
			if (hasOrchestrator) {
				el.innerHTML =
					'<div class="empty-state center-empty"><div class="empty-icon">&#x25C7;</div><div>Select an agent in the sidebar to view its terminal</div></div>';
			} else {
				el.innerHTML = `<div class="empty-state center-empty">
          <div class="empty-icon">&#x25C7;</div>
          <div>No orchestrator running</div>
          <button class="start-orchestrator-btn" onclick="window._startOrchestrator()" style="margin-top:16px">Start Orchestrator</button>
        </div>`;
			}
			return;
		}

		const session = S.sessions.find((s) => s.agent_name === S.selectedAgent);
		const tmuxSession = session?.tmux_session;
		const isActive = session && ["working", "booting", "stalled"].includes(session.state);

		el.innerHTML = `<div class="xterm-wrap">
      <div class="xterm-titlebar">
        <div class="terminal-dots"><span></span><span></span><span></span></div>
        <span class="terminal-session">${esc(S.selectedAgent)}${tmuxSession ? ` (${esc(tmuxSession)})` : ""}</span>
      </div>
      <div id="xterm-container"></div>
    </div>`;

		if (!tmuxSession || !isActive) {
			const container = document.getElementById("xterm-container");
			container.innerHTML =
				'<div class="empty-state" style="padding:40px">No active tmux session for this agent</div>';
			return;
		}

		const term = new Terminal({
			fontFamily: "'JetBrains Mono NF', 'JetBrains Mono', monospace",
			fontSize: 13,
			lineHeight: 1,
			customGlyphs: true,
			cursorBlink: true,
			allowProposedApi: true,
			theme: {
				background: "#11111b",
				foreground: "#cdd6f4",
				cursor: "#f5e0dc",
				selectionBackground: "#45475a80",
				black: "#45475a",
				red: "#f38ba8",
				green: "#a6e3a1",
				yellow: "#f9e2af",
				blue: "#89b4fa",
				magenta: "#cba6f7",
				cyan: "#94e2d5",
				white: "#cdd6f4",
				brightBlack: "#6c7086",
				brightRed: "#f38ba8",
				brightGreen: "#a6e3a1",
				brightYellow: "#f9e2af",
				brightBlue: "#89b4fa",
				brightMagenta: "#f5c2e7",
				brightCyan: "#89dcfe",
				brightWhite: "#cdd6f4",
			},
		});

		const fitAddon = new FitAddon.FitAddon();
		term.loadAddon(fitAddon);
		try {
			const webLinksAddon = new WebLinksAddon.WebLinksAddon();
			term.loadAddon(webLinksAddon);
		} catch {}

		const container = document.getElementById("xterm-container");
		term.open(container);

		const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${wsProto}//${location.host}/ws/terminal/${tmuxSession}`);

		// Defer fit until layout settles, then send dimensions to server
		requestAnimationFrame(() => {
			fitAddon.fit();
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
			}
		});

		ws.onopen = () => {
			// Re-fit in case layout changed between RAF and WS connect
			fitAddon.fit();
			ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
		};

		ws.onmessage = (e) => {
			term.write(e.data);
		};

		term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		});

		term.onResize(({ cols, rows }) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "resize", cols, rows }));
			}
		});

		const doFit = () => {
			try {
				fitAddon.fit();
			} catch {}
		};

		const resizeObserver = new ResizeObserver(doFit);
		resizeObserver.observe(container);
		window.addEventListener("resize", doFit);

		ws.onclose = () => {
			term.write("\r\n\x1b[90m[Connection closed]\x1b[0m\r\n");
		};

		activeTerminal = term;
		activeWs = ws;
		activeResizeObserver = resizeObserver;
		activeWindowResizeHandler = doFit;
	}

	async function loadTrace() {
		const el = $("center-content");
		if (!S.selectedAgent) return;
		el.innerHTML = '<div class="empty-state">Loading trace...</div>';
		const trace = await api(`/dash/api/trace/${S.selectedAgent}`);
		S.trace = Array.isArray(trace) ? trace : [];
		renderTrace();
	}

	function renderTrace() {
		const el = $("center-content");
		if (!S.trace.length) {
			el.innerHTML = '<div class="empty-state">No events for this agent</div>';
			return;
		}
		// Show newest first (already sorted DESC from server)
		el.innerHTML = S.trace
			.map((ev) => {
				let detail = "";
				if (ev.tool_args) {
					try {
						const args = typeof ev.tool_args === "string" ? JSON.parse(ev.tool_args) : ev.tool_args;
						detail = args.command || args.file_path || args.pattern || args.query || "";
					} catch (_e) {
						detail = "";
					}
				} else if (ev.data) {
					try {
						const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
						detail = d.message || d.reason || JSON.stringify(d).slice(0, 120);
					} catch (_e) {
						detail = "";
					}
				}
				return `<div class="trace-item">
        <span class="trace-time">${timeAgo(ev.created_at)}</span>
        <span class="trace-type level-${esc(ev.level || "info")}">${esc(ev.event_type)}</span>
        <span class="trace-tool">${esc(ev.tool_name || "")}</span>
        <span class="trace-detail" title="${esc(detail)}">${esc(detail)}</span>
        ${ev.tool_duration_ms ? `<span class="trace-dur">${dur(ev.tool_duration_ms)}</span>` : ""}
      </div>`;
			})
			.join("");
	}

	function renderAgentMail() {
		const el = $("center-content");
		if (!S.agentMail.length) {
			el.innerHTML = '<div class="empty-state">No messages for this agent</div>';
			return;
		}
		el.innerHTML = S.agentMail.map((m) => mailCard(m, true)).join("");
	}

	// ── Right Panel ──

	function renderRight() {
		$("right-tabs")
			.querySelectorAll(".tab")
			.forEach((t) => {
				t.classList.toggle("active", t.dataset.tab === S.rightTab);
			});
		switch (S.rightTab) {
			case "inbox":
				renderInbox();
				break;
			case "merge-queue":
				renderMergeQueuePanel();
				break;
			case "events":
				renderEventsPanel();
				break;
			case "metrics":
				renderMetricsPanel();
				break;
			case "usage":
				renderUsagePanel();
				break;
		}
	}

	function mailCard(m, expanded) {
		const unread = m.read === 0 ? " unread" : "";
		const priority = m.priority && m.priority !== "normal" ? ` priority-${m.priority}` : "";
		const typeClass = `type-${m.type || "status"}`;
		const exp = expanded ? " expanded" : "";
		return `<div class="mail-item${unread}${priority}${exp}" onclick="this.classList.toggle('expanded')">
      <div class="mail-header">
        <span class="mail-route"><span class="from">${esc(m.from_agent)}</span> → <span class="to">${esc(m.to_agent)}</span></span>
        <span class="mail-type ${typeClass}">${esc(m.type || "status")}</span>
        <span class="mail-time">${timeAgo(m.created_at)}</span>
      </div>
      <div class="mail-subject">${esc(m.subject)}</div>
      ${!expanded ? `<div class="mail-body-preview">${esc((m.body || "").slice(0, 100))}</div>` : ""}
      <div class="mail-body">${esc(m.body || "")}</div>
    </div>`;
	}

	function renderInbox() {
		const el = $("right-content");
		if (!Array.isArray(S.mail) || !S.mail.length) {
			el.innerHTML = '<div class="empty-state">No messages</div>';
			return;
		}
		el.innerHTML = S.mail.map((m) => mailCard(m, false)).join("");
	}

	function renderMergeQueuePanel() {
		const el = $("right-content");
		if (!Array.isArray(S.mergeQueue) || !S.mergeQueue.length) {
			el.innerHTML = '<div class="empty-state">Merge queue empty</div>';
			return;
		}
		el.innerHTML = S.mergeQueue
			.map((m) => {
				const statusCls = `merge-${m.status || "pending"}`;
				let files = "";
				if (m.files_modified) {
					try {
						const f =
							typeof m.files_modified === "string"
								? JSON.parse(m.files_modified)
								: m.files_modified;
						files = Array.isArray(f) ? `${f.length} files` : "";
					} catch (_e) {
						files = "";
					}
				}
				return `<div class="merge-item">
        <div class="merge-branch">${esc(m.branch_name)}</div>
        <div class="merge-meta">
          <span class="merge-status ${statusCls}">${esc(m.status)}</span>
          <span>${esc(m.agent_name || "")}</span>
          ${files ? `<span>${files}</span>` : ""}
          <span>${timeAgo(m.enqueued_at)}</span>
          ${m.resolved_tier ? `<span>${esc(m.resolved_tier)}</span>` : ""}
        </div>
      </div>`;
			})
			.join("");
	}

	function renderEventsPanel() {
		const el = $("right-content");
		if (!Array.isArray(S.events) || !S.events.length) {
			el.innerHTML = '<div class="empty-state">No events</div>';
			return;
		}
		el.innerHTML = S.events
			.map((ev) => {
				let detail = ev.tool_name || ev.event_type;
				if (ev.data) {
					try {
						const d = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
						if (d.message) detail += `: ${d.message}`;
					} catch (_e) {}
				}
				return `<div class="event-item">
        <span class="event-time">${timeAgo(ev.created_at)}</span>
        <span class="event-level level-${esc(ev.level || "info")}">${esc(ev.level || "info")}</span>
        <span class="event-agent">${esc(ev.agent_name)}</span>
        <span class="event-detail">${esc(detail)}</span>
      </div>`;
			})
			.join("");
	}

	function renderMetricsPanel() {
		const el = $("right-content");
		if (!Array.isArray(S.metrics) || !S.metrics.length) {
			el.innerHTML = '<div class="empty-state">No metrics data</div>';
			return;
		}
		const total = S.metrics.length;
		const totalCost = S.metrics.reduce((s, m) => s + (m.estimated_cost_usd || 0), 0);
		const totalInput = S.metrics.reduce((s, m) => s + (m.input_tokens || 0), 0);
		const totalOutput = S.metrics.reduce((s, m) => s + (m.output_tokens || 0), 0);
		const avgDur = S.metrics.reduce((s, m) => s + (m.duration_ms || 0), 0) / (total || 1);
		const byCap = {};
		S.metrics.forEach((m) => {
			byCap[m.capability] = (byCap[m.capability] || 0) + 1;
		});

		let html = '<div class="metrics-grid">';
		html += `<div class="metric-card"><div class="metric-val">${total}</div><div class="metric-label">Sessions</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">$${totalCost.toFixed(2)}</div><div class="metric-label">Total Cost</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">${dur(avgDur)}</div><div class="metric-label">Avg Duration</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">${(totalInput / 1000).toFixed(0)}k</div><div class="metric-label">Input Tokens</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">${(totalOutput / 1000).toFixed(0)}k</div><div class="metric-label">Output Tokens</div></div>`;
		html += "</div>";

		// By capability
		html += '<div class="ov-card-title" style="padding:8px 0">BY CAPABILITY</div>';
		html += '<div class="metrics-grid">';
		for (const [cap, count] of Object.entries(byCap)) {
			html += `<div class="metric-card"><div class="metric-val" style="font-size:18px">${count}</div><div class="metric-label"><span class="agent-cap cap-${esc(cap)}">${esc(cap)}</span></div></div>`;
		}
		html += "</div>";

		// Session table
		html += '<div class="ov-card-title" style="padding:12px 0 6px">SESSION HISTORY</div>';
		html += `<table class="metrics-table">
      <thead><tr><th>Agent</th><th>Cap</th><th>Duration</th><th>In Tokens</th><th>Out Tokens</th><th>Cost</th><th>Model</th></tr></thead>
      <tbody>`;
		for (const m of S.metrics.slice(0, 50)) {
			html += `<tr>
        <td>${esc(m.agent_name)}</td>
        <td><span class="agent-cap cap-${esc(m.capability)}">${esc(m.capability)}</span></td>
        <td>${dur(m.duration_ms)}</td>
        <td>${(m.input_tokens || 0).toLocaleString()}</td>
        <td>${(m.output_tokens || 0).toLocaleString()}</td>
        <td>$${(m.estimated_cost_usd || 0).toFixed(3)}</td>
        <td>${esc(m.model_used || "")}</td>
      </tr>`;
		}
		html += "</tbody></table>";

		el.innerHTML = html;
	}

	// ── Usage Panel ──

	function modelShort(m) {
		if (m.includes("opus")) return "Opus 4.6";
		if (m.includes("sonnet")) return "Sonnet 4.6";
		if (m.includes("haiku")) return "Haiku 4.5";
		return m;
	}

	function modelBarClass(m) {
		if (m.includes("opus")) return "model-opus";
		if (m.includes("sonnet")) return "model-sonnet";
		if (m.includes("haiku")) return "model-haiku";
		return "model-sonnet";
	}

	function gaugeClass(pct) {
		if (pct < 40) return "gauge-low";
		if (pct < 65) return "gauge-mid";
		if (pct < 85) return "gauge-high";
		return "gauge-crit";
	}

	function gaugeColor(pct) {
		if (pct < 40) return "var(--green)";
		if (pct < 65) return "var(--yellow)";
		if (pct < 85) return "var(--peach)";
		return "var(--red)";
	}

	function fmtTokens(n) {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
		return String(n);
	}

	function renderUsagePanel() {
		const el = $("right-content");
		const u = S.usage;
		if (!u || u.error) {
			el.innerHTML = `<div class="empty-state">${esc(u?.error || "Loading usage data...")}</div>`;
			return;
		}

		const t = u.totals;
		// Estimate usage percentage - rough heuristic based on weighted tokens
		// Max 20x plan ~= 80M weighted tokens per 5h window (estimated)
		const estimatedCap = 80_000_000;
		const usagePct = Math.min(100, Math.round((t.weighted_tokens / estimatedCap) * 100));

		let html = "";

		// Window info
		html += `<div class="usage-header">
      <span class="usage-window-label">5-HOUR ROLLING WINDOW</span>
      <span class="usage-window-val">${t.sessions} sessions &middot; ${t.requests} requests</span>
    </div>`;

		// Main gauge bar
		html += `<div class="usage-gauge-wrap">
      <div class="usage-gauge-label">
        <span class="lbl">Estimated Quota Used</span>
        <span class="pct" style="color:${gaugeColor(usagePct)}">${usagePct}%</span>
      </div>
      <div class="usage-gauge">
        <div class="usage-gauge-fill ${gaugeClass(usagePct)}" style="width:${usagePct}%"></div>
      </div>
    </div>`;

		// Summary cards
		html += '<div class="metrics-grid">';
		html += `<div class="metric-card"><div class="metric-val">${fmtTokens(t.raw_tokens)}</div><div class="metric-label">Raw Tokens</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">${fmtTokens(t.weighted_tokens)}</div><div class="metric-label">Weighted</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">$${t.api_cost_usd.toFixed(2)}</div><div class="metric-label">API Equiv.</div></div>`;
		html += `<div class="metric-card"><div class="metric-val">${fmtTokens(t.cache_read_input_tokens)}</div><div class="metric-label">Cache Read</div></div>`;
		html += "</div>";

		// Per-model breakdown
		const models = Object.entries(u.by_model).filter(([k]) => k !== "<synthetic>");
		if (models.length) {
			html += '<div class="ov-card-title" style="padding:8px 0">BY MODEL</div>';
			html += '<div class="usage-models">';
			const maxWeighted = Math.max(...models.map(([, v]) => v.weighted_tokens), 1);
			for (const [model, m] of models) {
				const barPct = Math.max(2, Math.round((m.weighted_tokens / maxWeighted) * 100));
				html += `<div class="usage-model-row">
          <span class="usage-model-name">${esc(modelShort(model))}</span>
          <div class="usage-model-bar-wrap">
            <div class="usage-model-bar ${modelBarClass(model)}" style="width:${barPct}%"></div>
          </div>
          <span class="usage-model-stats">
            <span>${m.requests}req</span>
            <span>${fmtTokens(m.input_tokens + m.output_tokens)}</span>
            <span class="cost">$${m.api_cost_usd.toFixed(2)}</span>
          </span>
        </div>`;
			}
			html += "</div>";
		}

		// Sparkline - 15-minute buckets over 5 hours
		const ts = u.time_series || [];
		if (ts.length) {
			const maxBucket = Math.max(...ts.map((b) => b.weighted), 1);
			html += '<div class="usage-sparkline-wrap">';
			html += '<div class="usage-sparkline-title">Activity (15-min buckets)</div>';
			html += '<div class="usage-sparkline">';
			for (let i = 0; i < ts.length; i++) {
				const b = ts[i];
				const h = Math.max(1, Math.round((b.weighted / maxBucket) * 48));
				const isCurrent = i === ts.length - 1;
				const title =
					new Date(b.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) +
					": " +
					fmtTokens(b.weighted) +
					" weighted, " +
					b.requests +
					" req";
				html += `<div class="spark-bar${isCurrent ? " current" : ""}" style="height:${h}px" title="${esc(title)}"></div>`;
			}
			html += "</div>";
			// Labels
			const first = ts[0]
				? new Date(ts[0].t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				: "";
			const last = ts[ts.length - 1]
				? new Date(ts[ts.length - 1].t).toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					})
				: "";
			html += `<div class="sparkline-labels"><span>${first}</span><span>${last}</span></div>`;
			html += "</div>";
		}

		// Raw token detail table
		html += '<div class="ov-card-title" style="padding:8px 0">TOKEN DETAIL</div>';
		html += `<table class="metrics-table">
      <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th><th>Reqs</th></tr></thead>
      <tbody>`;
		for (const [model, m] of models) {
			html += `<tr>
        <td>${esc(modelShort(model))}</td>
        <td>${fmtTokens(m.input_tokens)}</td>
        <td>${fmtTokens(m.output_tokens)}</td>
        <td>${fmtTokens(m.cache_read_input_tokens)}</td>
        <td>${fmtTokens(m.cache_creation_input_tokens)}</td>
        <td>${m.requests}</td>
      </tr>`;
		}
		html += "</tbody></table>";

		el.innerHTML = html;
	}

	function renderTopbarUsage() {
		const u = S.usage;
		if (!u || u.error) return;
		const t = u.totals;
		const estimatedCap = 80_000_000;
		const usagePct = Math.min(100, Math.round((t.weighted_tokens / estimatedCap) * 100));
		const existing = document.getElementById("topbar-usage");
		if (existing) {
			existing.querySelector(".topbar-usage-fill").style.width = `${usagePct}%`;
			existing.querySelector(".topbar-usage-fill").className =
				`topbar-usage-fill ${gaugeClass(usagePct)}`;
			existing.querySelector(".topbar-usage-pct").textContent = `${usagePct}%`;
			existing.querySelector(".topbar-usage-pct").style.color = gaugeColor(usagePct);
			return;
		}
		const div = document.createElement("div");
		div.id = "topbar-usage";
		div.className = "topbar-usage";
		div.innerHTML = `
      <span class="topbar-usage-label">5h</span>
      <div class="topbar-usage-bar">
        <div class="topbar-usage-fill ${gaugeClass(usagePct)}" style="width:${usagePct}%"></div>
      </div>
      <span class="topbar-usage-pct" style="color:${gaugeColor(usagePct)}">${usagePct}%</span>
    `;
		const topRight = document.querySelector(".topbar-right");
		topRight.insertBefore(div, topRight.firstChild);
	}

	// ── Main Loop ──

	async function refresh() {
		const dot = $("refresh-dot");
		dot.classList.add("pulsing");
		setTimeout(() => dot.classList.remove("pulsing"), 600);

		const now = Date.now();

		// Always fetch status + sessions
		const [status, sessions] = await Promise.all([
			api("/dash/api/status"),
			api("/dash/api/sessions"),
		]);
		S.status = status.error ? {} : status;
		S.sessions = Array.isArray(sessions) ? sessions : [];
		renderSidebar();
		renderStats();

		// Refresh mail periodically
		if (now - S.lastMailRefresh > MAIL_REFRESH) {
			S.lastMailRefresh = now;
			const [mail, mergeQueue, events] = await Promise.all([
				api("/dash/api/mail?limit=100"),
				api("/dash/api/merge-queue"),
				api("/dash/api/events?limit=80"),
			]);
			S.mail = Array.isArray(mail) ? mail : [];
			S.mergeQueue = Array.isArray(mergeQueue) ? mergeQueue : [];
			S.events = Array.isArray(events) ? events : [];
			renderRight();
		}

		// Refresh metrics less often
		if (now - S.lastMetricsRefresh > METRICS_REFRESH) {
			S.lastMetricsRefresh = now;
			const [metrics, usage] = await Promise.all([
				api("/dash/api/metrics"),
				api("/dash/api/usage"),
			]);
			S.metrics = Array.isArray(metrics) ? metrics : [];
			S.usage = usage && !usage.error ? usage : S.usage;
			if (S.rightTab === "metrics" || S.rightTab === "usage") renderRight();
			renderTopbarUsage();
		}

		// Fetch usage on first load if not loaded yet
		if (!S.usage && now - S.lastUsageRefresh > 5000) {
			S.lastUsageRefresh = now;
			const usage = await api("/dash/api/usage");
			S.usage = usage && !usage.error ? usage : null;
			if (S.rightTab === "usage") renderRight();
			renderTopbarUsage();
		}

		$("topbar-time").textContent = fmtTime();
	}

	// ── Tab Handlers ──

	function setupTabs() {
		$("center-tabs").addEventListener("click", (e) => {
			const tab = e.target.closest(".tab");
			if (!tab) return;
			if (S.centerTab === "terminal" && tab.dataset.tab !== "terminal") cleanupTerminal();
			S.centerTab = tab.dataset.tab;
			renderCenter();
		});

		$("right-tabs").addEventListener("click", (e) => {
			const tab = e.target.closest(".tab");
			if (!tab) return;
			S.rightTab = tab.dataset.tab;
			// Force refresh of right panel data
			S.lastMailRefresh = 0;
			S.lastMetricsRefresh = 0;
			renderRight();
		});
	}

	// ── Init ──

	function init() {
		setupTabs();

		// Clock toggle: click to switch 12h/24h
		$("topbar-time").style.cursor = "pointer";
		$("topbar-time").title = "Click to toggle 12h/24h";
		$("topbar-time").addEventListener("click", () => {
			S.use24h = !S.use24h;
			$("topbar-time").textContent = fmtTime();
		});

		// Force immediate data load
		S.lastMailRefresh = 0;
		S.lastMetricsRefresh = 0;
		refresh();
		setInterval(refresh, REFRESH);
	}

	init();
})();
