/**
 * Shell completion generation for overstory CLI.
 *
 * Generates completion scripts for bash, zsh, and fish shells.
 */

import { Command } from "commander";
import { printError } from "../logging/color.ts";

interface FlagDef {
	name: string;
	desc: string;
	takesValue?: boolean;
	values?: readonly string[];
}

interface SubcommandDef {
	name: string;
	desc: string;
	flags?: readonly FlagDef[];
}

interface CommandDef {
	name: string;
	desc: string;
	flags?: readonly FlagDef[];
	subcommands?: readonly SubcommandDef[];
}

export const COMMANDS: readonly CommandDef[] = [
	{
		name: "agents",
		desc: "Discover and query agents",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "discover",
				desc: "Find active agents by capability",
				flags: [
					{
						name: "--capability",
						desc: "Filter by capability",
						takesValue: true,
						values: [
							"builder",
							"scout",
							"reviewer",
							"lead",
							"merger",
							"orchestrator",
							"coordinator",
							"supervisor",
						],
					},
					{ name: "--all", desc: "Include completed and zombie agents" },
					{ name: "--json", desc: "JSON output" },
					{ name: "--help", desc: "Show help" },
				],
			},
		],
	},
	{
		name: "init",
		desc: "Initialize .overstory/ and bootstrap os-eco ecosystem tools",
		flags: [
			{ name: "--force", desc: "Overwrite existing configuration" },
			{ name: "--yes", desc: "Accept all defaults without prompting" },
			{ name: "-y", desc: "Alias for --yes" },
			{ name: "--name", desc: "Project name", takesValue: true },
			{ name: "--tools", desc: "Comma-separated list of tools to bootstrap", takesValue: true },
			{ name: "--skip-mulch", desc: "Skip mulch bootstrap" },
			{ name: "--skip-seeds", desc: "Skip seeds bootstrap" },
			{ name: "--skip-canopy", desc: "Skip canopy bootstrap" },
			{ name: "--skip-onboard", desc: "Skip CLAUDE.md onboarding step" },
			{ name: "--json", desc: "Output result as JSON" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "sling",
		desc: "Spawn a worker agent",
		flags: [
			{
				name: "--capability",
				desc: "Agent capability type",
				takesValue: true,
				values: ["builder", "scout", "reviewer", "lead", "merger"],
			},
			{ name: "--name", desc: "Unique agent name", takesValue: true },
			{ name: "--spec", desc: "Path to task spec file", takesValue: true },
			{ name: "--files", desc: "Exclusive file scope (comma-separated)", takesValue: true },
			{ name: "--parent", desc: "Parent agent name", takesValue: true },
			{ name: "--depth", desc: "Current hierarchy depth", takesValue: true },
			{ name: "--skip-scout", desc: "Skip scout phase for lead agents" },
			{ name: "--skip-review", desc: "Skip review phase for lead agents" },
			{ name: "--skip-task-check", desc: "Skip task existence validation" },
			{ name: "--force-hierarchy", desc: "Bypass hierarchy validation" },
			{ name: "--max-agents", desc: "Max children per lead", takesValue: true },
			{ name: "--dispatch-max-agents", desc: "Per-lead max agents ceiling", takesValue: true },
			{ name: "--runtime", desc: "Runtime adapter", takesValue: true },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "prime",
		desc: "Load context for orchestrator/agent",
		flags: [
			{ name: "--agent", desc: "Per-agent priming", takesValue: true },
			{ name: "--compact", desc: "Less context (for PreCompact hook)" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "stop",
		desc: "Terminate a running agent",
		flags: [
			{ name: "--force", desc: "Force kill and force-delete branch" },
			{ name: "--clean-worktree", desc: "Remove the agent's worktree after stopping" },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "status",
		desc: "Show all active agents and project state",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--verbose", desc: "Extra per-agent detail" },
			{ name: "--agent", desc: "Filter by agent", takesValue: true },
			{ name: "--all", desc: "Show sessions from all runs" },
			{ name: "--watch", desc: "Watch mode" },
			{ name: "--interval", desc: "Poll interval in ms", takesValue: true },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "dashboard",
		desc: "Live TUI dashboard for agent monitoring",
		flags: [
			{ name: "--interval", desc: "Poll interval in ms (default 2000)", takesValue: true },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "inspect",
		desc: "Deep inspection of a single agent",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--follow", desc: "Poll and refresh continuously" },
			{ name: "--interval", desc: "Polling interval in ms", takesValue: true },
			{ name: "--limit", desc: "Recent tool calls to show", takesValue: true },
			{ name: "--no-tmux", desc: "Skip tmux capture-pane" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "merge",
		desc: "Merge agent branches into canonical",
		flags: [
			{ name: "--branch", desc: "Specific branch to merge", takesValue: true },
			{ name: "--all", desc: "All completed branches" },
			{ name: "--into", desc: "Target branch to merge into", takesValue: true },
			{ name: "--dry-run", desc: "Check for conflicts only" },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "nudge",
		desc: "Send a text nudge to an agent",
		flags: [
			{ name: "--from", desc: "Sender name", takesValue: true },
			{ name: "--force", desc: "Skip debounce check" },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "clean",
		desc: "Wipe runtime state (nuclear cleanup)",
		flags: [
			{ name: "--all", desc: "Wipe everything" },
			{ name: "--mail", desc: "Clean mail database" },
			{ name: "--sessions", desc: "Clean sessions database" },
			{ name: "--metrics", desc: "Clean metrics database" },
			{ name: "--logs", desc: "Clean log files" },
			{ name: "--worktrees", desc: "Clean worktrees" },
			{ name: "--branches", desc: "Clean branches" },
			{ name: "--agents", desc: "Clean agent state" },
			{ name: "--specs", desc: "Clean specs" },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "doctor",
		desc: "Run health checks on overstory setup",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--verbose", desc: "Show passing checks too" },
			{
				name: "--category",
				desc: "Run one category only",
				takesValue: true,
				values: [
					"dependencies",
					"structure",
					"config",
					"databases",
					"consistency",
					"agents",
					"merge",
					"logs",
					"version",
					"ecosystem",
				],
			},
			{ name: "--fix", desc: "Attempt to auto-fix issues" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "log",
		desc: "Log a hook event",
		flags: [
			{ name: "--agent", desc: "Agent name", takesValue: true },
			{ name: "--tool-name", desc: "Tool name", takesValue: true },
			{ name: "--transcript", desc: "Transcript path", takesValue: true },
			{ name: "--stdin", desc: "Read from stdin" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "logs",
		desc: "Query NDJSON logs across agents",
		flags: [
			{ name: "--agent", desc: "Filter by agent", takesValue: true },
			{
				name: "--level",
				desc: "Filter by log level",
				takesValue: true,
				values: ["debug", "info", "warn", "error"],
			},
			{ name: "--since", desc: "Time filter (ISO 8601 or relative)", takesValue: true },
			{ name: "--until", desc: "Time filter (ISO 8601)", takesValue: true },
			{ name: "--limit", desc: "Max entries", takesValue: true },
			{ name: "--follow", desc: "Tail logs in real time" },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "watch",
		desc: "Start watchdog daemon",
		flags: [
			{ name: "--interval", desc: "Check interval in ms", takesValue: true },
			{ name: "--background", desc: "Run in background" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "trace",
		desc: "Chronological event timeline for agent or task",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--since", desc: "Time range filter (ISO 8601)", takesValue: true },
			{ name: "--until", desc: "Time range filter (ISO 8601)", takesValue: true },
			{ name: "--limit", desc: "Max events", takesValue: true },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "errors",
		desc: "Aggregated error view across agents",
		flags: [
			{ name: "--agent", desc: "Filter by agent", takesValue: true },
			{ name: "--run", desc: "Filter by run", takesValue: true },
			{ name: "--since", desc: "Time range filter (ISO 8601)", takesValue: true },
			{ name: "--until", desc: "Time range filter (ISO 8601)", takesValue: true },
			{ name: "--limit", desc: "Max errors", takesValue: true },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "feed",
		desc: "Unified real-time event stream across all agents",
		flags: [
			{ name: "--follow", desc: "Continuously poll for new events" },
			{ name: "-f", desc: "Alias for --follow" },
			{ name: "--interval", desc: "Polling interval in ms", takesValue: true },
			{ name: "--agent", desc: "Filter by agent", takesValue: true },
			{ name: "--run", desc: "Filter by run", takesValue: true },
			{ name: "--since", desc: "Start time (ISO 8601)", takesValue: true },
			{ name: "--limit", desc: "Max initial events", takesValue: true },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "replay",
		desc: "Interleaved chronological replay across agents",
		flags: [
			{ name: "--run", desc: "Filter by run", takesValue: true },
			{ name: "--agent", desc: "Filter by agent", takesValue: true },
			{ name: "--since", desc: "Time range filter (ISO 8601)", takesValue: true },
			{ name: "--until", desc: "Time range filter (ISO 8601)", takesValue: true },
			{ name: "--limit", desc: "Max events", takesValue: true },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "costs",
		desc: "Token/cost analysis and breakdown",
		flags: [
			{ name: "--live", desc: "Show real-time token usage for active agents" },
			{ name: "--agent", desc: "Filter by agent", takesValue: true },
			{ name: "--run", desc: "Filter by run", takesValue: true },
			{ name: "--by-capability", desc: "Group by capability with subtotals" },
			{ name: "--last", desc: "Recent sessions", takesValue: true },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "metrics",
		desc: "Show session metrics",
		flags: [
			{ name: "--last", desc: "Recent sessions", takesValue: true },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "spec",
		desc: "Manage task specs",
		flags: [{ name: "--help", desc: "Show help" }],
		subcommands: [
			{
				name: "write",
				desc: "Write a spec file",
				flags: [
					{ name: "--body", desc: "Spec content", takesValue: true },
					{ name: "--agent", desc: "Agent attribution", takesValue: true },
					{ name: "--help", desc: "Show help" },
				],
			},
		],
	},
	{
		name: "orchestrator",
		desc: "Persistent ecosystem orchestrator agent",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "start",
				desc: "Start orchestrator",
				flags: [
					{ name: "--attach", desc: "Attach to tmux session" },
					{ name: "--no-attach", desc: "Do not attach to tmux session" },
					{ name: "--watchdog", desc: "Auto-start watchdog daemon" },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "stop",
				desc: "Stop orchestrator",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
			{
				name: "status",
				desc: "Show orchestrator state",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
		],
	},
	{
		name: "coordinator",
		desc: "Persistent coordinator agent",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "start",
				desc: "Start coordinator",
				flags: [
					{ name: "--attach", desc: "Attach to tmux session" },
					{ name: "--no-attach", desc: "Do not attach to tmux session" },
					{ name: "--watchdog", desc: "Auto-start watchdog daemon" },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "stop",
				desc: "Stop coordinator",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
			{
				name: "status",
				desc: "Show coordinator state",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
		],
	},
	{
		name: "supervisor",
		desc: "[DEPRECATED] Per-project supervisor agent",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "start",
				desc: "Start supervisor",
				flags: [
					{ name: "--task", desc: "Task ID", takesValue: true },
					{ name: "--name", desc: "Unique name", takesValue: true },
					{ name: "--parent", desc: "Parent agent", takesValue: true },
					{ name: "--depth", desc: "Hierarchy depth", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "stop",
				desc: "Stop supervisor",
				flags: [
					{ name: "--name", desc: "Supervisor name", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "status",
				desc: "Show supervisor state",
				flags: [
					{ name: "--name", desc: "Supervisor name", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
		],
	},
	{
		name: "hooks",
		desc: "Manage orchestrator hooks",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "install",
				desc: "Install hooks",
				flags: [
					{ name: "--force", desc: "Overwrite existing hooks" },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "uninstall",
				desc: "Uninstall hooks",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
			{
				name: "status",
				desc: "Check if hooks are installed",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
		],
	},
	{
		name: "monitor",
		desc: "Tier 2 monitor agent",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "start",
				desc: "Start monitor",
				flags: [
					{ name: "--attach", desc: "Attach to tmux session" },
					{ name: "--no-attach", desc: "Do not attach to tmux session" },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "stop",
				desc: "Stop monitor",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
			{
				name: "status",
				desc: "Show monitor state",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
		],
	},
	{
		name: "mail",
		desc: "Mail system",
		flags: [{ name: "--help", desc: "Show help" }],
		subcommands: [
			{
				name: "send",
				desc: "Send a message",
				flags: [
					{ name: "--to", desc: "Recipient agent", takesValue: true },
					{ name: "--subject", desc: "Message subject", takesValue: true },
					{ name: "--body", desc: "Message body", takesValue: true },
					{ name: "--from", desc: "Sender name", takesValue: true },
					{ name: "--agent", desc: "Agent name", takesValue: true },
					{
						name: "--type",
						desc: "Message type",
						takesValue: true,
						values: [
							"status",
							"question",
							"result",
							"error",
							"worker_done",
							"merge_ready",
							"merged",
							"merge_failed",
							"escalation",
							"health_check",
							"dispatch",
							"assign",
						],
					},
					{
						name: "--priority",
						desc: "Message priority",
						takesValue: true,
						values: ["low", "normal", "high", "urgent"],
					},
					{ name: "--payload", desc: "Structured JSON payload", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "check",
				desc: "Check inbox (unread messages)",
				flags: [
					{ name: "--agent", desc: "Agent name", takesValue: true },
					{ name: "--inject", desc: "Inject messages" },
					{ name: "--debounce", desc: "Debounce interval in ms", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "list",
				desc: "List messages with filters",
				flags: [
					{ name: "--from", desc: "Filter by sender", takesValue: true },
					{ name: "--to", desc: "Filter by recipient", takesValue: true },
					{ name: "--agent", desc: "Agent name", takesValue: true },
					{ name: "--unread", desc: "Show only unread messages" },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "read",
				desc: "Mark message as read",
			},
			{
				name: "reply",
				desc: "Reply to a message",
				flags: [
					{ name: "--body", desc: "Reply body", takesValue: true },
					{ name: "--from", desc: "Sender name", takesValue: true },
					{ name: "--agent", desc: "Agent name", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "purge",
				desc: "Delete old messages",
				flags: [
					{ name: "--all", desc: "Delete all messages" },
					{ name: "--days", desc: "Delete messages older than N days", takesValue: true },
					{ name: "--agent", desc: "Agent name", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
		],
	},
	{
		name: "group",
		desc: "Task groups",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--skip-validation", desc: "Skip task validation" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{ name: "create", desc: "Create a new task group" },
			{ name: "status", desc: "Show progress for one or all groups" },
			{ name: "add", desc: "Add issues to a group" },
			{ name: "remove", desc: "Remove issues from a group" },
			{ name: "list", desc: "List all groups (summary)" },
		],
	},
	{
		name: "worktree",
		desc: "Manage worktrees",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "list",
				desc: "List worktrees with status",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
			{
				name: "clean",
				desc: "Remove completed worktrees",
				flags: [
					{ name: "--completed", desc: "Only finished agents" },
					{ name: "--all", desc: "Force remove all" },
					{ name: "--json", desc: "JSON output" },
				],
			},
		],
	},
	{
		name: "run",
		desc: "Manage runs",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
		subcommands: [
			{
				name: "list",
				desc: "List recent runs",
				flags: [
					{ name: "--last", desc: "Number of runs to show", takesValue: true },
					{ name: "--json", desc: "JSON output" },
				],
			},
			{
				name: "show",
				desc: "Show run details",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
			{
				name: "complete",
				desc: "Mark current run as completed",
				flags: [{ name: "--json", desc: "JSON output" }],
			},
		],
	},
	{
		name: "ecosystem",
		desc: "Show a summary dashboard of all installed os-eco tools",
		flags: [
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "upgrade",
		desc: "Upgrade overstory to the latest version",
		flags: [
			{ name: "--check", desc: "Compare current vs latest without installing" },
			{ name: "--all", desc: "Upgrade all os-eco tools" },
			{ name: "--json", desc: "JSON output" },
			{ name: "--help", desc: "Show help" },
		],
	},
	{
		name: "completions",
		desc: "Generate shell completions",
		flags: [{ name: "--help", desc: "Show help" }],
	},
] as const;

export function generateBash(): string {
	const lines: string[] = [
		"# Bash completion for ov",
		"# Source this file to enable completions:",
		"#   source <(ov --completions bash)",
		"",
		"_ov() {",
		"  local cur prev words cword",
		"  _init_completion || return",
		"",
		"  local commands='agents init sling prime stop status dashboard inspect merge nudge clean doctor log logs watch trace errors feed replay costs metrics spec coordinator supervisor hooks monitor mail group worktree run ecosystem upgrade completions'",
		"",
		"  # Top-level completion",
		"  if [[ $cword -eq 1 ]]; then",
		'    COMPREPLY=($(compgen -W "$commands --help --version --completions" -- "$cur"))',
		"    return",
		"  fi",
		"",
		// Shell variable expansion - not a template string placeholder
		`  local command="\${words[1]}"`,
		"",
	];

	// Generate command-specific completions
	for (const cmd of COMMANDS) {
		lines.push(`  if [[ $command == "${cmd.name}" ]]; then`);

		if (cmd.subcommands && cmd.subcommands.length > 0) {
			// Command with subcommands
			const subcmdNames = cmd.subcommands.map((s) => s.name).join(" ");
			lines.push("    if [[ $cword -eq 2 ]]; then");
			lines.push(`      COMPREPLY=($(compgen -W "${subcmdNames}" -- "$cur"))`);
			lines.push("      return");
			lines.push("    fi");

			// Subcommand flags
			for (const subcmd of cmd.subcommands) {
				if (subcmd.flags && subcmd.flags.length > 0) {
					const subcmdFlags = subcmd.flags.map((f) => f.name).join(" ");
					lines.push(`    if [[ \${words[2]} == "${subcmd.name}" ]]; then`);
					lines.push(`      COMPREPLY=($(compgen -W "${subcmdFlags}" -- "$cur"))`);
					lines.push("      return");
					lines.push("    fi");
				}
			}
		}

		// Command-level flags
		if (cmd.flags && cmd.flags.length > 0) {
			const cmdFlags = cmd.flags.map((f) => f.name).join(" ");
			lines.push(`    COMPREPLY=($(compgen -W "${cmdFlags}" -- "$cur"))`);
			lines.push("    return");
		}

		lines.push("  fi");
		lines.push("");
	}

	lines.push("  return 0");
	lines.push("}");
	lines.push("");
	lines.push("complete -F _ov ov");

	return lines.join("\n");
}

export function generateZsh(): string {
	const lines: string[] = [
		"#compdef ov",
		"# Zsh completion for ov",
		"# Place this file in your fpath or source it:",
		"#   source <(ov --completions zsh)",
		"",
		"_ov() {",
		"  local -a commands",
		"  commands=(",
	];

	// List all commands
	for (const cmd of COMMANDS) {
		lines.push(`    '${cmd.name}:${cmd.desc}'`);
	}
	lines.push("  )");
	lines.push("");

	lines.push("  local -a global_opts");
	lines.push("  global_opts=(");
	lines.push("    '--help[Show help]'");
	lines.push("    '--version[Show version]'");
	lines.push("    '--completions[Generate shell completions]:shell:(bash zsh fish)'");
	lines.push("  )");
	lines.push("");

	lines.push("  if (( CURRENT == 2 )); then");
	lines.push("    _describe 'command' commands");
	lines.push("    _arguments $global_opts");
	lines.push("    return");
	lines.push("  fi");
	lines.push("");

	lines.push('  local command="$words[2]"');
	lines.push("");
	lines.push('  case "$command" in');

	// Generate completions for each command
	for (const cmd of COMMANDS) {
		lines.push(`    ${cmd.name})`);

		if (cmd.subcommands && cmd.subcommands.length > 0) {
			lines.push("      local -a subcommands");
			lines.push("      subcommands=(");
			for (const subcmd of cmd.subcommands) {
				lines.push(`        '${subcmd.name}:${subcmd.desc}'`);
			}
			lines.push("      )");
			lines.push("");
			lines.push("      if (( CURRENT == 3 )); then");
			lines.push("        _describe 'subcommand' subcommands");
			lines.push("        return");
			lines.push("      fi");

			// Subcommand-specific flags
			for (const subcmd of cmd.subcommands) {
				if (subcmd.flags && subcmd.flags.length > 0) {
					lines.push(`      if [[ $words[3] == "${subcmd.name}" ]]; then`);
					lines.push("        _arguments \\");
					for (const flag of subcmd.flags) {
						if (flag.values) {
							const vals = flag.values.join(" ");
							lines.push(`          '${flag.name}[${flag.desc}]:value:(${vals})' \\`);
						} else if (flag.takesValue) {
							lines.push(`          '${flag.name}[${flag.desc}]:value:' \\`);
						} else {
							lines.push(`          '${flag.name}[${flag.desc}]' \\`);
						}
					}
					const lastLine = lines[lines.length - 1];
					if (lastLine) {
						lines[lines.length - 1] = lastLine.replace(" \\", "");
					}
					lines.push("        return");
					lines.push("      fi");
				}
			}
		}

		// Command-level flags
		if (cmd.flags && cmd.flags.length > 0) {
			lines.push("      _arguments \\");
			for (const flag of cmd.flags) {
				if (flag.values) {
					const vals = flag.values.join(" ");
					lines.push(`        '${flag.name}[${flag.desc}]:value:(${vals})' \\`);
				} else if (flag.takesValue) {
					lines.push(`        '${flag.name}[${flag.desc}]:value:' \\`);
				} else {
					lines.push(`        '${flag.name}[${flag.desc}]' \\`);
				}
			}
			const lastLine = lines[lines.length - 1];
			if (lastLine) {
				lines[lines.length - 1] = lastLine.replace(" \\", "");
			}
		}

		lines.push("      ;;");
	}

	lines.push("  esac");
	lines.push("}");
	lines.push("");
	lines.push('_ov "$@"');

	return lines.join("\n");
}

export function generateFish(): string {
	const lines: string[] = [
		"# Fish completion for ov",
		"# Place this file in ~/.config/fish/completions/ov.fish or source it:",
		"#   ov --completions fish | source",
		"",
		"# Remove all existing completions for ov",
		"complete -c ov -e",
		"",
		"# Global options",
		"complete -c ov -l help -d 'Show help'",
		"complete -c ov -l version -d 'Show version'",
		"complete -c ov -l completions -d 'Generate shell completions' -xa 'bash zsh fish'",
		"",
	];

	// Generate completions for each command
	for (const cmd of COMMANDS) {
		// Command name
		lines.push(`# ${cmd.desc}`);
		lines.push(`complete -c ov -f -n '__fish_use_subcommand' -a '${cmd.name}' -d '${cmd.desc}'`);

		if (cmd.subcommands && cmd.subcommands.length > 0) {
			// Subcommand names
			for (const subcmd of cmd.subcommands) {
				lines.push(
					`complete -c ov -f -n '__fish_seen_subcommand_from ${cmd.name}; and not __fish_seen_subcommand_from ${cmd.subcommands.map((s) => s.name).join(" ")}' -a '${subcmd.name}' -d '${subcmd.desc}'`,
				);

				// Subcommand flags
				if (subcmd.flags && subcmd.flags.length > 0) {
					for (const flag of subcmd.flags) {
						const flagName = flag.name.replace(/^--/, "");
						const cond = `'__fish_seen_subcommand_from ${cmd.name}; and __fish_seen_subcommand_from ${subcmd.name}'`;

						if (flag.values) {
							lines.push(
								`complete -c ov -f -n ${cond} -l '${flagName}' -d '${flag.desc}' -xa '${flag.values.join(" ")}'`,
							);
						} else if (flag.takesValue) {
							lines.push(`complete -c ov -n ${cond} -l '${flagName}' -d '${flag.desc}'`);
						} else {
							lines.push(`complete -c ov -f -n ${cond} -l '${flagName}' -d '${flag.desc}'`);
						}
					}
				}
			}
		}

		// Command-level flags
		if (cmd.flags && cmd.flags.length > 0) {
			for (const flag of cmd.flags) {
				const flagName = flag.name.replace(/^--/, "");
				const cond = `'__fish_seen_subcommand_from ${cmd.name}'`;

				if (flag.values) {
					lines.push(
						`complete -c ov -f -n ${cond} -l '${flagName}' -d '${flag.desc}' -xa '${flag.values.join(" ")}'`,
					);
				} else if (flag.takesValue) {
					lines.push(`complete -c ov -n ${cond} -l '${flagName}' -d '${flag.desc}'`);
				} else {
					lines.push(`complete -c ov -f -n ${cond} -l '${flagName}' -d '${flag.desc}'`);
				}
			}
		}

		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Create the Commander command for `overstory completions`.
 */
export function createCompletionsCommand(): Command {
	return new Command("completions")
		.description("Generate shell completions")
		.argument("<shell>", "Shell to generate completions for (bash, zsh, fish)")
		.action((shell: string) => {
			completionsCommand([shell]);
		});
}

export function completionsCommand(args: string[]): void {
	const shell = args[0];

	if (!shell) {
		printError("missing shell argument", "Usage: ov --completions <bash|zsh|fish>");
		process.exitCode = 1;
		return;
	}

	let script: string;
	switch (shell.toLowerCase()) {
		case "bash":
			script = generateBash();
			break;
		case "zsh":
			script = generateZsh();
			break;
		case "fish":
			script = generateFish();
			break;
		default:
			printError(`unknown shell '${shell}'`, "Supported shells: bash, zsh, fish");
			process.exitCode = 1;
			return;
	}

	process.stdout.write(script);
	process.stdout.write("\n");
}
