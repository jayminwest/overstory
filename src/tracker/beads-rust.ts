/**
 * Beads Rust tracker adapter.
 *
 * Wraps src/beads-rust/client.ts to implement the unified TrackerClient interface.
 */

import { createBeadsRustClient } from "../beads-rust/client.ts";
import type { TrackerClient, TrackerIssue } from "./types.ts";

/**
 * Create a TrackerClient backed by the beads_rust (br) CLI.
 *
 * @param cwd - Working directory for br commands
 */
export function createBeadsRustTracker(cwd: string): TrackerClient {
	const client = createBeadsRustClient(cwd);

	return {
		async ready() {
			const issues = await client.ready();
			return issues as TrackerIssue[];
		},

		async show(id) {
			const issue = await client.show(id);
			return issue as TrackerIssue;
		},

		async create(title, options) {
			return client.create(title, options);
		},

		async claim(id) {
			return client.claim(id);
		},

		async close(id, reason) {
			return client.close(id, reason);
		},

		async list(options) {
			const issues = await client.list(options);
			return issues as TrackerIssue[];
		},

		async sync() {
			return client.sync();
		},
	};
}
