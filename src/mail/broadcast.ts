/**
 * Group address resolution for broadcast messaging.
 *
 * Provides pure logic for resolving group addresses (e.g., @all, @builders)
 * into lists of individual agent names. No I/O — takes active sessions as
 * input and returns agent names as output.
 */

import type { AgentSession } from "../types.ts";

/**
 * Check if a recipient address is a group address.
 * Group addresses start with '@'.
 */
export function isGroupAddress(recipient: string): boolean {
	return recipient.startsWith("@");
}

/**
 * Capability group prefixes. Matches singular and plural forms.
 * E.g., @builder and @builders both resolve to agents with capability "builder".
 */
const CAPABILITY_GROUPS: Record<string, string> = {
	"@builder": "builder",
	"@builders": "builder",
	"@scout": "scout",
	"@scouts": "scout",
	"@reviewer": "reviewer",
	"@reviewers": "reviewer",
	"@lead": "lead",
	"@leads": "lead",
	"@merger": "merger",
	"@mergers": "merger",
	"@supervisor": "supervisor",
	"@supervisors": "supervisor",
	"@coordinator": "coordinator",
	"@coordinators": "coordinator",
	"@monitor": "monitor",
	"@monitors": "monitor",
};

/**
 * Resolve a group address to a list of agent names.
 *
 * @param groupAddress - The group address to resolve (e.g., "@all", "@builders")
 * @param activeSessions - List of active agent sessions
 * @param senderName - Name of the sender (excluded from recipients)
 * @returns Array of agent names that match the group
 * @throws Error if the group address is unknown or resolves to zero recipients
 */
export function resolveGroupAddress(
	groupAddress: string,
	activeSessions: AgentSession[],
	senderName: string,
	senderProjectId?: string,
): string[] {
	const normalized = groupAddress.toLowerCase();

	// Handle @all — same-project agents only when senderProjectId is provided, else all agents
	if (normalized === "@all") {
		const recipients = activeSessions
			.filter((s) => {
				if (s.agentName === senderName) return false;
				if (senderProjectId !== undefined) return s.projectId === senderProjectId;
				return true;
			})
			.map((s) => s.agentName);

		if (recipients.length === 0) {
			throw new Error(
				`Group address "${groupAddress}" resolved to zero recipients (sender excluded)`,
			);
		}

		return recipients;
	}

	// Handle @workspace — all active agents across all projects except sender
	if (normalized === "@workspace") {
		const recipients = activeSessions.map((s) => s.agentName).filter((name) => name !== senderName);
		if (recipients.length === 0) {
			throw new Error(
				`Group address "${groupAddress}" resolved to zero recipients (sender excluded)`,
			);
		}
		return recipients;
	}
	// Handle capability groups
	const capability = CAPABILITY_GROUPS[normalized];
	if (capability !== undefined) {
		const recipients = activeSessions
			.filter((s) => s.capability === capability)
			.map((s) => s.agentName)
			.filter((name) => name !== senderName);

		if (recipients.length === 0) {
			throw new Error(
				`Group address "${groupAddress}" resolved to zero recipients (no active ${capability} agents)`,
			);
		}

		return recipients;
	}

	// Unknown group
	throw new Error(
		`Unknown group address: "${groupAddress}". Valid groups: @all, @workspace, ${Object.keys(CAPABILITY_GROUPS).join(", ")}`,
	);
}
