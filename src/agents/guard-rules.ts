/**
 * Shared guard rule constants for overstory agent hook generation.
 *
 * Pure data module — named exports only, no logic. These constants are the
 * single source of truth for tool names, bash patterns, and safe prefixes
 * used when generating PreToolUse guards in hooks-deployer.ts.
 */

/**
 * Claude Code native team/task tools that bypass overstory orchestration.
 * All overstory agents must use `overstory sling` for delegation, not these.
 */
export const NATIVE_TEAM_TOOLS = [
	"Task",
	"TeamCreate",
	"TeamDelete",
	"SendMessage",
	"TaskCreate",
	"TaskUpdate",
	"TaskList",
	"TaskGet",
	"TaskOutput",
	"TaskStop",
];

/**
 * Tools that require human interaction and block indefinitely in non-interactive
 * tmux sessions. Agents run non-interactively and must never call these tools.
 * Use overstory mail (--type question) to escalate to the orchestrator instead.
 */
export const INTERACTIVE_TOOLS = ["AskUserQuestion", "EnterPlanMode", "EnterWorktree"];

/** Tools that non-implementation agents must not use. */
export const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * Bash commands that modify files and must be blocked for non-implementation agents.
 * Each pattern is a regex fragment used inside a grep -qE check.
 */
export const DANGEROUS_BASH_PATTERNS = [
	"sed\\s+-i",
	"sed\\s+--in-place",
	"echo\\s+.*>",
	"printf\\s+.*>",
	"cat\\s+.*>",
	"tee\\s",
	"\\bvim\\b",
	"\\bnano\\b",
	"\\bvi\\b",
	"\\bmv\\s",
	"\\bcp\\s",
	"\\brm\\s",
	"\\bmkdir\\s",
	"\\btouch\\s",
	"\\bchmod\\s",
	"\\bchown\\s",
	">>",
	"\\bgit\\s+add\\b",
	"\\bgit\\s+commit\\b",
	"\\bgit\\s+merge\\b",
	"\\bgit\\s+push\\b",
	"\\bgit\\s+reset\\b",
	"\\bgit\\s+checkout\\b",
	"\\bgit\\s+rebase\\b",
	"\\bgit\\s+stash\\b",
	"\\bnpm\\s+install\\b",
	"\\bbun\\s+install\\b",
	"\\bbun\\s+add\\b",
	// Runtime eval flags — bypass shell pattern guards by executing JS/Python directly
	"\\bbun\\s+-e\\b",
	"\\bbun\\s+--eval\\b",
	"\\bnode\\s+-e\\b",
	"\\bnode\\s+--eval\\b",
	"\\bdeno\\s+eval\\b",
	"\\bpython3?\\s+-c\\b",
	"\\bperl\\s+-e\\b",
	"\\bruby\\s+-e\\b",
];

/**
 * Bash commands that are always safe for non-implementation agents.
 * If a command starts with any of these prefixes, it bypasses the dangerous command check.
 * This whitelist is checked BEFORE the blocklist.
 */
export const SAFE_BASH_PREFIXES = [
	"ov ",
	"overstory ",
	"bd ",
	"sd ",
	"git status",
	"git log",
	"git diff",
	"git show",
	"git blame",
	"git branch",
	"mulch ",
	"agent-browser ",
];
