import type { OverstoryConfig } from "../types.ts";

// === Doctor (Health Checks) ===

/** Categories for doctor health checks. */
export type DoctorCategory =
	| "dependencies"
	| "structure"
	| "config"
	| "databases"
	| "consistency"
	| "agents"
	| "merge"
	| "logs"
	| "version"
	| "ecosystem"
	| "providers"
	| "watchdog"
	| "serve";

/** Result of a single doctor health check. */
export interface DoctorCheck {
	name: string;
	category: DoctorCategory;
	status: "pass" | "warn" | "fail";
	message: string;
	details?: string[];
	/** Whether this check issues can be auto-fixed via --fix. */
	fixable?: boolean;
	/** Auto-fix closure — called when --fix flag is passed. Captures context at construction time. */
	fix?: () => Promise<string[]> | string[];
}

/**
 * Signature for a doctor check function.
 * Each check module exports a function matching this signature.
 * Receives the loaded config and the absolute path to .overstory/.
 * Returns one or more check results.
 */
export type DoctorCheckFn = (
	config: OverstoryConfig,
	overstoryDir: string,
) => DoctorCheck[] | Promise<DoctorCheck[]>;
