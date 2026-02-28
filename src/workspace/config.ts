import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ConfigError, ValidationError } from "../errors.ts";

export interface WorkspaceProject {
	name: string;
	root: string;
	canonicalBranch: string;
}

export interface WorkspaceConfig {
	name: string;
	root: string;
	projects: WorkspaceProject[];
	maxConcurrentTotal: number;
	maxDepth: number;
}

export const WORKSPACE_DIR = ".overstory-workspace";
export const WORKSPACE_CONFIG_FILENAME = "workspace.yaml";
export const DEFAULT_PROJECT_ID = "_default";
export const WORKSPACE_PROJECT_ID = "_workspace";

export function resolveWorkspaceRoot(startDir: string): string | null {
	let current = resolve(startDir);
	while (true) {
		if (existsSync(resolve(current, WORKSPACE_DIR))) {
			return current;
		}
		const parent = resolve(current, "..");
		if (parent === current) return null;
		current = parent;
	}
}

export function isWorkspaceMode(startDir: string): boolean {
	return resolveWorkspaceRoot(startDir) !== null;
}

export async function loadWorkspaceConfig(
	workspaceRoot: string,
	opts?: { lenient?: boolean },
): Promise<WorkspaceConfig> {
	const configPath = resolve(workspaceRoot, WORKSPACE_DIR, WORKSPACE_CONFIG_FILENAME);

	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		throw new ConfigError(`Workspace config not found: ${configPath}`, { configPath });
	}

	let text: string;
	try {
		text = await file.text();
	} catch (err) {
		throw new ConfigError(`Failed to read workspace config: ${configPath}`, {
			configPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ConfigError(`Failed to parse YAML in workspace config: ${configPath}`, {
			configPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	return validateAndBuild(parsed, workspaceRoot, opts?.lenient ?? false);
}

function validateAndBuild(
	parsed: Record<string, unknown>,
	workspaceRoot: string,
	lenient: boolean,
): WorkspaceConfig {
	const rawName = parsed.name;
	if (typeof rawName !== "string" || rawName.trim() === "") {
		throw new ValidationError("workspace name must be a non-empty string", {
			field: "name",
			value: rawName,
		});
	}
	const name = rawName.trim();

	const rawProjects = parsed.projects;
	if (!Array.isArray(rawProjects) || rawProjects.length === 0) {
		throw new ValidationError("workspace projects must be a non-empty array", {
			field: "projects",
			value: rawProjects,
		});
	}

	let maxConcurrentTotal = 25;
	if (parsed.maxConcurrentTotal !== undefined && parsed.maxConcurrentTotal !== null) {
		const v = parsed.maxConcurrentTotal;
		if (!Number.isInteger(v) || (v as number) <= 0) {
			throw new ValidationError("maxConcurrentTotal must be a positive integer", {
				field: "maxConcurrentTotal",
				value: v,
			});
		}
		maxConcurrentTotal = v as number;
	}

	let maxDepth = 4;
	if (parsed.maxDepth !== undefined && parsed.maxDepth !== null) {
		const v = parsed.maxDepth;
		if (!Number.isInteger(v) || (v as number) < 3) {
			throw new ValidationError(
				"maxDepth must be >= 3 (workspace needs workspace -> coordinator -> lead -> specialist)",
				{ field: "maxDepth", value: v },
			);
		}
		maxDepth = v as number;
	}

	const seenNames = new Set<string>();
	const projects: WorkspaceProject[] = [];

	for (let i = 0; i < rawProjects.length; i++) {
		const rawProject = rawProjects[i];
		if (rawProject === null || typeof rawProject !== "object" || Array.isArray(rawProject)) {
			throw new ValidationError(`projects[${i}] must be an object`, {
				field: `projects[${i}]`,
				value: rawProject,
			});
		}
		const p = rawProject as Record<string, unknown>;

		const projName = p.name;
		if (typeof projName !== "string" || projName.trim() === "") {
			throw new ValidationError(`projects[${i}].name must be a non-empty string`, {
				field: `projects[${i}].name`,
				value: projName,
			});
		}
		if (seenNames.has(projName)) {
			throw new ValidationError(`duplicate project name: '${projName}'`, {
				field: `projects[${i}].name`,
				value: projName,
			});
		}
		seenNames.add(projName);

		const projRoot = p.root;
		if (typeof projRoot !== "string" || projRoot.trim() === "") {
			throw new ValidationError(`projects[${i}].root must be a non-empty string`, {
				field: `projects[${i}].root`,
				value: projRoot,
			});
		}
		const absRoot = isAbsolute(projRoot) ? projRoot : resolve(workspaceRoot, projRoot);

		if (!lenient && !existsSync(absRoot)) {
			throw new ValidationError(`projects[${i}].root does not exist: '${absRoot}'`, {
				field: `projects[${i}].root`,
				value: absRoot,
			});
		}
		if (!lenient && !existsSync(resolve(absRoot, ".git"))) {
			throw new ValidationError(
				`projects[${i}].root is not a git repository (no .git found): '${absRoot}'`,
				{ field: `projects[${i}].root`, value: absRoot },
			);
		}

		const canonicalBranch = p.canonicalBranch;
		if (typeof canonicalBranch !== "string" || canonicalBranch.trim() === "") {
			throw new ValidationError(`projects[${i}].canonicalBranch must be a non-empty string`, {
				field: `projects[${i}].canonicalBranch`,
				value: canonicalBranch,
			});
		}

		projects.push({
			name: projName,
			root: absRoot,
			canonicalBranch: canonicalBranch.trim(),
		});
	}

	return { root: workspaceRoot, name, projects, maxConcurrentTotal, maxDepth };
}

function parseYaml(text: string): Record<string, unknown> {
	const lines = text.split("\n");
	const root: Record<string, unknown> = {};
	const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		if (rawLine === undefined) continue;

		const commentFree = stripComment(rawLine);
		const trimmed = commentFree.trimEnd();
		if (trimmed.trim() === "") continue;

		const indent = countIndent(trimmed);
		const content = trimmed.trim();

		while (stack.length > 1) {
			const top = stack[stack.length - 1];
			if (top && top.indent >= indent) {
				stack.pop();
			} else {
				break;
			}
		}

		const parent = stack[stack.length - 1];
		if (!parent) continue;

		if (content.startsWith("- ")) {
			const value = content.slice(2).trim();
			const objColonIdx = value.indexOf(":");
			const isObjectItem =
				objColonIdx > 0 &&
				!value.startsWith('"') &&
				!value.startsWith("'") &&
				/^[\w-]+$/.test(value.slice(0, objColonIdx).trim());

			if (isObjectItem) {
				const itemKey = value.slice(0, objColonIdx).trim();
				const itemVal = value.slice(objColonIdx + 1).trim();
				const newItem: Record<string, unknown> = {};
				if (itemVal !== "") {
					newItem[itemKey] = parseValue(itemVal);
				} else {
					newItem[itemKey] = {};
				}

				const lastKey = findLastKey(parent.obj);
				if (lastKey !== null) {
					const existing = parent.obj[lastKey];
					if (Array.isArray(existing)) {
						existing.push(newItem);
						stack.push({ indent, obj: newItem });
						continue;
					}
				}

				if (stack.length >= 2) {
					const grandparent = stack[stack.length - 2];
					if (grandparent) {
						const gpKey = findLastKey(grandparent.obj);
						if (gpKey !== null) {
							const gpVal = grandparent.obj[gpKey];
							if (
								gpVal !== null &&
								typeof gpVal === "object" &&
								!Array.isArray(gpVal) &&
								Object.keys(gpVal as Record<string, unknown>).length === 0
							) {
								grandparent.obj[gpKey] = [newItem];
								stack.pop();
								stack.push({ indent, obj: newItem });
								continue;
							}
						}
					}
				}
				continue;
			}

			const lastKey = findLastKey(parent.obj);
			if (lastKey !== null) {
				const existing = parent.obj[lastKey];
				if (Array.isArray(existing)) {
					existing.push(parseValue(value));
					continue;
				}
			}

			if (stack.length >= 2) {
				const grandparent = stack[stack.length - 2];
				if (grandparent) {
					const gpKey = findLastKey(grandparent.obj);
					if (gpKey !== null) {
						const gpVal = grandparent.obj[gpKey];
						if (
							gpVal !== null &&
							typeof gpVal === "object" &&
							!Array.isArray(gpVal) &&
							Object.keys(gpVal as Record<string, unknown>).length === 0
						) {
							grandparent.obj[gpKey] = [parseValue(value)];
							stack.pop();
							continue;
						}
					}
				}
			}
			continue;
		}

		const colonIndex = content.indexOf(":");
		if (colonIndex === -1) continue;

		const key = content.slice(0, colonIndex).trim();
		const rawValue = content.slice(colonIndex + 1).trim();

		if (rawValue === "" || rawValue === undefined) {
			const nested: Record<string, unknown> = {};
			parent.obj[key] = nested;
			stack.push({ indent, obj: nested });
		} else if (rawValue === "[]") {
			parent.obj[key] = [];
		} else {
			parent.obj[key] = parseValue(rawValue);
		}
	}

	return root;
}

function findLastKey(obj: Record<string, unknown>): string | null {
	const keys = Object.keys(obj);
	return keys.length > 0 ? (keys[keys.length - 1] ?? null) : null;
}

function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		if (ch === '"' && !inSingle) inDouble = !inDouble;
		if (ch === "#" && !inSingle && !inDouble) {
			const prev = i > 0 ? line[i - 1] : "";
			if (i === 0 || prev === " " || prev === "\t") {
				return line.slice(0, i);
			}
		}
	}
	return line;
}

function countIndent(line: string): number {
	let n = 0;
	while (n < line.length && line[n] === " ") n++;
	return n;
}

function parseValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed === "null") return null;
	if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
	if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
	return trimmed;
}
